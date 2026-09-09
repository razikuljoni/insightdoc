/**
 * InsightDoc — Shared Domain Contracts (Zod + TypeScript)
 *
 * Single source of truth for API payloads, SSE frames and DB row shapes.
 * Imported by both Next.js client components and server routes, enforcing
 * end-to-end type safety as required by spec §1.3.
 */
import { z } from 'zod';

// ─── Enums (String-backed for SQLite; Zod-validated) ─────────────────────────

export const ROLES = ['ADMIN', 'MEMBER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

export const DOCUMENT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);

export const USAGE_KINDS = ['embedding', 'chat', 'rerank'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

// ─── Citations ───────────────────────────────────────────────────────────────

export const CitationSchema = z.object({
  documentId: z.string(),
  documentTitle: z.string(),
  pageNumber: z.number().int().min(1),
  snippet: z.string(),
  score: z.number().min(0).max(1),
  chunkId: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const RetrievalInfoSchema = z.object({
  vectorHits: z.number().int(),
  keywordHits: z.number().int(),
  fusedCandidates: z.number().int(),
  rerankedTopK: z.number().int(),
  retrieveMs: z.number(),
  rerankMs: z.number(),
});
export type RetrievalInfo = z.infer<typeof RetrievalInfoSchema>;

// ─── Users / Workspaces ──────────────────────────────────────────────────────

export const WorkspaceDTOSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  documentCount: z.number().int(),
  chatCount: z.number().int(),
  memberCount: z.number().int(),
  storageBytes: z.number().int(),
  role: RoleSchema,
});
export type WorkspaceDTO = z.infer<typeof WorkspaceDTOSchema>;

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

/** PATCH /api/v1/workspaces/:workspaceId — metadata edit (ADMIN only) */
export const UpdateWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name too long (max 80)').optional(),
  description: z.string().trim().max(300, 'Description too long (max 300)').nullable().optional(),
});
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;

// ─── Documents ───────────────────────────────────────────────────────────────

export const DocumentDTOSchema = z.object({
  id: z.string(),
  title: z.string(),
  fileName: z.string(),
  fileSize: z.number().int(),
  pageCount: z.number().int(),
  status: DocumentStatusSchema,
  progress: z.number().int().min(0).max(100),
  /** Live worker phase copy shown under the ingestion bar (e.g. "OCR page 2/9…"). */
  statusDetail: z.string().nullable(),
  errorMessage: z.string().nullable(),
  chunkCount: z.number().int(),
  tokenCount: z.number().int(),
  starred: z.boolean(),
  /** >0 = text layer recovered via OCR on N pages (badge in library/inspector). */
  ocrPages: z.number().int().min(0),
  /** Analyst tags (lowercase, deduped). */
  tags: z.array(z.string()),
  workspaceId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentDTO = z.infer<typeof DocumentDTOSchema>;

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB per spec §2.2

/** PATCH /api/v1/documents/:documentId — metadata edit (rename and/or star).
 *  At least one field must be present; both are optional so a single route
 *  serves inline rename and the favorites toggle without differing shapes. */
export const UpdateDocumentSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(160, 'Title too long (max 160)').optional(),
    starred: z.boolean().optional(),
    tags: z
      .array(
        z
          .string()
          .trim()
          .min(1, 'Tags cannot be empty')
          .max(24, 'Tag too long (max 24)')
          .transform((t) => t.toLowerCase()),
      )
      .max(8, 'At most 8 tags per document')
      .optional(),
  })
  .refine((v) => v.title !== undefined || v.starred !== undefined || v.tags !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;
/** Back-compat alias for callers that only rename. */
export const RenameDocumentSchema = UpdateDocumentSchema;
export type RenameDocumentInput = UpdateDocumentInput;

/**
 * Workspace-wide tag maintenance (Document Library → Manage tags).
 * rename: rewrites the tag on every document that carries it (acts as merge
 * when the target tag already exists — duplicates collapse, cap 8 enforced).
 * delete: strips the tag from every document that carries it.
 */
export const RenameTagOperationSchema = z.object({
  action: z.literal('rename'),
  from: z.string().trim().min(1).max(24),
  to: z
    .string()
    .trim()
    .min(1, 'New tag name is required')
    .max(24, 'Tag too long (max 24)')
    .transform((t) => t.toLowerCase()),
});
export const DeleteTagOperationSchema = z.object({
  action: z.literal('delete'),
  from: z.string().trim().min(1).max(24),
});
export const TagOperationSchema = z.discriminatedUnion('action', [
  RenameTagOperationSchema,
  DeleteTagOperationSchema,
]);
export type TagOperation = z.infer<typeof TagOperationSchema>;

/** POST /api/v1/workspaces/:id/tags → { updated: DocumentDTO[] } */
export const TagOperationResponseSchema = z.object({ updated: z.array(DocumentDTOSchema) });

/** Parse the Document.tags JSON column into a validated string[]. */
export function parseDocumentTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)
      .slice(0, 8);
  } catch {
    return [];
  }
}

