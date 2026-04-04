/**
 * Prompt caching utilities.
 *
 * - Anthropic: explicit cacheControl with 1h TTL on system prompts (2x write, 0.25x read)
 * - OpenAI: automatic for >1024 tokens (no config needed)
 * - OpenRouter/Gemini: supports cache_control on content blocks
 *
 * Since our system prompts are large and reused every 5-15 min,
 * we use the longest available TTL (1h) for maximum savings.
 */

type Provider = 'anthropic' | 'openai' | 'openrouter';

/**
 * Wraps a system prompt as a messages array with cache control.
 * Use this instead of the `system` parameter in generateText
 * to enable prompt caching on all providers.
 *
 * Usage:
 *   generateText({
 *     model: getModel(role),
 *     messages: [
 *       ...cachedSystemPrompt(SYSTEM_PROMPT, provider),
 *       { role: 'user', content: userPrompt },
 *     ],
 *     // NO `system` param — it's in messages now
 *   })
 */
export function cachedSystemPrompt(
  systemPrompt: string,
  provider: Provider,
): Array<{ role: 'system'; content: any; providerOptions?: any }> {
  if (provider === 'anthropic') {
    return [{
      role: 'system' as const,
      content: systemPrompt,
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral', ttl: '1h' },
        },
      },
    }];
  }

  if (provider === 'openrouter') {
    // OpenRouter passes cache_control to underlying provider (Gemini, Anthropic, etc.)
    return [{
      role: 'system' as const,
      content: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      }] as any,
    }];
  }

  // OpenAI: automatic caching for >1024 tokens, no special config needed
  return [{
    role: 'system' as const,
    content: systemPrompt,
  }];
}

/**
 * Returns provider-specific caching options to merge into providerOptions.
 * For OpenAI, adds a stable promptCacheKey per role for better cache hits.
 */
export function getCacheProviderOptions(role: string, provider: Provider): Record<string, any> {
  if (provider === 'openai') {
    return {
      openai: {
        // Stable key per role improves cache hit rate across cycles
        promptCacheKey: `trading-agent-${role}`,
      },
    };
  }
  return {};
}

/**
 * Merges multiple providerOptions objects (effort + caching).
 */
export function mergeProviderOptions(...options: Array<Record<string, any> | undefined>): Record<string, any> | undefined {
  const merged: Record<string, any> = {};
  for (const opt of options) {
    if (!opt) continue;
    for (const [provider, settings] of Object.entries(opt)) {
      merged[provider] = { ...merged[provider], ...settings };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
