'use client';

/**
 * InsightDoc — Digest Compare Dialog
 * Side-by-side comparison of two documents' AI digests: overview, key points
 * and entity chips with shared-entity highlighting — the analyst's "what
 * changed / what overlaps" view across two filings or revisions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, FileText, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { DocumentSummaryResponse } from '@/lib/types';
import { useAppStore } from './store';
import { fetchDocumentSummary, generateDocumentSummary } from './api-client';

type SideState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: DocumentSummaryResponse };

function useDigestSide(documentId: string | null): {
  state: SideState;
  generating: boolean;
  generate: (force?: boolean) => Promise<void>;
} {
  const [state, setState] = useState<SideState>({ kind: 'loading' });
  const [generating, setGenerating] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    setState({ kind: 'loading' });
    if (!documentId) return;
    fetchDocumentSummary(documentId)
      .then((s) => !cancelled && setState(s ? { kind: 'ready', data: s } : { kind: 'missing' }))
      .catch((e) => !cancelled && setState({ kind: 'error', message: e instanceof Error ? e.message : 'Failed to load digest' }));
    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
  }, [documentId]);

  const generate = async (force = false) => {
    if (!documentId || generating) return;
    setGenerating(true);
    try {
      const s = await generateDocumentSummary(documentId, force);
      if (aliveRef.current) setState({ kind: 'ready', data: s });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Digest failed';
      if (aliveRef.current) {
        setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', message: msg }));
        toast.error(msg);
      }
    } finally {
      if (aliveRef.current) setGenerating(false);
    }
  };

  return { state, generating, generate };
}

/** One column of the comparison. */
function CompareSide({
  label,
  documentId,
  accent,
}: {
  label: string;
  documentId: string | null;
  accent: 'primary' | 'cyan';
}) {
  const documents = useAppStore((s) => s.documents);
  const doc = documentId ? documents.find((d) => d.id === documentId) ?? null : null;
  const { state, generating, generate } = useDigestSide(documentId);

  // Publish the loaded digest upward for shared-entity computation.
  useEffect(() => {
    if (state.kind === 'ready') {
      publishSideDigest(documentId, state.data);
    }
  }, [documentId, state]);

  if (!documentId || !doc) {
    return (
      <div className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
        Select a document
      </div>
    );
  }

  const accentDot = accent === 'primary' ? 'bg-primary' : 'bg-cyan-500';
  const accentText = accent === 'primary' ? 'text-primary' : 'text-cyan-500';

  return (
    <div className="digest-compare-col flex min-h-0 flex-col gap-2.5 rounded-lg border bg-card/70 p-3">
      <div className="flex items-center gap-2">
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-muted font-mono text-[9px] font-bold text-muted-foreground"
          aria-hidden
        >
          {label}
        </span>
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', accentDot)} aria-hidden />
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold" title={doc.title}>
          <FileText className={cn('h-3.5 w-3.5 shrink-0', accentText)} />
          <span className="truncate">{doc.title}</span>
        </span>
        {doc.starred && <span className="shrink-0 text-[10px]" aria-label="starred">⭐</span>}
      </div>

      {state.kind === 'loading' && (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground" aria-live="polite">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading digest…
        </div>
      )}

      {(state.kind === 'missing' || state.kind === 'error') && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3">
          <p className="text-xs text-muted-foreground">
            {state.kind === 'missing'
              ? 'No AI digest yet for this document.'
              : `Could not load the digest — ${state.message}`}
          </p>
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={generating} onClick={() => void generate()}>
            {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3 text-primary" />}
            {generating ? 'Generating… (~10s)' : 'Generate digest'}
          </Button>
        </div>
      )}

      {state.kind === 'ready' && (
        <DigestBody data={state.data} onRegenerate={() => void generate(true)} generating={generating} />
      )}
    </div>
  );
}

