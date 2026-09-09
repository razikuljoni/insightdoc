'use client';

/**
 * InsightDoc — Interactive PDF Viewer (spec §6.2 right column)
 *
 * react-pdf (pdf.js) rendering with:
 *  - page-accurate deep-linking driven by citation pills (jump + flash ring)
 *  - best-effort in-text highlight of the cited snippet via customTextRenderer
 *  - full-text search across every page (lazy text extraction + amber marks,
 *    match navigation, per-page result chips)
 *  - zoom controls, page stepper, thumbnail drawer (windowed rendering)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Minus,
  Plus,
  FileWarning,
  ZoomIn,
  MessageCircleQuestion,
  PanelLeftOpen,
  PanelLeftClose,
  Search,
  X,
  ArrowUp,
  ArrowDown,
  TextSearch,
  Maximize,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAppStore } from './store';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

const PAGE_WINDOW = 4; // pages rendered around the active page
const A4_ASPECT = 1.414; // height/width fallback for placeholder sizing

interface PdfViewerPanelProps {
  documentId: string;
  title: string;
}

interface PageMatchGroup {
  page: number;
  count: number;
  preview: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeForMatch(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
}

/** Longest snippet n-gram (2..8 words) present in the text item. */
function matchRange(str: string, snippetWords: string[]): [number, number] | null {
  const norm = normalizeForMatch(str);
  const maxN = Math.min(8, snippetWords.length);
  for (let n = maxN; n >= 2; n--) {
    for (let start = 0; start + n <= snippetWords.length; start++) {
      const gram = snippetWords.slice(start, start + n).join(' ');
      if (gram.length < 6) continue; // skip trivial grams
      const idx = norm.indexOf(gram);
      if (idx !== -1) {
        // Map normalized index back to raw string via word-boundary scan
        return locateRawRange(str, gram);
      }
    }
  }
  return null;
}

