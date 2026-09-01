// ============================================================================
// AI provider layer (plan §0 cloud-only; §6 stack; extension quota-router port)
//
// Four cloud providers: Groq, Gemini, DeepSeek, OpenRouter. Groq/DeepSeek/
// OpenRouter speak the OpenAI-compatible chat-completions protocol (SSE
// streaming); Gemini uses its own API (streamGenerateContent with alt=sse).
//
// Failover (plan §0: "429/503 → auto-route to next provider", zero downtime):
// a provider that answers 429/503 or throws a network error is skipped and the
// next one in the chain takes the request. 4xx (bad request etc.) surfaces
// immediately — retrying would not help.
//
// All providers are injectable via `fetchImpl` for deterministic tests.
// ============================================================================

export type ProviderId = "groq" | "gemini" | "deepseek" | "openrouter";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  model: string;
  baseUrl: string;
  /** Builds provider-specific auth headers. */
  headers: (apiKey: string) => Record<string, string>;
  /** OpenAI-compatible protocol vs Gemini protocol. */
  protocol: "openai" | "gemini";
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  groq: {
    id: "groq",
    label: "Groq",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    protocol: "openai",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    model: "gemini-2.0-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    headers: () => ({}), // Gemini uses ?key= query param
    protocol: "gemini",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    protocol: "openai",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    model: "meta-llama/llama-3.3-70b-instruct",
    baseUrl: "https://openrouter.ai/api/v1",
    headers: (k) => ({
      Authorization: `Bearer ${k}`,
      "HTTP-Referer": "https://agent.thesharkweb.com",
      "X-Title": "Zonaed AI",
    }),
    protocol: "openai",
  },
};

const ENV_KEYS: Record<ProviderId, string> = {
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Failover chain (first live provider wins). */
export const FAILOVER_CHAIN: ProviderId[] = ["groq", "gemini", "deepseek", "openrouter"];

/** Providers with a configured API key, in failover order. */
export function availableProviders(env: Record<string, string | undefined>): ProviderConfig[] {
  return FAILOVER_CHAIN.filter((id) => Boolean(env[ENV_KEYS[id]]) && !env[ENV_KEYS[id]]!.startsWith("placeholder")).map(
    (id) => PROVIDERS[id],
  );
}
// ---------------------------------------------------------------------------
// Streaming + failover
// ---------------------------------------------------------------------------

export interface ChatMessageInput {
  role: "system" | "user" | "assistant";
  content: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: ProviderId,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Should a failure trigger failover to the next provider? (plan §0: 429/503) */
export function shouldFailover(err: unknown): boolean {
  if (err instanceof ProviderError) return err.status === 429 || err.status === 503;
  return err instanceof TypeError; // network-level failures
}

function openAiBody(messages: ChatMessageInput[], model: string): Record<string, unknown> {
  return { model, messages, stream: true, temperature: 0.7 };
}

function openAiCompleteBody(messages: ChatMessageInput[], model: string): Record<string, unknown> {
  // Low temperature: extraction/structuring jobs want determinism, not flair.
  return { model, messages, stream: false, temperature: 0.2 };
}


function geminiBody(messages: ChatMessageInput[]): Record<string, unknown> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { temperature: 0.7 },
  };
}

/**
 * Stream a chat completion from one provider. Yields text deltas.
 * Throws ProviderError on HTTP failure (failover decision is the caller's).
 */
