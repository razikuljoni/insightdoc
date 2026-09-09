'use client';

/**
 * Renders assistant/user message content with inline citation markers.
 * The LLM is instructed to emit bracketed [n] markers; the renderer converts
 * them into clickable pills that deep-link the PDF viewer (spec §2.3/§6.2).
 */
import { Fragment, memo, useMemo } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Citation } from '@/lib/types';
import { useAppStore } from './store';

const CITATION_SOURCE = /\[(\d{1,2})\]/g.source;

interface RenderProps {
  content: string;
  citations: Citation[];
  streaming?: boolean;
}

/** Bold + inline-code emphasis for the light markdown subset the model emits. */
function renderEmphasis(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      parts.push(
        <strong key={`${keyPrefix}-b${i++}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code key={`${keyPrefix}-c${i++}`} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export const MessageContent = memo(function MessageContent({ content, citations, streaming }: RenderProps) {
  const jumpToCitation = useAppStore((s) => s.jumpToCitation);

  const onCitation = (c: Citation) => {
    jumpToCitation(c.documentId, c.pageNumber, c);
  };

  const blocks = useMemo(() => {
    const raw = content.replace(/\r\n/g, '\n');
    return raw.split(/\n{2,}/);
  }, [content]);

  const inline = (text: string, keyPrefix: string) => {
    // Split by citation markers first, then apply emphasis to plain segments
    const segments: React.ReactNode[] = [];
    const citationRe = new RegExp(CITATION_SOURCE, 'g');
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = citationRe.exec(text)) !== null) {
      const n = Number(match[1]);
      if (n < 1 || n > citations.length) continue;
      if (match.index > lastIndex) {
        segments.push(...renderEmphasis(text.slice(lastIndex, match.index), `${keyPrefix}-e${lastIndex}`));
      }
      const citation = citations[n - 1];
      segments.push(
        <Button
          key={`${keyPrefix}-cit${match.index}`}
          variant="outline"
          size="sm"
          title={`${citation.documentTitle} — page ${citation.pageNumber}`}
          aria-label={`Open citation ${n}: ${citation.documentTitle}, page ${citation.pageNumber}`}
          onClick={() => onCitation(citation)}
          className="mx-0.5 inline-flex h-5 items-center gap-1 rounded-full border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0 font-mono text-[10px] font-medium text-cyan-600 hover:bg-cyan-500/20 dark:text-cyan-300"
        >
          <FileText className="h-2.5 w-2.5" aria-hidden />
          {citation.documentTitle.length > 18 ? `${citation.documentTitle.slice(0, 17)}…` : citation.documentTitle} · p.{citation.pageNumber}
        </Button>,
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      segments.push(...renderEmphasis(text.slice(lastIndex), `${keyPrefix}-e${lastIndex}`));
    }
    return segments;
  };

  return (
    <div className={streaming ? 'streaming-caret' : undefined}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const isBullet = lines.every((l) => /^\s*[-*•]\s+/.test(l));
        const isNumbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));

        if (isBullet && lines.length > 0) {
          return (
            <ul key={`b${bi}`} className="my-1.5 list-disc space-y-1 pl-5">
              {lines.map((line, li) => (
                <li key={`b${bi}-${li}`}>{inline(line.replace(/^\s*[-*•]\s+/, ''), `b${bi}-${li}`)}</li>
              ))}
            </ul>
          );
        }
        if (isNumbered && lines.length > 0) {
          return (
            <ol key={`b${bi}`} className="my-1.5 list-decimal space-y-1 pl-5">
              {lines.map((line, li) => (
                <li key={`b${bi}-${li}`}>{inline(line.replace(/^\s*\d+[.)]\s+/, ''), `b${bi}-${li}`)}</li>
              ))}
            </ol>
          );
        }
        const headingMatch = /^#{1,4}\s+(.*)$/.exec(block);
        if (headingMatch) {
          return (
            <p key={`b${bi}`} className="mt-2 mb-1 text-sm font-semibold">
              {inline(headingMatch[1], `h${bi}`)}
            </p>
          );
        }
        return (
          <p key={`b${bi}`} className="my-1.5 whitespace-pre-wrap leading-relaxed">
            {inline(block, `p${bi}`)}
          </p>
        );
      })}
    </div>
  );
});
