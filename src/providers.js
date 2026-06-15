/**
 * Provider Fallback Chain Configuration
 *
 * Order:
 *  1. Xiaomi Mimo (mimo-v2.5) — Key A first, Key B on auth/rate error
 *  2. NVIDIA (deepseek-ai/deepseek-v4-pro)
 *  3. B.ai (deepseek-v4-flash)
 *  4. TokenLB (claude-sonnet-4-6)
 *
 * If a provider returns an HTTP error or network error the chain moves to the
 * next provider automatically.  The caller never sees the failover.
 */

// ─── Provider definitions ─────────────────────────────────────────────────────

/**
 * Each entry in PROVIDERS may optionally export `getApiKeys()` returning an
 * array of keys to try in sequence before failing over to the next provider.
 */
export const PROVIDERS = [

  // ── 1. Xiaomi Mimo ──────────────────────────────────────────────────────────
  {
    name: 'Xiaomi Mimo (mimo-v2.5)',
    model: process.env.XIAOMI_MODEL || 'mimo-v2.5',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
    // Two keys — A is tried first, B is the backup
    getApiKeys: () => [
      process.env.XIAOMI_API_KEY_A,
      process.env.XIAOMI_API_KEY_B,
    ].filter(Boolean),
    headers: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
  },

  // ── 1. Kimchi minimax-m3 ───────────────────────────────────────────────────
  {
    name: 'Kimchi (minimax-m3)',
    model: 'minimax-m3',
    baseUrl: 'https://llm.kimchi.dev/openai/v1/chat/completions',
    getApiKeys: () => [
      process.env.KIMCHI_API_KEY || 'minimax-m3',
    ].filter(Boolean),
    headers: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
  },


  // ── 2. NVIDIA minimax-m3 ───────────────────────────────────────────────────
  {
    name: 'NVIDIA (minimaxai/minimax-m3)',
    model: 'minimaxai/minimax-m3',
    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    getApiKeys: () => [process.env.NVIDIA_API_KEY].filter(Boolean),
    headers: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
  },


  // ── 4. TokenLB Claude Sonnet 4-6 ────────────────────────────────────────────
  {
    name: 'TokenLB (claude-sonnet-4-6)',
    model: 'claude-sonnet-4-6',
    baseUrl: 'https://tokenlb.net/v1/chat/completions',
    getApiKeys: () => [process.env.TOKENLB_API_KEY].filter(Boolean),
    headers: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
  },
];

// ─── Message normalisation ────────────────────────────────────────────────────

function normalizeTools(tools) {
  return Array.isArray(tools) && tools.length > 0 ? tools : undefined;
}

function normalizeMessages(messages = []) {
  const normalized = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== 'object') continue;

    if (
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      const expectedIds = new Set(
        message.tool_calls.map((tc) => tc.id).filter(Boolean),
      );
      const followingToolMessages = [];
      let j = i + 1;

      while (j < messages.length && messages[j]?.role === 'tool') {
        followingToolMessages.push(messages[j]);
        j++;
      }

      const returnedIds = new Set(
        followingToolMessages.map((tm) => tm.tool_call_id).filter(Boolean),
      );
      const hasAllToolResults =
        expectedIds.size > 0 &&
        [...expectedIds].every((id) => returnedIds.has(id));

      if (hasAllToolResults) {
        normalized.push(message);
        normalized.push(...followingToolMessages);
        i = j - 1;
      } else {
        const { tool_calls, ...assistantWithoutToolCalls } = message;
        normalized.push({
          ...assistantWithoutToolCalls,
          content: assistantWithoutToolCalls.content ?? '',
        });
        i = j - 1;
      }
      continue;
    }

    if (message.role === 'tool') continue;
    normalized.push(message);
  }

  return normalized;
}

// ─── Core fallback function ───────────────────────────────────────────────────

/**
 * Attempts to call each provider (and each key within a provider) in sequence
 * until one succeeds.  Returns `{ data, providerName, model }` on success, or
 * throws `{ message, errors }` if every option is exhausted.
 *
 * For streaming requests returns `{ stream, providerName, model }`.
 */
export async function callWithFallback(messages, options = {}) {
  const { temperature, max_tokens, stream, model: requestedModel, tools } = options;
  const normalizedTools = normalizeTools(tools);
  const normalizedMessages = normalizeMessages(messages);
  const errors = [];

  const targetModelName = requestedModel || 'force-model';

  for (const provider of PROVIDERS) {
    const keys = provider.getApiKeys();

    if (!keys || keys.length === 0) {
      errors.push({ provider: provider.name, error: 'API key(s) not configured' });
      continue;
    }

    // Try each key in this provider before moving on
    for (const apiKey of keys) {
      if (!apiKey || apiKey.startsWith('your_')) {
        errors.push({ provider: provider.name, error: 'Invalid API key placeholder' });
        continue;
      }

      try {
        console.log(
          `[Gateway] Routing "${targetModelName}" → ${provider.name} [key: ...${apiKey.slice(-6)}]`,
        );

        const body = {
          model: provider.model,
          messages: normalizedMessages,
          ...(temperature !== undefined && { temperature }),
          ...(max_tokens !== undefined && { max_tokens }),
          ...(stream !== undefined && { stream }),
          ...(normalizedTools && { tools: normalizedTools }),
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_800_000); // 30 min

        const response = await fetch(provider.baseUrl, {
          method: 'POST',
          headers: provider.headers(apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text();
          const status = response.status;
          console.warn(
            `[Gateway] ${provider.name} → ${status}: ${errorText.substring(0, 200)}`,
          );
          errors.push({ provider: provider.name, status, error: errorText.substring(0, 200) });

          // 401 / 403 / 429 on this key → try next key in same provider
          if ([401, 403, 429].includes(status)) continue;

          // Other 4xx/5xx → skip to next provider entirely
          break;
        }

        if (stream) {
          return { stream: response.body, providerName: provider.name, model: provider.model };
        }

        const data = await response.json();
        console.log(`[Gateway] ✓ Success via ${provider.name}`);
        return { data, providerName: provider.name, model: provider.model };

      } catch (err) {
        const errorMsg = err.name === 'AbortError' ? 'Timeout (30 min)' : `Network Error: ${err.message}`;
        console.error(`[Gateway] ${provider.name} exception: ${errorMsg}`);
        errors.push({ provider: provider.name, error: errorMsg });
        // Network error — try next key then next provider
        continue;
      }
    }
  }

  throw { message: 'All providers failed.', errors };
}
