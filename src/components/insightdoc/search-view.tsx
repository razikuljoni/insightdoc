'use client';

/**
 * InsightDoc — Semantic Search View (spec §2.3 scoped semantic search)
 * Cross-document hybrid retrieval without a chat round-trip: ranked passages,
 * score bars, query-term highlighting, and one-click deep-link into the viewer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, FileSearch, Filter, Loader2, Search, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Citation, RetrievalInfo } from '@/lib/types';
import { useAppStore } from './store';
import { searchDocuments } from './api-client';

const SUGGESTIONS = [
  'What are the disclosed risk factors?',
  'Summarize the liquidity position',
  'Which legal proceedings are pending?',
  'What cybersecurity metrics are reported?',
];

/** Highlight query terms inside a snippet (word-boundary, case-insensitive). */
function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const terms = [...new Set(query.toLowerCase().split(/\s+/))].filter((t) => t.length >= 3);
    if (terms.length === 0) return [{ text, match: false }];
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re).map((seg) => ({ text: seg, match: terms.includes(seg.toLowerCase()) }));
  }, [text, query]);

  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      {parts.map((p, i) =>
        p.match ? (
          <mark key={`hl-${i}`} className="match-highlight px-0.5">
            {p.text}
          </mark>
        ) : (
          <span key={`t-${i}`}>{p.text}</span>
        ),
      )}
    </p>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-1.5" title={`Relevance ${score.toFixed(2)}`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className="score-shimmer h-full rounded-full bg-gradient-to-r from-cyan-500 to-primary transition-all"
          style={{ width: `${Math.max(6, Math.min(100, score * 100))}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-muted-foreground">{score.toFixed(2)}</span>
    </div>
  );
}

export function SearchView() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const documents = useAppStore((s) => s.documents);
  const pendingSearchQuery = useAppStore((s) => s.pendingSearchQuery);
  const setPendingSearchQuery = useAppStore((s) => s.setPendingSearchQuery);
  const openDocument = useAppStore((s) => s.openDocument);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Citation[] | null>(null);
  const [stats, setStats] = useState<RetrievalInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Local search scope — independent of the chat scope selector. */
  const [searchDocIds, setSearchDocIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const completedDocs = documents.filter((d) => d.status === 'COMPLETED');
  const filteredRun = searchDocIds.filter((id) => completedDocs.some((d) => d.id === id));

  const toggleSearchDoc = (docId: string) => {
    setSearchDocIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId],
    );
  };

  const runSearch = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || !activeWorkspaceId || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await searchDocuments({
        workspaceId: activeWorkspaceId,
        query: trimmed,
        documentIds: filteredRun,
        topK: 12,
      });
      setResults(res.results);
      setStats(res.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  // Consume a query handed over from the command palette
  useEffect(() => {
    if (pendingSearchQuery) {
      setQuery(pendingSearchQuery);
      void runSearch(pendingSearchQuery);
      setPendingSearchQuery(null);
    }
  }, [pendingSearchQuery]);

  return (
    <div className="insightdoc-scroll h-full overflow-y-auto">
      <div className="bg-grid border-b bg-gradient-to-b from-primary/[0.06] to-transparent">
        <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-5 lg:p-8">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <FileSearch className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Semantic Search</h1>
              <p className="text-xs text-muted-foreground">
                Hybrid vector + BM25 retrieval across every indexed page — no chat needed.
              </p>
            </div>
            <Badge variant="outline" className="ml-auto gap-1 border-cyan-500/30 bg-cyan-500/5 text-cyan-600 dark:text-cyan-400">
              <Sparkles className="h-3 w-3" /> top-{stats?.rerankedTopK ?? 12}
            </Badge>
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch(query);
                }}
                placeholder="Search across your document library…"
                className="h-11 rounded-xl pl-9 pr-9 text-sm"
                aria-label="Search query"
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1.5 top-1/2 h-7 w-7 -translate-y-1/2"
                  onClick={() => {
                    setQuery('');
                    setResults(null);
                    inputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <Button onClick={() => void runSearch(query)} disabled={!query.trim() || loading} className="h-11 gap-1.5 rounded-xl px-5">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </Button>
          </div>

          {/* Document scope filter — local to Search so it never fights the chat scope */}
          {completedDocs.length >= 2 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Filter className="h-3 w-3" /> Scope
              </span>
              <button
                onClick={() => setSearchDocIds([])}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] transition',
                  filteredRun.length === 0
                    ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                    : 'border-border bg-card/70 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
                aria-pressed={filteredRun.length === 0}
              >
                All documents ({completedDocs.length})
              </button>
              {completedDocs.map((d) => {
                const active = filteredRun.includes(d.id);
                return (
                  <button
                    key={d.id}
                    onClick={() => toggleSearchDoc(d.id)}
                    className={cn(
                      'flex max-w-52 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition',
                      active
                        ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                        : 'border-border bg-card/70 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                    )}
                    aria-pressed={active}
                    title={d.title}
                  >
                    <span className="truncate">{d.title}</span>
                    {active && <X className="h-3 w-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          {results === null && !loading && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setQuery(s);
                    void runSearch(s);
                  }}
                  className="rounded-full border bg-card/70 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {stats && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {results?.length ?? 0} passages · {stats.vectorHits} vector / {stats.keywordHits} keyword candidates
              fused → reranked in {stats.retrieveMs + stats.rerankMs}ms
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-3 p-4 sm:p-5 lg:p-8">
        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && (
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => i).map((i) => (
              <Skeleton key={`sk-${i}`} className="h-24 rounded-xl" />
            ))}
          </div>
        )}

        <AnimatePresence>
          {!loading && results?.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-xl border border-dashed p-10 text-center"
            >
              <FileSearch className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">No matching passages</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try broader wording, or check that relevant documents are indexed.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {results?.map((r, i) => (
          <motion.article
            key={r.chunkId ?? `res-${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="group rounded-xl border bg-card p-4 transition hover:border-primary/40 hover:shadow-md hover:shadow-primary/5"
          >
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="outline" className="shrink-0 font-mono text-[10px] text-primary">
                #{i + 1}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.documentTitle}</span>
              <span className="shrink-0 rounded-md border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                p.{r.pageNumber}
              </span>
              <ScoreBar score={r.score} />
            </div>
            <HighlightedSnippet text={r.snippet} query={query} />
            <div className="mt-3 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-primary opacity-0 transition group-hover:opacity-100"
                onClick={() => openDocument(r.documentId, r.pageNumber)}
              >
                Open page {r.pageNumber} in viewer <ArrowRight className="h-3 w-3" />
              </Button>
            </div>
          </motion.article>
        ))}

        {!loading && results === null && !error && (
          <div className={cn('rounded-xl border border-dashed p-10 text-center', completedDocs.length === 0 && 'bg-card')}>
            {completedDocs.length === 0 ? (
              <>
                <p className="text-sm font-medium">Nothing indexed yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Upload a PDF from the Dashboard or Documents view to enable search.
                </p>
              </>
            ) : (
              <>
                <Search className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">Search {completedDocs.length} indexed document(s)</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Ask in natural language — the engine fuses semantic and keyword matches.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
