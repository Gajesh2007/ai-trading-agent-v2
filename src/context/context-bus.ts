import type { HLAsset, PredictionEvent } from '../schemas/discovery.js';
import { fetchAllTradableAssets } from '../data-sources/hyperliquid.js';
import { fetchPolymarketEvents } from '../data-sources/polymarket.js';
import { fetchKalshiEvents } from '../data-sources/kalshi.js';
import { readAllSignalCaches, getActiveTheses, getOpenPositions } from '../state/manager.js';
import type { Thesis } from '../schemas/thesis.js';
import type { Position } from '../schemas/position.js';
import { log } from '../logger.js';

// --- Discovery Context (Layer 1 → Discovery Scanner) ---

export interface DiscoveryContext {
  assets: HLAsset[];
  categories: Record<string, string>;
  kalshiEvents: PredictionEvent[];
  polymarketEvents: PredictionEvent[];
  signals: Record<string, unknown>; // Pre-processed Layer 1 signals
  fetchedAt: string;
  errors: string[];
}

export async function assembleDiscoveryContext(): Promise<DiscoveryContext> {
  const errors: string[] = [];

  const [hlResult, kalshiResult, polymarketResult] = await Promise.allSettled([
    fetchAllTradableAssets(),
    fetchKalshiEvents(),
    fetchPolymarketEvents(),
  ]);

  let assets: HLAsset[] = [];
  let categories: Record<string, string> = {};

  if (hlResult.status === 'fulfilled') {
    assets = hlResult.value.assets;
    categories = Object.fromEntries(hlResult.value.categories);
  } else {
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

  if (errors.length > 0) {
    log({ level: 'warn', event: 'context_partial', data: { errors } });
  }

  return { assets, categories, kalshiEvents, polymarketEvents, signals, fetchedAt: new Date().toISOString(), errors };
}

// --- Synthesis Context (Discovery Candidate → Thesis Generator) ---

export interface SynthesisContext extends DiscoveryContext {
  candidateTicker: string;
  relevantAssets: HLAsset[];
  relevantEvents: PredictionEvent[];
}

export function assembleSynthesisContext(base: DiscoveryContext, ticker: string): SynthesisContext {
  const rawTicker = ticker.replace('xyz:', '');
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
  const rawTicker = thesis.ticker.replace('xyz:', '');
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
