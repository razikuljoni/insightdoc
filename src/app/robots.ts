import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://insightdoc.vercel.app';

/**
 * robots.txt — welcomes search engines AND AI crawlers explicitly.
 * Served at /robots.txt by the Next.js Metadata API (replaces public/robots.txt).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Main search engines
      { userAgent: 'Googlebot', allow: '/' },
      { userAgent: 'Bingbot', allow: '/' },
      { userAgent: 'DuckDuckBot', allow: '/' },
      // AI crawlers / answer engines — InsightDoc is meant to be discoverable
      { userAgent: 'GPTBot', allow: '/' },
      { userAgent: 'OAI-SearchBot', allow: '/' },
      { userAgent: 'ChatGPT-User', allow: '/' },
      { userAgent: 'ClaudeBot', allow: '/' },
      { userAgent: 'PerplexityBot', allow: '/' },
      { userAgent: 'Google-Extended', allow: '/' },
      { userAgent: 'Applebot-Extended', allow: '/' },
      { userAgent: 'CCBot', allow: '/' },
      { userAgent: 'Amazonbot', allow: '/' },
      { userAgent: 'meta-externalagent', allow: '/' },
      // Everyone else
      { userAgent: '*', allow: '/', disallow: ['/api/'] },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
