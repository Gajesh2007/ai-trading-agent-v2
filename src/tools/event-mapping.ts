import { generateText, Output, tool } from 'ai';
import { z } from 'zod';
import { getModel, getModelLabel } from '../model-router.js';
import { withRetry } from '../utils/retry.js';
import { log } from '../logger.js';

// Tool-within-tool pattern: this tool calls an LLM to reason about
// which equities map to which prediction market events.

const MappingSchema = z.object({
  affectedAssets: z.array(z.object({
    ticker: z.string().describe('XYZ perp symbol, e.g. "xyz:NVDA"'),
    direction: z.enum(['bullish', 'bearish', 'neutral']),
    magnitude: z.enum(['low', 'medium', 'high']),
    reasoning: z.string(),
  })),
  alreadyPricedIn: z.boolean()
    .describe('Whether the equity market appears to have already priced this event'),
  pricingAssessment: z.string()
    .describe('How you determined whether it is priced in'),
});

export const eventMappingTools = {
  getEventEquityMapping: tool({
    description: `Given a specific prediction market event, determine which Hyperliquid
      XYZ equity perps would be affected, in what direction, and with what magnitude.
      Also assesses whether the equity market has already priced in the event.

      Example: "semiconductor tariff probability at 70%" → xyz:NVDA bearish high,
      xyz:AMD bearish high, xyz:TSM bearish medium, xyz:INTC bearish medium.

      This tool uses an LLM to reason about the mapping — it's not a simple lookup.`,
    inputSchema: z.object({
      event: z.string().describe('The prediction market event description'),
      currentOdds: z.number().describe('Current probability (0-1)'),
      oddsChange: z.number().optional().describe('Change in odds recently'),
    }),
    execute: async ({ event, currentOdds, oddsChange }) => {
      try {
        const result = await withRetry(
          () => generateText({
            model: getModel('discovery'),
            output: Output.object({ schema: MappingSchema }),
            system: `You map prediction market events to Hyperliquid XYZ equity perps.
Available XYZ tickers: AAPL, AMD, AMZN, BABA, COIN, COST, GME, GOOGL, HOOD, INTC,
LLY, META, MSFT, MSTR, MU, NFLX, NVDA, ORCL, PLTR, RIVN, TSLA, TSM, SOFTBANK,
SMSN, GOLD, SILVER, CL, COPPER, NATGAS, SP500, VIX, DXY, EUR, JPY.
All prefixed with "xyz:".

Determine which assets are affected by the event, in what direction, and whether
the market has already priced it in.`,
            prompt: `Event: ${event}\nCurrent odds: ${(currentOdds * 100).toFixed(1)}%\n${oddsChange !== undefined ? `Recent odds change: ${(oddsChange * 100).toFixed(1)}pp` : ''}`,
          }),
          { label: 'event-equity-mapping', maxAttempts: 2 },
        );

        log({
          level: 'info',
          event: 'event_mapping',
          data: {
            eventTitle: event,
            affectedCount: result.output?.affectedAssets.length ?? 0,
            pricedIn: result.output?.alreadyPricedIn,
          },
        });

        return result.output;
      } catch (e: any) {
        return { error: e.message };
      }
    },
  }),
};
