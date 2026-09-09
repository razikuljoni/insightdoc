'use client';

/**
 * InsightDoc — Core Workspace Split-Screen View (spec §6.2)
 * Left rail: chat sessions · Center (45%): RAG chat stream · Right (55%): PDF viewer
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { FileText, Loader2, MessageSquare, MessageSquarePlus, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ChatSessionDTO } from '@/lib/types';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAppStore } from './store';
import { ChatPanel } from './chat-panel';
import { createChat, deleteChat, renameChat } from './api-client';

const PdfViewerPanel = dynamic(() => import('./pdf-viewer-panel'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-muted/40">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  ),
});

function EmptyViewer() {
  return (
    <div className="bg-grid flex h-full flex-col items-center justify-center gap-3 bg-muted/30 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
        <FileText className="h-7 w-7 text-primary" />
      </div>
      <h3 className="text-base font-semibold">No document open</h3>
      <p className="max-w-xs text-sm text-muted-foreground">
        Click a citation pill in the conversation — the viewer will jump to the exact page and
        highlight the quoted passage.
      </p>
    </div>
  );
}

export function ChatView() {
  const chats = useAppStore((s) => s.chats);
  const activeChatId = useAppStore((s) => s.activeChatId);
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const upsertChat = useAppStore((s) => s.upsertChat);
  const removeChat = useAppStore((s) => s.removeChat);
  const toggleChatPin = useAppStore((s) => s.toggleChatPin);
  const documents = useAppStore((s) => s.documents);
  const pdfTarget = useAppStore((s) => s.pdfTarget);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const composerPrefill = useAppStore((s) => s.composerPrefill);
  const isMobile = useIsMobile();

  const [sessionFilter, setSessionFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mobilePane, setMobilePane] = useState<'chats' | 'chat' | 'doc'>('chat');

  // Pinned-first ordering: pinned sessions (newest pin first), then the rest
  // by recency. The search filter applies inside both groups.
  const { pinnedChats, recentChats } = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase();
    const matching = chats.filter((c) => c.title.toLowerCase().includes(q));
    const byRecency = (a: (typeof matching)[number], b: (typeof matching)[number]) =>
      b.updatedAt.localeCompare(a.updatedAt);
    const pinned = matching
      .filter((c) => c.pinnedAt !== null)
      .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''));
    const recent = matching.filter((c) => c.pinnedAt === null).sort(byRecency);
    return { pinnedChats: pinned, recentChats: recent };
  }, [chats, sessionFilter]);

  const viewerDoc = useMemo(() => {
    if (!pdfTarget) return null;
    return documents.find((d) => d.id === pdfTarget.documentId) ?? null;
  }, [pdfTarget, documents]);

  // On mobile, opening a citation flips to the document pane automatically.
  useEffect(() => {
    if (isMobile && pdfTarget) setMobilePane('doc');
  }, [isMobile, pdfTarget]);

  // Cross-view prefills (digest "Ask →", viewer "Ask about this page") arrive
  // with no active chat. ChatPanel — the composer consumer — is only mounted
  // once a chat exists, so the ChatView level transparently creates one first.
  const prefillNonceRef = useRef(-1);
  useEffect(() => {
    if (!composerPrefill || !activeWorkspaceId || activeChatId) return;
    if (prefillNonceRef.current === composerPrefill.nonce) return;
    prefillNonceRef.current = composerPrefill.nonce;
    let cancelled = false;
    void (async () => {
      try {
        const chat = await createChat(activeWorkspaceId);
        if (cancelled) return;
        upsertChat(chat);
        setActiveChat(chat.id);
        if (isMobile) setMobilePane('chat');
      } catch (error) {
        console.error('Prefill: could not create chat', error);
        toast.error('Could not start a conversation for the prefilled question');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composerPrefill, activeChatId, activeWorkspaceId, upsertChat, setActiveChat, isMobile]);

  const handleNewChat = async () => {
    if (!activeWorkspaceId || creating) return;
    setCreating(true);
    try {
      const chat = await createChat(activeWorkspaceId);
      upsertChat(chat);
      setActiveChat(chat.id);
      if (isMobile) setMobilePane('chat');
    } catch (error) {
      console.error(error);
    } finally {
      setCreating(false);
    }
  };

  const handleTogglePin = async (id: string) => {
    try {
      const pinned = await toggleChatPin(id);
      toast.success(pinned ? 'Chat pinned to top' : 'Chat unpinned');
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Could not update pin');
    }
  };

  const handleDeleteChat = async (id: string) => {
    try {
      await deleteChat(id);
      removeChat(id);
    } catch (error) {
      console.error(error);
      toast.error('Could not delete chat');
    }
  };

  const startRenameChat = (id: string, current: string) => {
    setRenameValue(current);
    setRenamingId(id);
  };

  const commitRenameChat = async (id: string) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    const existing = chats.find((c) => c.id === id);
    if (!existing || existing.title === title) return;
    try {
      const updated = await renameChat(id, title);
      upsertChat(updated);
      toast.success('Chat renamed');
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Rename failed');
    }
  };

  const openChatMobile = (id: string) => {
    setActiveChat(id);
    if (isMobile) setMobilePane('chat');
  };

  /** One session row in the rail; `pinned` controls the amber accent + icon. */
  const renderChatRow = (c: ChatSessionDTO, pinned: boolean) => (
    <div
      key={c.id}
      className={cn(
        'group chat-row flex items-center gap-1 rounded-lg px-2 py-1.5 transition',
        c.id === activeChatId ? 'bg-primary/10 text-foreground' : 'hover:bg-accent',
        pinned && 'chat-row-pinned border-l-2 border-amber-400/80',
      )}
    >
      {renamingId === c.id ? (
        <Input
          value={renameValue}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => void commitRenameChat(c.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRenameChat(c.id);
            if (e.key === 'Escape') setRenamingId(null);
          }}
          className="h-6 text-xs"
          maxLength={120}
          aria-label="Edit chat title"
        />
      ) : (
        <>
          <button
            onClick={() => (isMobile ? openChatMobile(c.id) : setActiveChat(c.id))}
            onDoubleClick={() => startRenameChat(c.id, c.title)}
            className="min-w-0 flex-1 text-left"
            aria-label={`Open chat ${c.title}`}
          >
            <span className="flex items-center gap-1">
              {pinned && <Pin className="h-2.5 w-2.5 shrink-0 fill-amber-500 text-amber-500" aria-label="Pinned" />}
              <span className="block truncate text-xs font-medium">{c.title}</span>
            </span>
            <span className="whitespace-nowrap text-[10px] text-muted-foreground">
              {c.messageCount} messages
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-6 w-6 text-amber-600 hover:text-amber-500 dark:text-amber-400',
              pinned ? 'opacity-80' : 'opacity-0 transition group-hover:opacity-60 hover:!opacity-100',
            )}
            onClick={() => void handleTogglePin(c.id)}
            aria-label={pinned ? `Unpin chat ${c.title}` : `Pin chat ${c.title}`}
            aria-pressed={pinned}
            title={pinned ? 'Unpin' : 'Pin to top'}
          >
            {pinned ? <Pin className="h-3 w-3 fill-current insightdoc-pop" /> : <PinOff className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 transition group-hover:opacity-100"
            onClick={() => startRenameChat(c.id, c.title)}
            aria-label={`Rename chat ${c.title}`}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-6 w-6 text-destructive/80 hover:text-destructive',
          renamingId === c.id ? 'opacity-100' : 'opacity-0 transition group-hover:opacity-100',
        )}
        onClick={() => void handleDeleteChat(c.id)}
        aria-label={`Delete chat ${c.title}`}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );

  // ── Session rail content (shared by desktop panel & mobile pane) ──────────
  const sessionRail = (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-3">
        <Button onClick={() => void handleNewChat()} disabled={creating} className="w-full gap-1.5" size="sm">
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
          New chat
        </Button>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
            placeholder="Search chats"
            className="h-8 pl-8 text-xs"
            aria-label="Search chat sessions"
          />
        </div>
      </div>
      <ScrollArea className="insightdoc-scroll min-h-0 flex-1 p-2">
        {pinnedChats.length === 0 && recentChats.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No conversations yet</p>
        ) : (
          <div className="space-y-1">
            {pinnedChats.length > 0 && (
              <p className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                <Pin className="h-3 w-3 fill-current" /> Pinned
              </p>
            )}
            {pinnedChats.map((c) => renderChatRow(c, true))}
            {pinnedChats.length > 0 && recentChats.length > 0 && (
              <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent
              </p>
            )}
            {recentChats.map((c) => renderChatRow(c, false))}
          </div>
        )}
      </ScrollArea>
    </div>
  );

  const chatPane = activeChatId ? (
    <ChatPanel />
  ) : (
    <div className="bg-grid flex h-full flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
        <Plus className="h-7 w-7 text-primary" />
      </div>
      <h3 className="text-base font-semibold">Start a conversation</h3>
      <p className="max-w-xs text-sm text-muted-foreground">
        Create a chat to query your document library with grounded, citation-backed answers.
      </p>
      <Button onClick={() => void handleNewChat()} disabled={creating} size="sm" className="gap-1.5">
        {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
        New chat
      </Button>
    </div>
  );

  const docPane =
    viewerDoc && (activeChatId || pdfTarget) ? (
      <PdfViewerPanel key={viewerDoc.id} documentId={viewerDoc.id} title={viewerDoc.title} />
    ) : (
      <EmptyViewer />
    );

  // ── Mobile: segmented single-pane layout ────────────────────────────────────
  if (isMobile) {
    const PANES = [
      { id: 'chats' as const, label: 'Chats', icon: MessageSquare },
      { id: 'chat' as const, label: 'Conversation', icon: MessageSquarePlus },
      { id: 'doc' as const, label: 'Document', icon: FileText },
    ];
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b bg-card/40 p-1.5" role="tablist" aria-label="Workspace panes">
          {PANES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={mobilePane === id}
              onClick={() => setMobilePane(id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition',
                mobilePane === id
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {mobilePane === 'chats' && <div className="h-full bg-card/30">{sessionRail}</div>}
          {mobilePane === 'chat' && chatPane}
          {mobilePane === 'doc' && docPane}
        </div>
      </div>
    );
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      {/* Session rail */}
      <ResizablePanel defaultSize={17} minSize={12} maxSize={28} className="border-r bg-card/30">
        {sessionRail}
      </ResizablePanel>

      {/* Chat column */}
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={38} minSize={25}>
        {chatPane}
      </ResizablePanel>

      {/* PDF column */}
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={45} minSize={25}>
        {docPane}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
