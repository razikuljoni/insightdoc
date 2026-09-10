/**
 * InsightDoc — AI provider bootstrap (server-only)
 *
 * Provides process-cached AI client construction and model discovery.
 * Supports environment variables (AI_API_KEY, AI_BASE_URL, AI_MODEL) or disk config.
 *
 * NEVER import this module from client components — credentials must stay server-side.
 */
export type AIClient = Awaited<ReturnType<(typeof import('z-ai-web-dev-sdk'))['default']['create']>>;
type AIConfig = { baseUrl: string; apiKey: string; userId?: string; token?: string };
type AICtor = new (config: AIConfig) => AIClient;

function sanitizeClient(client: AIClient): AIClient {
  const origCreate = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = (async (body: Parameters<typeof origCreate>[0]) => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.body && typeof init.body === 'string') {
          try {
            const data = JSON.parse(init.body);
            if ('thinking' in data) {
              delete data.thinking;
              init = { ...init, body: JSON.stringify(data) };
            }
          } catch {
            // empty catch
          }
        }
        return origFetch(input, init);
      }) as typeof fetch;
      return await origCreate(body);
    } finally {
      globalThis.fetch = origFetch;
    }
  }) as typeof origCreate;
  return client;
}

let cached: AIClient | null = null;

async function load(): Promise<AIClient> {
  const { default: AIClientCtor } = await import('z-ai-web-dev-sdk');

  const apiKey = process.env.AI_API_KEY || process.env.ZAI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || process.env.ZAI_BASE_URL;
  const userId = process.env.AI_USER_ID || process.env.ZAI_USER_ID;
  const token = process.env.AI_TOKEN || process.env.ZAI_TOKEN;

  if (apiKey && baseUrl) {
    // Environment-variable mode — required on Vercel and other platforms
    const Ctor = AIClientCtor as unknown as AICtor;
    const instance = new Ctor({
      apiKey,
      baseUrl,
      ...(userId ? { userId } : {}),
      ...(token ? { token } : {}),
    });
    return sanitizeClient(instance);
  }

  if (apiKey && !baseUrl) {
    throw new Error(
      'AI_API_KEY is set but AI_BASE_URL is missing. Set both environment variables, or neither to use file-based .z-ai-config discovery.',
    );
  }

  // Local/self-hosted mode — SDK discovers config file on disk.
  try {
    return sanitizeClient(await AIClientCtor.create());
  } catch {
    throw new Error(
      'AI credentials missing. Set AI_API_KEY and AI_BASE_URL environment variables (e.g. in Vercel or .env), or create a .z-ai-config file in project root.',
    );
  }
}

/** Returns the active AI model name configured in environment or default fallback. */
export function getAIModel(): string {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (process.env.ZAI_MODEL) return process.env.ZAI_MODEL;
  return 'gemini-3.1-flash-lite';
}

/** Returns a process-cached, env-aware AI client. Server-side only. */
export async function getAIClient(): Promise<AIClient> {
  if (!cached) cached = await load();
  return cached;
}

// Backwards-compatibility aliases
export const getZAIModel = getAIModel;
export const getZAI = getAIClient;
export type ZAIClient = AIClient;