function DigestBody({
  data,
  onRegenerate,
  generating,
}: {
  data: DocumentSummaryResponse;
  onRegenerate: () => void;
  generating: boolean;
}) {
  return (
    <>
      <p className="digest-compare-overview text-xs leading-relaxed text-foreground/90">{data.summary.overview}</p>

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Key points</p>
        <ul className="space-y-1">
          {data.summary.keyPoints.map((k, i) => (
            <li
              key={i}
              className="digest-compare-point flex gap-1.5 text-xs leading-snug text-foreground/85"
              style={{ animationDelay: `${i * 45}ms` }}
            >
              <span className="mt-0.5 font-mono text-[10px] text-primary/70">{String(i + 1).padStart(2, '0')}</span>
              <span className="min-w-0">{k}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Entities</p>
        <div className="flex flex-wrap gap-1">
          {data.summary.entities.map((e) => (
            <SharedEntityChip key={e} entity={e} />
          ))}
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-2 font-mono text-[10px] text-muted-foreground">
        <span>
          {data.model} · {data.basis.chunkCount} chunks{data.cached ? ' · cached' : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          disabled={generating}
          onClick={onRegenerate}
          aria-label="Regenerate this digest"
          title="Regenerate this digest"
        >
          {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>
    </>
  );
}

// ── Shared-entity signalling (module-level pub between the two columns) ──────
const sideDigests = new Map<string, DocumentSummaryResponse>();
const listeners = new Set<() => void>();

function publishSideDigest(documentId: string | null, data: DocumentSummaryResponse) {
  if (!documentId) return;
  sideDigests.set(documentId, data);
  listeners.forEach((l) => l());
}

function SharedEntityChip({ entity }: { entity: string }) {
  const [shared, setShared] = useState(false);

  useEffect(() => {
    const recompute = () => {
      const entries = Array.from(sideDigests.values());
      const mine = entries[0];
      const other = entries[1];
      setShared(
        entries.length >= 2 && mine !== undefined && other !== undefined
          ? normEntity(mine.summary.entities).has(normEntityStr(entity)) &&
              normEntity(other.summary.entities).has(normEntityStr(entity))
          : false,
      );
    };
    recompute();
    listeners.add(recompute);
    return () => {
      listeners.delete(recompute);
    };
  }, [entity]);

  return (
    <span
      className={cn(
        'digest-compare-entity inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px]',
        shared
          ? 'border-emerald-500/50 bg-emerald-500/10 font-medium text-emerald-600 dark:text-emerald-400'
          : 'bg-muted/60 text-muted-foreground',
      )}
      title={shared ? 'Entity appears in both documents' : undefined}
    >
      {shared && <span className="mr-1 text-[9px]" aria-hidden>⇄</span>}
      {entity}
    </span>
  );
}

const normEntityStr = (s: string) => s.trim().toLowerCase();
const normEntity = (list: string[]) => new Set(list.map(normEntityStr));

// ── Dialog shell ─────────────────────────────────────────────────────────────
export function DigestCompareDialog() {
  const compareDocIds = useAppStore((s) => s.compareDocIds);
  const setCompareDocIds = useAppStore((s) => s.setCompareDocIds);
  const open = compareDocIds !== null;
  const [digestVersion, setDigestVersion] = useState(0);

  // Clear the module-level pub so stale digests don't leak between opens,
  // and subscribe to digest loads for the shared-count footer.
  useEffect(() => {
    if (!open) return;
    sideDigests.clear();
    listeners.forEach((l) => l());
    const onUpdate = () => setDigestVersion((v) => v + 1);
    listeners.add(onUpdate);
    return () => {
      listeners.delete(onUpdate);
    };
  }, [open, compareDocIds]);

  const [idA, idB] = compareDocIds ?? [null, null];

  const sharedCount = useMemo(() => {
    void digestVersion; // recompute when any column finishes loading
    const entries = Array.from(sideDigests.values());
    if (entries.length < 2) return null;
    const setA = normEntity(entries[0].summary.entities);
    const setB = normEntity(entries[1].summary.entities);
    let count = 0;
    setA.forEach((e) => {
      if (setB.has(e)) count += 1;
    });
    return count;
  }, [digestVersion, compareDocIds]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setCompareDocIds(null)}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary/25 to-cyan-500/10">
              <ArrowRightLeft className="h-3.5 w-3.5 text-primary" />
            </span>
            Digest compare
          </DialogTitle>
          <DialogDescription>
            Side-by-side AI digests — shared entities are highlighted, so overlaps and differences between the two documents surface at a glance.
          </DialogDescription>
        </DialogHeader>

        {/* Plain overflow div — Radix ScrollArea's h-full viewport can't resolve
            against a max-height dialog (indefinite height) and never scrolls. */}
        <div className="insightdoc-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <div className="grid gap-3 md:grid-cols-2">
            <CompareSide label="A" documentId={idA} accent="primary" />
            <CompareSide label="B" documentId={idB} accent="cyan" />
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-2.5">
          <p className="text-[11px] text-muted-foreground" aria-live="polite">
            {sharedCount === null
              ? 'Shared entities appear once both digests are loaded'
              : sharedCount > 0
                ? `${sharedCount} shared entit${sharedCount === 1 ? 'y' : 'ies'} detected`
                : 'No shared entities between these digests'}
          </p>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setCompareDocIds(null)}>
            <X className="h-3 w-3" /> Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
