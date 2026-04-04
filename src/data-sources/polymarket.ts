import type { PredictionEvent } from '../schemas/discovery.js';
import { log } from '../logger.js';
import { withRetry } from '../utils/retry.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Categories relevant to crypto/equity markets
const RELEVANT_TAG_SLUGS = [
  'crypto',
  'finance',
  'economics',
  'politics',
  'business',
  'crypto-prices',
  'geopolitics',
] as const;

interface GammaMarket {
  id: string;
  question: string;
  outcomePrices: string; // JSON string: '["0.55", "0.45"]'
  volume: number;
  liquidity?: number;
  bestBid?: number;
  bestAsk?: number;
  endDate: string;
  active: boolean;
  closed: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  tags: Array<{ label: string; slug: string }>;
  markets: GammaMarket[];
  volume: number;
  active: boolean;
  closed: boolean;
}

async function fetchByTagSlug(tagSlug: string, limit = 20): Promise<GammaEvent[]> {
  return withRetry(async () => {
    const url = `${GAMMA_API}/events?limit=${limit}&active=true&closed=false&tag_slug=${tagSlug}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Polymarket API error: ${res.status}`);
    return res.json() as Promise<GammaEvent[]>;
  }, { label: `polymarket-${tagSlug}` });
}

function parseOutcomePrices(raw: string): { yes: number; no: number } {
  try {
    const parsed = JSON.parse(raw) as string[];
    return { yes: parseFloat(parsed[0] ?? '0'), no: parseFloat(parsed[1] ?? '0') };
  } catch {
    return { yes: 0, no: 0 };
  }
}

function normalizeEvent(evt: GammaEvent): PredictionEvent {
  return {
    source: 'polymarket',
    id: evt.id,
    title: evt.title,
    category: evt.tags?.map(t => t.label).join(', ') ?? undefined,
    markets: (evt.markets ?? [])
      .filter(m => m.active && !m.closed)
      .map(m => {
        const prices = parseOutcomePrices(m.outcomePrices);
        return {
          id: m.id,
          question: m.question,
          yesPrice: prices.yes,
          volume: m.volume,
          endDate: m.endDate,
        };
      }),
  };
}

export async function fetchPolymarketEvents(): Promise<PredictionEvent[]> {
  const results = await Promise.allSettled(
    RELEVANT_TAG_SLUGS.map(tag => fetchByTagSlug(tag))
  );

  const seen = new Set<string>();
  const events: PredictionEvent[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      for (const evt of result.value) {
        if (!seen.has(evt.id)) {
          seen.add(evt.id);
          const normalized = normalizeEvent(evt);
          if (normalized.markets.length > 0) {
            events.push(normalized);
          }
        }
      }
    } else {
      log({
        level: 'warn',
        event: 'polymarket_fetch_failed',
        data: { tag: RELEVANT_TAG_SLUGS[i], error: String(result.reason) },
      });
    }
  }

  return events;
}
