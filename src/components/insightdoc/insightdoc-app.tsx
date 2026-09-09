'use client';

/**
 * InsightDoc — App Shell (root orchestrator)
 * Boots platform data (workspaces, documents, chats), owns polling for live
 * ingestion status, renders the sidebar and the active view (spec §6.2).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Database,
  FileText,
  FolderKanban,
  Hash,
  Keyboard,
  LayoutDashboard,
  Loader2,
  MessageSquarePlus,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun,
  Trash2,
  Users,
  Command,
} from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useAppStore, onWorkspaceInvalid, notifyWorkspaceInvalid, type AppView } from './store';
import { ApiError, deleteWorkspace, fetchChats, fetchDocuments, fetchWorkspaces, updateWorkspace } from './api-client';
import { DashboardView } from './dashboard-view';
import { DocumentsView } from './documents-view';
import { ChatView } from './chat-view';
import { SearchView } from './search-view';
import { AnalyticsView } from './analytics-view';
import { CommandPalette } from './command-palette';
import { DocumentDetailDialog } from './document-detail-dialog';
import { DigestCompareDialog } from './digest-compare-dialog';
import { GlobalUploadManager } from './global-upload';
import { ShortcutsDialog } from './shortcuts-dialog';

const NAV: Array<{ view: AppView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'documents', label: 'Documents', icon: FileText },
  { view: 'chat', label: 'RAG Chat', icon: MessageSquarePlus },
  { view: 'search', label: 'Search', icon: Search },
  { view: 'analytics', label: 'Analytics', icon: BarChart3 },
];

function WorkspaceCreateDialog() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/v1/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      const body = (await res.json()) as { workspace?: { id: string; name: string; slug: string; description: string | null; createdAt: string; role: 'ADMIN' } };
      if (res.ok && body.workspace) {
        const w = {
          ...body.workspace,
          documentCount: 0,
          chatCount: 0,
          memberCount: 1,
          storageBytes: 0,
        };
        addWorkspace(w);
        setActiveWorkspace(w.id);
        setOpen(false);
        setName('');
        setDescription('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Create workspace">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            Workspaces isolate documents, vector indexes and conversations.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">Name</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q4 Legal Audits"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-desc">Description (optional)</Label>
            <Textarea
              id="ws-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this workspace for?"
              className="min-h-16"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => void create()} disabled={!name.trim() || busy} className="gap-1.5">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Edit active-workspace metadata + read-only stats (ADMIN-only persistence). */
