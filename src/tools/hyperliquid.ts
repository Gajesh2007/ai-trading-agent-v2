import { tool } from 'ai';
import { z } from 'zod';
import { fetchPerpsForDex, fetchPredictedFundingRates } from '../data-sources/hyperliquid.js';

export const hyperliquidTools = {
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
