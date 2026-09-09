/**
 * InsightDoc — Client app store (Zustand)
 * Holds view routing, active workspace/chat, live streaming state and the
 * PDF viewer "deep-link target" used by citation pills (spec §2.3/§6.2).
 */
import { create } from 'zustand';
import type { Citation, ChatMessageDTO, ChatSessionDTO, DocumentDTO, RetrievalInfo, WorkspaceDTO } from '@/lib/types';
import { updateChat, updateDocument } from './api-client';

export type AppView = 'dashboard' | 'documents' | 'chat' | 'search' | 'analytics';

export interface StreamingState {
  active: boolean;
  content: string;
  citations: Citation[];
  retrieval: RetrievalInfo | null;
  error: string | null;
  recoverable: boolean;
  messageId: string | null;
  totalTokens: number | null;
  latencyMs: number | null;
}

export interface PdfTarget {
  /** Bump to re-trigger jump even for identical page. */
  nonce: number;
  documentId: string;
  pageNumber: number;
  citation: Citation | null;
}

interface InsightDocState {
  booted: boolean;
  view: AppView;
  workspaces: WorkspaceDTO[];
  activeWorkspaceId: string | null;
  documents: DocumentDTO[];
  chats: ChatSessionDTO[];
  activeChatId: string | null;
  messages: ChatMessageDTO[];
  messagesLoading: boolean;
  streaming: StreamingState;
  /** Documents explicitly scoped for RAG queries (empty = all completed). */
  selectedDocIds: string[];
  pdfTarget: PdfTarget | null;
  theme: 'dark' | 'light';
  /** Document id whose detail dialog is open (chunk inspector). */
  detailDocumentId: string | null;
  /** Two document ids for the side-by-side digest compare dialog (null = closed). */
  compareDocIds: [string, string] | null;
  /** Pre-filled search query handed to the Search view (e.g. from palette). */
  pendingSearchQuery: string | null;
  /** Keyboard shortcuts help dialog visibility. */
  shortcutsOpen: boolean;
  /** Composer prefill from other views (e.g. "Ask about this page" in the viewer).
   *  nonce lets consumers react to repeated identical prefills. */
  composerPrefill: { text: string; nonce: number } | null;

  setBooted: (v: boolean) => void;
  setView: (v: AppView) => void;
  setTheme: (t: 'dark' | 'light') => void;
  toggleTheme: () => void;
  setWorkspaces: (ws: WorkspaceDTO[]) => void;
  addWorkspace: (w: WorkspaceDTO) => void;
  /** Drop a deleted workspace; active selection falls back to the first survivor. */
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  setDocuments: (docs: DocumentDTO[]) => void;
  upsertDocument: (doc: DocumentDTO) => void;
  /** Optimistic star/unstar with rollback on API failure. */
  toggleDocumentStar: (id: string) => Promise<boolean>;
  removeDocument: (id: string) => void;
  setChats: (chats: ChatSessionDTO[]) => void;
  upsertChat: (chat: ChatSessionDTO) => void;
  /** Optimistic pin/unpin; resolves to the resulting pinned state. */
  toggleChatPin: (id: string) => Promise<boolean>;
  removeChat: (id: string) => void;
  setActiveChat: (id: string | null) => void;
  setMessages: (messages: ChatMessageDTO[]) => void;
  setMessagesLoading: (v: boolean) => void;
  appendMessage: (m: ChatMessageDTO) => void;
  /** Optimistically update the 👍/👎 signal of one message. */
  setMessageFeedback: (messageId: string, feedback: 'UP' | 'DOWN' | null) => void;
  startStreaming: () => void;
  streamToken: (delta: string) => void;
  streamCitations: (citations: Citation[]) => void;
  streamRetrieval: (info: RetrievalInfo) => void;
  streamError: (message: string, recoverable: boolean) => void;
  finishStreaming: (info: { messageId: string; totalTokens: number; latencyMs: number }) => void;
  resetStreaming: () => void;
  toggleDocSelection: (docId: string) => void;
  setSelectedDocIds: (ids: string[]) => void;
  jumpToCitation: (documentId: string, pageNumber: number, citation: Citation | null) => void;
  openDocument: (documentId: string, page?: number) => void;
  setDetailDocumentId: (id: string | null) => void;
  setCompareDocIds: (ids: [string, string] | null) => void;
  setPendingSearchQuery: (q: string | null) => void;
  setShortcutsOpen: (v: boolean) => void;
  /** Hand a draft question to the chat composer and switch to the chat view. */
  prefillComposer: (text: string, opts?: { switchToChat?: boolean }) => void;
  clearComposerPrefill: () => void;
}

