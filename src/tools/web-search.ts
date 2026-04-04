import { anthropic } from '@ai-sdk/anthropic';
import { tool } from 'ai';
import { z } from 'zod';
import { withRetry } from '../utils/retry.js';

// Claude's native web search — only works with Anthropic models
const claudeWebSearch = anthropic.tools.webSearch_20250305({
  maxUses: 5,
});

// Fallback web search for non-Anthropic models (Tavily / Brave)
const fallbackWebSearch = tool({
  description: `Search the web for current information. Use for:
    - Breaking news affecting specific tickers or sectors
    - Recent earnings reports and analyst reactions
    - Macro economic data releases and Fed commentary
    - Regulatory announcements and policy changes
    Keep queries specific and concise (3-6 words).`,
  inputSchema: z.object({
    query: z.string().describe('Search query'),
  }),
  execute: async ({ query }) => {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      return withRetry(async () => {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5, include_answer: true }),
        });
        if (!res.ok) throw new Error(`Tavily error: ${res.status}`);
        const data = await res.json() as any;
        return {
          answer: data.answer,
          results: (data.results ?? []).map((r: any) => ({
            title: r.title, url: r.url, snippet: r.content?.slice(0, 300),
          })),
        };
      }, { label: 'tavily-search' });
    }
    return { error: 'No search API configured. Set TAVILY_API_KEY for non-Anthropic models.' };
  },
});

export const fetchWebPage = tool({
  description: `Fetch and read the content of a web page. Use after finding a relevant
    search result you need to read in detail. Returns text content, capped at ~2K tokens.`,
  inputSchema: z.object({
    url: z.string().describe('Full URL to fetch'),
  }),
  execute: async ({ url }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TradingAgent/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const text = await res.text();
      const clean = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
      return { content: clean, url };
    } catch (e: any) {
      return { error: e.message };
    }
  },
});

/**
 * Returns web tools appropriate for the given model provider.
 * - Anthropic models get Claude's native web search (better, no extra key)
 * - Other models get Tavily fallback
 */
export function getWebToolsForProvider(provider: string): Record<string, any> {
  const tools: Record<string, any> = { fetchWebPage };

  if (provider === 'anthropic') {
    tools.web_search = claudeWebSearch;
  } else {
    tools.webSearch = fallbackWebSearch;
  }

  return tools;
}