function locateRawRange(raw: string, gram: string): [number, number] | null {
  const rawWords: Array<{ word: string; start: number; end: number }> = [];
  const re = /[A-Za-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    rawWords.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  const target = gram.split(' ');
  for (let i = 0; i + target.length <= rawWords.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (rawWords[i + j].word !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return [rawWords[i].start, rawWords[i + target.length - 1].end];
  }
  return null;
}

interface MarkRange {
  start: number;
  end: number;
  cls: string;
}

/** Apply non-overlapping highlight ranges (citation wins ties) to a raw string. */
function renderWithRanges(str: string, ranges: MarkRange[]): string {
  if (ranges.length === 0) return escapeHtml(str);
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const picked: MarkRange[] = [];
  let lastEnd = -1;
  for (const r of sorted) {
    if (r.start >= lastEnd) {
      picked.push(r);
      lastEnd = r.end;
    }
  }
  let html = '';
  let pos = 0;
  for (const r of picked) {
    html += escapeHtml(str.slice(pos, r.start));
    html += `<mark class="${r.cls}">${escapeHtml(str.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  html += escapeHtml(str.slice(pos));
  return html;
}

export default function PdfViewerPanel({ documentId, title }: PdfViewerPanelProps) {
  const prefillComposer = useAppStore((s) => s.prefillComposer);
  const pdfTarget = useAppStore((s) => s.pdfTarget);
  const fileUrl = `/api/v1/documents/${documentId}/file`;
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [autoFit, setAutoFit] = useState(true); // fit-to-width until the user zooms manually
  const [fitScale, setFitScale] = useState(1); // computed from the container width
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thumbnailsOpen, setThumbnailsOpen] = useState(false);
  const [activeCitation, setActiveCitation] = useState<{ page: number; snippet: string } | null>(null);

  // ── In-document full-text search state ─────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [matchGroups, setMatchGroups] = useState<PageMatchGroup[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0); // flat index across all groups
  const [extracting, setExtracting] = useState(false);

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pageTextsRef = useRef<Map<number, string>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Query the current results were computed from — Enter re-runs when it differs. */
  const lastQueryRef = useRef<string>('');

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [visibleRange, setVisibleRange] = useState<[number, number]>([1, PAGE_WINDOW + 1]);

  // ── Fit-to-width: recompute fitScale whenever the viewer pane resizes ──────
  // The base page box is 620px wide at scale 1; on narrow panes (mobile, narrow
  // split columns) autoFit shrinks pages so text is never clipped off-screen.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setFitScale(Math.min(1, Math.max(0.4, (w - 40) / 620)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const effectiveScale = autoFit ? fitScale : scale;
  const zoomOut = () => {
    setAutoFit(false);
    setScale((s) => Math.max(0.5, s - 0.15));
  };
  const zoomIn = () => {
    setAutoFit(false);
    setScale((s) => Math.min(2.5, s + 0.15));
  };

  // Reset per-document state when the opened file changes
  useEffect(() => {
    setNumPages(0);
    setPageNumber(1);
    setActiveCitation(null);
    setSearchOpen(false);
    setSearchInput('');
    setMatchGroups([]);
    setTotalMatches(0);
    setCurrentMatch(0);
    pdfDocRef.current = null;
    pageTextsRef.current = new Map();
  }, [documentId]);

  // ── Citation deep-link: jump to page + flash highlight ────────────────────
  // State updates are deferred to a timeout so the target page can mount first
  // (also avoids synchronous setState inside the effect body).
  useEffect(() => {
    if (!pdfTarget || pdfTarget.documentId !== documentId) return;
    const target = pdfTarget;
    const timer = setTimeout(() => {
      const page = Math.max(1, Math.min(target.pageNumber, numPages || target.pageNumber));
      setPageNumber(page);
      setActiveCitation({ page: target.pageNumber, snippet: target.citation?.snippet ?? '' });
      const el = pageRefs.current.get(page);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => clearTimeout(timer);
  }, [pdfTarget, documentId, numPages]);

  // ── Virtualization: track scroll and render a window of pages ─────────────
  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    let firstVisible = pageNumber;
    const entries = [...pageRefs.current.entries()].sort((a, b) => a[0] - b[0]);
    for (const [page, el] of entries) {
      const top = el.offsetTop - container.offsetTop;
      const bottom = top + el.offsetHeight;
      if (bottom >= viewTop && top <= viewBottom) {
        firstVisible = page;
        break;
      }
    }
    setVisibleRange(([prevFirst]) => {
      const nextFirst = Math.max(1, firstVisible - PAGE_WINDOW);
      const nextLast = Math.min(numPages || firstVisible + PAGE_WINDOW, firstVisible + PAGE_WINDOW + 2);
      if (Math.abs(prevFirst - nextFirst) < 1) return [prevFirst, Math.min(nextLast, numPages || nextLast)];
      return [nextFirst, nextLast];
    });
    // Sync page stepper with scroll
    if (firstVisible !== pageNumber) setPageNumber(firstVisible);
  }, [numPages, pageNumber]);

  // ── Lazy full-text extraction (pdf.js getTextContent per page) ────────────
  const ensurePageTexts = useCallback(async (): Promise<Map<number, string> | null> => {
    const pdf = pdfDocRef.current;
    if (!pdf) return null;
    if (pageTextsRef.current.size >= pdf.numPages) return pageTextsRef.current;
    setExtracting(true);
    try {
      const map = new Map<number, string>();
      for (let i = 1; i <= pdf.numPages; i++) {
        try {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          const text = tc.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ');
          map.set(i, text);
        } catch {
          map.set(i, '');
        }
      }
      pageTextsRef.current = map;
      return map;
    } finally {
      setExtracting(false);
    }
  }, []);

  // ── Search execution ────────────────────────────────────────────────────────
  const runSearch = useCallback(
    async (jumpToFirst: boolean) => {
      const rawQuery = searchInput.trim();
      lastQueryRef.current = rawQuery;
      if (rawQuery.length === 0) {
        setMatchGroups([]);
        setTotalMatches(0);
        setCurrentMatch(0);
        return;
      }
      const texts = await ensurePageTexts();
      if (!texts) return;

      const needle = normalizeForMatch(rawQuery);
      const rawLower = rawQuery.toLowerCase();
      const groups: PageMatchGroup[] = [];
      for (const [page, text] of [...texts.entries()].sort((a, b) => a[0] - b[0])) {
        const norm = normalizeForMatch(text);
        let count = 0;
        let idx = 0;
        let firstNormIdx = -1;
        while ((idx = norm.indexOf(needle, idx)) !== -1) {
          if (firstNormIdx === -1) firstNormIdx = idx;
          count++;
          idx += needle.length;
        }
        if (count > 0) {
          // Build a readable preview from the raw page text
          let rawIdx = text.toLowerCase().indexOf(rawLower);
          if (rawIdx === -1) rawIdx = Math.min(firstNormIdx, Math.max(0, text.length - 1));
          const start = Math.max(0, rawIdx - 36);
          const end = Math.min(text.length, rawIdx + rawQuery.length + 56);
          const preview = `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}…`;
          groups.push({ page, count, preview });
        }
      }
      setMatchGroups(groups);
      setTotalMatches(groups.reduce((s, g) => s + g.count, 0));
      setCurrentMatch(0);
      if (groups.length > 0 && jumpToFirst) {
        const el = pageRefs.current.get(groups[0].page);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setPageNumber(groups[0].page);
      }
    },
    [searchInput, ensurePageTexts],
  );

  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 60);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchInput('');
    setMatchGroups([]);
    setTotalMatches(0);
    setCurrentMatch(0);
  };

  /** Flat index over matchGroups → page number, or null when out of range. */
  const flatToPage = (flat: number): number | null => {
    let acc = 0;
    for (const g of matchGroups) {
      if (flat < acc + g.count) return g.page;
      acc += g.count;
    }
    return null;
  };

  const pageToFirstFlat = (page: number): number => {
    let acc = 0;
    for (const g of matchGroups) {
      if (g.page === page) return acc;
      acc += g.count;
    }
    return 0;
  };

  const stepMatch = (dir: 1 | -1) => {
    if (totalMatches === 0) return;
    const next = (currentMatch + dir + totalMatches) % totalMatches;
    setCurrentMatch(next);
    const page = flatToPage(next);
    if (page) {
      const el = pageRefs.current.get(page);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setPageNumber(page);
    }
  };

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(page, numPages || 1));
    setPageNumber(clamped);
    const el = pageRefs.current.get(clamped);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const onDocumentLoadSuccess = (pdf: any) => {
    setNumPages(pdf.numPages);
    setLoadError(null);
    pdfDocRef.current = pdf;
  };

  // ── Combined text-layer highlighting (citation grams + search terms) ──────
  const snippetWords = useMemo(() => {
    if (!activeCitation) return [];
    return normalizeForMatch(activeCitation.snippet).split(' ').filter((w) => w.length > 2);
  }, [activeCitation]);

  const searchTerms = useMemo(() => {
    if (!searchOpen) return [];
    return searchInput
      .trim()
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 1);
  }, [searchOpen, searchInput]);

  const customTextRenderer = useMemo(() => {
    if ((!activeCitation || snippetWords.length === 0) && searchTerms.length === 0) return undefined;
    return (props: { str: string; pageNumber: number }) => {
      const ranges: MarkRange[] = [];
      if (searchTerms.length > 0) {
        const lower = props.str.toLowerCase();
        for (const term of searchTerms) {
          let idx = lower.indexOf(term);
          while (idx !== -1) {
            ranges.push({ start: idx, end: idx + term.length, cls: 'search-highlight' });
            idx = lower.indexOf(term, idx + term.length);
          }
        }
      }
      if (activeCitation && props.pageNumber === activeCitation.page && snippetWords.length > 0) {
        const r = matchRange(props.str, snippetWords);
        if (r) ranges.push({ start: r[0], end: r[1], cls: 'match-highlight' });
      }
      return renderWithRanges(props.str, ranges);
    };
  }, [activeCitation, snippetWords, searchTerms]);

  const currentMatchPage = flatToPage(currentMatch);

  return (
    <div className="flex h-full min-w-0 flex-col bg-muted/40">
      {/* Toolbar — wraps to a second row on narrow panes instead of overflowing */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b bg-card/60 px-3 py-2 backdrop-blur">
        <div className="flex min-w-28 flex-1 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setThumbnailsOpen((v) => !v)}
            aria-label={thumbnailsOpen ? 'Close thumbnails' : 'Open thumbnails'}
          >
            {thumbnailsOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground" title={title}>
            {title}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
            onClick={() =>
              prefillComposer(`About page ${pageNumber} of “${title}”: `, { switchToChat: true })
            }
            aria-label={`Ask a question about page ${pageNumber}`}
            title="Pre-fill the chat composer with this page's context"
          >
            <MessageCircleQuestion className="h-4 w-4" />
            <span className="hidden sm:inline">Ask about this page</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', searchOpen && 'bg-primary/10 text-primary')}
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            aria-label={searchOpen ? 'Close document search' : 'Search in document'}
            aria-pressed={searchOpen}
          >
            <TextSearch className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={zoomOut} aria-label="Zoom out">
            <Minus className="h-4 w-4" />
          </Button>
          <span className="hidden w-12 text-center font-mono text-xs text-muted-foreground sm:block" aria-live="polite">
            {Math.round(effectiveScale * 100)}%
          </span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={zoomIn} aria-label="Zoom in">
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', autoFit && 'bg-primary/10 text-primary')}
            onClick={() => setAutoFit(true)}
            aria-label="Fit page to width"
            aria-pressed={autoFit}
            title="Fit page to width"
          >
            <Maximize className="h-4 w-4" />
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => goToPage(pageNumber - 1)} disabled={pageNumber <= 1} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Input
            value={pageNumber}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) goToPage(v);
            }}
            className="h-8 w-12 px-2 text-center font-mono text-xs"
            aria-label="Page number"
            inputMode="numeric"
          />
          <span className="font-mono text-xs text-muted-foreground">/ {numPages || '…'}</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => goToPage(pageNumber + 1)} disabled={numPages > 0 && pageNumber >= numPages} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* In-document search bar */}
      {searchOpen && (
        <div className="border-b bg-amber-500/5 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <Input
              ref={searchInputRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const isNewQuery = searchInput.trim() !== lastQueryRef.current;
                  if (!isNewQuery && matchGroups.length > 0) {
                    stepMatch(e.shiftKey ? -1 : 1);
                  } else {
                    void runSearch(true);
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              placeholder="Find in document… (Enter = next, Shift+Enter = previous)"
              className="h-8 flex-1 border-amber-500/30 bg-background/70 text-xs focus-visible:ring-amber-500/40"
              aria-label="Search text in this document"
            />
            {extracting ? (
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> extracting text…
              </span>
            ) : (
              searchInput.trim().length > 0 && (
                <span
                  className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
                  aria-live="polite"
                >
                  {totalMatches === 0
                    ? 'no matches'
                    : `${Math.min(currentMatch + 1, totalMatches)}/${totalMatches}`}
                </span>
              )
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => stepMatch(-1)}
              disabled={totalMatches === 0}
              aria-label="Previous match"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => stepMatch(1)}
              disabled={totalMatches === 0}
              aria-label="Next match"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={closeSearch} aria-label="Close search">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Per-page result chips */}
          {matchGroups.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {matchGroups.map((g) => {
                const isCurrent = currentMatchPage === g.page;
                return (
                  <button
                    key={g.page}
                    onClick={() => {
                      setCurrentMatch(pageToFirstFlat(g.page));
                      goToPage(g.page);
                    }}
                    className={cn(
                      'rounded-full border px-2 py-0.5 font-mono text-[10px] transition',
                      isCurrent
                        ? 'border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                        : 'border-border bg-card/60 text-muted-foreground hover:border-amber-500/40 hover:text-foreground',
                    )}
                    aria-label={`Go to page ${g.page} (${g.count} matches)`}
                  >
                    p.{g.page} × {g.count}
                  </button>
                );
              })}
            </div>
          )}
          {searchInput.trim().length > 0 && !extracting && matchGroups.length === 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              No pages contain “{searchInput.trim()}” — try fewer or different words.
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Thumbnail drawer */}
        {thumbnailsOpen && numPages > 0 && (
          <div className="insightdoc-scroll w-40 shrink-0 overflow-y-auto border-r bg-card/40 p-2">
            {Array.from({ length: Math.min(numPages, 60) }, (_, i) => i + 1).map((page) => (
              <button
                key={page}
                onClick={() => goToPage(page)}
                className={cn(
                  'mb-2 block w-full overflow-hidden rounded border text-left transition',
                  page === pageNumber ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/50',
                )}
                aria-label={`Go to page ${page}`}
              >
                {Math.abs(page - pageNumber) <= 12 ? (
                  <Page
                    pageNumber={page}
                    width={128}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                  />
                ) : (
                  <div className="flex h-[181px] w-[128px] items-center justify-center bg-muted text-xs text-muted-foreground">
                    p. {page}
                  </div>
                )}
              </button>
            ))}
            {numPages > 60 && (
              <p className="px-1 text-[10px] text-muted-foreground">Thumbnails capped at 60 pages</p>
            )}
          </div>
        )}

        {/* Pages */}
        <div
          ref={containerRef}
          onScroll={onScroll}
          className="insightdoc-scroll min-w-0 flex-1 overflow-auto p-4"
          role="region"
          aria-label="PDF document viewer"
        >
          <Document
            file={fileUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={(err) =>
              setLoadError(err?.message ?? 'Failed to load PDF document')
            }
            loading={
              <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Rendering document…
              </div>
            }
            error={
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-destructive">
                <FileWarning className="h-6 w-6" />
                {loadError ?? 'This document could not be displayed.'}
              </div>
            }
            className="mx-auto w-fit"
          >
            {numPages > 0 &&
              Array.from({ length: numPages }, (_, i) => i + 1).map((page) => {
                const inWindow = page >= visibleRange[0] && page <= visibleRange[1];
                const isCitationPage = activeCitation?.page === page;
                const isMatchPage = currentMatchPage === page && searchOpen && totalMatches > 0;
                const matchCountOnPage = matchGroups.find((g) => g.page === page)?.count ?? 0;
                return (
                  <div
                    key={page}
                    ref={(el) => {
                      if (el) pageRefs.current.set(page, el);
                      else pageRefs.current.delete(page);
                    }}
                    className={cn(
                      'relative mx-auto mb-4 overflow-hidden rounded-lg border bg-white shadow-sm transition-shadow',
                      isCitationPage && 'ring-2 ring-cyan-500/70',
                      isMatchPage && 'ring-2 ring-amber-500/80',
                    )}
                    data-page={page}
                  >
                    {inWindow ? (
                      <Page
                        pageNumber={page}
                        scale={effectiveScale}
                        customTextRenderer={customTextRenderer}
                        className="mx-auto"
                        loading={
                          <div style={{ width: 620 * effectiveScale, height: 620 * effectiveScale * A4_ASPECT }} className="flex items-center justify-center bg-muted/50">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                          </div>
                        }
                      />
                    ) : (
                      <div
                        style={{ width: 620 * effectiveScale, height: 620 * effectiveScale * A4_ASPECT }}
                        className="flex items-center justify-center bg-muted/40 text-xs text-muted-foreground"
                      >
                        Page {page}
                      </div>
                    )}
                    <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-background/80 px-2 py-0.5 font-mono text-[10px] text-muted-foreground shadow">
                      p.{page}
                    </span>
                    {searchOpen && matchCountOnPage > 0 && (
                      <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-amber-500/90 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-950 shadow">
                        {matchCountOnPage} match{matchCountOnPage > 1 ? 'es' : ''}
                      </span>
                    )}
                  </div>
                );
              })}
          </Document>
        </div>
      </div>

      {/* Source snippet card */}
      {activeCitation && activeCitation.snippet && (
        <div className="border-t bg-cyan-500/5 px-4 py-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
              Source · page {activeCitation.page}
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setActiveCitation(null)}>
              Dismiss
            </Button>
          </div>
          <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{activeCitation.snippet}</p>
        </div>
      )}
    </div>
  );
}
