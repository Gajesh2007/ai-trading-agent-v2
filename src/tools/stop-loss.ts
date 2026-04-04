import { tool } from 'ai';
import { z } from 'zod';
import { HttpTransport } from '@nktkas/hyperliquid';
import { metaAndAssetCtxs } from '@nktkas/hyperliquid/api/info';
import { order } from '@nktkas/hyperliquid/api/exchange';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { log } from '../logger.js';

const transport = new HttpTransport();

export const stopLossTools = {
  setStopLoss: tool({
    description: `Set or update a stop-loss for an open position on Hyperliquid.
      Places a trigger order that executes as a market order when the stop price is hit.
      In paper trading mode, the stop is tracked locally and checked in the monitoring loop.`,
    inputSchema: z.object({
      ticker: z.string().describe('XYZ perp symbol, e.g. "xyz:NVDA"'),
      stopPrice: z.number().describe('Price at which to trigger the stop-loss'),
      direction: z.enum(['long', 'short']).describe('Direction of the position being protected'),
    }),
    execute: async ({ ticker, stopPrice, direction }) => {
      if (config.PAPER_TRADING) {
        // In paper mode, log the stop and let monitoring handle it
        log({
          level: 'info',
          event: 'paper_stop_loss_set',
          data: { ticker, stopPrice, direction },
        });
        return {
          status: 'paper_stop_set',
          ticker,
          stopPrice,
          note: 'Paper trading — stop will be checked in monitoring loop',
        };
      }

      try {
        const wallet = privateKeyToAccount(process.env.HL_PRIVATE_KEY as `0x${string}`);
        const [meta] = await metaAndAssetCtxs({ transport }, { dex: 'xyz' });
        const assetIndex = meta.universe.findIndex(a => a.name === ticker);
        if (assetIndex === -1) return { error: `Asset ${ticker} not found` };

        // Stop loss: sell if long, buy if short
        const isBuy = direction === 'short';
        const tpsl = 'sl' as const;

        await order(
          { transport, wallet },
          {
            orders: [{
              a: assetIndex,
              b: isBuy,
              p: stopPrice.toFixed(2),
              s: '0', // Size will be filled by position
              r: true,
              t: {
                trigger: {
                  isMarket: true,
                  triggerPx: stopPrice.toFixed(2),
                  tpsl,
                },
              },
            }],
            grouping: 'positionTpsl',
          },
        );

        log({
          level: 'info',
          event: 'stop_loss_set',
          data: { ticker, stopPrice, direction },
        });

        return { status: 'stop_set', ticker, stopPrice };
      } catch (e: any) {
        log({ level: 'error', event: 'stop_loss_failed', data: { ticker, error: e.message } });
        return { error: e.message };
      }
    },
  }),
};