const emptyStreaming: StreamingState = {
  active: false,
  content: '',
  citations: [],
  retrieval: null,
  error: null,
  recoverable: false,
  messageId: null,
  totalTokens: null,
  latencyMs: null,
};

export const useAppStore = create<InsightDocState>((set, get) => ({
  booted: false,
  view: 'dashboard',
  workspaces: [],
  activeWorkspaceId: null,
  documents: [],
  chats: [],
  activeChatId: null,
  messages: [],
  messagesLoading: false,
  streaming: emptyStreaming,
  selectedDocIds: [],
  pdfTarget: null,
  theme: 'dark',
  detailDocumentId: null,
  compareDocIds: null,
  pendingSearchQuery: null,
  shortcutsOpen: false,
  composerPrefill: null,

  setBooted: (v) => set({ booted: v }),
  setView: (v) => set({ view: v }),
  setTheme: (t) => {
    set({ theme: t });
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', t === 'dark');
      try {
        localStorage.setItem('insightdoc-theme', t);
      } catch {
        /* storage unavailable */
      }
    }
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  setWorkspaces: (ws) => set({ workspaces: ws }),
  addWorkspace: (w) => set((s) => ({ workspaces: [...s.workspaces, w] })),
  removeWorkspace: (id) =>
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const isActiveDeleted = s.activeWorkspaceId === id;
      const nextActive = isActiveDeleted ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId;
      // Switching workspace context clears document/chat state; the shell
      // re-fetches for the new active id (same path as setActiveWorkspace).
      if (isActiveDeleted) {
        return {
          workspaces,
          activeWorkspaceId: nextActive,
          documents: [],
          chats: [],
          activeChatId: null,
          messages: [],
          selectedDocIds: [],
          pdfTarget: null,
        };
      }
      return { workspaces };
    }),
  setActiveWorkspace: (id) =>
    set({
      activeWorkspaceId: id,
      documents: [],
      chats: [],
      activeChatId: null,
      messages: [],
      selectedDocIds: [],
      pdfTarget: null,
    }),
  setDocuments: (docs) => set({ documents: docs }),
  upsertDocument: (doc) =>
    set((s) => {
      const idx = s.documents.findIndex((d) => d.id === doc.id);
      if (idx === -1) return { documents: [doc, ...s.documents] };
      const next = [...s.documents];
      next[idx] = doc;
      return { documents: next };
    }),
  removeDocument: (id) =>
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== id),
      selectedDocIds: s.selectedDocIds.filter((d) => d !== id),
    })),
  toggleDocumentStar: async (id) => {
    const current = get().documents.find((d) => d.id === id);
    if (!current) return false;
    const nextStarred = !current.starred;
    // Optimistic flip
    get().upsertDocument({ ...current, starred: nextStarred });
    try {
      const updated = await updateDocument(id, { starred: nextStarred });
      get().upsertDocument(updated);
      return updated.starred;
    } catch (error) {
      // Roll back on failure
      get().upsertDocument(current);
      throw error;
    }
  },
  setChats: (chats) => set({ chats }),
  upsertChat: (chat) =>
    set((s) => {
      const idx = s.chats.findIndex((c) => c.id === chat.id);
      if (idx === -1) return { chats: [chat, ...s.chats] };
      const next = [...s.chats];
      next[idx] = chat;
      return { chats: next };
    }),
  /** Optimistic pin/unpin with rollback on API failure. Returns the new state. */
  toggleChatPin: async (id) => {
    const current = get().chats.find((c) => c.id === id);
    if (!current) return false;
    const nextPinned = current.pinnedAt === null;
    const patched: ChatSessionDTO = {
      ...current,
      pinnedAt: nextPinned ? new Date().toISOString() : null,
    };
    get().upsertChat(patched);
    try {
      const updated = await updateChat(id, { pinned: nextPinned });
      get().upsertChat(updated);
      return updated.pinnedAt !== null;
    } catch (error) {
      get().upsertChat(current); // roll back
      throw error;
    }
  },
  removeChat: (id) =>
    set((s) => ({
      chats: s.chats.filter((c) => c.id !== id),
      activeChatId: s.activeChatId === id ? null : s.activeChatId,
    })),
  setActiveChat: (id) => set({ activeChatId: id, messages: [], pdfTarget: null }),
  setMessages: (messages) => set({ messages }),
  setMessagesLoading: (v) => set({ messagesLoading: v }),
  appendMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setMessageFeedback: (messageId, feedback) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === messageId ? { ...m, feedback } : m)),
    })),
  startStreaming: () => set({ streaming: { ...emptyStreaming, active: true } }),
  streamToken: (delta) =>
    set((s) => ({ streaming: { ...s.streaming, content: s.streaming.content + delta } })),
  streamCitations: (citations) => set((s) => ({ streaming: { ...s.streaming, citations } })),
  streamRetrieval: (retrieval) => set((s) => ({ streaming: { ...s.streaming, retrieval } })),
  streamError: (error, recoverable) =>
    set((s) => ({
      streaming: { ...s.streaming, active: false, error, recoverable },
    })),
  finishStreaming: ({ messageId, totalTokens, latencyMs }) =>
    set((s) => ({ streaming: { ...s.streaming, active: false, messageId, totalTokens, latencyMs } })),
  resetStreaming: () => set({ streaming: emptyStreaming }),
  toggleDocSelection: (docId) =>
    set((s) => ({
      selectedDocIds: s.selectedDocIds.includes(docId)
        ? s.selectedDocIds.filter((d) => d !== docId)
        : [...s.selectedDocIds, docId],
    })),
  setSelectedDocIds: (ids) => set({ selectedDocIds: ids }),
  jumpToCitation: (documentId, pageNumber, citation) =>
    set((s) => ({ pdfTarget: { nonce: (s.pdfTarget?.nonce ?? 0) + 1, documentId, pageNumber, citation } })),
  openDocument: (documentId, page = 1) =>
    set((s) => ({
      view: 'chat',
      pdfTarget: { nonce: (s.pdfTarget?.nonce ?? 0) + 1, documentId, pageNumber: page, citation: null },
    })),
  setDetailDocumentId: (id) => set({ detailDocumentId: id }),
  setCompareDocIds: (ids) => set({ compareDocIds: ids }),
  setPendingSearchQuery: (q) => set({ pendingSearchQuery: q }),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  prefillComposer: (text, opts) =>
    set((s) => ({
      composerPrefill: { text, nonce: (s.composerPrefill?.nonce ?? 0) + 1 },
      ...(opts?.switchToChat ? { view: 'chat' as AppView } : {}),
    })),
  clearComposerPrefill: () => set({ composerPrefill: null }),
}));

// ─── Workspace-invalid event bus ─────────────────────────────────────────────
/**
 * Self-heal signal: fired when any component discovers the active workspace is
 * gone or forbidden (403/404) — e.g. it was deleted by another tab, an admin,
 * or a cleanup script. The app shell listens once and re-validates the
 * workspace list, falling back to the first survivor. Without this, stale
 * clients poll a dead workspace forever (observed as endless 403s in dev.log).
 */
const wsInvalidListeners = new Set<() => void>();

export function onWorkspaceInvalid(listener: () => void): () => void {
  wsInvalidListeners.add(listener);
  return () => {
    wsInvalidListeners.delete(listener);
  };
}

export function notifyWorkspaceInvalid(): void {
  for (const listener of wsInvalidListeners) listener();
}
