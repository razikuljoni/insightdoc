'use client';

/**
 * InsightDoc — Chat Panel (spec §6.2 left column, 45%)
 * Streaming RAG feed with document scoping, citation pills, SSE-driven state,
 * per-message actions (copy / regenerate / export turn) and stop-generation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleQuestionMark,
  ClipboardCopy,
  Copy,
  Download,
  FileJson,
  FileText,
  Loader2,
  Mic,
  MoreVertical,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  User,
  Volume2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DigestNoteContentSchema, type ChatMessageDTO, type DigestNoteContent, type MessageFeedback } from '@/lib/types';
import { useAppStore } from './store';
import { MessageContent } from './message-renderer';
import { PromptLibrary } from './prompt-library';
import {
  createChat,
  exportChatUrl,
  fetchChatMessages,
  fetchFollowups,
  setMessageFeedback,
  speakText,
  streamChat,
  transcribeAudio,
  truncateMessagesFrom,
} from './api-client';

/** Trigger a browser download for a same-origin export URL. */
function downloadExport(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function CitationCard({ index, c }: { index: number; c: { documentTitle: string; pageNumber: number; snippet: string; score: number; documentId: string } }) {
  const jumpToCitation = useAppStore((s) => s.jumpToCitation);
  return (
    <button
      onClick={() => jumpToCitation(c.documentId, c.pageNumber, c)}
      className="group w-full rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-2.5 text-left transition duration-200 hover:-translate-y-px hover:border-cyan-500/50 hover:bg-cyan-500/10 hover:shadow-md hover:shadow-cyan-500/10"
      aria-label={`Jump to ${c.documentTitle} page ${c.pageNumber}`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <Badge variant="outline" className="h-4 border-cyan-500/40 px-1 font-mono text-[9px] text-cyan-600 dark:text-cyan-400">
          [{index + 1}]
        </Badge>
        <FileText className="h-3 w-3 shrink-0 text-cyan-600/70 dark:text-cyan-400/70" />
        <span className="truncate text-[11px] font-medium">{c.documentTitle}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          p.{c.pageNumber} · {c.score.toFixed(2)}
        </span>
      </div>
      <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground group-hover:text-foreground/80">
        {c.snippet}
      </p>
    </button>
  );
}

/** Clipboard write with a legacy fallback for restricted contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

// ─── Voice: recording (ASR) & narration (TTS) ───────────────────────────────

/** Single-flight narration player — exactly one voice playback app-wide. */
let activeNarration: { audio: HTMLAudioElement; url: string } | null = null;
function stopNarration() {
  if (activeNarration) {
    activeNarration.audio.pause();
    URL.revokeObjectURL(activeNarration.url);
    activeNarration = null;
  }
}

/** Playback speeds offered for voice narration (cycles on click). */
const NARRATION_SPEEDS = [0.75, 1, 1.25, 1.5] as const;
function nextNarrationSpeed(current: number): (typeof NARRATION_SPEEDS)[number] {
  const idx = NARRATION_SPEEDS.indexOf(current as (typeof NARRATION_SPEEDS)[number]);
  return NARRATION_SPEEDS[(idx + 1) % NARRATION_SPEEDS.length];
}

function formatSeconds(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Microphone capture for the composer: records via MediaRecorder, transcribes
 * through the backend ASR route and hands the text to the caller. Handles
 * permission denial, unsupported browsers and clean unmount teardown.
 */
function VoiceRecorder({ onTranscribed, disabled }: { onTranscribed: (text: string) => void; disabled: boolean }) {
  const [recording, setRecording] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // Unmount: cancel any in-flight capture so the mic indicator turns off
  useEffect(
    () => () => {
      cancelledRef.current = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      cleanup();
    },
    [cleanup],
  );

  const start = async () => {
    if (disabled || preparing || recording || transcribing) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('Voice input is not supported in this browser');
      return;
    }
    try {
      setPreparing(true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ['audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      cancelledRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        cleanup();
        if (cancelledRef.current || blob.size === 0) {
          setRecording(false);
          setSeconds(0);
          return;
        }
        setTranscribing(true);
        try {
          const text = await transcribeAudio(blob);
          if (!cancelledRef.current && text) onTranscribed(text);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Could not transcribe the recording');
        } finally {
          setTranscribing(false);
          setRecording(false);
          setSeconds(0);
        }
      };
      recorder.start(250);
      recorderRef.current = recorder;
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (error) {
      cleanup();
      const name = (error as Error).name;
      if (name === 'NotAllowedError') toast.error('Microphone permission denied — allow access in the browser bar');
      else if (name === 'NotFoundError') toast.error('No microphone found on this device');
      else toast.error('Could not start recording');
    } finally {
      setPreparing(false);
    }
  };

  const stop = (cancel: boolean) => {
    cancelledRef.current = cancel;
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop(); // onstop handles cleanup + transcription/cancel
    } else if (cancel) {
      cleanup();
      setRecording(false);
      setSeconds(0);
    }
  };

  if (transcribing) {
    return (
      <div
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border bg-card px-3"
        role="status"
        aria-label="Transcribing recording"
      >
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">Transcribing…</span>
      </div>
    );
  }

  if (recording) {
    return (
      <div className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/5 px-2">
        <span className="relative flex h-2.5 w-2.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </span>
        <span className="w-9 font-mono text-xs tabular-nums text-rose-600 dark:text-rose-400" aria-live="polite">
          {formatSeconds(seconds)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400"
          aria-label="Discard recording"
          onClick={() => stop(true)}
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-foreground hover:bg-accent"
          aria-label="Finish recording and transcribe"
          onClick={() => stop(false)}
        >
          <Check className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-xl text-muted-foreground hover:text-primary"
            aria-label="Record a voice question"
            disabled={disabled || preparing}
            onClick={() => void start()}
          >
            {preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">Voice question</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Persisted 👍/👎 quality signal on assistant answers. Clicking the active
 * value clears it (toggle). Optimistic store update, rolled back on failure.
 */
function FeedbackButtons({ message }: { message: ChatMessageDTO }) {
  const activeChatId = useAppStore((s) => s.activeChatId);
  const current = message.feedback;

  const apply = async (next: MessageFeedback) => {
    if (!activeChatId) return;
    const target = current === next ? null : next;
    useAppStore.getState().setMessageFeedback(message.id, target);
    try {
      await setMessageFeedback(activeChatId, message.id, target);
      if (target === 'DOWN') toast('Thanks — feedback recorded to improve retrieval', { icon: '👎' });
      else if (target === 'UP') toast.success('Thanks — feedback recorded');
    } catch (error) {
      useAppStore.getState().setMessageFeedback(message.id, current);
      toast.error(error instanceof Error ? error.message : 'Could not save feedback');
    }
  };

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Rate this answer">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'insightdoc-pop h-6 w-6 hover:text-emerald-500',
                current === 'UP' && 'text-emerald-500',
              )}
              aria-label="Good answer"
              aria-pressed={current === 'UP'}
              onClick={() => void apply('UP')}
            >
              <ThumbsUp className={cn('h-3 w-3', current === 'UP' && 'fill-current')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Good answer</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'insightdoc-pop h-6 w-6 hover:text-rose-500',
                current === 'DOWN' && 'text-rose-500',
              )}
              aria-label="Bad answer"
              aria-pressed={current === 'DOWN'}
              onClick={() => void apply('DOWN')}
            >
              <ThumbsDown className={cn('h-3 w-3', current === 'DOWN' && 'fill-current')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Bad answer</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

/** Clipboard copy with a transient check-mark. */
function CopyButton({ getText, label }: { getText: () => string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            aria-label={label}
            onClick={async () => {
              const ok = await copyText(getText());
              if (ok) {
                setCopied(true);
                toast.success('Copied to clipboard');
                setTimeout(() => setCopied(false), 1400);
              } else {
                toast.error('Clipboard unavailable — select the text manually');
              }
            }}
          >
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{copied ? 'Copied!' : label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Compose a portable Markdown transcript of one Q/A turn. */
function turnToMarkdown(question: string, answer: ChatMessageDTO): string {
  const lines: string[] = [`**Q:** ${question}`, '', answer.content.replace(/\[(\d{1,2})\]/g, '[$1]')];
  if (answer.citations && answer.citations.length > 0) {
    lines.push('', '### Sources');
    for (let i = 0; i < answer.citations.length; i++) {
      const c = answer.citations[i];
      lines.push(`${i + 1}. \`${c.documentTitle}\` p.${c.pageNumber} — score ${c.score.toFixed(2)} — "${c.snippet.slice(0, 140)}${c.snippet.length > 140 ? '…' : ''}"`);
    }
  }
  if (answer.retrievalInfo) {
    lines.push(
      '',
      `> retrieval: ${answer.retrievalInfo.vectorHits} vector / ${answer.retrievalInfo.keywordHits} keyword → top ${answer.retrievalInfo.rerankedTopK} · ${(answer.retrievalInfo.retrieveMs + answer.retrievalInfo.rerankMs).toFixed(0)}ms`,
    );
  }
  return lines.join('\n');
}

/** Build a clipboard-friendly Markdown transcript of the whole conversation. */
function conversationToMarkdown(title: string, msgs: ChatMessageDTO[]): string {
  const lines: string[] = [`# ${title}`, ''];
  for (const m of msgs) {
    if (m.role === 'note') {
      const note = parseDigestNote(m.content);
      lines.push('### 📋 Shared AI digest', '', note ? digestNoteToMarkdown(note, false) : m.content, '');
      continue;
    }
    if (m.role === 'user') {
      lines.push(`### 🧑 Question`, '', m.content, '');
    } else {
      lines.push(`### 🤖 InsightDoc`, '', m.content.replace(/\[(\d{1,2})\]/g, '[$1]'));
      if (m.citations && m.citations.length > 0) {
        lines.push('', '**Sources:**');
        m.citations.forEach((c, i) =>
          lines.push(`${i + 1}. ${c.documentTitle}, p.${c.pageNumber} (score ${c.score.toFixed(2)})`),
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ─── Digest note cards (persisted 'note' messages) ───────────────────────────

/** Parse a note message's content JSON; null when corrupt (fallback rendering). */
function parseDigestNote(content: string): DigestNoteContent | null {
  try {
    const parsed = DigestNoteContentSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Markdown export of a digest note; `includeTitle` off for transcripts. */
function digestNoteToMarkdown(n: DigestNoteContent, includeTitle = true): string {
  const lines: string[] = [];
  if (includeTitle) lines.push(`# AI digest — ${n.documentTitle}`, '');
  lines.push(
    n.digest.overview,
    '',
    '## Key points',
    ...n.digest.keyPoints.map((k) => `- ${k}`),
    '',
  );
  if (n.digest.entities.length > 0) {
    lines.push('## Entities', n.digest.entities.join(', '), '');
  }
  if (n.digest.suggestedQuestions.length > 0) {
    lines.push('## Suggested questions', ...n.digest.suggestedQuestions.map((q) => `- ${q}`), '');
  }
  lines.push(`---\nGenerated by ${n.model} · ${new Date(n.generatedAt).toLocaleString()}`);
  return lines.join('\n');
}

/**
 * Persisted 'note' message: a shared AI digest rendered as a rich, immutable
 * conversation artifact. Excluded from LLM transcripts; offers copy + jump.
 */
function DigestMessageCard({ message }: { message: ChatMessageDTO }) {
  const prefillComposer = useAppStore((s) => s.prefillComposer);
  const openDocument = useAppStore((s) => s.openDocument);
  const note = parseDigestNote(message.content);

  if (!note) {
    return (
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 max-w-[85%] rounded-2xl rounded-bl-sm border bg-card px-4 py-3 text-sm text-muted-foreground">
          Shared note — content unavailable.
        </div>
      </div>
    );
  }

  return (
    <div className="group/msg flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/25 to-cyan-500/15">
        <Sparkles className="h-4 w-4 text-primary" />
      </div>
      <div className="flex min-w-0 max-w-[85%] flex-col">
        <div className="note-card overflow-hidden rounded-2xl rounded-bl-sm border bg-gradient-to-b from-primary/[0.06] to-transparent shadow-sm shadow-black/5">
          <div className="flex items-center gap-2 border-b bg-card/50 px-3.5 py-2">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-primary">AI digest</span>
            <span className="truncate text-xs font-medium text-foreground/90" title={note.documentTitle}>
              {note.documentTitle}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
              {new Date(note.generatedAt).toLocaleDateString()}
            </span>
          </div>
          <div className="space-y-2.5 px-3.5 py-3">
            <p className="text-sm leading-relaxed text-foreground/90">{note.digest.overview}</p>
            <ul className="space-y-1">
              {note.digest.keyPoints.slice(0, 6).map((k, i) => (
                <li key={`nk-${i}`} className="flex items-start gap-1.5 text-xs leading-relaxed">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
                  <span>{k}</span>
                </li>
              ))}
              {note.digest.keyPoints.length > 6 && (
                <li className="pl-[18px] text-[11px] text-muted-foreground">
                  +{note.digest.keyPoints.length - 6} more key points in the inspector
                </li>
              )}
            </ul>
            {note.digest.entities.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {note.digest.entities.slice(0, 8).map((e, i) => (
                  <span
                    key={`ne-${i}`}
                    className="rounded-full border border-primary/25 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary/90"
                  >
                    {e}
                  </span>
                ))}
              </div>
            )}
            {note.digest.suggestedQuestions.length > 0 && (
              <div className="space-y-1 pt-0.5">
                {note.digest.suggestedQuestions.map((q, i) => (
                  <button
                    key={`nq-${i}`}
                    onClick={() => prefillComposer(`About "${note.documentTitle}": ${q}`)}
                    className="group/q flex w-full items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 text-left text-xs transition hover:border-primary/40 hover:bg-primary/5"
                  >
                    <CircleQuestionMark className="h-3 w-3 shrink-0 text-primary/70" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{q}</span>
                    <span className="shrink-0 text-[10px] text-primary/70 opacity-0 transition group-hover/q:opacity-100">Ask →</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 border-t pt-2 font-mono text-[10px] text-muted-foreground">
              <span className="truncate">{note.model}</span>
              <button
                type="button"
                onClick={() => openDocument(note.documentId)}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-primary transition hover:bg-primary/10"
                aria-label={`Open source document ${note.documentTitle}`}
              >
                <FileText className="h-3 w-3" /> Open source document
              </button>
            </div>
          </div>
        </div>
        {/* Hover actions — notes are immutable artifacts: copy only */}
        <div className="mt-1 flex items-center gap-0.5 self-start opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100">
          <CopyButton label="Copy digest as Markdown" getText={() => digestNoteToMarkdown(note)} />
        </div>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const documents = useAppStore((s) => s.documents);
  const activeChatId = useAppStore((s) => s.activeChatId);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const messages = useAppStore((s) => s.messages);
  const messagesLoading = useAppStore((s) => s.messagesLoading);
  const streaming = useAppStore((s) => s.streaming);
  const selectedDocIds = useAppStore((s) => s.selectedDocIds);
  const toggleDocSelection = useAppStore((s) => s.toggleDocSelection);
  const setSelectedDocIds = useAppStore((s) => s.setSelectedDocIds);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const upsertChat = useAppStore((s) => s.upsertChat);
  const startStreaming = useAppStore((s) => s.startStreaming);
  const streamToken = useAppStore((s) => s.streamToken);
  const streamCitations = useAppStore((s) => s.streamCitations);
  const streamRetrieval = useAppStore((s) => s.streamRetrieval);
  const streamError = useAppStore((s) => s.streamError);
  const finishStreaming = useAppStore((s) => s.finishStreaming);
  const resetStreaming = useAppStore((s) => s.resetStreaming);
  const activeChatTitle = useAppStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.title ?? 'Conversation');

  const [input, setInput] = useState('');
  const [docPickerOpen, setDocPickerOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [narratingId, setNarratingId] = useState<string | null>(null);
  const [narrationLoadingId, setNarrationLoadingId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ forMessageId: string; items: string[]; loading: boolean } | null>(null);
  /** Narration playback speed — applies live and persists for future sessions. */
  const [narrationSpeed, setNarrationSpeed] = useState<(typeof NARRATION_SPEEDS)[number]>(() => {
    try {
      const stored = localStorage.getItem('insightdoc-tts-speed');
      const parsed = Number(stored);
      if (NARRATION_SPEEDS.includes(parsed as never)) return parsed as never;
    } catch { /* storage unavailable */ }
    return 1;
  });
  const abortRef = useRef<AbortController | null>(null);
  const narrationAbortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fetchedFollowupsRef = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerPrefill = useAppStore((s) => s.composerPrefill);
  const clearComposerPrefill = useAppStore((s) => s.clearComposerPrefill);

  // "Ask about this page" and other cross-view prefills land in the composer.
  // Without an active chat we transparently create one first so the composer
  // (and the prefilled draft) is immediately usable.
  useEffect(() => {
    if (!composerPrefill) return;
    const text = composerPrefill.text;
    clearComposerPrefill();
    void (async () => {
      if (!activeChatId && activeWorkspaceId) {
        try {
          const chat = await createChat(activeWorkspaceId);
          useAppStore.getState().upsertChat(chat);
          useAppStore.getState().setActiveChat(chat.id);
        } catch (error) {
          console.error('Prefill: could not create chat', error);
          toast.error('Could not start a conversation — the draft was kept in the viewer context');
        }
      }
      setInput((prev) => (prev ? `${prev} ${text}` : text));
      // Focus after the view switch / composer mount settles.
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        const end = composerRef.current?.value.length ?? 0;
        composerRef.current?.setSelectionRange(end, end);
      });
    })();
  }, [composerPrefill, clearComposerPrefill, activeChatId, activeWorkspaceId]);

  const completedDocs = documents.filter((d) => d.status === 'COMPLETED');
  const activeDocs = selectedDocIds.length > 0
    ? completedDocs.filter((d) => selectedDocIds.includes(d.id))
    : completedDocs;

  useEffect(() => {
    if (!activeChatId) return;
    let cancelled = false;
    const load = async () => {
      const store = useAppStore.getState();
      store.setMessagesLoading(true);
      try {
        const msgs = await fetchChatMessages(activeChatId);
        if (!cancelled) {
          useAppStore.getState().setMessages(msgs);
          useAppStore.getState().setMessagesLoading(false);
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
        if (!cancelled) useAppStore.getState().setMessagesLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeChatId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, streaming.content]);

  /** Shared streaming runner — used by both send() and regenerate(). */
  const runStream = useCallback(
    async (question: string) => {
      if (!activeChatId) return;
      startStreaming();
      const controller = new AbortController();
      abortRef.current = controller;

      await streamChat(
        activeChatId,
        { message: question, documentIds: selectedDocIds, temperature: 0.2 },
        {
          onCitations: streamCitations,
          onRetrieval: streamRetrieval,
          onToken: streamToken,
          onDone: ({ messageId, totalTokens, latencyMs }) => {
            finishStreaming({ messageId, totalTokens, latencyMs });
            const st = useAppStore.getState().streaming;
            appendMessage({
              id: messageId || `local-assistant-${Date.now()}`,
              role: 'assistant',
              content: st.content,
              citations: st.citations,
              tokenUsage: totalTokens,
              latencyMs,
              retrievalInfo: st.retrieval,
              feedback: null,
              createdAt: new Date().toISOString(),
            });
            resetStreaming();
            {
              // Refresh the rail row in place — preserve title/pin/bookkeeping.
              const existing = useAppStore.getState().chats.find((c) => c.id === activeChatId);
              if (existing) {
                upsertChat({
                  ...existing,
                  updatedAt: new Date().toISOString(),
                  messageCount: useAppStore.getState().messages.length,
                });
              }
            }
          },
          onError: (message, recoverable) => {
            streamError(message, recoverable);
            toast.error(message);
          },
        },
        controller.signal,
      );
      abortRef.current = null;
    },
    [activeChatId, selectedDocIds, startStreaming, streamCitations, streamRetrieval, streamToken, finishStreaming, appendMessage, resetStreaming, upsertChat, streamError],
  );

  /** Re-answer an existing assistant turn: drop it server-side, re-stream. */
  const regenerate = async (assistantMsg: ChatMessageDTO) => {
    if (!activeChatId || streaming.active || regenerating) return;
    const idx = messages.findIndex((m) => m.id === assistantMsg.id);
    if (idx === -1) return;
    const question = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
    if (!question) return;

    setRegenerating(true);
    setSuggestions(null);
    try {
      await truncateMessagesFrom(activeChatId, assistantMsg.id, true);
      useAppStore.getState().setMessages(messages.slice(0, idx));
      resetStreaming();
      await runStream(question.content);
    } catch (error) {
      console.error(error);
      toast.error('Could not regenerate — reload the chat and try again');
    } finally {
      setRegenerating(false);
    }
  };

  const stopGenerating = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    resetStreaming();
    toast('Generation stopped', { icon: '⏹' });
  };

  const downloadTurn = (question: string, answer: ChatMessageDTO) => {
    const md = turnToMarkdown(question, answer);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `insightdoc-answer-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Turn exported as Markdown');
  };

  const retryLast = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      setInput(lastUser.content);
      resetStreaming();
    }
  };

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && !messages[i].id.startsWith('local-')) {
        return messages[i].id;
      }
    }
    return null;
  }, [messages]);

  // Stop narration on chat switch or whenever a new answer starts streaming
  useEffect(() => {
    narrationAbortRef.current?.abort();
    narrationAbortRef.current = null;
    stopNarration();
    setNarratingId(null);
    setNarrationLoadingId(null);
  }, [activeChatId]);

  useEffect(() => {
    if (streaming.active) {
      narrationAbortRef.current?.abort();
      narrationAbortRef.current = null;
      stopNarration();
      setNarratingId(null);
    }
  }, [streaming.active]);

  /** Read an assistant answer aloud; clicking again stops playback or cancels synthesis. */
  const narrate = async (m: ChatMessageDTO) => {
    if (narrationLoadingId === m.id) {
      narrationAbortRef.current?.abort(); // cancel in-flight synthesis
      return;
    }
    if (narratingId === m.id) {
      stopNarration();
      setNarratingId(null);
      return;
    }
    if (narrationLoadingId) return;
    stopNarration();
    setNarratingId(null);
    setNarrationLoadingId(m.id);
    toast('Synthesizing narration…', { id: 'tts-pending', icon: '🎙️', duration: Infinity });
    const controller = new AbortController();
    narrationAbortRef.current = controller;
    try {
      const blob = await speakText(m.content, 1.0, controller.signal);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = narrationSpeed;
      activeNarration = { audio, url };
      audio.onended = () => {
        if (activeNarration?.audio === audio) {
          stopNarration();
          setNarratingId(null);
        }
      };
      setNarrationLoadingId(null);
      narrationAbortRef.current = null;
      setNarratingId(m.id);
      await audio.play();
      toast.success('Reading answer aloud', { id: 'tts-pending', icon: '🔊' });
    } catch (error) {
      stopNarration();
      setNarratingId(null);
      if ((error as Error).name === 'AbortError') {
        toast.dismiss('tts-pending'); // user cancelled the synthesis
      } else {
        toast.error(error instanceof Error ? error.message : 'Could not play narration', { id: 'tts-pending' });
      }
    } finally {
      setNarrationLoadingId(null);
    }
  };

  const cycleNarrationSpeed = () => {
    setNarrationSpeed((prev) => {
      const next = nextNarrationSpeed(prev);
      try {
        localStorage.setItem('insightdoc-tts-speed', String(next));
      } catch { /* storage unavailable */ }
      if (activeNarration) activeNarration.audio.playbackRate = next; // apply live
      return next;
    });
  };

  // LLM-suggested follow-ups for the latest persisted answer (best-effort)
  useEffect(() => {
    if (!activeChatId || !lastAssistantId || streaming.active || regenerating) {
      if (streaming.active) setSuggestions(null);
      return;
    }
    if (fetchedFollowupsRef.current.has(lastAssistantId)) return;
    fetchedFollowupsRef.current.add(lastAssistantId);
    let cancelled = false;
    setSuggestions({ forMessageId: lastAssistantId, items: [], loading: true });
    fetchFollowups(activeChatId)
      .then((items) => {
        if (!cancelled) setSuggestions({ forMessageId: lastAssistantId, items, loading: false });
      })
      .catch(() => {
        if (!cancelled) setSuggestions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, lastAssistantId, streaming.active, regenerating]);

  const refreshSuggestions = async () => {
    if (!activeChatId || !lastAssistantId) return;
    fetchedFollowupsRef.current.delete(lastAssistantId);
    setSuggestions({ forMessageId: lastAssistantId, items: [], loading: true });
    try {
      const items = await fetchFollowups(activeChatId);
      setSuggestions({ forMessageId: lastAssistantId, items, loading: false });
    } catch {
      setSuggestions(null);
    }
  };

  const sendText = async (question: string) => {
    if (!question || !activeChatId || streaming.active) return;
    setInput('');
    setSuggestions(null);
    appendMessage({
      id: `local-user-${Date.now()}`,
      role: 'user',
      content: question,
      citations: null,
      tokenUsage: null,
      latencyMs: null,
      retrievalInfo: null,
      feedback: null,
      createdAt: new Date().toISOString(),
    });
    await runStream(question);
  };

  const send = async () => {
    await sendText(input.trim());
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {/* Header: scope selector */}
      <div className="flex items-center gap-2 border-b bg-card/40 px-4 py-2.5">
        <Popover open={docPickerOpen} onOpenChange={setDocPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" aria-label="Select retrieval scope">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="max-w-56 truncate">
                Scope:{' '}
                {selectedDocIds.length === 0
                  ? `All documents (${completedDocs.length})`
                  : `${activeDocs.length} selected`}
              </span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-2">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-xs font-medium text-muted-foreground">Retrieval scope</span>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setSelectedDocIds([])}>
                All
              </Button>
            </div>
            <ScrollArea className="max-h-64">
              {completedDocs.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No processed documents yet — upload a PDF and wait for ingestion to complete.
                </p>
              )}
              {completedDocs.map((d) => {
                const checked = selectedDocIds.includes(d.id);
                return (
                  <button
                    key={d.id}
                    onClick={() => toggleDocSelection(d.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    role="checkbox"
                    aria-checked={checked}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs">{d.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{d.pageCount}p</span>
                  </button>
                );
              })}
            </ScrollArea>
          </PopoverContent>
        </Popover>
        <div className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-500" aria-hidden />
          Hybrid retrieval: vector + BM25 + rerank
        </div>

        {/* Conversation actions: export / copy — only meaningful with messages */}
        {activeChatId && messages.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Conversation actions"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="max-w-full truncate text-[11px] font-medium text-muted-foreground">
                {activeChatTitle}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-xs"
                onClick={() => {
                  downloadExport(exportChatUrl(activeChatId, 'md'));
                  toast.success('Markdown export started');
                }}
              >
                <FileText className="h-3.5 w-3.5" /> Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 text-xs"
                onClick={() => {
                  downloadExport(exportChatUrl(activeChatId, 'json'));
                  toast.success('JSON export started');
                }}
              >
                <FileJson className="h-3.5 w-3.5" /> Export as JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-xs"
                onClick={async () => {
                  const ok = await copyText(conversationToMarkdown(activeChatTitle, messages));
                  if (ok) toast.success('Conversation copied as Markdown');
                  else toast.error('Clipboard unavailable');
                }}
              >
                <ClipboardCopy className="h-3.5 w-3.5" /> Copy conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="insightdoc-scroll min-h-0 flex-1 px-4">
        <div className="mx-auto max-w-3xl space-y-4 py-4">
          {messagesLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!messagesLoading && messages.length === 0 && !streaming.active && (
            <div className="flex flex-col items-center gap-4 py-14 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                <Bot className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold">Interrogate your documents</h3>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  Ask anything about the indexed PDFs — every claim comes back with a verifiable,
                  page-accurate citation.
                </p>
              </div>
              {completedDocs.length > 0 && (
                <div className="flex max-w-md flex-wrap justify-center gap-2">
                  {[
                    `What are the key points in ${completedDocs[0].title}?`,
                    'Summarize the disclosed risk factors',
                    'What financial figures stand out?',
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setInput(suggestion)}
                      className="rounded-full border bg-card/70 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === 'note') {
              return <DigestMessageCard key={m.id} message={m} />;
            }
            const isUser = m.role === 'user';
            const isLocal = m.id.startsWith('local-');
            const precedingQuestion = [...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.content ?? '';
            return (
              <div key={m.id} className={cn('group/msg flex gap-3', isUser && 'justify-end')}>
                {m.role === 'assistant' && (
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                )}
                <div className="flex min-w-0 max-w-[85%] flex-col">
                  <div
                    className={cn(
                      'rounded-2xl px-4 py-3 text-sm transition-shadow',
                      isUser
                        ? 'rounded-br-sm bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                        : 'rounded-bl-sm border bg-card shadow-sm shadow-black/5',
                    )}
                  >
                    {isUser ? (
                      <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                    ) : (
                      <>
                        <MessageContent content={m.content} citations={m.citations ?? []} />
                        {m.citations && m.citations.length > 0 && (
                          <div className="mt-3 space-y-1.5">
                            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              Sources
                            </div>
                            {m.citations.map((c, ci) => (
                              <CitationCard key={`${m.id}-c${ci}`} index={ci} c={c} />
                            ))}
                          </div>
                        )}
                        {(m.tokenUsage !== null || m.latencyMs !== null) && (
                          <div className="mt-2 flex gap-3 border-t pt-1.5 font-mono text-[10px] text-muted-foreground">
                            {m.tokenUsage !== null && <span>{m.tokenUsage} tokens</span>}
                            {m.latencyMs !== null && <span>{(m.latencyMs / 1000).toFixed(1)}s</span>}
                            {m.retrievalInfo && (
                              <span>
                                {m.retrievalInfo.vectorHits}v/{m.retrievalInfo.keywordHits}k → top{m.retrievalInfo.rerankedTopK}
                              </span>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Hover action bar — persisted messages only */}
                  {!isLocal && !streaming.active && !regenerating && (
                    <div
                      className={cn(
                        'mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100',
                        isUser ? 'flex-row-reverse self-end' : 'self-start',
                      )}
                    >
                      <CopyButton
                        label={isUser ? 'Copy question' : 'Copy answer'}
                        getText={() =>
                          isUser || !m.citations?.length
                            ? m.content
                            : turnToMarkdown(precedingQuestion, m)
                        }
                      />
                      {!isUser && <FeedbackButtons message={m} />}
                      {!isUser && (
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  'h-6 w-6 text-muted-foreground hover:text-primary',
                                  narratingId === m.id && 'text-primary',
                                )}
                                aria-label={
                                  narrationLoadingId === m.id
                                    ? 'Cancel narration'
                                    : narratingId === m.id
                                      ? 'Stop narration'
                                      : 'Read answer aloud'
                                }
                                aria-pressed={narratingId === m.id || narrationLoadingId === m.id}
                                disabled={narrationLoadingId !== null && narrationLoadingId !== m.id}
                                onClick={() => void narrate(m)}
                              >
                                {narrationLoadingId === m.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : narratingId === m.id ? (
                                  <span className="eq inline-flex items-end gap-px" aria-hidden>
                                    <span className="eq-bar" />
                                    <span className="eq-bar" />
                                    <span className="eq-bar" />
                                  </span>
                                ) : (
                                  <Volume2 className="h-3 w-3" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">
                              {narrationLoadingId === m.id ? 'Cancel narration' : narratingId === m.id ? 'Stop reading' : 'Read aloud'}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {!isUser && narratingId === m.id && (
                        <button
                          type="button"
                          onClick={cycleNarrationSpeed}
                          aria-label={`Narration speed ${narrationSpeed}× — click to change`}
                          title="Playback speed"
                          className="h-6 shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 font-mono text-[10px] font-semibold text-primary transition-transform hover:scale-110 active:scale-95 insightdoc-pop"
                        >
                          {narrationSpeed}×
                        </button>
                      )}
                      {!isUser && (
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                aria-label="Export this answer as Markdown"
                                onClick={() => downloadTurn(precedingQuestion, m)}
                              >
                                <Download className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">Export turn (.md)</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {!isUser && m.id === lastAssistantId && (
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-primary"
                                aria-label="Regenerate this answer"
                                onClick={() => void regenerate(m)}
                              >
                                <RotateCcw className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">Regenerate answer</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                  )}
                  {regenerating && m.id === lastAssistantId && (
                    <div className="mt-1 flex items-center gap-1.5 self-start text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> regenerating…
                    </div>
                  )}
                </div>
                {isUser && (
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
                    <User className="h-4 w-4 text-secondary-foreground" />
                  </div>
                )}
              </div>
            );
          })}

          {/* Live streaming bubble */}
          {streaming.active && (
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Bot className="h-4 w-4 animate-pulse text-primary" />
              </div>
              <div className="min-w-0 max-w-[85%] rounded-2xl rounded-bl-sm border bg-card px-4 py-3 text-sm shadow-sm shadow-black/5">
                {streaming.retrieval && streaming.content.length === 0 && (
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Fused {streaming.retrieval.fusedCandidates} candidates · reranked to{' '}
                    {streaming.retrieval.rerankedTopK} · {(streaming.retrieval.retrieveMs + streaming.retrieval.rerankMs)}ms
                  </div>
                )}
                {!streaming.retrieval && streaming.content.length === 0 && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Searching the vector index…
                  </div>
                )}
                <MessageContent content={streaming.content} citations={streaming.citations} streaming />
                {streaming.citations.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Sources
                    </div>
                    {streaming.citations.map((c, i) => (
                      <CitationCard key={`live-c${i}`} index={i} c={c} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Stream error w/ recovery */}
          {streaming.error && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p className="text-destructive">{streaming.error}</p>
              {streaming.recoverable && (
                <Button variant="outline" size="sm" className="mt-2 h-7 gap-1.5" onClick={retryLast}>
                  <RotateCcw className="h-3 w-3" /> Retry
                </Button>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Composer */}
      <div className="border-t bg-card/40 p-3">
        <div className="mx-auto max-w-3xl">
          {/* LLM-suggested follow-ups for the latest answer */}
          {activeChatId && suggestions && suggestions.forMessageId === lastAssistantId && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Suggested follow-up questions">
              <span className="flex items-center gap-1 pr-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <Sparkles className="h-3 w-3 text-amber-500" />
                Follow-up
              </span>
              {suggestions.loading
                ? Array.from({ length: 3 }, (_, i) => i).map((i) => (
                    <span
                      key={`sk${i}`}
                      className="h-7 animate-pulse rounded-full bg-muted/70"
                      style={{ width: `${140 + i * 36}px` }}
                      aria-hidden
                    />
                  ))
                : suggestions.items.map((q, i) => (
                    <button
                      key={q}
                      onClick={() => void sendText(q)}
                      disabled={streaming.active || regenerating}
                      className="followup-chip max-w-full truncate rounded-full border bg-card/70 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-50"
                      style={{ animationDelay: `${i * 70}ms` }}
                      title={q}
                    >
                      {q}
                    </button>
                  ))}
              {!suggestions.loading && suggestions.items.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Refresh suggestions"
                  onClick={() => void refreshSuggestions()}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              )}
            </div>
          )}

          <div className="flex items-end gap-2">
            <PromptLibrary
              onInsert={(text) => {
                setInput(text);
                requestAnimationFrame(() => {
                  composerRef.current?.focus();
                  const end = composerRef.current?.value.length ?? 0;
                  composerRef.current?.setSelectionRange(end, end);
                });
              }}
              draft={input}
              disabled={!activeChatId || streaming.active || regenerating}
            />
            <VoiceRecorder
              onTranscribed={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))}
              disabled={!activeChatId || streaming.active || regenerating}
            />
            <Textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                activeDocs.length === 0
                  ? 'Upload and process a PDF to start asking questions…'
                  : 'Ask about your documents — e.g. "What risk factors are disclosed for Q3?"'
              }
              disabled={!activeChatId || streaming.active}
              className="insightdoc-scroll max-h-36 min-h-11 flex-1 resize-none rounded-xl"
              aria-label="Chat message"
            />
            {streaming.active ? (
              <Button
                onClick={stopGenerating}
                size="icon"
                variant="outline"
                className="h-11 w-11 shrink-0 rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label="Stop generating"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            ) : (
              <Button
                onClick={() => void send()}
                disabled={!activeChatId || input.trim().length === 0}
                size="icon"
                className="h-11 w-11 shrink-0 rounded-xl transition-transform active:scale-95"
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>

          <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
            Answers are grounded in retrieved context and may cite pages. Verify critical figures against the source.
          </p>
        </div>
      </div>
    </div>
  );
}
