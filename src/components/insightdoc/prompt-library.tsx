'use client';

/**
 * InsightDoc — Prompt Library (composer popover)
 * A lightweight, per-browser saved-prompt library persisted in localStorage.
 * Insert a saved prompt into the composer, save the current draft as a new
 * prompt, or prune old ones. No server round-trips — prompts are workspace-
 * agnostic personal shortcuts (questions like "Summarize the risk factors").
 */
import { useMemo, useState } from 'react';
import { BookMarked, Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export interface SavedPrompt {
  id: string;
  title: string;
  text: string;
  createdAt: string;
}

const STORAGE_KEY = 'insightdoc-prompts';
const MAX_PROMPTS = 50;

function loadPrompts(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedPrompt =>
        typeof p === 'object' && p !== null
        && typeof (p as SavedPrompt).id === 'string'
        && typeof (p as SavedPrompt).title === 'string'
        && typeof (p as SavedPrompt).text === 'string',
    );
  } catch {
    return [];
  }
}

function persistPrompts(prompts: SavedPrompt[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts.slice(0, MAX_PROMPTS)));
  } catch {
    /* storage unavailable — in-memory only for this session */
  }
}

export function PromptLibrary({
  onInsert,
  draft,
  disabled,
}: {
  onInsert: (text: string) => void;
  /** Current composer draft — enables "save draft as prompt". */
  draft: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [title, setTitle] = useState('');
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  // localStorage is client-only: hydrate lazily the first time the popover
  // opens (avoids both SSR mismatch and setState-in-effect lint violations).
  const handleOpenChange = (next: boolean) => {
    if (next) setPrompts(loadPrompts());
    setOpen(next);
  };

  const draftTrimmed = draft.trim();
  const canSave = draftTrimmed.length >= 3 && draftTrimmed.length <= 4000;
  const defaultTitle = useMemo(
    () => (draftTrimmed ? draftTrimmed.replace(/\s+/g, ' ').slice(0, 42) + (draftTrimmed.length > 42 ? '…' : '') : ''),
    [draftTrimmed],
  );

  const saveDraft = () => {
    if (!canSave) return;
    const entry: SavedPrompt = {
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: (title.trim() || defaultTitle).slice(0, 80),
      text: draftTrimmed,
      createdAt: new Date().toISOString(),
    };
    const next = [entry, ...prompts.filter((p) => p.text !== entry.text)].slice(0, MAX_PROMPTS);
    setPrompts(next);
    persistPrompts(next);
    setTitle('');
    setSavedFlash(entry.id);
    toast.success('Prompt saved to library');
    setTimeout(() => setSavedFlash(null), 1200);
  };

  const removePrompt = (id: string) => {
    const next = prompts.filter((p) => p.id !== id);
    setPrompts(next);
    persistPrompts(next);
  };

  const insert = (text: string) => {
    onInsert(text);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          disabled={disabled}
          className="h-11 w-11 shrink-0 rounded-xl text-muted-foreground transition-colors hover:text-primary"
          aria-label="Prompt library"
          title="Prompt library — reuse saved questions"
        >
          <BookMarked className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <BookMarked className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-semibold">Prompt library</span>
          <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {prompts.length}
          </span>
        </div>

        {/* Save the current draft as a reusable prompt */}
        <div className="border-b bg-muted/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={defaultTitle || 'Title (optional)'}
              maxLength={80}
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-primary/50"
              aria-label="Prompt title"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveDraft();
                }
              }}
            />
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={!canSave}
              onClick={saveDraft}
              aria-label="Save current draft as prompt"
            >
              {savedFlash ? <Check className="h-3 w-3 insightdoc-pop" /> : <Plus className="h-3 w-3" />}
              Save draft
            </Button>
          </div>
          {!canSave && draftTrimmed.length === 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Type a question in the composer, then save it here to reuse anytime.
            </p>
          )}
        </div>

        <ScrollArea className="insightdoc-scroll max-h-64">
          {prompts.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No saved prompts yet — your reusable questions will live here.
            </p>
          ) : (
            <div className="p-1.5">
              {prompts.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    'prompt-row group flex items-start gap-2 rounded-lg px-2 py-1.5 transition hover:bg-accent',
                    savedFlash === p.id && 'bg-emerald-500/10',
                  )}
                >
                  <button onClick={() => insert(p.text)} className="min-w-0 flex-1 text-left" aria-label={`Insert prompt ${p.title}`}>
                    <span className="block truncate text-xs font-medium">{p.title}</span>
                    <span className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">{p.text}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                    onClick={() => removePrompt(p.id)}
                    aria-label={`Delete prompt ${p.title}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
