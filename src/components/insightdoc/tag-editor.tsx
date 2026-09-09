'use client';

/**
 * InsightDoc — Document tag editor (shared: library rows + inspector dialog)
 * Edits a draft tag list in a popover; saving PATCHes the document
 * ({ tags }) and returns the fresh DTO via onSaved. Suggested tags are the
 * workspace-wide tag vocabulary (most used first) minus the doc's own.
 */
import { useState } from 'react';
import { Check, Plus, Tag, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { DocumentDTO } from '@/lib/types';
import { updateDocument } from './api-client';

export function TagEditor({
  doc,
  suggestions,
  onSaved,
  className,
}: {
  doc: DocumentDTO;
  /** Candidate tags (workspace vocabulary, already excluding doc.tags). */
  suggestions: string[];
  onSaved: (doc: DocumentDTO) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(doc.tags);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(doc.tags);
      setValue('');
    }
    setOpen(next);
  };

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase().slice(0, 24);
    if (!tag) return;
    if (draft.includes(tag)) {
      setValue('');
      return;
    }
    if (draft.length >= 8) {
      toast.warning('At most 8 tags per document');
      return;
    }
    setDraft((prev) => [...prev, tag]);
    setValue('');
  };

  const removeTag = (tag: string) => {
    setDraft((prev) => prev.filter((t) => t !== tag));
  };

  const save = async () => {
    setBusy(true);
    try {
      const updated = await updateDocument(doc.id, { tags: draft });
      onSaved(updated);
      setSavedFlash(true);
      toast.success(doc.tags.length === 0 ? `Tagged “${doc.title}”` : 'Tags updated');
      setTimeout(() => setSavedFlash(false), 1000);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save tags');
    } finally {
      setBusy(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(doc.tags);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7 text-muted-foreground hover:text-primary', className)}
          aria-label={`Edit tags for ${doc.title}`}
          title="Edit tags"
        >
          <Tag className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
          <Tag className="h-3 w-3 text-primary" /> Tags — {doc.title}
        </p>

        <div className="mb-2 flex min-h-7 flex-wrap gap-1">
          {draft.length === 0 && (
            <span className="text-[11px] text-muted-foreground">No tags yet — add one below.</span>
          )}
          {draft.map((tag) => (
            <span
              key={tag}
              className="doc-tag inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                aria-label={`Remove tag ${tag}`}
                className="rounded-full p-0.5 transition hover:bg-primary/15"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag(value);
              }
            }}
            placeholder="Add tag (Enter)"
            className="h-7 text-xs"
            maxLength={24}
            aria-label="New tag name"
          />
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => addTag(value)}
            disabled={!value.trim() || draft.length >= 8}
            aria-label="Add tag"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {suggestions.length > 0 && (
          <div className="mt-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Suggestions
            </p>
            <div className="flex flex-wrap gap-1">
              {suggestions.slice(0, 6).map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => addTag(tag)}
                  className="rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                >
                  + {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        <Button
          size="sm"
          className="mt-3 h-7 w-full gap-1 text-xs"
          onClick={() => void save()}
          disabled={busy || !dirty}
        >
          {savedFlash ? <Check className="h-3 w-3 insightdoc-pop" /> : null}
          {busy ? 'Saving…' : dirty ? `Save ${draft.length} tag${draft.length === 1 ? '' : 's'}` : 'Saved'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
