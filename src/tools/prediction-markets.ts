import { tool } from 'ai';
import { z } from 'zod';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export const predictionMarketTools = {
  searchPolymarket: tool({
    description: `Search Polymarket for prediction market events by category.
      Use tag_slug to filter: crypto, finance, economics, politics,
      business, crypto-prices, geopolitics, elections.
      Returns events with market questions and current odds.`,
    inputSchema: z.object({
      tagSlug: z.string().describe('Category to search, e.g. "crypto", "finance", "politics"'),
      limit: z.number().optional().default(10),
    }),
    execute: async ({ tagSlug, limit }) => {
      const url = `${GAMMA_API}/events?limit=${limit}&active=true&closed=false&tag_slug=${tagSlug}`;
      const res = await fetch(url);
      if (!res.ok) return { error: `API returned ${res.status}` };
      const events = await res.json() as any[];
      return events.map(e => ({
        id: e.id,
        title: e.title,
        tags: e.tags?.map((t: any) => t.label) ?? [],
        volume: e.volume,
        markets: (e.markets ?? []).slice(0, 3).map((m: any) => {
          let prices = { yes: 0, no: 0 };
          try { const p = JSON.parse(m.outcomePrices); prices = { yes: +p[0], no: +p[1] }; } catch {}
          return { question: m.question, yesPrice: prices.yes, volume: m.volume };
        }),
      }));
    },
  }),
};