/** AI-generated document digest — payload cached on Document.summary (JSON). */
export const DocumentSummaryPayloadSchema = z.object({
  overview: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).max(10),
  entities: z.array(z.string().min(1)).max(12),
  suggestedQuestions: z.array(z.string().min(1)).max(4),
});
export type DocumentSummaryPayload = z.infer<typeof DocumentSummaryPayloadSchema>;

/** GET/POST /api/v1/documents/:documentId/summary → response envelope. */
export const DocumentSummaryResponseSchema = z.object({
  documentId: z.string(),
  summary: DocumentSummaryPayloadSchema,
  generatedAt: z.string(),
  model: z.string(),
  /** Retrieval basis: chunks + chars of source text fed to the model. */
  basis: z.object({ chunkCount: z.number().int(), charCount: z.number().int() }),
  cached: z.boolean(),
});
export type DocumentSummaryResponse = z.infer<typeof DocumentSummaryResponseSchema>;

/** Document failure taxonomies surfaced to the UI (see document-processor). */
export const DOCUMENT_ERROR_CODES = {
  SCANNED_PDF: '[SCANNED_PDF]',
  EXTRACTION_FAILED: '[EXTRACTION_FAILED]',
} as const;

/** Human-friendly rewrite of raw worker error messages for display. */
export function friendlyDocumentError(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  if (errorMessage.startsWith(DOCUMENT_ERROR_CODES.SCANNED_PDF)) {
    return (
      'No usable text could be recovered — this looks like a scanned or image-only PDF whose OCR '
      + 'produced too little text (blank, rotated or very low-quality scan). '
      + 'Re-scan at higher quality or upload a text-based PDF.'
    );
  }
  if (errorMessage.startsWith(DOCUMENT_ERROR_CODES.EXTRACTION_FAILED)) {
    return 'The PDF could not be parsed. It may be corrupted, password-protected, or not a valid PDF.';
  }
  return errorMessage;
}

// ─── Chat / SSE ──────────────────────────────────────────────────────────────

export const ChatSessionDTOSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceId: z.string(),
  /** ISO timestamp while pinned; null = not pinned. Pinned chats sort first. */
  pinnedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int(),
});
export type ChatSessionDTO = z.infer<typeof ChatSessionDTOSchema>;

/** PATCH /api/v1/chats/:sessionId — rename and/or pin. At least one field. */
export const UpdateChatSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(120, 'Title too long (max 120)').optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.pinned !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateChatInput = z.infer<typeof UpdateChatSchema>;
/** Back-compat alias — rename-only callers. */
export const RenameChatSchema = UpdateChatSchema;
export type RenameChatInput = UpdateChatInput;

export const MESSAGE_FEEDBACKS = ['UP', 'DOWN'] as const;
export type MessageFeedback = (typeof MESSAGE_FEEDBACKS)[number];
export const MessageFeedbackSchema = z.enum(MESSAGE_FEEDBACKS);

/** PATCH /api/v1/chats/:sessionId/messages — per-answer quality signal */
export const SetMessageFeedbackSchema = z.object({
  messageId: z.string().min(1),
  /** null clears the signal (toggle-off). */
  feedback: MessageFeedbackSchema.nullable(),
});
export type SetMessageFeedbackInput = z.infer<typeof SetMessageFeedbackSchema>;

export const ChatMessageDTOSchema = z.object({
  id: z.string(),
  /** 'note' = persisted app card (e.g. a shared AI digest) — excluded from LLM transcripts. */
  role: z.enum(['user', 'assistant', 'system', 'note']),
  content: z.string(),
  citations: z.array(CitationSchema).nullable(),
  tokenUsage: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  retrievalInfo: RetrievalInfoSchema.nullable(),
  feedback: MessageFeedbackSchema.nullable(),
  createdAt: z.string(),
});
export type ChatMessageDTO = z.infer<typeof ChatMessageDTOSchema>;

/** POST /api/v1/chats/:sessionId/stream — body (spec §5.2) */
export const StreamQuerySchema = z.object({
  message: z.string().min(1).max(8000),
  documentIds: z.array(z.string()).optional().default([]),
  temperature: z.number().min(0).max(2).optional().default(0.2),
});
export type StreamQueryInput = z.infer<typeof StreamQuerySchema>;

/**
 * DELETE /api/v1/chats/:sessionId/messages — truncate a turn so it can be
 * regenerated. Everything from `fromMessageId` (inclusive) onward is removed.
 */