export async function* streamFromProvider(
  provider: ProviderConfig,
  apiKey: string,
  messages: ChatMessageInput[],
  fetchImpl: typeof fetch,
): AsyncGenerator<string> {
  const url =
    provider.protocol === "gemini"
      ? `${provider.baseUrl}/models/${provider.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
      : `${provider.baseUrl}/chat/completions`;

  const body = provider.protocol === "gemini" ? geminiBody(messages) : openAiBody(messages, provider.model);

  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...provider.headers(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new ProviderError(
      `${provider.label} error ${res.status}: ${detail.slice(0, 300)}`,
      res.status,
      provider.id,
    );
  }

  // Both protocols speak SSE: "data: {json}" lines with a "data: [DONE]" terminator.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as Record<string, unknown>;
        if (provider.protocol === "gemini") {
          const candidates = json.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
          const text = candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          if (text) yield text;
        } else {
          const choices = json.choices as { delta?: { content?: string } }[] | undefined;
          const text = choices?.[0]?.delta?.content ?? "";
          if (text) yield text;
        }
      } catch {
        // Skip malformed partial lines; providers occasionally send keepalives.
      }
    }
  }
}

export interface StreamWithFailoverResult {
  /** Streams text deltas from the first healthy provider. */
  stream: AsyncGenerator<string>;
  /** The provider that won the failover race. */
  provider: ProviderConfig;
}

async function* prepend(gen: AsyncGenerator<string>, first: string): AsyncGenerator<string> {
  yield first;
  yield* gen;
}

/**
 * Try providers in failover order; returns the first that starts streaming
 * successfully. Failover happens BEFORE any delta is emitted, so the client
 * never sees a half-answer from a dead provider. A provider dying mid-stream
 * after deltas were emitted cannot be retried transparently (documented;
 * the route surfaces an error event in that case).
 */
export async function streamWithFailover(
  providers: ProviderConfig[],
  messages: ChatMessageInput[],
  fetchImpl: typeof fetch = fetch,
): Promise<StreamWithFailoverResult> {
  const errors: string[] = [];
  for (const provider of providers) {
    const apiKey = process.env[ENV_KEYS[provider.id]] ?? "";
    try {
      const gen = streamFromProvider(provider, apiKey, messages, fetchImpl);
      const first = await gen.next();
      if (first.done) {
        // Provider answered OK with an empty body: treat as usable empty response.
        return { stream: gen, provider };
      }
      return { stream: prepend(gen, first.value), provider };
    } catch (err) {
      errors.push(`${provider.label}: ${err instanceof Error ? err.message : String(err)}`);
      if (!shouldFailover(err)) throw err;
    }
  }
  throw new Error(`All providers failed: ${errors.join(" | ")}`);
}

// ---------------------------------------------------------------------------
// Non-streaming completion (same failover semantics, buffered result)
// ---------------------------------------------------------------------------

/**
 * One-shot (non-streaming) completion from a single provider. Used by
 * background jobs (e.g. /api/learn/cron) where SSE has no consumer.
 */
export async function completeFromProvider(
  provider: ProviderConfig,
  apiKey: string,
  messages: ChatMessageInput[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url =
    provider.protocol === "gemini"
      ? `${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(apiKey)}`
      : `${provider.baseUrl}/chat/completions`;

  const body =
    provider.protocol === "gemini"
      ? geminiBody(messages)
      : openAiCompleteBody(messages, provider.model);

  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...provider.headers(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ProviderError(
      `${provider.label} error ${res.status}: ${detail.slice(0, 300)}`,
      res.status,
      provider.id,
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  if (provider.protocol === "gemini") {
    const candidates = json.candidates as
      | { content?: { parts?: { text?: string }[] } }[]
      | undefined;
    return candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  }
  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  return choices?.[0]?.message?.content ?? "";
}

export interface CompleteWithFailoverResult {
  text: string;
  provider: ProviderConfig;
}

/**
 * Non-streaming twin of streamWithFailover: try providers in failover order,
 * return the first successful buffered completion.
 */
export async function completeWithFailover(
  providers: ProviderConfig[],
  messages: ChatMessageInput[],
  fetchImpl: typeof fetch = fetch,
): Promise<CompleteWithFailoverResult> {
  const errors: string[] = [];
  for (const provider of providers) {
    const apiKey = process.env[ENV_KEYS[provider.id]] ?? "";
    try {
      const text = await completeFromProvider(provider, apiKey, messages, fetchImpl);
      return { text, provider };
    } catch (err) {
      errors.push(`${provider.label}: ${err instanceof Error ? err.message : String(err)}`);
      if (!shouldFailover(err)) throw err;
    }
  }
  throw new Error(`All providers failed: ${errors.join(" | ")}`);
}



