import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'InsightDoc — Autonomous PDF Analytics & Vector Search',
    short_name: 'InsightDoc',
    description:
      'Enterprise RAG platform: ingest PDFs, search them semantically, and get streamed, citation-grounded answers with page-accurate deep links.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0F172A',
    theme_color: '#0F172A',
    categories: ['productivity', 'business', 'utilities'],
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