export const TruncateMessagesSchema = z.object({
  fromMessageId: z.string().min(1),
});
export type TruncateMessagesInput = z.infer<typeof TruncateMessagesSchema>;

/** SSE frames emitted by the stream endpoint (spec §5.2) */
export type SSEFrame =
  | { event: 'citations'; data: Citation[] }
  | { event: 'retrieval'; data: RetrievalInfo }
  | { event: 'token'; data: { delta: string } }
  | { event: 'done'; data: { messageId: string; totalTokens: number; latencyMs: number } }
  | { event: 'error'; data: { message: string; recoverable: boolean } };

// ─── Semantic Search ─────────────────────────────────────────────────────────

export const SearchResponseSchema = z.object({
  results: z.array(CitationSchema),
  stats: RetrievalInfoSchema,
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export interface ChunkPreview {
  id: string;
  pageNumber: number;
  chunkIndex: number;
  heading: string | null;
  tokenCount: number | null;
  preview: string;
}

export interface DocumentChunksResponse {
  total: number;
  page: number;
  pageSize: number;
  chunks: ChunkPreview[];
}

// ─── Voice: ASR (speech→text) & TTS (text→speech) ────────────────────────────

/** POST /api/v1/audio/transcribe → { text } */
export const TranscribeResponseSchema = z.object({
  text: z.string(),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;

/** POST /api/v1/audio/speech — body. Answers are chunked server-side (TTS API caps at 1024 chars). */
export const SpeechRequestSchema = z.object({
  text: z.string().trim().min(1, 'Nothing to read aloud').max(6000, 'Text too long to narrate (max 6000 chars)'),
  speed: z.number().min(0.5).max(2.0).optional().default(1.0),
});
export type SpeechRequestInput = z.infer<typeof SpeechRequestSchema>;

/** POST /api/v1/chats/:sessionId/followups → { suggestions } */
export const FollowupsResponseSchema = z.object({
  suggestions: z.array(z.string().min(1)).max(3),
});
export type FollowupsResponse = z.infer<typeof FollowupsResponseSchema>;

// ─── Digest share-to-chat (persisted 'note' message) ────────────────────────

/** JSON payload stored in ChatMessage.content when role='note'. */
export const DigestNoteContentSchema = z.object({
  kind: z.literal('digest'),
  documentId: z.string(),
  documentTitle: z.string(),
  digest: DocumentSummaryPayloadSchema,
  model: z.string(),
  generatedAt: z.string(),
});
export type DigestNoteContent = z.infer<typeof DigestNoteContentSchema>;

/** POST /api/v1/documents/:documentId/summary/share — body. */
export const ShareDigestSchema = z.object({
  /** Existing session to post into; omit to auto-create "Digest — <title>". */
  sessionId: z.string().optional(),
});

/** POST /api/v1/documents/:documentId/summary/share → response envelope. */
export const ShareDigestResponseSchema = z.object({
  chat: ChatSessionDTOSchema,
  message: ChatMessageDTOSchema,
  createdChat: z.boolean(),
});
export type ShareDigestResponse = z.infer<typeof ShareDigestResponseSchema>;

// ─── Feedback review queue (Analytics) ───────────────────────────────────────

export const FeedbackReviewItemSchema = z.object({
  messageId: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  question: z.string(),
  content: z.string(),
  citationsCount: z.number().int(),
  createdAt: z.string(),
});
export type FeedbackReviewItem = z.infer<typeof FeedbackReviewItemSchema>;

/** GET /api/v1/feedback-review?rating=DOWN|UP&limit=8 */
export const FeedbackReviewQuerySchema = z.object({
  rating: MessageFeedbackSchema.default('DOWN'),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});

// ─── Analytics ───────────────────────────────────────────────────────────────

export const AnalyticsDTOSchema = z.object({
  totals: z.object({
    workspaces: z.number().int(),
    documents: z.number().int(),
    completedDocuments: z.number().int(),
    failedDocuments: z.number().int(),
    chunks: z.number().int(),
    chats: z.number().int(),
    messages: z.number().int(),
    storageBytes: z.number().int(),
  }),
  usage: z.object({
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    totalTokens: z.number().int(),
    estimatedCostUsd: z.number(),
    embeddingTokens: z.number().int(),
    chatTokens: z.number().int(),
    byDay: z.array(z.object({ date: z.string(), tokens: z.number().int(), costUsd: z.number() })),
  }),
  feedback: z.object({
    up: z.number().int(),
    down: z.number().int(),
  }),
  recentAudit: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      actorEmail: z.string(),
      targetType: z.string().nullable(),
      targetId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type AnalyticsDTO = z.infer<typeof AnalyticsDTOSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}
