/**
 * InsightDoc — Typed API client (frontend)
 * Every response is parsed through the shared Zod contracts before touching UI state.
 */
import { z } from 'zod';
import {
  AnalyticsDTOSchema,
  ChatMessageDTOSchema,
  ChatSessionDTOSchema,
  DocumentDTOSchema,
  WorkspaceDTOSchema,
  CitationSchema,
  RetrievalInfoSchema,
  TranscribeResponseSchema,
  FollowupsResponseSchema,
  FeedbackReviewItemSchema,
  ShareDigestResponseSchema,
  TagOperationResponseSchema,
  type AnalyticsDTO,
  type ChatMessageDTO,
  type ChatSessionDTO,
  type Citation,
  type DocumentDTO,
  type FeedbackReviewItem,
  type RetrievalInfo,
  type ShareDigestResponse,
  type TagOperation,
  type WorkspaceDTO,
  SearchResponseSchema,
  DocumentSummaryResponseSchema,
  type DocumentChunksResponse,
  type DocumentSummaryResponse,
  type SearchResponse,
} from '@/lib/types';

/** Typed fetch failure carrying the HTTP status (used for self-healing flows). */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

export async function fetchWorkspaces(): Promise<WorkspaceDTO[]> {
  const data = await request<{ workspaces: unknown[] }>('/api/v1/workspaces');
  return data.workspaces.map((w) => WorkspaceDTOSchema.parse(w));
}

