import type { PredictionEvent } from '../schemas/discovery.js';
import { log } from '../logger.js';
import { withRetry } from '../utils/retry.js';

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';

// Categories most relevant to trading
const RELEVANT_CATEGORIES = [
  'Economics',
  'Financial',
  'Fed',
  'Climate and Weather',
  'Companies',
  'Crypto',
  'World',
  'Elections',
  'Congress',
] as const;

interface KalshiMarket {
  ticker: string;
  title: string;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  last_price_dollars: string;
  volume_fp: string;
  close_time: string;
  status: string;
  yes_sub_title?: string;
}

interface KalshiEvent {
  event_ticker: string;
  title: string;
  category: string;
  sub_title?: string;
  series_ticker: string;
  markets: KalshiMarket[];
}

async function fetchKalshiPage(cursor?: string): Promise<{ events: KalshiEvent[]; cursor: string }> {
  const params = new URLSearchParams({
    limit: '100',
    status: 'open',
    with_nested_markets: 'true',
  });
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(`${KALSHI_API}/events?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  const data = await res.json() as any;
  return { events: data.events ?? [], cursor: data.cursor ?? '' };
}

export async function fetchKalshiEvents(): Promise<PredictionEvent[]> {
  return withRetry(async () => {
    // Fetch first 2 pages (up to 200 events)
    const page1 = await fetchKalshiPage();
    let allEvents = page1.events;

    if (page1.cursor) {
      try {
        const page2 = await fetchKalshiPage(page1.cursor);
        allEvents = [...allEvents, ...page2.events];
      } catch {
        // First page is enough
      }
    }

    // Filter to relevant categories
    const relevant = allEvents.filter(evt =>
      RELEVANT_CATEGORIES.some(cat =>
        evt.category?.toLowerCase().includes(cat.toLowerCase())
      )
    );

    const events: PredictionEvent[] = relevant.map(evt => ({
      source: 'kalshi' as const,
      id: evt.event_ticker,
      title: evt.title + (evt.sub_title ? ` — ${evt.sub_title}` : ''),
      category: evt.category,
      markets: evt.markets
        .filter(m => m.status === 'active')
        .map(m => ({
          id: m.ticker,
          question: m.title + (m.yes_sub_title ? ` (${m.yes_sub_title})` : ''),
          yesPrice: parseFloat(m.last_price_dollars || m.yes_bid_dollars || '0'),
          volume: parseFloat(m.volume_fp || '0'),
          endDate: m.close_time,
        })),
    })).filter(e => e.markets.length > 0);

    log({
      level: 'info',
      event: 'kalshi_fetched',
      data: { total: allEvents.length, relevant: relevant.length, withMarkets: events.length },
    });

    return events;
  }, { label: 'kalshi-fetch' });
}
