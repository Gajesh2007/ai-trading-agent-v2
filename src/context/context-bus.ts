import type { HLAsset, PredictionEvent } from '../schemas/discovery.js';
import { fetchAllTradableAssets } from '../data-sources/hyperliquid.js';
import { fetchPolymarketEvents } from '../data-sources/polymarket.js';
import { fetchKalshiEvents } from '../data-sources/kalshi.js';
import { readAllSignalCaches, getActiveTheses, getOpenPositions, getRecentRejections, type Rejection } from '../state/manager.js';
import { getAllExchanges, type ExchangeAsset } from '../exchanges/index.js';
import type { Thesis } from '../schemas/thesis.js';
import type { Position } from '../schemas/position.js';
import { log } from '../logger.js';

// --- Discovery Context (Layer 1 → Discovery Scanner) ---

export interface DiscoveryContext {
  assets: HLAsset[];
  categories: Record<string, string>;
  kalshiEvents: PredictionEvent[];
  polymarketEvents: PredictionEvent[];
  signals: Record<string, unknown>;
  recentRejections: Rejection[];
  fetchedAt: string;
  errors: string[];
  // Multi-exchange: additional assets from other exchanges
  exchangeAssets: ExchangeAsset[];
  activeExchanges: string[];
}

export async function assembleDiscoveryContext(): Promise<DiscoveryContext> {
  const errors: string[] = [];
  const exchangeNames = getAllExchanges().map(e => e.name);
  const hasHL = exchangeNames.includes('hyperliquid');

  // Fetch HL assets only if Hyperliquid is registered
  const fetches: Promise<any>[] = [
    hasHL ? fetchAllTradableAssets() : Promise.resolve(null),
    fetchKalshiEvents(),
    fetchPolymarketEvents(),
  ];

  const [hlResult, kalshiResult, polymarketResult] = await Promise.allSettled(fetches);

  let assets: HLAsset[] = [];
  let categories: Record<string, string> = {};

  if (hasHL && hlResult.status === 'fulfilled' && hlResult.value) {
    assets = hlResult.value.assets;
    categories = Object.fromEntries(hlResult.value.categories);
  } else if (hasHL && hlResult.status === 'rejected') {
    errors.push(`Hyperliquid: ${hlResult.reason}`);
  }

  const kalshiEvents = kalshiResult.status === 'fulfilled'
    ? kalshiResult.value
    : (errors.push(`Kalshi: ${kalshiResult.reason}`), []);

  const polymarketEvents = polymarketResult.status === 'fulfilled'
    ? polymarketResult.value
    : (errors.push(`Polymarket: ${polymarketResult.reason}`), []);

  // Read pre-processed signals from Layer 1 agents
  const signals = readAllSignalCaches();

  // Fetch assets from all registered exchanges (includes HL + Public.com + any future exchanges)
  const exchanges = getAllExchanges();
  const activeExchanges: string[] = [];
  const exchangeAssets: ExchangeAsset[] = [];

  // Fetch non-HL exchange assets in parallel
  const otherExchanges = exchanges.filter(e => e.name !== 'hyperliquid');
  if (otherExchanges.length > 0) {
    const exchangeResults = await Promise.allSettled(
      otherExchanges.map(async e => {
        const assets = await e.fetchAssets();
        return { name: e.name, assets };
      }),
    );

    for (const r of exchangeResults) {
      if (r.status === 'fulfilled') {
        activeExchanges.push(r.value.name);
        exchangeAssets.push(...r.value.assets);
      } else {
        errors.push(`Exchange ${(r as any).reason?.name ?? 'unknown'}: ${r.reason}`);
      }
    }
  }

  // HL is always an active exchange if it returned data
  if (assets.length > 0) activeExchanges.unshift('hyperliquid');

  if (errors.length > 0) {
    log({ level: 'warn', event: 'context_partial', data: { errors } });
  }

  const recentRejections = getRecentRejections(24);

  return {
    assets, categories, kalshiEvents, polymarketEvents,
    signals, recentRejections, fetchedAt: new Date().toISOString(), errors,
    exchangeAssets, activeExchanges,
  };
}

// --- Synthesis Context (Discovery Candidate → Thesis Generator) ---

export interface SynthesisContext extends DiscoveryContext {
  candidateTicker: string;
  relevantAssets: HLAsset[];
  relevantEvents: PredictionEvent[];
  relevantExchangeAssets: ExchangeAsset[];
}

export function assembleSynthesisContext(base: DiscoveryContext, ticker: string): SynthesisContext {
  const rawTicker = ticker.replace('xyz:', '').replace('pub:', '');
  return {
    ...base,
    candidateTicker: ticker,
    relevantAssets: base.assets.filter(a =>
      a.symbol === ticker || a.symbol.includes(rawTicker)
    ),
    relevantEvents: [...base.kalshiEvents, ...base.polymarketEvents].filter(e =>
      e.title.toLowerCase().includes(rawTicker.toLowerCase()) ||
      e.markets.some(m => m.question.toLowerCase().includes(rawTicker.toLowerCase()))
    ),
    relevantExchangeAssets: base.exchangeAssets.filter(a =>
      a.symbol === rawTicker || a.symbol.includes(rawTicker)
    ),
  };
}

// --- Monitoring Context (Thesis Validator) ---

export interface MonitoringContext {
  thesis: Thesis;
  position: Position;
  currentAsset: HLAsset | undefined;
  signals: Record<string, unknown>;
  relevantEvents: PredictionEvent[];
  fetchedAt: string;
}

export function assembleMonitoringContext(
  base: DiscoveryContext,
  thesis: Thesis,
  position: Position,
): MonitoringContext {
  const rawTicker = thesis.ticker.replace('xyz:', '').replace('pub:', '');
  return {
    thesis,
    position,
    currentAsset: base.assets.find(a => a.symbol === thesis.ticker),
    signals: base.signals,
    relevantEvents: [...base.kalshiEvents, ...base.polymarketEvents].filter(e =>
      e.title.toLowerCase().includes(rawTicker.toLowerCase()) ||
      e.markets.some(m => m.question.toLowerCase().includes(rawTicker.toLowerCase()))
    ),
    fetchedAt: base.fetchedAt,
  };
}
