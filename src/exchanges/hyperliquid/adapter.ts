import type { ExchangeAdapter, ExchangeAsset, ExchangeCapabilities, ExchangePortfolio, ExchangePosition } from '../types.js';
import type { Position } from '../../schemas/position.js';
import type { Thesis } from '../../schemas/thesis.js';
import { fetchAllTradableAssets, fetchPredictedFundingRates } from './data-source.js';
import {
  executeOpen as hlExecuteOpen,
  executeClose as hlExecuteClose,
  executeReduce as hlExecuteReduce,
  getAccountEquity,
  getHLPositions,
  getCurrentPrice as hlGetCurrentPrice,
} from '../../execution/executor.js';
import { getOpenPositions, getActiveTheses } from '../../state/manager.js';
import { tool } from 'ai';
import { z } from 'zod';
import { fetchPerpsForDex } from './data-source.js';

export class HyperliquidAdapter implements ExchangeAdapter {
  readonly name = 'hyperliquid';

  readonly capabilities: ExchangeCapabilities = {
    hasPerps: true,
    hasFundingRates: true,
    hasSpot: false,
    hasOptions: false,
    hasLeveragedETFs: false,
    hasMultiLeg: false,
    maxLeverage: 50,
    supportedOrderTypes: ['limit'],
  };

  async fetchAssets(): Promise<ExchangeAsset[]> {
    const { assets, categories } = await fetchAllTradableAssets();
    return assets.map(a => ({
      symbol: a.symbol,
      exchange: 'hyperliquid',
      type: 'perp' as const,
      markPx: a.markPx,
      volume24h: a.dayNtlVlm,
      fundingRate: a.fundingRate,
      openInterest: a.openInterest,
      maxLeverage: a.maxLeverage,
    }));
  }

  async getCurrentPrice(ticker: string): Promise<number> {
    return hlGetCurrentPrice(ticker);
  }

  async getPortfolio(): Promise<ExchangePortfolio> {
    const equity = await getAccountEquity();
    const positions = await this.getPositions();
    return { equity, buyingPower: equity, positions };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const hlPositions = await getHLPositions();
    return hlPositions.map(p => ({
      symbol: p.coin,
      exchange: 'hyperliquid',
      direction: parseFloat(p.szi) >= 0 ? 'long' as const : 'short' as const,
      quantity: Math.abs(parseFloat(p.szi)),
      sizeUSD: Math.abs(parseFloat(p.szi) * parseFloat(p.entryPx)),
      entryPrice: p.entryPx,
      unrealizedPnl: p.unrealizedPnl,
      leverage: p.leverage,
    }));
  }

  async executeOpen(thesis: Thesis, equity: number): Promise<Position | null> {
    return hlExecuteOpen(thesis, equity);
  }

  async executeClose(position: Position, reason: string): Promise<void> {
    return hlExecuteClose(position, reason);
  }

  async executeReduce(position: Position, reduceTo: number, reason: string): Promise<void> {
    return hlExecuteReduce(position, reduceTo, reason);
  }

  async fetchCategories(): Promise<Record<string, string>> {
    const { categories } = await fetchAllTradableAssets();
    return Object.fromEntries(categories);
  }

  getTools(): Record<string, any> {
    return {
      refreshXYZAssets: tool({
        description: `Get fresh market data for all assets on the XYZ DEX (stocks, commodities, indices, FX).
          Returns current mark price, funding rate, open interest, and 24h volume for each asset.`,
        inputSchema: z.object({}),
        execute: async () => {
          const assets = await fetchPerpsForDex('xyz');
          return { assets, count: assets.length };
        },
      }),

      getFundingRates: tool({
        description: `Get predicted funding rates across Hyperliquid perps.
          Extreme funding rates signal crowded positioning:
          very positive = crowded long (potential short),
          very negative = crowded short (potential squeeze).`,
        inputSchema: z.object({}),
        execute: async () => {
          const rates = await fetchPredictedFundingRates();
          return rates;
        },
      }),
    };
  }
}
