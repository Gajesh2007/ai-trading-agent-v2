import { tool } from 'ai';
import { z } from 'zod';
import { getRecentRejections, getRejectionsForTicker, readTradeDecisions, readCycleSummaries } from '../state/manager.js';

export const historyTools = {
  getRecentRejections: tool({
    description: `Get recently rejected trade ideas. Shows ticker, direction, stage (synthesis/jury/evaluator),
      score, and the evaluator's reasoning for rejection. Use to avoid re-surfacing ideas that were
      already investigated and found lacking. Also useful for understanding what the evaluator
      is looking for.`,
    inputSchema: z.object({
      hoursBack: z.number().optional().describe('How many hours back to look (default 24)'),
      ticker: z.string().optional().describe('Filter to a specific ticker, e.g. "xyz:DKNG"'),
    }),
    execute: async ({ hoursBack, ticker }) => {
      if (ticker) {
        const rejections = getRejectionsForTicker(ticker, 'long')
          .concat(getRejectionsForTicker(ticker, 'short'));
        return { rejections, count: rejections.length };
      }
      const rejections = getRecentRejections(hoursBack ?? 24);
      // Deduplicate by ticker+direction, keep latest
      const deduped = new Map<string, typeof rejections[0]>();
      for (const r of rejections) {
        deduped.set(`${r.ticker}-${r.direction}`, r);
      }
      return { rejections: [...deduped.values()], count: deduped.size };
    },
  }),

  getPastDecisions: tool({
    description: `Get past trade decisions and their outcomes. Shows what was traded, the thesis,
      jury agreement, evaluator score, and P&L outcome if closed. Use for pattern analysis —
      what types of trades worked? What failed? What did the evaluator approve vs reject?`,
    inputSchema: z.object({
      limit: z.number().optional().describe('Number of recent decisions (default 20)'),
    }),
    execute: async ({ limit }) => {
      return { decisions: readTradeDecisions(limit ?? 20) };
    },
  }),

  getCycleSummaries: tool({
    description: `Get recent cycle summaries showing the full pipeline for each discovery cycle:
      how many candidates found, which went to synthesis, jury agreement, evaluator verdict,
      and whether it was executed. Use to understand the system's decision patterns.`,
    inputSchema: z.object({
      limit: z.number().optional().describe('Number of recent cycles (default 10)'),
    }),
    execute: async ({ limit }) => {
      return { cycles: readCycleSummaries(limit ?? 10) };
    },
  }),
};
