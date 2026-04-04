import { tool } from 'ai';
import { z } from 'zod';
import { withRetry } from '../utils/retry.js';
import { getCurrentPrice } from '../execution/executor.js';

export const macroTools = {
  getMacroIndicators: tool({
    description: `Get current macro indicators relevant to equity/crypto positioning.
      Returns: VIX level, DXY (dollar index), SP500 level, gold price, EUR/USD, JPY/USD,
      crude oil — all from live Hyperliquid XYZ perp prices.
      Also returns a simple regime signal based on VIX level:
      VIX < 15 = risk-on, 15-25 = neutral, 25-35 = risk-off, > 35 = crisis.`,
    inputSchema: z.object({}),
    execute: async () => {
      const indicators: Record<string, string | number> = {};
      const tickers = [
        ['xyz:VIX', 'vix'],
        ['xyz:DXY', 'dollarIndex'],
        ['xyz:SP500', 'sp500'],
        ['xyz:GOLD', 'gold'],
        ['xyz:EUR', 'eurUsd'],
        ['xyz:JPY', 'jpyUsd'],
        ['xyz:CL', 'crudeOil'],
      ] as const;

      await Promise.allSettled(
        tickers.map(async ([ticker, key]) => {
          try {
            indicators[key] = await getCurrentPrice(ticker);
          } catch {
            indicators[key] = 'unavailable';
          }
        })
      );

      // Regime classification from VIX
      const vix = typeof indicators.vix === 'number' ? indicators.vix : 20;
      let regime: string;
      if (vix < 15) regime = 'risk-on';
      else if (vix < 25) regime = 'neutral';
      else if (vix < 35) regime = 'risk-off';
      else regime = 'crisis';

      return { ...indicators, macroRegime: regime };
    },
  }),

  getEarningsCalendar: tool({
    description: `Get upcoming earnings dates and context for stocks in the XYZ perps universe.
      Uses web search to find upcoming earnings. Returns earnings dates, consensus
      estimates where available, and any recent analyst revision activity.`,
    inputSchema: z.object({
      tickers: z.array(z.string()).optional()
        .describe('Specific tickers to check, e.g. ["xyz:NVDA", "xyz:TSLA"]. Omit for top movers.'),
      daysAhead: z.number().optional().default(14),
    }),
    execute: async ({ tickers, daysAhead }) => {
      // This tool delegates to web search at the agent level.
      // It provides a structured hint about what to search for.
      const tickerList = tickers?.map(t => t.replace('xyz:', '')) ?? [
        'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOG', 'META', 'AMD', 'NFLX',
      ];
      return {
        hint: `Search the web for upcoming earnings for: ${tickerList.join(', ')}. Look for earnings dates within the next ${daysAhead} days, consensus EPS estimates, and recent analyst revisions.`,
        tickers: tickerList,
        daysAhead,
      };
    },
  }),
};
