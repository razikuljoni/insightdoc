'use client';

/**
 * InsightDoc — Document Library (spec §6.2 page 2)
 * Table with live ingestion status badges, filtering, row actions,
 * inline title editing and taxonomy-aware failure messaging.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRightLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Pencil,
  RotateCcw,
  ScanLine,
  Search,
  Settings2,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DOCUMENT_ERROR_CODES, formatBytes, friendlyDocumentError, type TagOperation } from '@/lib/types';
import { useAppStore } from './store';
import { UploadZone } from './upload-zone';
import { TagEditor } from './tag-editor';
import { deleteDocument, manageWorkspaceTags, renameDocument, reprocessDocument } from './api-client';

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  COMPLETED: { label: 'Indexed', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  PROCESSING: { label: 'Processing', className: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  PENDING: { label: 'Queued', className: 'border-border bg-muted text-muted-foreground' },
  FAILED: { label: 'Failed', className: 'border-destructive/30 bg-destructive/10 text-destructive' },
};

type StatusFilter = 'ALL' | 'COMPLETED' | 'PROCESSING' | 'FAILED';

interface StatusDocLite {
  status: string;
  progress: number;
  statusDetail: string | null;
  ocrPages: number;
}

/**
 * Status cell content, shared by the dedicated Status column (md+) and the
 * compact in-row placement on mobile (<md) so both stay in sync.
 */
