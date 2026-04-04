import { tool } from 'ai';
import { z } from 'zod';
import { getOpenPositions, getActiveTheses, readTradeDecisions } from '../state/manager.js';
import { getAccountEquity, getHLPositions } from '../execution/executor.js';

export const portfolioTools = {
  getPortfolioState: tool({
    description: `Get current portfolio state. Returns: open positions (ticker, direction,
      size, entry price, unrealized PnL, leverage), active theses with falsification
      conditions, account equity, and margin usage. Use before making trade decisions
      to understand current exposure.`,
    inputSchema: z.object({}),
    execute: async () => {
      const [equity, hlPositions, localPositions, theses] = await Promise.all([
        getAccountEquity(),
        getHLPositions(),
        Promise.resolve(getOpenPositions()),
        Promise.resolve(getActiveTheses()),
      ]);

      return {
        equity,
        positions: localPositions.map(p => {
          const hlPos = hlPositions.find(hp => hp.coin === p.ticker || hp.coin === p.ticker.replace('xyz:', ''));
          return {
            ...p,
            unrealizedPnl: hlPos?.unrealizedPnl ?? p.unrealizedPnl ?? 'unknown',
            currentLeverage: hlPos?.leverage ?? p.leverage,
            liquidationPx: hlPos?.liquidationPx ?? null,
          };
        }),
        activeTheses: theses.map(t => ({
          id: t.id,
          ticker: t.ticker,
          direction: t.direction,
          conviction: t.conviction,
          thesis: t.thesis,
          falsificationConditions: t.falsificationConditions,
          timeHorizon: t.timeHorizon,
          createdAt: t.createdAt,
        })),
        positionCount: localPositions.length,
      };
    },
  }),

  getTradeHistory: tool({
    description: `Get historical trades and their outcomes. Returns past trades with:
      ticker, direction, entry/exit price, PnL, hold duration, the original thesis,
      and exit reason. Use for pattern analysis and calibrating confidence.`,
    inputSchema: z.object({
      limit: z.number().optional().default(20).describe('Number of recent trades to return'),
    }),
    execute: async ({ limit }) => {
      const decisions = readTradeDecisions(limit);
      return { trades: decisions, count: decisions.length };
    },
  }),
};
