/**
 * InsightDoc — AI provider bootstrap (server-only)
 *
 * z-ai-web-dev-sdk resolves credentials from a `.z-ai-config` JSON file on
 * disk (cwd → home → /etc). That works for local/self-hosted runs but NOT on
 * read-only serverless filesystems (e.g. Vercel), where no such file exists.
 *
 * getZAI() adds first-class environment support:
 *   1. If ZAI_API_KEY and ZAI_BASE_URL are both set → construct the client
 *      directly from env vars (recommended for Vercel / Docker / CI).
 *   2. Otherwise → fall back to the SDK's file-based config discovery.
 *
 * The client instance is cached per serverless invocation context, so warm
 * starts skip construction entirely.
 *
 * NEVER import this module from client components — the SDK must stay
 * server-side so credentials are never shipped to the browser.
 */
type ZAIClient = Awaited<ReturnType<(typeof import('z-ai-web-dev-sdk'))['default']['create']>>;
type ZAIConfig = { baseUrl: string; apiKey: string; userId?: string; token?: string };
// The SDK's bundled .d.ts marks the constructor private (create() is the only
// typed entry point, and it is hard-wired to file-based config). The runtime
// constructor is public — this cast just restores access for env mode.
type ZAICtor = new (config: ZAIConfig) => ZAIClient;

let cached: ZAIClient | null = null;

async function load(): Promise<ZAIClient> {
  const { default: ZAIClientCtor } = await import('z-ai-web-dev-sdk');

  const apiKey = process.env.ZAI_API_KEY;
  const baseUrl = process.env.ZAI_BASE_URL;

  if (apiKey && baseUrl) {
    // Environment-variable mode — required on Vercel and other platforms
    // without a readable .z-ai-config file.
    const Ctor = ZAIClientCtor as unknown as ZAICtor;
    return new Ctor({
      apiKey,
      baseUrl,
      ...(process.env.ZAI_USER_ID ? { userId: process.env.ZAI_USER_ID } : {}),
      ...(process.env.ZAI_TOKEN ? { token: process.env.ZAI_TOKEN } : {}),
    });
  }

  if (apiKey && !baseUrl) {
    throw new Error(
      'ZAI_API_KEY is set but ZAI_BASE_URL is missing. Set both environment variables, or neither to use file-based .z-ai-config discovery.',
    );
  }

  // Local/self-hosted mode — SDK discovers .z-ai-config on disk.
  return ZAIClientCtor.create();
}

/** Returns a process-cached, env-aware z-ai SDK client. Server-side only. */
export async function getZAI(): Promise<ZAIClient> {
  if (!cached) cached = await load();
  return cached;
}