function StatusBlock({ d, badgeClassName }: { d: StatusDocLite; badgeClassName: string }) {
  const badge = STATUS_BADGE[d.status] ?? STATUS_BADGE.PENDING;
  const processing = d.status === 'PROCESSING' || d.status === 'PENDING';
  return (
    <div data-testid="doc-status-block">
      <div className="flex items-center gap-1">
        <Badge variant="outline" className={cn('gap-1 font-medium', badgeClassName || badge.className)}>
          {d.status === 'COMPLETED' && <CheckCircle2 className="h-3 w-3" />}
          {(d.status === 'PROCESSING' || d.status === 'PENDING') && <Loader2 className="h-3 w-3 animate-spin" />}
          {badge.label}
        </Badge>
        {d.ocrPages > 0 && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="gap-0.5 border-cyan-500/30 bg-cyan-500/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-cyan-600 dark:text-cyan-400"
                >
                  <ScanLine className="h-2.5 w-2.5" /> OCR
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                Text recovered via OCR on {d.ocrPages} page{d.ocrPages === 1 ? '' : 's'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {processing && (
        <>
          <Progress value={d.progress} className="mt-1 h-1" aria-label={`Ingestion ${d.progress}%`} />
          {d.statusDetail && (
            <p className="mt-0.5 flex max-w-40 items-center gap-1 text-[10px] leading-tight" role="status" aria-live="polite">
              <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-amber-500" aria-hidden />
              <span className="shimmer-text truncate font-medium" title={d.statusDetail}>
                {d.statusDetail}
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Inline rename editor with optimistic UI and server reconciliation. */
function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = async () => {
    const title = value.trim();
    if (!title || title === initial) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await onCommit(title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Input
      ref={inputRef}
      value={value}
      disabled={busy}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="h-7 text-sm"
      maxLength={160}
      aria-label="Edit document title"
    />
  );
}

export function DocumentsView() {
  const documents = useAppStore((s) => s.documents);
  const removeDocument = useAppStore((s) => s.removeDocument);
  const upsertDocument = useAppStore((s) => s.upsertDocument);
  const toggleDocumentStar = useAppStore((s) => s.toggleDocumentStar);
  const setDetailDocumentId = useAppStore((s) => s.setDetailDocumentId);
  const setCompareDocIds = useAppStore((s) => s.setCompareDocIds);
  const activeRole = useAppStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.role ?? 'VIEWER');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [starredOnly, setStarredOnly] = useState(false);
  /** Active tag filters (OR semantics). */
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  /** Workspace-wide tag maintenance dialog state. */
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [renamingTag, setRenamingTag] = useState<{ from: string; value: string } | null>(null);
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<string | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** Bulk selection (local to this view — independent of chat retrieval scope). */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  /** Workspace-wide tag vocabulary with usage counts (most used first). */
  const tagVocabulary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of documents) {
      for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, count]) => ({ tag: t, count }));
  }, [documents]);

  const toggleTagFilter = (tag: string) =>
    setTagFilters((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  /** Apply a workspace-wide rename/merge or delete, then sync store + filters. */
  const runTagOp = async (op: TagOperation, onDone: () => void) => {
    const wsId = useAppStore.getState().activeWorkspaceId;
    if (!wsId) return;
    setTagBusy(true);
    try {
      const updated = await manageWorkspaceTags(wsId, op);
      const store = useAppStore.getState();
      for (const d of updated) store.upsertDocument(d);
      if (op.action === 'rename') {
        setTagFilters((prev) => prev.map((t) => (t === op.from ? op.to : t)));
        toast.success(`Renamed “${op.from}” → “${op.to}” on ${updated.length} document${updated.length === 1 ? '' : 's'}`);
      } else {
        setTagFilters((prev) => prev.filter((t) => t !== op.from));
        toast.success(`Removed “${op.from}” from ${updated.length} document${updated.length === 1 ? '' : 's'}`);
      }
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Tag operation failed');
    } finally {
      setTagBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = documents.filter((d) => {
      if (starredOnly && !d.starred) return false;
      if (statusFilter !== 'ALL' && d.status !== statusFilter) return false;
      if (tagFilters.length > 0 && !tagFilters.some((t) => d.tags.includes(t))) return false;
      if (q && !d.title.toLowerCase().includes(q) && !d.fileName.toLowerCase().includes(q)) return false;
      return true;
    });
    // Favorites float to the top so a starred 10-Q is never buried.
    return [...rows].sort((a, b) => Number(b.starred) - Number(a.starred));
  }, [documents, search, statusFilter, starredOnly, tagFilters]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((d) => selected.has(d.id));
  const someVisibleSelected = filtered.some((d) => selected.has(d.id));
  const selectedInView = filtered.filter((d) => selected.has(d.id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        filtered.forEach((d) => next.delete(d.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((d) => next.add(d.id));
      return next;
    });
  };

  const bulkDelete = async () => {
    const targets = [...selected];
    if (targets.length === 0) return;
    setBulkConfirmOpen(false);
    setBulkBusy(true);
    let deleted = 0;
    let failed = 0;
    for (const id of targets) {
      try {
        await deleteDocument(id);
        removeDocument(id);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    if (failed === 0) toast.success(`Deleted ${deleted} document${deleted === 1 ? '' : 's'}`);
    else toast.warning(`Deleted ${deleted}, failed ${failed} — check permissions and retry`);
  };

  const withBusy = (id: string, fn: () => Promise<void>) => async () => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const commitRename = async (docId: string, title: string) => {
    try {
      const updated = await renameDocument(docId, title);
      upsertDocument(updated);
      toast.success(`Renamed to “${title}”`);
      setRenamingId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Rename failed');
      setRenamingId(null);
    }
  };

  const toggleStar = (docId: string, title: string) => {
    toggleDocumentStar(docId)
      .then((starred) => {
        toast.success(starred ? `Starred “${title}”` : `Removed star from “${title}”`, {
          icon: starred ? '⭐' : '☆',
        });
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Could not update star');
      });
  };

  const confirmDelete = async () => {
    const doc = documents.find((d) => d.id === pendingDelete);
    if (!doc) return;
    setPendingDelete(null);
    await withBusy(doc.id, async () => {
      await deleteDocument(doc.id);
      removeDocument(doc.id);
      toast.success(`Deleted “${doc.title}”`);
    })();
  };

  return (
    <div className="insightdoc-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-5 lg:p-8">
        <header>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Document Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload, monitor ingestion, and manage the knowledge base backing every answer.
          </p>
        </header>

        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <section className="min-w-0 rounded-xl border bg-card">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b p-3">
              <div className="relative min-w-44 flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search documents"
                  className="h-8 pl-8 text-xs"
                  aria-label="Search documents"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="COMPLETED">Indexed</SelectItem>
                  <SelectItem value="PROCESSING">Processing</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => setStarredOnly((v) => !v)}
                aria-pressed={starredOnly}
                className={cn(
                  'star-filter-focus flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-all',
                  starredOnly
                    ? 'border-amber-400/50 bg-amber-400/10 text-amber-600 shadow-[0_0_12px_-4px] shadow-amber-400/40 dark:text-amber-400'
                    : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Star className={cn('h-3.5 w-3.5', starredOnly && 'fill-current')} />
                Starred
                <span className="rounded-full bg-muted px-1.5 font-mono text-[10px]">
                  {documents.filter((d) => d.starred).length}
                </span>
              </button>
            </div>

            {/* Tag filter row — appears once the workspace has tags */}
            {tagVocabulary.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
                <Tag className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                {tagVocabulary.map(({ tag, count }) => {
                  const active = tagFilters.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTagFilter(tag)}
                      aria-pressed={active}
                      className={cn(
                        'doc-tag-filter rounded-full border px-2 py-0.5 text-[10px] font-medium transition-all',
                        active
                          ? 'border-primary/50 bg-primary/10 text-primary shadow-[0_0_10px_-3px] shadow-primary/40'
                          : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
                      )}
                    >
                      {tag}
                      <span className="ml-1 font-mono opacity-70">{count}</span>
                    </button>
                  );
                })}
                {tagFilters.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTagFilters([])}
                    className="ml-1 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Clear
                  </button>
                )}
                {activeRole !== 'VIEWER' && (
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingTag(null);
                      setConfirmDeleteTag(null);
                      setTagManagerOpen(true);
                    }}
                    className="ml-1 flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-primary"
                    aria-label="Manage workspace tags"
                    title="Rename, merge or delete tags across the workspace"
                  >
                    <Settings2 className="h-3 w-3" /> Manage
                  </button>
                )}
              </div>
            )}

            {/* Bulk action bar */}
            {selectedInView.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b bg-primary/[0.06] px-3 py-2">
                <span className="whitespace-nowrap text-xs font-medium text-primary">
                  {selectedInView.length} selected
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {formatBytes(selectedInView.reduce((s, d) => s + d.fileSize, 0))}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  {selectedInView.length === 2 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="digest-compare-btn h-7 gap-1 text-xs"
                      onClick={() => setCompareDocIds([selectedInView[0].id, selectedInView[1].id])}
                      disabled={bulkBusy}
                      title="Compare the AI digests of the two selected documents side by side"
                    >
                      <ArrowRightLeft className="h-3 w-3" />
                      Compare digests
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setSelected(new Set())}
                    disabled={bulkBusy}
                  >
                    <X className="h-3 w-3" /> Clear
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setBulkConfirmOpen(true)}
                    disabled={bulkBusy}
                  >
                    {bulkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    Delete selected
                  </Button>
                </div>
              </div>
            )}

            {/* Table */}
            <div className="p-1">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-9 pl-3">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                        }}
                        onChange={toggleSelectAll}
                        aria-label="Select all visible documents"
                        className="h-3.5 w-3.5 cursor-pointer rounded border-input accent-[var(--primary)]"
                      />
                    </TableHead>
                    <TableHead className="pl-1">Document</TableHead>
                    <TableHead className="hidden w-20 text-right md:table-cell">Size</TableHead>
                    <TableHead className="hidden w-14 text-right lg:table-cell">Pages</TableHead>
                    <TableHead className="hidden w-14 text-right lg:table-cell">Chunks</TableHead>
                    <TableHead className="hidden w-32 md:table-cell">Status</TableHead>
                    <TableHead className="w-24 pr-4 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        <FileText className="mx-auto mb-2 h-6 w-6 opacity-50" />
                        {starredOnly
                          ? 'No starred documents yet — click the ☆ next to a title to favorite it.'
                          : 'No documents match. Upload a PDF to get started.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((d) => {
                      const badge = STATUS_BADGE[d.status] ?? STATUS_BADGE.PENDING;
                      const busy = busyIds.has(d.id);
                      const friendlyError = friendlyDocumentError(d.errorMessage);
                      const isScanned = Boolean(d.errorMessage?.startsWith(DOCUMENT_ERROR_CODES.SCANNED_PDF));
                      const isRenaming = renamingId === d.id;
                      return (
                        <TableRow
                          key={d.id}
                          className={cn(
                            'group',
                            selected.has(d.id) && 'bg-primary/[0.05]',
                            d.starred && 'border-l-2 border-l-amber-400/50 row-starred',
                          )}
                        >
                          <TableCell className="pl-3">
                            <input
                              type="checkbox"
                              checked={selected.has(d.id)}
                              onChange={() => toggleSelect(d.id)}
                              aria-label={`Select ${d.title}`}
                              className="h-3.5 w-3.5 cursor-pointer rounded border-input accent-[var(--primary)]"
                            />
                          </TableCell>
                          <TableCell className="max-w-0 pl-1">
                            <div className="flex items-center gap-2">
                              <FileText
                                className={cn(
                                  'h-4 w-4 shrink-0',
                                  isScanned ? 'text-amber-500' : 'text-primary/70',
                                )}
                              />
                              <div className="min-w-0">
                                {isRenaming ? (
                                  <RenameField
                                    initial={d.title}
                                    onCommit={(title) => commitRename(d.id, title)}
                                    onCancel={() => setRenamingId(null)}
                                  />
                                ) : (
                                  <div className="flex items-center gap-1">
                                    <p
                                      className="cursor-pointer truncate text-sm font-medium transition group-hover:text-primary"
                                      title={`${d.title} — click to inspect, double-click to rename`}
                                      onClick={() => setDetailDocumentId(d.id)}
                                      onDoubleClick={() => setRenamingId(d.id)}
                                    >
                                      {d.title}
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => toggleStar(d.id, d.title)}
                                      aria-label={d.starred ? `Unstar ${d.title}` : `Star ${d.title}`}
                                      aria-pressed={d.starred}
                                      className={cn(
                                        'shrink-0 rounded-sm p-0.5 transition-all hover:scale-125 active:scale-95',
                                        d.starred
                                          ? 'star-pop text-amber-400 opacity-100'
                                          : 'text-muted-foreground opacity-0 hover:!text-amber-400 group-hover:opacity-60 max-md:opacity-40',
                                      )}
                                    >
                                      <Star className={cn('h-3.5 w-3.5', d.starred && 'fill-amber-400')} />
                                    </button>
                                  </div>
                                )}
                                <p className="truncate text-[11px] text-muted-foreground" title={d.fileName}>
                                  {d.fileName}
                                </p>
                                {d.tags.length > 0 && (
                                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                                    {d.tags.slice(0, 3).map((tag) => (
                                      <span
                                        key={tag}
                                        className="doc-tag rounded-full border border-primary/25 bg-primary/5 px-1.5 py-px text-[9px] font-medium text-primary/90"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                    {d.tags.length > 3 && (
                                      <span className="font-mono text-[9px] text-muted-foreground">
                                        +{d.tags.length - 3}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {d.status === 'FAILED' && friendlyError && (
                                  <p
                                    className={cn(
                                      'mt-0.5 flex items-start gap-1 text-[11px]',
                                      isScanned ? 'text-amber-600 dark:text-amber-400' : 'text-destructive',
                                    )}
                                  >
                                    {isScanned ? (
                                      <ScanLine className="mt-px h-3 w-3 shrink-0" />
                                    ) : (
                                      <AlertCircle className="mt-px h-3 w-3 shrink-0" />
                                    )}
                                    <span className="line-clamp-2">{friendlyError}</span>
                                  </p>
                                )}
                                {/* Mobile meta line — mirrors the numeric columns hidden below md/lg */}
                                <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground md:hidden">
                                  {formatBytes(d.fileSize)} ·{' '}
                                  {d.pageCount || '—'} page{(d.pageCount || 0) === 1 ? '' : 's'} ·{' '}
                                  {d.chunkCount || '—'} chunk{(d.chunkCount || 0) === 1 ? '' : 's'}
                                </p>
                                {/* Mobile status — dedicated Status column is hidden below md */}
                                <div className="mt-1.5 md:hidden">
                                  <StatusBlock d={d} badgeClassName={badge.className} />
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="hidden text-right font-mono text-xs text-muted-foreground md:table-cell">
                            {formatBytes(d.fileSize)}
                          </TableCell>
                          <TableCell className="hidden text-right font-mono text-xs text-muted-foreground lg:table-cell">
                            {d.pageCount || '—'}
                          </TableCell>
                          <TableCell className="hidden text-right font-mono text-xs text-muted-foreground lg:table-cell">
                            {d.chunkCount || '—'}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <StatusBlock d={d} badgeClassName={badge.className} />
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <div className="flex justify-end gap-0.5 opacity-0 transition group-hover:opacity-100 max-md:opacity-100">
                              <TooltipProvider delayDuration={400}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span tabIndex={-1} className="inline-flex">
                                      <TagEditor
                                        doc={d}
                                        suggestions={tagVocabulary.map((v) => v.tag).filter((t) => !d.tags.includes(t))}
                                        onSaved={upsertDocument}
                                      />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="left" className="text-xs">Edit tags</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              <TooltipProvider delayDuration={400}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7"
                                      disabled={busy || isRenaming}
                                      onClick={() => setRenamingId(d.id)}
                                      aria-label={`Rename ${d.title}`}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="left" className="text-xs">Rename</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              {d.status === 'FAILED' && (
                                <TooltipProvider delayDuration={400}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        disabled={busy}
                                        onClick={withBusy(d.id, async () => {
                                          await reprocessDocument(d.id);
                                          upsertDocument({ ...d, status: 'PENDING', progress: 0, errorMessage: null });
                                          toast.info('Re-queued for processing');
                                        })}
                                        aria-label={`Retry processing ${d.title}`}
                                      >
                                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="left" className="text-xs">Retry ingestion</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              <TooltipProvider delayDuration={400}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-destructive hover:text-destructive"
                                      disabled={busy}
                                      onClick={() => setPendingDelete(d.id)}
                                      aria-label={`Delete ${d.title}`}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="left" className="text-xs">Delete</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* Upload sidebar */}
          <aside className="space-y-4">
            <div className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Add documents</h2>
              <UploadZone compact />
            </div>
            <div className="rounded-xl border bg-card p-4 text-xs leading-relaxed text-muted-foreground">
              <h3 className="mb-1.5 text-sm font-semibold text-foreground">Ingestion pipeline</h3>
              <ol className="list-decimal space-y-1 pl-4">
                <li>Page-by-page text extraction</li>
                <li>Scanned-PDF detection → OCR fallback (tesseract)</li>
                <li>Page-scoped chunking (1000/200 sliding window)</li>
                <li>1536-dim vector embedding</li>
                <li>Hybrid index build (vector + BM25)</li>
              </ol>
            </div>
          </aside>
        </div>
      </div>

      {/* Workspace tag manager — rename/merge or delete across all documents */}
      <Dialog open={tagManagerOpen} onOpenChange={(v) => { if (!v) { setTagManagerOpen(false); setRenamingTag(null); setConfirmDeleteTag(null); } }}>
        <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-primary" /> Manage workspace tags
            </DialogTitle>
            <DialogDescription>
              Renaming applies to every tagged document (same-name tags merge automatically);
              deleting strips the tag everywhere. Both actions are audited.
            </DialogDescription>
          </DialogHeader>

          <div className="insightdoc-scroll -mx-1 max-h-[46vh] overflow-y-auto px-1">
            {tagVocabulary.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No tags yet — tag a document from its row or inspector first.
              </p>
            )}
            <div className="space-y-1.5">
              {tagVocabulary.map(({ tag, count }) => {
                const isRenaming = renamingTag?.from === tag;
                const isConfirming = confirmDeleteTag === tag;
                const widthPct = Math.max(8, Math.round((count / Math.max(tagVocabulary[0]?.count ?? 1, 1)) * 100));
                return (
                  <div
                    key={tag}
                    data-danger={isConfirming}
                    className="tag-mgmt-row rounded-lg border bg-card/60 px-2.5 py-2"
                  >
                    {isConfirming ? (
                      <div className="flex items-center gap-2">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        <p className="min-w-0 flex-1 text-xs leading-snug">
                          Remove <span className="font-semibold text-destructive">“{tag}”</span> from{' '}
                          <span className="font-semibold">{count}</span> document{count === 1 ? '' : 's'}?
                        </p>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-[11px]"
                          disabled={tagBusy}
                          onClick={() => void runTagOp({ action: 'delete', from: tag }, () => setConfirmDeleteTag(null))}
                        >
                          {tagBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Remove'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-[11px]"
                          disabled={tagBusy}
                          onClick={() => setConfirmDeleteTag(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : isRenaming ? (
                      <div className="flex items-center gap-1.5">
                        <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <Input
                          value={renamingTag.value}
                          disabled={tagBusy}
                          autoFocus
                          maxLength={24}
                          onChange={(e) => setRenamingTag({ from: tag, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const to = renamingTag.value.trim();
                              if (to && to.toLowerCase() !== tag) {
                                void runTagOp({ action: 'rename', from: tag, to }, () => setRenamingTag(null));
                              }
                            }
                            if (e.key === 'Escape') setRenamingTag(null);
                          }}
                          className="h-7 flex-1 text-xs"
                          aria-label={`New name for tag ${tag}`}
                        />
                        <Button
                          size="sm"
                          className="h-7 shrink-0 px-2 text-[11px]"
                          disabled={tagBusy || !renamingTag.value.trim()}
                          onClick={() => {
                            const to = renamingTag.value.trim();
                            if (to && to.toLowerCase() !== tag) {
                              void runTagOp({ action: 'rename', from: tag, to }, () => setRenamingTag(null));
                            }
                          }}
                        >
                          {tagBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Rename'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-[11px]"
                          disabled={tagBusy}
                          onClick={() => setRenamingTag(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="doc-tag rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary">
                          {tag}
                        </span>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <div className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                            <div className="tag-usage-bar h-full rounded-full" style={{ width: `${widthPct}%` }} />
                          </div>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground" aria-label={`${count} documents tagged`}>
                            {count} doc{count === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={tagBusy}
                            onClick={() => setRenamingTag({ from: tag, value: tag })}
                            aria-label={`Rename tag ${tag}`}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive hover:text-destructive"
                            disabled={tagBusy}
                            onClick={() => setConfirmDeleteTag(tag)}
                            aria-label={`Delete tag ${tag}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation (single) */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              “{documents.find((d) => d.id === pendingDelete)?.title}” and its vector chunks will be
              permanently removed from the workspace index. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void confirmDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation (bulk) */}
      <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedInView.length} documents?</AlertDialogTitle>
            <AlertDialogDescription>
              The selected documents and all of their vector chunks will be permanently removed from
              the workspace index. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void bulkDelete()}
            >
              Delete {selectedInView.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
