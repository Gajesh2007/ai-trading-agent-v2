import { registerExchange, getAllExchanges, getExchange, getExchangeNames } from './types.js';
import { HyperliquidAdapter } from './hyperliquid/index.js';
import { PublicComAdapter } from './public-com/index.js';
import { log } from '../logger.js';

export { getAllExchanges, getExchange, getExchangeNames } from './types.js';
export type { ExchangeAdapter, ExchangeAsset, ExchangePosition, ExchangePortfolio, ExchangeCapabilities } from './types.js';

/**
 * Initialize exchanges based on EXCHANGES env var (comma-separated).
 * Must be called once at startup before any exchange operations.
 */
export function initializeExchanges(): void {
  const exchangeList = (process.env.EXCHANGES ?? 'hyperliquid')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  for (const name of exchangeList) {
    switch (name) {
      case 'hyperliquid':
      case 'hl':
        registerExchange(new HyperliquidAdapter());
        log({ level: 'info', event: 'exchange_registered', data: { exchange: 'hyperliquid' } });
        break;

      case 'public':
      case 'public.com':
      case 'publiccom': {
        const apiKey = process.env.PUBLIC_API_SECRET;
        if (!apiKey) {
          log({ level: 'warn', event: 'exchange_skip', data: { exchange: 'public', reason: 'PUBLIC_API_SECRET not set' } });
          break;
        }
        const accountId = process.env.PUBLIC_ACCOUNT_ID;
        const enableTrading = process.env.PUBLIC_ENABLE_TRADING === 'true';
        registerExchange(new PublicComAdapter(apiKey, accountId, enableTrading));
        log({ level: 'info', event: 'exchange_registered', data: { exchange: 'public', trading: enableTrading } });
        break;
      }

      default:
        log({ level: 'warn', event: 'exchange_unknown', data: { exchange: name } });
    }
  }

  const registered = getExchangeNames();
  if (registered.length === 0) {
    throw new Error('No exchanges registered. Set EXCHANGES env var (e.g. EXCHANGES=hyperliquid,public)');
  }

  log({ level: 'info', event: 'exchanges_initialized', data: { exchanges: registered } });
}

/**
 * Get the exchange adapter for a given ticker based on prefix.
 * "pub:NVDA" → public, "xyz:NVDA" or "NVDA" → hyperliquid
 */
export function getExchangeForTicker(ticker: string): ReturnType<typeof getExchange> {
  if (ticker.startsWith('pub:')) return getExchange('public');
  // Default to hyperliquid for xyz: prefix or no prefix
  return getExchange('hyperliquid');
}

/**
 * Get all exchange-specific tools merged together, for agents that need multi-exchange access.
 */
export function getAllExchangeTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  for (const exchange of getAllExchanges()) {
    Object.assign(tools, exchange.getTools());
  }
  return tools;
}