export async function createWorkspace(input: { name: string; description?: string }): Promise<WorkspaceDTO> {
  const data = await request<{ workspace: unknown }>('/api/v1/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return WorkspaceDTOSchema.parse(data.workspace);
}

/** PATCH /api/v1/workspaces/:id — rename / re-describe (ADMIN only). */
export async function updateWorkspace(
  workspaceId: string,
  input: { name?: string; description?: string | null },
): Promise<WorkspaceDTO> {
  const data = await request<{ workspace: unknown }>(`/api/v1/workspaces/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return WorkspaceDTOSchema.parse(data.workspace);
}

// ─── Documents ───────────────────────────────────────────────────────────────

export async function fetchDocuments(workspaceId: string): Promise<DocumentDTO[]> {
  const data = await request<{ documents: unknown[] }>(
    `/api/v1/documents?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return data.documents.map((d) => DocumentDTOSchema.parse(d));
}

export async function deleteDocument(documentId: string): Promise<void> {
  await request(`/api/v1/documents/${documentId}`, { method: 'DELETE' });
}

export async function reprocessDocument(documentId: string): Promise<void> {
  await request(`/api/v1/documents/${documentId}/process`, { method: 'POST' });
}

export async function updateDocument(
  documentId: string,
  patch: { title?: string; starred?: boolean; tags?: string[] },
): Promise<DocumentDTO> {
  const data = await request<{ document: unknown }>(`/api/v1/documents/${documentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return DocumentDTOSchema.parse(data.document);
}

/** Destructive: removes the workspace + documents + chats (ADMIN only). */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await request(`/api/v1/workspaces/${workspaceId}`, { method: 'DELETE' });
}

/** Back-compat wrapper — rename only. */
export async function renameDocument(documentId: string, title: string): Promise<DocumentDTO> {
  return updateDocument(documentId, { title });
}

/** Replace the document's analyst tags (server dedupes + lowercases). */
export async function setDocumentTags(documentId: string, tags: string[]): Promise<DocumentDTO> {
  return updateDocument(documentId, { tags });
}

/** XHR-based multipart upload so we get real upload progress. */
export function uploadDocuments(
  workspaceId: string,
  files: File[],
  onProgress: (percent: number) => void,
): Promise<{ documents: DocumentDTO[]; errors: Array<{ fileName: string; error: string }> }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/workspaces/${workspaceId}/documents/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as {
          documents?: unknown[];
          errors?: Array<{ fileName: string; error: string }>;
          error?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300 && body.documents) {
          const documents = body.documents.map((d) => DocumentDTOSchema.parse(d));
          resolve({ documents, errors: body.errors ?? [] });
        } else {
          reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
        }
      } catch {
        reject(new Error('Malformed upload response'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(form);
  });
}

// ─── Chats ───────────────────────────────────────────────────────────────────

export async function fetchChats(workspaceId: string): Promise<ChatSessionDTO[]> {
  const data = await request<{ chats: unknown[] }>(
    `/api/v1/chats?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return data.chats.map((c) => ChatSessionDTOSchema.parse(c));
}

export async function createChat(workspaceId: string): Promise<ChatSessionDTO> {
  const data = await request<{ chat: unknown }>('/api/v1/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  return ChatSessionDTOSchema.parse(data.chat);
}

export async function fetchChatMessages(sessionId: string): Promise<ChatMessageDTO[]> {
  const data = await request<{ messages: unknown[] }>(`/api/v1/chats/${sessionId}`);
  return data.messages.map((m) => ChatMessageDTOSchema.parse(m));
}

export async function deleteChat(sessionId: string): Promise<void> {
  await request(`/api/v1/chats/${sessionId}`, { method: 'DELETE' });
}

export async function renameChat(sessionId: string, title: string): Promise<ChatSessionDTO> {
  return updateChat(sessionId, { title });
}

/** PATCH /api/v1/chats/:id — rename and/or pin (optimistic callers wrap this). */
export async function updateChat(
  sessionId: string,
  input: { title?: string; pinned?: boolean },
): Promise<ChatSessionDTO> {
  const data = await request<{ chat: unknown }>(`/api/v1/chats/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return ChatSessionDTOSchema.parse(data.chat);
}

/**
 * Removes a message and everything after it so the turn can be regenerated.
 * `keepAnchor=false` also drops the anchor itself (used for user questions —
 * the question is re-streamed from the client).
 */
export async function truncateMessagesFrom(
  sessionId: string,
  fromMessageId: string,
  keepAnchor: boolean,
): Promise<void> {
  await request(
    `/api/v1/chats/${sessionId}/messages?fromMessageId=${encodeURIComponent(fromMessageId)}&keepAnchor=${keepAnchor}`,
    { method: 'DELETE' },
  );
}

export function exportChatUrl(sessionId: string, format: 'md' | 'json'): string {
  return `/api/v1/chats/${sessionId}/export?format=${format}`;
}

/** Set or clear the 👍/👎 signal on an assistant answer. `null` clears it. */
export async function setMessageFeedback(
  sessionId: string,
  messageId: string,
  feedback: 'UP' | 'DOWN' | null,
): Promise<void> {
  await request(`/api/v1/chats/${sessionId}/messages`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, feedback }),
  });
}

// ─── Semantic Search ─────────────────────────────────────────────────────────

export async function searchDocuments(input: {
  workspaceId: string;
  query: string;
  documentIds?: string[];
  topK?: number;
}): Promise<SearchResponse> {
  const res = await fetch('/api/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Search failed (${res.status})`, res.status);
  }
  const json: unknown = await res.json();
  return SearchResponseSchema.parse(json);
}

export async function fetchDocumentChunks(
  documentId: string,
  page = 1,
  pageSize = 20,
): Promise<DocumentChunksResponse> {
  const res = await fetch(
    `/api/v1/documents/${documentId}/chunks?page=${page}&pageSize=${pageSize}`,
  );
  if (!res.ok) throw new Error('Failed to load chunks');
  return (await res.json()) as DocumentChunksResponse;
}

// ─── Document AI digest ──────────────────────────────────────────────────────

/** GET cached digest — null when none exists yet. */
export async function fetchDocumentSummary(documentId: string): Promise<DocumentSummaryResponse | null> {
  const res = await fetch(`/api/v1/documents/${documentId}/summary`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Failed to load digest (${res.status})`, res.status);
  }
  return DocumentSummaryResponseSchema.parse(await res.json());
}

/** Generate (or force-regenerate) the grounded AI digest. */
export async function generateDocumentSummary(documentId: string, force = false): Promise<DocumentSummaryResponse> {
  const res = await fetch(
    `/api/v1/documents/${documentId}/summary${force ? '?force=1' : ''}`,
    { method: 'POST' },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Digest failed (${res.status})`, res.status);
  }
  return DocumentSummaryResponseSchema.parse(await res.json());
}

/**
 * Post the cached AI digest into a chat as a persisted note card.
 * Omit sessionId to drop it into a fresh "Digest — <doc>" conversation.
 */
export async function shareDigestToChat(documentId: string, sessionId?: string): Promise<ShareDigestResponse> {
  const data = await request<unknown>(`/api/v1/documents/${documentId}/summary/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });
  return ShareDigestResponseSchema.parse(data);
}

// ─── Workspace tag management ────────────────────────────────────────────────

/** Rename (merging duplicates) or delete a tag across the whole workspace. */
export async function manageWorkspaceTags(workspaceId: string, op: TagOperation): Promise<DocumentDTO[]> {
  const data = await request<unknown>(`/api/v1/workspaces/${workspaceId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(op),
  });
  return TagOperationResponseSchema.parse(data).updated;
}

export async function fetchAnalytics(): Promise<AnalyticsDTO> {
  const data = await request<{ analytics: unknown }>('/api/v1/analytics');
  return AnalyticsDTOSchema.parse(data.analytics);
}

// ─── Workspace activity feed (Dashboard) ─────────────────────────────────────

const ActivityEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorEmail: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  createdAt: z.string(),
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export async function fetchActivity(workspaceId: string, limit = 8): Promise<ActivityEvent[]> {
  const data = await request<{ events: unknown[] }>(
    `/api/v1/activity?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`,
  );
  return z.array(ActivityEventSchema).parse(data.events);
}

// ─── Voice (ASR / TTS) ───────────────────────────────────────────────────────

/** Transcribe a recorded question via the backend ASR service. */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('wav') ? 'wav' : 'webm';
  form.append('audio', blob, `voice-question.${ext}`);
  const res = await fetch('/api/v1/audio/transcribe', { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Transcription failed (${res.status})`);
  }
  const json: unknown = await res.json();
  return TranscribeResponseSchema.parse(json).text;
}

/** Synthesize one continuous WAV narration for an answer (server merges chunks). */
export async function speakText(text: string, speed = 1.0, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch('/api/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speed }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Speech synthesis failed (${res.status})`);
  }
  return await res.blob();
}

// ─── Follow-up suggestions ───────────────────────────────────────────────────

export async function fetchFollowups(sessionId: string): Promise<string[]> {
  const data = await request<{ suggestions: unknown }>(`/api/v1/chats/${sessionId}/followups`, {
    method: 'POST',
  });
  return FollowupsResponseSchema.parse(data).suggestions;
}

// ─── Feedback review queue (Analytics) ───────────────────────────────────────

export async function fetchFeedbackReview(
  rating: 'UP' | 'DOWN' = 'DOWN',
  limit = 6,
): Promise<FeedbackReviewItem[]> {
  const data = await request<{ items: unknown[] }>(
    `/api/v1/feedback-review?rating=${rating}&limit=${limit}`,
  );
  return z.array(FeedbackReviewItemSchema).parse(data.items);
}

// ─── SSE streaming (spec §5.2) ───────────────────────────────────────────────

export interface StreamHandlers {
  onCitations: (citations: Citation[]) => void;
  onRetrieval: (info: RetrievalInfo) => void;
  onToken: (delta: string) => void;
  onDone: (info: { messageId: string; totalTokens: number; latencyMs: number }) => void;
  onError: (message: string, recoverable: boolean) => void;
}

/**
 * POST /api/v1/chats/:id/stream via fetch + ReadableStream (EventSource can't POST).
 * Frames are parsed incrementally; the caller owns all state transitions.
 */
export async function streamChat(
  sessionId: string,
  body: { message: string; documentIds: string[]; temperature: number },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/v1/chats/${sessionId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
    handlers.onError(errBody?.error ?? `Stream failed (${res.status})`, false);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (raw: string) => {
    // raw is a full SSE frame: "event: X\ndata: {...}"
    const eventMatch = /event: (.+)/.exec(raw);
    const dataMatch = /data: ([\s\S]+)/.exec(raw);
    if (!eventMatch || !dataMatch) return;
    const event = eventMatch[1].trim();
    let payload: unknown;
    try {
      payload = JSON.parse(dataMatch[1]);
    } catch {
      return;
    }
    switch (event) {
      case 'citations': {
        const parsed = CitationSchema.array().safeParse(payload);
        if (parsed.success) handlers.onCitations(parsed.data);
        break;
      }
      case 'retrieval': {
        const parsed = RetrievalInfoSchema.safeParse(payload);
        if (parsed.success) handlers.onRetrieval(parsed.data);
        break;
      }
      case 'token': {
        const d = payload as { delta?: string };
        if (typeof d.delta === 'string') handlers.onToken(d.delta);
        break;
      }
      case 'done': {
        const d = payload as { messageId?: string; totalTokens?: number; latencyMs?: number };
        handlers.onDone({
          messageId: d.messageId ?? '',
          totalTokens: d.totalTokens ?? 0,
          latencyMs: d.latencyMs ?? 0,
        });
        break;
      }
      case 'error': {
        const d = payload as { message?: string; recoverable?: boolean };
        handlers.onError(d.message ?? 'Unknown stream error', Boolean(d.recoverable));
        break;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const trimmed = frame.trim();
        if (trimmed) dispatch(trimmed);
      }
    }
    if (buffer.trim()) dispatch(buffer.trim());
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    handlers.onError(`Stream interrupted: ${(error as Error).message}`, true);
  }
}
