import { tool } from 'ai';
import { z } from 'zod';
import { getOpenPositions, getActiveTheses, readTradeDecisions } from '../state/manager.js';
import { getAccountEquity, getHLPositions } from '../execution/executor.js';
import { getAllExchanges } from '../exchanges/index.js';

export const portfolioTools = {
  getPortfolioState: tool({
    description: `Get current portfolio state across ALL exchanges. Returns: open positions (ticker, direction,
      size, entry price, unrealized PnL, leverage), active theses with falsification
      conditions, account equity, and exposure by exchange. Use before making trade decisions
      to understand current exposure.`,
    inputSchema: z.object({}),
    execute: async () => {
      const [equity, hlPositions, localPositions, theses] = await Promise.all([
        getAccountEquity(),
        getHLPositions(),
        Promise.resolve(getOpenPositions()),
        Promise.resolve(getActiveTheses()),
      ]);

      // Get portfolio from all registered exchanges
      const exchangePortfolios: Record<string, { equity: number; positionCount: number }> = {};
      for (const exchange of getAllExchanges()) {
        try {
          const portfolio = await exchange.getPortfolio();
          exchangePortfolios[exchange.name] = {
            equity: portfolio.equity,
            positionCount: portfolio.positions.length,
          };
        } catch { /* exchange unavailable */ }
      }

      return {
        equity,
        exchangePortfolios,
        positions: localPositions.map(p => {
          // For HL positions, enrich with live data
          if (!p.ticker.startsWith('pub:')) {
            const hlPos = hlPositions.find(hp => hp.coin === p.ticker || hp.coin === p.ticker.replace('xyz:', ''));
            return {
              ...p,
              exchange: 'hyperliquid',
              unrealizedPnl: hlPos?.unrealizedPnl ?? p.unrealizedPnl ?? 'unknown',
              currentLeverage: hlPos?.leverage ?? p.leverage,
              liquidationPx: hlPos?.liquidationPx ?? null,
            };
          }
          // Public.com positions
          return {
            ...p,
            exchange: 'public',
            unrealizedPnl: p.unrealizedPnl ?? 'unknown',
            currentLeverage: p.leverage,
            liquidationPx: null,
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
    description: `Get historical trades and their outcomes across all exchanges. Returns past trades with:
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
