'use client';

/**
 * InsightDoc — Workspace Dashboard (spec §6.2 page 1)
 * Storage metrics, ingestion health, quick upload, recent documents and a
 * live workspace activity feed sourced from the audit trail.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Database,
  FileText,
  FileSearch,
  HardDrive,
  History,
  Layers,
  Loader2,
  MessageSquarePlus,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCcw,
  ScanLine,
  Send,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/types';
import { useAppStore, notifyWorkspaceInvalid } from './store';
import { UploadZone } from './upload-zone';
import { ApiError, createChat, fetchActivity, type ActivityEvent } from './api-client';

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'primary',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone?: 'primary' | 'cyan' | 'emerald' | 'amber';
}) {
  const tones = {
    primary: 'from-primary/25 to-primary/0 text-primary',
    cyan: 'from-cyan-500/25 to-cyan-500/0 text-cyan-500',
    emerald: 'from-emerald-500/25 to-emerald-500/0 text-emerald-500',
    amber: 'from-amber-500/25 to-amber-500/0 text-amber-500',
  } as const;
  return (
    <div className="stat-card group relative overflow-hidden rounded-xl border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5">
      {/* top gradient accent */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-x-0 top-0 h-px bg-gradient-to-r opacity-70',
          tones[tone],
        )}
      />
      <div className="flex items-center gap-2 text-muted-foreground">
        <span
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br',
            tones[tone],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2.5 text-2xl font-semibold tabular-nums transition-colors group-hover:text-primary">
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** Audit action → icon + friendly label for the activity timeline. */
const ACTIVITY_META: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; label: (t: string) => string; tone: string }
> = {
  'document.upload': { icon: Upload, label: () => 'uploaded a document', tone: 'bg-primary/10 text-primary' },
  'document.rename': { icon: Pencil, label: () => 'renamed a document', tone: 'bg-sky-500/10 text-sky-500' },
  'document.tag': { icon: Tag, label: () => 'tagged a document', tone: 'bg-primary/10 text-primary' },
  'document.ocr': { icon: ScanLine, label: () => 'OCR-indexed a scanned document', tone: 'bg-cyan-500/10 text-cyan-500' },
  'document.star': { icon: Star, label: () => 'starred a document', tone: 'bg-amber-500/10 text-amber-500' },
  'document.unstar': { icon: Star, label: () => 'removed a star', tone: 'bg-muted text-muted-foreground' },
  'document.delete': { icon: Trash2, label: () => 'deleted a document', tone: 'bg-destructive/10 text-destructive' },
  'document.reprocess': { icon: RefreshCcw, label: () => 're-queued a document for ingestion', tone: 'bg-amber-500/10 text-amber-500' },
  'chat.create': { icon: MessageSquarePlus, label: () => 'started a conversation', tone: 'bg-emerald-500/10 text-emerald-500' },
  'chat.query': { icon: MessageSquare, label: () => 'asked a RAG question', tone: 'bg-emerald-500/10 text-emerald-500' },
  'chat.rename': { icon: Pencil, label: () => 'renamed a conversation', tone: 'bg-sky-500/10 text-sky-500' },
  'chat.pin': { icon: Pin, label: () => 'pinned a conversation', tone: 'bg-amber-500/10 text-amber-500' },
  'chat.unpin': { icon: PinOff, label: () => 'unpinned a conversation', tone: 'bg-muted text-muted-foreground' },
  'document.summary': { icon: Sparkles, label: () => 'generated an AI digest', tone: 'bg-primary/10 text-primary' },
  'digest.share': { icon: Send, label: () => 'shared an AI digest into chat', tone: 'bg-primary/10 text-primary' },
  'document.tag.rename': { icon: Tag, label: () => 'renamed a tag across documents', tone: 'bg-sky-500/10 text-sky-500' },
  'document.tag.delete': { icon: Tag, label: () => 'removed a tag from documents', tone: 'bg-muted text-muted-foreground' },
  'chat.truncate': { icon: RefreshCcw, label: () => 'regenerated an answer', tone: 'bg-amber-500/10 text-amber-500' },
  'search.query': { icon: FileSearch, label: () => 'ran a semantic search', tone: 'bg-cyan-500/10 text-cyan-500' },
  'export.create': { icon: FileText, label: () => 'exported a conversation', tone: 'bg-violet-500/10 text-violet-500' },
  'workspace.create': { icon: Database, label: () => 'created the workspace', tone: 'bg-primary/10 text-primary' },
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function ActivityFeed() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    const load = () => {
      fetchActivity(activeWorkspaceId, 8)
        .then((e) => !cancelled && (setEvents(e), setError(false)))
        .catch((err) => {
          if (!cancelled) setError(true);
          // 403/404 ⇒ this workspace disappeared or access was revoked elsewhere.
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            notifyWorkspaceInvalid();
          }
        });
    };
    load();
    const timer = setInterval(load, 30_000); // refresh periodically
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeWorkspaceId]);

  return (
    <div className="min-w-0 rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4 text-primary/80" /> Workspace activity
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground">audit trail</span>
      </div>
      {events === null && !error && (
        <div className="space-y-3 p-4">
          {Array.from({ length: 4 }, (_, i) => i).map((i) => (
            <div key={`act-sk-${i}`} className="flex items-center gap-3">
              <Skeleton className="h-7 w-7 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="p-4 text-xs text-muted-foreground">Activity feed unavailable right now.</p>
      )}
      {events !== null && events.length === 0 && !error && (
        <p className="p-6 text-center text-xs text-muted-foreground">
          No activity yet — uploads, chats and searches will appear here.
        </p>
      )}
      {events !== null && events.length > 0 && (
        <ol className="relative space-y-0 px-4 py-2">
          {events.map((e, i) => {
            const meta = ACTIVITY_META[e.action] ?? {
              icon: Zap,
              label: () => e.action,
              tone: 'bg-muted text-muted-foreground',
            };
            const Icon = meta.icon;
            return (
              <li key={e.id} className="relative flex gap-3 py-2.5">
                {/* timeline connector */}
                {i < events.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-[13px] top-10 h-[calc(100%-1rem)] w-px bg-border"
                  />
                )}
                <span
                  className={cn(
                    'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                    meta.tone,
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs leading-5">
                    <span className="font-medium">{e.actorEmail.split('@')[0]}</span>{' '}
                    <span className="text-muted-foreground">{meta.label(e.targetType)}</span>
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground" title={new Date(e.createdAt).toLocaleString()}>
                    {relativeTime(e.createdAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function DashboardView() {
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const documents = useAppStore((s) => s.documents);
  const chats = useAppStore((s) => s.chats);
  const setView = useAppStore((s) => s.setView);
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const upsertChat = useAppStore((s) => s.upsertChat);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const [creating, setCreating] = useState(false);

  const stats = useMemo(() => {
    const completed = documents.filter((d) => d.status === 'COMPLETED');
    const processing = documents.filter((d) => d.status === 'PROCESSING' || d.status === 'PENDING');
    const failed = documents.filter((d) => d.status === 'FAILED');
    const storageBytes = documents.reduce((s, d) => s + d.fileSize, 0);
    const chunks = documents.reduce((s, d) => s + d.chunkCount, 0);
    const tokens = documents.reduce((s, d) => s + d.tokenCount, 0);
    return { completed, processing, failed, storageBytes, chunks, tokens };
  }, [documents]);

  const recentDocs = useMemo(
    () => [...documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
    [documents],
  );

  const handleNewChat = async () => {
    if (!activeWorkspaceId || creating) return;
    setCreating(true);
    try {
      const chat = await createChat(activeWorkspaceId);
      upsertChat(chat);
      setActiveChat(chat.id);
      setView('chat');
    } catch (error) {
      console.error(error);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="insightdoc-scroll h-full overflow-y-auto">
      <div className="bg-grid border-b bg-gradient-to-b from-primary/[0.06] to-transparent">
        <div className="mx-auto max-w-6xl space-y-1 p-4 sm:p-5 lg:p-8">
          <Badge variant="outline" className="mb-3 gap-1 border-primary/30 bg-primary/5 text-primary">
            <Zap className="h-3 w-3" /> Enterprise RAG Workspace
          </Badge>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{activeWorkspace?.name ?? 'Workspace'}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {activeWorkspace?.description ?? 'Upload dense documents, then interrogate them with citation-grounded answers.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => setView('documents')} className="gap-1.5">
              <Plus className="h-4 w-4" /> Add documents
            </Button>
            <Button variant="outline" onClick={() => void handleNewChat()} disabled={creating} className="gap-1.5">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
              New chat
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-5 lg:p-8">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={FileText}
            label="Documents"
            value={String(documents.length)}
            sub={`${stats.completed.length} indexed · ${stats.processing.length} processing${stats.failed.length > 0 ? ` · ${stats.failed.length} failed` : ''}`}
          />
          <StatCard
            icon={Layers}
            label="Vector chunks"
            value={stats.chunks.toLocaleString()}
            sub={`${Math.round(stats.tokens / 1000)}K tokens embedded`}
            tone="cyan"
          />
          <StatCard
            icon={HardDrive}
            label="Storage"
            value={formatBytes(stats.storageBytes)}
            sub={`${activeWorkspace?.storageBytes ? formatBytes(activeWorkspace.storageBytes) + ' in workspace' : 'of PDF payloads'}`}
            tone="emerald"
          />
          <StatCard
            icon={Bot}
            label="Conversations"
            value={String(chats.length)}
            sub="RAG sessions in this workspace"
            tone="amber"
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {/* Upload + pipeline */}
          <div className="space-y-4">
            <div className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Database className="h-4 w-4 text-primary/80" /> Quick upload
              </h2>
              <UploadZone />
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                or drop PDFs anywhere in the app
              </p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Ingestion health</h2>
              {stats.processing.length > 0 && (
                <p className="mb-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  {stats.processing.length} document(s) currently processing…
                </p>
              )}
              {stats.failed.length > 0 && (
                <p className="mb-2 text-xs text-destructive">
                  {stats.failed.length} failed — retry from the Document Library.
                </p>
              )}
              {stats.processing.length === 0 && stats.failed.length === 0 && (
                <p className="text-xs text-muted-foreground">All documents indexed and query-ready.</p>
              )}
            </div>
          </div>

          {/* Recent documents + activity */}
          <div className="min-w-0 space-y-4">
            <div className="rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b p-4">
                <h2 className="text-sm font-semibold">Recently updated</h2>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setView('documents')}>
                  View all
                </Button>
              </div>
              {recentDocs.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  Nothing here yet — your uploaded PDFs will appear in this feed.
                </p>
              ) : (
                <div className="divide-y">
                  {recentDocs.map((d) => (
                    <div key={d.id} className="group flex items-center gap-3 p-3.5 transition-colors hover:bg-accent/40">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/15">
                        <FileText className="h-4 w-4 text-primary/80" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium transition-colors group-hover:text-primary">
                          <span className="truncate">{d.title}</span>
                          {d.starred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {d.pageCount > 0 ? `${d.pageCount} pages · ` : ''}
                          {formatBytes(d.fileSize)} · {new Date(d.updatedAt).toLocaleString()}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          d.status === 'COMPLETED'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : d.status === 'FAILED'
                              ? 'border-destructive/30 bg-destructive/10 text-destructive'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        }
                      >
                        {d.status === 'COMPLETED' ? 'Indexed' : d.status === 'FAILED' ? 'Failed' : 'Processing'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <ActivityFeed />
          </div>
        </div>
      </div>
    </div>
  );
}
