import type { Tool } from 'ai';
import type { Position } from '../schemas/position.js';
import type { Thesis } from '../schemas/thesis.js';

// --- Unified asset shape across exchanges ---

export interface ExchangeAsset {
  symbol: string;          // Exchange-native symbol (e.g. "NVDA" on HL, "NVDA" on Public)
  exchange: string;        // "hyperliquid" | "public"
  type: 'perp' | 'spot' | 'option' | 'etf';
  markPx: string;
  bidPx?: string;
  askPx?: string;
  volume24h?: string;
  // Perp-specific
  fundingRate?: string;
  openInterest?: string;
  maxLeverage?: number;
  // Options-specific
  optionType?: 'call' | 'put';
  strikePrice?: string;
  expirationDate?: string;
  impliedVolatility?: string;
  delta?: string;
  gamma?: string;
  theta?: string;
  vega?: string;
}

// --- Exchange capabilities (drives discovery prompt) ---

export interface ExchangeCapabilities {
  hasPerps: boolean;
  hasFundingRates: boolean;
  hasSpot: boolean;
  hasOptions: boolean;
  hasLeveragedETFs: boolean;
  hasMultiLeg: boolean;        // Multi-leg options strategies
  maxLeverage: number;         // 0 = no leverage (spot only), 50 = perps
  supportedOrderTypes: ('market' | 'limit' | 'stop' | 'stop_limit')[];
}

// --- Portfolio snapshot ---

export interface ExchangePortfolio {
  equity: number;
  buyingPower: number;
  positions: ExchangePosition[];
}

export interface ExchangePosition {
  symbol: string;
  exchange: string;
  direction: 'long' | 'short';
  quantity: number;
  sizeUSD: number;
  entryPrice: string;
  currentPrice?: string;
  unrealizedPnl?: string;
  leverage: number;
  // Options-specific
  optionType?: 'call' | 'put';
  strikePrice?: string;
  expirationDate?: string;
}

// --- The adapter interface ---

export interface ExchangeAdapter {
  readonly name: string;
  readonly capabilities: ExchangeCapabilities;

  // --- Data ---
  /** Fetch all tradeable assets (equities, perps, ETFs — NOT full options chains) */
  fetchAssets(): Promise<ExchangeAsset[]>;
  /** Get current mid/mark price for a ticker */
  getCurrentPrice(ticker: string): Promise<number>;
  /** Get portfolio snapshot (equity, buying power, positions) */
  getPortfolio(): Promise<ExchangePortfolio>;
  /** Get open positions in exchange-native format */
  getPositions(): Promise<ExchangePosition[]>;

  // --- Execution ---
  executeOpen(thesis: Thesis, equity: number): Promise<Position | null>;
  executeClose(position: Position, reason: string): Promise<void>;
  executeReduce(position: Position, reduceTo: number, reason: string): Promise<void>;

  // --- LLM Tools ---
  /** Exchange-specific tools for LLM agents (e.g. getFundingRates for HL, getOptionChain for Public) */
  getTools(): Record<string, Tool>;

  // --- Categories (optional) ---
  fetchCategories?(): Promise<Record<string, string>>;
}

// --- Exchange registry ---

const adapters = new Map<string, ExchangeAdapter>();

export function registerExchange(adapter: ExchangeAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getExchange(name: string): ExchangeAdapter {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Exchange "${name}" not registered. Available: ${[...adapters.keys()].join(', ')}`);
  return adapter;
}

export function getAllExchanges(): ExchangeAdapter[] {
  return [...adapters.values()];
}

export function getExchangeNames(): string[] {
  return [...adapters.keys()];
}