function WorkspaceSettingsDialog() {
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const canEdit = active?.role === 'ADMIN';

  // Sync editable fields each time the dialog opens (state derived from props on demand).
  useEffect(() => {
    if (open && active) {
      setName(active.name);
      setDescription(active.description ?? '');
      setSaveError(null);
    }
  }, [open, active]);

  const dirty = active !== null && (name !== active.name || description !== (active.description ?? ''));

  const save = async () => {
    if (!active || busy || !dirty) return;
    setBusy(true);
    setSaveError(null);
    try {
      const updated = await updateWorkspace(active.id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      useAppStore.setState((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === updated.id ? updated : w)),
      }));
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setBusy(false);
    }
  };

  if (!active) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-6 w-6 transition-transform duration-200 hover:rotate-45',
            !canEdit && 'opacity-50',
          )}
          aria-label={`Settings for ${active.name}`}
          title={canEdit ? 'Workspace settings' : 'Settings (view-only — admin required to save)'}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderKanban className="h-4 w-4 text-primary" /> Workspace settings
          </DialogTitle>
          <DialogDescription>
            Metadata for this workspace — documents, vector index and chats are unaffected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ws-set-name">Name</Label>
            <Input
              id="ws-set-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit || busy}
              maxLength={80}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-set-desc">Description</Label>
            <Textarea
              id="ws-set-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this workspace for?"
              className="min-h-16"
              disabled={!canEdit || busy}
              maxLength={300}
            />
            <p className="text-right text-[10px] text-muted-foreground">{description.length}/300</p>
          </div>

          {/* Read-only facts */}
          <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3 text-xs sm:grid-cols-3">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <FileText className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="font-medium text-foreground">{active.documentCount}</span> docs
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="font-medium text-foreground">{active.chatCount}</span> chats
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="font-medium text-foreground">{active.memberCount}</span> members
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Database className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="font-medium text-foreground">{(active.storageBytes / 1024).toFixed(0)} KB</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Hash className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="truncate font-mono text-[10px]" title={active.slug}>{active.slug}</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              {new Date(active.createdAt).toLocaleDateString()}
            </div>
          </div>

          {!canEdit && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              You are a {active.role} of this workspace — only admins can save changes.
            </p>
          )}
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}

          {/* Danger zone */}
          {canEdit && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/[0.04] p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-destructive">Danger zone</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    Permanently delete this workspace, its {active.documentCount} document(s), vector
                    index and {active.chatCount} conversation(s). Uploaded files are erased from
                    storage. This cannot be undone.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 shrink-0 gap-1 text-[11px]"
                  disabled={deleting}
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={() => void save()}
            disabled={!canEdit || busy || !dirty || !name.trim()}
            className="gap-1.5"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{active.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the workspace together with{' '}
              <span className="font-medium text-foreground">{active.documentCount} document(s)</span>,
              their vector chunks and{' '}
              <span className="font-medium text-foreground">{active.chatCount} conversation(s)</span>.
              Uploaded PDF files are erased from storage and this action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault(); // keep dialog open until the call settles
                void (async () => {
                  setDeleting(true);
                  try {
                    await deleteWorkspace(active.id);
                    useAppStore.getState().removeWorkspace(active.id);
                    toast.success(`Deleted workspace “${active.name}”`);
                    setDeleteConfirmOpen(false);
                    setOpen(false);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Failed to delete workspace');
                  } finally {
                    setDeleting(false);
                  }
                })();
              }}
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Delete ${active.name}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

