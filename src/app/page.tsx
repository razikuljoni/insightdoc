import { InsightDocApp } from '@/components/insightdoc/insightdoc-app';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://insightdoc.vercel.app';

/**
 * JSON-LD structured data — makes InsightDoc machine-understandable for
 * search engines and AI crawlers (Google rich results, ChatGPT/Perplexity
 * citations, etc.). Rendered on the server; invisible to users.
 */
function StructuredData() {
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'InsightDoc',
      alternateName: 'InsightDoc RAG Platform',
      url: SITE_URL,
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Document Intelligence / Retrieval-Augmented Generation',
      operatingSystem: 'Web (self-hostable)',
      description:
        'Autonomous PDF analytics and vector search pipeline. Ingest dense PDFs into a chunked vector index and interrogate them with streamed, citation-grounded answers, page-accurate deep links, AI digests, OCR for scanned documents, and usage analytics.',
      featureList: [
        'PDF ingestion with chunking, deduplication and background processing',
        'Hybrid vector + keyword search with reciprocal-rank-fusion reranking',
        'Streamed, citation-grounded chat with page-accurate PDF deep links',
        'AI document digests with share-to-chat and multi-document compare',
        'OCR fallback for scanned documents (tesseract.js)',
        'Usage and cost analytics dashboard',
        'Voice input and speech output',
      ],
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
      keywords:
        'RAG, vector search, PDF analytics, document intelligence, enterprise search, citations, OCR',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What is InsightDoc?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'InsightDoc is an open-source, enterprise-grade RAG (retrieval-augmented generation) platform that ingests PDFs into a chunked vector index and answers questions about them with streamed, citation-grounded responses linked to the exact source page.',
          },
        },
        {
          '@type': 'Question',
          name: 'Does InsightDoc work with scanned PDFs?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Yes. Documents without an embedded text layer are routed through an OCR fallback built on tesseract.js, so scanned documents are indexed and searchable too.',
          },
        },
        {
          '@type': 'Question',
          name: 'Can InsightDoc be self-hosted?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Yes. InsightDoc is MIT-licensed and ships with a Next.js standalone build. It runs on Vercel, in Docker, or on any Node/Bun host, with SQLite out of the box and documented upgrade paths to Postgres and object storage.',
          },
        },
      ],
    },
  ];
  return (
    <script
      type="application/ld+json"
      // Static, developer-authored JSON — no user input is interpolated.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}

export default function Page() {
  return (
    <>
      <StructuredData />
      <InsightDocApp />
    </>
  );
}
