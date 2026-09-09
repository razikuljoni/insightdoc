'use client';

/**
 * InsightDoc — Analytics, Cost Control & Audit (spec §2.4 / §6.2 page 4)
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Coins,
  Database,
  Download,
  FileJson,
  FileText,
  MessageCircleQuestion,
  ScrollText,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/types';
import type { FeedbackReviewItem } from '@/lib/types';
import { exportChatUrl, fetchFeedbackReview } from './api-client';
import { useAppStore } from './store';

interface Analytics {
  totals: {
    workspaces: number;
    documents: number;
    completedDocuments: number;
    failedDocuments: number;
    chunks: number;
    chats: number;
    messages: number;
    storageBytes: number;
  };
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    embeddingTokens: number;
    chatTokens: number;
    byDay: Array<{ date: string; tokens: number; costUsd: number }>;
  };
  feedback: {
    up: number;
    down: number;
  };
  recentAudit: Array<{
    id: string;
    action: string;
    actorEmail: string;
    targetType: string | null;
    targetId: string | null;
    createdAt: string;
  }>;
}

function Metric({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4 text-primary/80" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Compact Y-axis tick labels — keeps 5-digit token counts inside the chart gutter. */
function formatCompactTokens(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(v) >= 1_000) {
    const k = v / 1_000;
    return `${k >= 100 || k % 1 === 0 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(v);
}

/** Compact USD tick labels — $0 / $0.07 / $0.1 / $1.2 style. */
function formatCompactUsd(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  if (Math.abs(v) >= 100) return String(Math.round(v));
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(2).replace(/0$/, '');
}

export function AnalyticsView() {
  const chats = useAppStore((s) => s.chats);
  const setView = useAppStore((s) => s.setView);
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<FeedbackReviewItem[] | null>(null);
  const [reviewLoading, setReviewLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/analytics');
        if (!res.ok) throw new Error(`Failed (${res.status})`);
        const body = (await res.json()) as { analytics: Analytics };
        if (!cancelled) setAnalytics(body.analytics);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load analytics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    (async () => {
      try {
        const items = await fetchFeedbackReview('DOWN', 6);
        if (!cancelled) setReviewItems(items);
      } catch {
        if (!cancelled) setReviewItems([]);
      } finally {
        if (!cancelled) setReviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Jump from the review queue into the originating conversation. */
  const openReviewItem = (item: FeedbackReviewItem) => {
    setActiveChat(item.sessionId);
    setView('chat');
  };

  const chartData = useMemo(
    () =>
      (analytics?.usage.byDay ?? []).map((d) => ({
        ...d,
        label: new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      })),
    [analytics],
  );

  if (loading) {
    return (
      <div className="insightdoc-scroll h-full overflow-y-auto p-4 sm:p-5 lg:p-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => i).map((i) => (
              <Skeleton key={`sk${i}`} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  if (error || !analytics) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-destructive">
        {error ?? 'Analytics unavailable'}
      </div>
    );
  }

  return (
    <div className="insightdoc-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-5 lg:p-8">
        <header>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Analytics & Cost Control</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Token consumption, vector storage usage and the platform audit trail.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric
            icon={Coins}
            label="Est. spend"
            value={`$${analytics.usage.estimatedCostUsd.toFixed(4)}`}
            sub="blended model estimate"
          />
          <Metric
            icon={Activity}
            label="Total tokens"
            value={analytics.usage.totalTokens.toLocaleString()}
            sub={`${analytics.usage.promptTokens.toLocaleString()} in / ${analytics.usage.completionTokens.toLocaleString()} out`}
          />
          <Metric
            icon={Database}
            label="Vector chunks"
            value={analytics.totals.chunks.toLocaleString()}
            sub={`${formatBytes(analytics.totals.storageBytes)} PDF storage`}
          />
          <Metric
            icon={ScrollText}
            label="RAG turns"
            value={analytics.totals.messages.toLocaleString()}
            sub={`${analytics.totals.chats} conversations`}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">Token consumption — 14 days</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              {analytics.usage.embeddingTokens.toLocaleString()} embedding ·{' '}
              {analytics.usage.chatTokens.toLocaleString()} chat
            </p>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="tokenFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    stroke="var(--muted-foreground)"
                    width={54}
                    tickFormatter={(v: number | string) => formatCompactTokens(Number(v))}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--popover)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v: number | string) => [Number(v).toLocaleString(), 'tokens']}
                  />
                  <Area type="monotone" dataKey="tokens" stroke="var(--chart-1)" fill="url(#tokenFill)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">Estimated cost — 14 days</h2>
            <p className="mb-3 text-xs text-muted-foreground">USD per day across all pipelines</p>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    stroke="var(--muted-foreground)"
                    width={54}
                    tickFormatter={(v: number | string) => `$${formatCompactUsd(Number(v))}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--popover)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v: number | string) => [`$${Number(v).toFixed(4)}`, 'cost']}
                  />
                  <Bar dataKey="costUsd" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>

        {/* Answer quality — human feedback signal on RAG answers */}
        <section className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <ThumbsUp className="h-4 w-4 text-emerald-500" />
            <h2 className="text-sm font-semibold">Answer quality</h2>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {analytics.feedback.up} up · {analytics.feedback.down} down
            </span>
          </div>
          {analytics.feedback.up + analytics.feedback.down === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              No ratings yet — hover an answer in RAG Chat and tap 👍 / 👎 to record feedback.
            </p>
          ) : (
            <>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums text-emerald-500">
                  {Math.round(
                    (analytics.feedback.up / (analytics.feedback.up + analytics.feedback.down)) * 100,
                  )}
                  %
                </span>
                <span className="text-xs text-muted-foreground">rated helpful</span>
              </div>
              <div
                className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-rose-500/25"
                role="progressbar"
                aria-valuenow={analytics.feedback.up}
                aria-valuemin={0}
                aria-valuemax={analytics.feedback.up + analytics.feedback.down}
                aria-label="Helpful answer ratio"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700"
                  style={{
                    width: `${(analytics.feedback.up / (analytics.feedback.up + analytics.feedback.down)) * 100}%`,
                  }}
                />
              </div>
            </>
          )}
        </section>

        {/* Feedback review queue — answers rated 👎, one click to the source conversation */}
        <section className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <MessageCircleQuestion className="h-4 w-4 text-rose-500" />
            <h2 className="text-sm font-semibold">Feedback review — low-rated answers</h2>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {reviewLoading ? '…' : `${reviewItems?.length ?? 0} flagged`}
            </span>
          </div>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            The 👎-rated answers worth a second look — click one to open the conversation at the source.
          </p>
          {reviewLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }, (_, i) => i).map((i) => (
                <Skeleton key={`rq${i}`} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : !reviewItems || reviewItems.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              Nothing flagged yet — answers rated 👎 in RAG Chat will queue up here for review.
            </p>
          ) : (
            <div className="space-y-2">
              {reviewItems.map((item) => (
                <button
                  key={item.messageId}
                  onClick={() => openReviewItem(item)}
                  className="group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition hover:border-rose-500/40 hover:bg-rose-500/5"
                  aria-label={`Open conversation: ${item.sessionTitle}`}
                >
                  <ThumbsDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-xs font-medium">{item.sessionTitle}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {relativeTime(item.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-1 block text-[11px] italic text-muted-foreground">
                      Q: {item.question}
                    </span>
                    <span className="line-clamp-2 block text-[11px] leading-snug text-muted-foreground/90 group-hover:text-foreground/80">
                      {item.content}
                    </span>
                    <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                      {item.citationsCount} citation{item.citationsCount === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          {/* Audit trail */}
          <section className="min-w-0 rounded-xl border bg-card">
            <div className="flex items-center gap-2 border-b p-4">
              <ScrollText className="h-4 w-4 text-primary/80" />
              <h2 className="text-sm font-semibold">Audit log</h2>
              <span className="ml-auto text-[10px] text-muted-foreground">latest 12 events</span>
            </div>
            {analytics.recentAudit.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No events recorded yet.</p>
            ) : (
              <div className="divide-y">
                {analytics.recentAudit.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{a.action}</span>
                    <span className="text-muted-foreground">{a.actorEmail}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {new Date(a.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Exports */}
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">Export insights</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Download any conversation with full citations as Markdown or JSON.
            </p>
            {chats.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                No conversations to export yet.
              </p>
            ) : (
              <div className="space-y-2">
                {chats.slice(0, 4).map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-lg border p-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{c.title}</span>
                    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" asChild>
                      <a href={exportChatUrl(c.id, 'md')} download>
                        <Download className="h-3 w-3" /> MD
                      </a>
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" asChild>
                      <a href={exportChatUrl(c.id, 'json')} download>
                        <FileJson className="h-3 w-3" /> JSON
                      </a>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