export function InsightDocApp() {
  const booted = useAppStore((s) => s.booted);
  const setBooted = useAppStore((s) => s.setBooted);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const workspaces = useAppStore((s) => s.workspaces);
  const setWorkspaces = useAppStore((s) => s.setWorkspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const setDocuments = useAppStore((s) => s.setDocuments);
  const upsertDocument = useAppStore((s) => s.upsertDocument);
  const setChats = useAppStore((s) => s.setChats);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const documents = useAppStore((s) => s.documents);

  const [bootError, setBootError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Boot: load workspaces, activate first, theme ───────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        try {
          const stored = localStorage.getItem('insightdoc-theme');
          if (stored === 'light' || stored === 'dark') setTheme(stored);
          else setTheme('dark');
        } catch {
          setTheme('dark');
        }
        const ws = await fetchWorkspaces();
        if (cancelled) return;
        setWorkspaces(ws);
        if (ws.length > 0) setActiveWorkspace(ws[0].id);
        setBooted(true);
      } catch (error) {
        if (!cancelled) setBootError(error instanceof Error ? error.message : 'Boot failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load workspace-scoped data on switch ───────────────────────────────────
  const loadWorkspaceData = useCallback(async () => {
    if (!activeWorkspaceId) return;
    try {
      const [docs, chatList] = await Promise.all([
        fetchDocuments(activeWorkspaceId),
        fetchChats(activeWorkspaceId),
      ]);
      useAppStore.getState().setDocuments(docs);
      setChats(chatList);
    } catch (error) {
      // Active workspace vanished (deleted elsewhere / RBAC revoked) → self-heal.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        notifyWorkspaceInvalid();
        return;
      }
      console.error('Failed to load workspace data:', error);
    }
  }, [activeWorkspaceId, setChats]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData]);

  // ── Self-heal: re-validate active workspace when reported invalid ──────────
  const recoveringRef = useRef(false);
  useEffect(() => {
    return onWorkspaceInvalid(() => {
      if (recoveringRef.current) return; // one recovery at a time
      recoveringRef.current = true;
      void (async () => {
        try {
          const ws = await fetchWorkspaces();
          const snap = useAppStore.getState();
          const stillValid = ws.some((w) => w.id === snap.activeWorkspaceId);
          if (!stillValid) {
            snap.setWorkspaces(ws);
            if (ws.length > 0) {
              snap.setActiveWorkspace(ws[0].id);
              toast.info(`Workspace no longer available — switched to “${ws[0].name}”`);
            } else {
              snap.setActiveWorkspace(null);
              toast.warning('Your workspace was removed — create a new one to continue');
            }
          }
        } catch {
          /* recovery fetch failed — keep current state; next signal retries */
        } finally {
          recoveringRef.current = false;
        }
      })();
    });
  }, []);

  // ── Ingestion polling: poll while any doc is PENDING/PROCESSING ────────────
  const hasPending = documents.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING');

  useEffect(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (!booted || !activeWorkspaceId) return;

    const poll = async () => {
      try {
        const docs = await fetchDocuments(activeWorkspaceId);
        const current = useAppStore.getState().documents;
        // Completion/failure detection — fire toasts when background ingest settles
        docs.forEach((d) => {
          const prev = current.find((c) => c.id === d.id);
          if (!prev) return; // brand-new docs are toasted by the upload flow
          const wasBusy = prev.status === 'PENDING' || prev.status === 'PROCESSING';
          if (wasBusy && d.status === 'COMPLETED') {
            const detail = d.chunkCount > 0 ? `${d.chunkCount} chunk${d.chunkCount === 1 ? '' : 's'} indexed` : 'ready for questions';
            toast.success(`“${d.title || d.fileName}” finished processing`, {
              description: `${detail} — now searchable and answerable.`,
              action: {
                label: 'View',
                onClick: () => useAppStore.getState().setView('documents'),
              },
            });
          } else if (wasBusy && d.status === 'FAILED') {
            toast.error(`“${d.title || d.fileName}” failed to process`, {
              description: d.errorMessage || d.statusDetail || 'The ingestion pipeline could not index this file.',
              action: {
                label: 'Details',
                onClick: () => {
                  useAppStore.getState().setView('documents');
                  useAppStore.getState().setDetailDocumentId(d.id);
                },
              },
            });
          }
        });
        const statusChanged = docs.some((d) => {
          const prev = current.find((c) => c.id === d.id);
          return !prev || prev.status !== d.status || prev.progress !== d.progress;
        });
        if (statusChanged) {
          // Merge without clobbering optimistic removals
          docs.forEach(upsertDocument);
          const removedIds = current
            .filter((c) => !docs.some((d) => d.id === c.id))
            .map((c) => c.id);
          if (removedIds.length > 0) {
            removedIds.forEach((id) => useAppStore.getState().removeDocument(id));
          }
        }
      } catch (error) {
        /* transient polling errors are ignored unless the workspace itself is gone */
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          notifyWorkspaceInvalid();
        }
      }
    };

    if (hasPending) {
      pollTimer.current = setInterval(() => void poll(), 1500);
    }
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [booted, activeWorkspaceId, hasPending, upsertDocument]);

  if (!booted) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="relative"
        >
          <motion.div
            animate={{ opacity: [0.5, 1, 0.5], scale: [1, 1.06, 1] }}
            transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
            className="absolute -inset-3 rounded-2xl bg-primary/15 blur-lg"
            aria-hidden
          />
          <div className="relative flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-lg shadow-primary/25">
            iD
          </div>
        </motion.div>
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-semibold">Booting InsightDoc…</p>
          <p className="text-xs text-muted-foreground">Connecting to workspace and vector indexes</p>
          <div className="mt-1 h-1 w-44 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full w-1/3 rounded-full bg-primary"
              animate={{ x: ['-100%', '300%'] }}
              transition={{ repeat: Infinity, duration: 1.1, ease: 'easeInOut' }}
            />
          </div>
          {bootError && <p className="mt-2 text-xs text-destructive">{bootError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center gap-2.5 border-b px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
            iD
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">InsightDoc</p>
            <p className="text-[10px] text-muted-foreground">Enterprise RAG Platform</p>
          </div>
        </div>

        {/* Workspace selector */}
        <div className="border-b p-3">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Workspace
            </span>
            <div className="flex items-center gap-0.5">
              <WorkspaceSettingsDialog />
              <WorkspaceCreateDialog />
            </div>
          </div>
          <div className="space-y-1">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => setActiveWorkspace(w.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                  w.id === activeWorkspaceId ? 'bg-primary/10' : 'hover:bg-sidebar-accent',
                )}
                aria-pressed={w.id === activeWorkspaceId}
              >
                <FolderKanban
                  className={cn('h-4 w-4 shrink-0', w.id === activeWorkspaceId ? 'text-primary' : 'text-muted-foreground')}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{w.name}</span>
                <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px]">
                  {w.role}
                </Badge>
              </button>
            ))}
            {workspaces.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">No workspaces yet</p>
            )}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-3" aria-label="Primary">
          {NAV.map(({ view: v, label, icon: Icon }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                view === v
                  ? 'text-primary-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )}
              aria-current={view === v ? 'page' : undefined}
            >
              {view === v && (
                <motion.span
                  layoutId="nav-active-pill"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-primary shadow-sm shadow-primary/30"
                  aria-hidden
                />
              )}
              <Icon className="relative z-10 h-4 w-4" />
              <span className="relative z-10">{label}</span>
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="space-y-2 border-t p-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border bg-card/50 px-2.5 py-2 text-left text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            >
              <Command className="h-3.5 w-3.5 shrink-0" />
              Commands
              <kbd className="ml-auto rounded border bg-muted px-1 py-0.5 font-mono text-[9px]">⌘K</kbd>
            </button>
            <button
              onClick={() => useAppStore.getState().setShortcutsOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border bg-card/50 px-2.5 py-2 text-left text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            >
              <Keyboard className="h-3.5 w-3.5 shrink-0" />
              Shortcuts
              <kbd className="ml-auto rounded border bg-muted px-1 py-0.5 font-mono text-[9px]">?</kbd>
            </button>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-sidebar-accent/60 px-3 py-2">
            <div>
              <p className="text-[11px] font-medium">Theme</p>
              <p className="text-[10px] text-muted-foreground">{theme === 'dark' ? 'Slate dark' : 'Off-white'}</p>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={useAppStore.getState().toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
            Hybrid retrieval · SSE streaming · page-level citations
          </p>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center gap-2 border-b bg-background/90 px-3 py-2 backdrop-blur md:hidden">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          iD
        </div>
        <span className="text-sm font-semibold">InsightDoc</span>
        <div className="ml-auto flex gap-1">
          {NAV.map(({ view: v, label, icon: Icon }) => (
            <Button
              key={v}
              variant={view === v ? 'default' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView(v)}
              aria-label={label}
            >
              <Icon className="h-4 w-4" />
            </Button>
          ))}
        </div>
      </div>

      {/* Main */}
      <main className="min-w-0 flex-1 pt-[52px] md:pt-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="h-full"
          >
            {view === 'dashboard' && <DashboardView />}
            {view === 'documents' && <DocumentsView />}
            {view === 'chat' && <ChatView />}
            {view === 'search' && <SearchView />}
            {view === 'analytics' && <AnalyticsView />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Global overlays */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <DocumentDetailDialog />
      <DigestCompareDialog />
      <ShortcutsDialog />
      <GlobalUploadManager />
    </div>
  );
}
