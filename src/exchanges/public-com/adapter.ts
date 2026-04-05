import { randomUUID } from 'crypto';
import { tool } from 'ai';
import { z } from 'zod';
import type { ExchangeAdapter, ExchangeAsset, ExchangeCapabilities, ExchangePortfolio, ExchangePosition } from '../types.js';
import type { Position } from '../../schemas/position.js';
import type { Thesis } from '../../schemas/thesis.js';
import { PublicApiClient } from './client/api.js';
import { InstrumentType, OrderSide, OrderType, TimeInForce, OpenCloseIndicator, OrderStatus } from './client/types.js';
import { addPosition, updatePosition, updateThesis, logTradeDecision, getOpenPositions } from '../../state/manager.js';
import { log } from '../../logger.js';
import { config } from '../../config.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Paper trading state for Public.com
const PUBLIC_PAPER_STATE_PATH = join(config.STATE_DIR, 'public-paper-equity.json');

interface PaperState {
  realizedEquity: number;
  lastUpdated: string;
}

function readPaperState(): PaperState {
  try {
    return JSON.parse(readFileSync(PUBLIC_PAPER_STATE_PATH, 'utf-8'));
  } catch {
    return { realizedEquity: config.PAPER_STARTING_EQUITY, lastUpdated: new Date().toISOString() };
  }
}

function writePaperState(state: PaperState): void {
  writeFileSync(PUBLIC_PAPER_STATE_PATH, JSON.stringify(state, null, 2));
}

function addRealizedPnl(pnl: number): void {
  const state = readPaperState();
  state.realizedEquity += pnl;
  state.lastUpdated = new Date().toISOString();
  writePaperState(state);
}

export class PublicComAdapter implements ExchangeAdapter {
  readonly name = 'public';
  private client: PublicApiClient;
  private enableTrading: boolean;

  // Cache instruments for 5 minutes
  private instrumentsCache: Map<string, { symbol: string; type: InstrumentType; name?: string; optionsEnabled?: boolean }> | null = null;
  private instrumentsCacheTime = 0;
  private readonly CACHE_TTL = 300_000;

  readonly capabilities: ExchangeCapabilities = {
    hasPerps: false,
    hasFundingRates: false,
    hasSpot: true,
    hasOptions: true,
    hasLeveragedETFs: true,
    hasMultiLeg: true,
    maxLeverage: 2, // margin account leverage
    supportedOrderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  };

  private accountDiscovered = false;

  constructor(apiSecretKey: string, accountId?: string, enableTrading = false) {
    this.client = new PublicApiClient(apiSecretKey, accountId);
    this.enableTrading = enableTrading;
  }

  /** Auto-discover account ID on first API call if not set */
  private async ensureAccountId(): Promise<void> {
    if (this.accountDiscovered) return;
    try {
      const accounts = await this.client.getAccounts();
      if (accounts.accounts.length > 0 && !process.env.PUBLIC_ACCOUNT_ID) {
        const acc = accounts.accounts[0];
        // Re-create client with discovered account ID
        this.client = new PublicApiClient(
          process.env.PUBLIC_API_SECRET!,
          acc.accountId,
        );
        log({ level: 'info', event: 'public_account_discovered', data: { accountId: acc.accountId, type: acc.accountType } });
      }
    } catch (e) {
      log({ level: 'warn', event: 'public_account_discovery_failed', data: { error: String(e) } });
    }
    this.accountDiscovered = true;
  }

  // --- Data ---

  async fetchAssets(): Promise<ExchangeAsset[]> {
    await this.ensureAccountId();

    // Read the Market Scanner agent's dynamic watchlist from signal cache.
    // The scanner runs as a Layer 1 agent and discovers interesting tickers
    // by scanning news, options flow, volume anomalies, earnings, and
    // prediction market links. Zero hardcoded tickers.
    const { readSignalCache } = await import('../../state/manager.js');
    const scannerOutput = readSignalCache('market-scanner') as any;

    if (!scannerOutput?.watchlist?.length) {
      log({ level: 'info', event: 'public_no_watchlist', data: { reason: 'Market scanner has not run yet or found no tickers' } });
      return [];
    }

    // Quote the watchlist tickers
    const symbols: string[] = scannerOutput.watchlist.map((w: any) => w.ticker);
    const allAssets: ExchangeAsset[] = [];

    for (let i = 0; i < symbols.length; i += 50) {
      const batch = symbols.slice(i, i + 50);
      try {
        const quotes = await this.client.getQuotes(
          batch.map(s => ({ symbol: s, type: InstrumentType.EQUITY })),
        );
        for (const q of quotes) {
          if (q.outcome === 'SUCCESS') {
            allAssets.push({
              symbol: q.instrument.symbol,
              exchange: 'public',
              type: 'spot',
              markPx: q.last ?? q.bid ?? '0',
              bidPx: q.bid,
              askPx: q.ask,
              volume24h: q.volume?.toString(),
            });
          }
        }
      } catch (e) {
        log({ level: 'warn', event: 'public_quotes_batch_failed', data: { error: String(e), batch: i } });
      }
    }

    log({ level: 'info', event: 'public_assets_fetched', data: { count: allAssets.length, fromScanner: symbols.length } });
    return allAssets;
  }

  async getCurrentPrice(ticker: string): Promise<number> {
    const quotes = await this.client.getQuotes([{ symbol: ticker, type: InstrumentType.EQUITY }]);
    if (quotes.length === 0 || !quotes[0].last) throw new Error(`No price for ${ticker}`);
    return parseFloat(quotes[0].last);
  }

  async getPortfolio(): Promise<ExchangePortfolio> {
    if (config.PAPER_TRADING) {
      const state = readPaperState();
      const positions = await this.getPositions();
      return { equity: state.realizedEquity, buyingPower: state.realizedEquity, positions };
    }

    const portfolio = await this.client.getPortfolio();
    const totalEquity = portfolio.equity.reduce((sum, e) => sum + parseFloat(e.value || '0'), 0);
    const buyingPower = parseFloat(portfolio.buyingPower.buyingPower || '0');

    const positions: ExchangePosition[] = portfolio.positions.map(p => ({
      symbol: p.instrument.symbol,
      exchange: 'public',
      direction: 'long' as const, // Public.com positions are long by default (short requires separate handling)
      quantity: parseFloat(p.quantity),
      sizeUSD: parseFloat(p.currentValue ?? '0'),
      entryPrice: p.costBasis?.unitCost ?? '0',
      currentPrice: p.currentValue ? (parseFloat(p.currentValue) / parseFloat(p.quantity)).toFixed(2) : undefined,
      unrealizedPnl: p.costBasis?.gainValue,
      leverage: 1,
    }));

    return { equity: totalEquity, buyingPower, positions };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (config.PAPER_TRADING) {
      // Derive from local state, filtered to public exchange positions
      const localPositions = getOpenPositions().filter(p => p.ticker.startsWith('pub:'));
      const result: ExchangePosition[] = [];
      for (const pos of localPositions) {
        const symbol = pos.ticker.replace('pub:', '');
        try {
          const price = await this.getCurrentPrice(symbol);
          const entryPrice = parseFloat(pos.entryPrice);
          const pnl = pos.direction === 'long'
            ? (price - entryPrice) * pos.sizeUSD / entryPrice
            : (entryPrice - price) * pos.sizeUSD / entryPrice;
          result.push({
            symbol,
            exchange: 'public',
            direction: pos.direction,
            quantity: pos.sizeUSD / entryPrice,
            sizeUSD: pos.sizeUSD,
            entryPrice: pos.entryPrice,
            currentPrice: price.toFixed(2),
            unrealizedPnl: pnl.toFixed(2),
            leverage: pos.leverage,
          });
        } catch {
          result.push({
            symbol,
            exchange: 'public',
            direction: pos.direction,
            quantity: pos.sizeUSD / parseFloat(pos.entryPrice),
            sizeUSD: pos.sizeUSD,
            entryPrice: pos.entryPrice,
            unrealizedPnl: pos.unrealizedPnl,
            leverage: pos.leverage,
          });
        }
      }
      return result;
    }

    const portfolio = await this.client.getPortfolio();
    return portfolio.positions.map(p => ({
      symbol: p.instrument.symbol,
      exchange: 'public',
      direction: 'long' as const,
      quantity: parseFloat(p.quantity),
      sizeUSD: parseFloat(p.currentValue ?? '0'),
      entryPrice: p.costBasis?.unitCost ?? '0',
      unrealizedPnl: p.costBasis?.gainValue,
      leverage: 1,
    }));
  }

  // --- Execution ---

  async executeOpen(thesis: Thesis, equity: number): Promise<Position | null> {
    const sizeUSD = thesis.positionSizeRecommendation * equity;
    const symbol = thesis.ticker.replace('pub:', '');

    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      const quantity = sizeUSD / currentPrice;

      log({
        level: 'info',
        event: 'public_executing_open',
        data: { paper: config.PAPER_TRADING, ticker: symbol, direction: thesis.direction, sizeUSD: sizeUSD.toFixed(2), quantity: quantity.toFixed(4), currentPrice },
      });

      let actualEntryPrice = currentPrice.toString();

      if (config.PAPER_TRADING) {
        // Simulate fill with 0.1% slippage
        const slippage = thesis.direction === 'long' ? 1.001 : 0.999;
        actualEntryPrice = (currentPrice * slippage).toFixed(2);
        log({ level: 'info', event: 'public_paper_fill', data: { ticker: symbol, price: actualEntryPrice } });
      } else {
        if (!this.enableTrading) throw new Error('Trading disabled — set PUBLIC_ENABLE_TRADING=true');

        const orderSide = thesis.direction === 'long' ? OrderSide.BUY : OrderSide.SELL;
        const orderId = randomUUID();

        const result = await this.client.placeOrder({
          orderId,
          instrument: { symbol, type: InstrumentType.EQUITY },
          orderSide,
          orderType: OrderType.MARKET,
          expiration: { timeInForce: TimeInForce.DAY },
          quantity: quantity.toFixed(4),
        });

        // Poll for fill (up to 10s)
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(r => setTimeout(r, 1000));
          const order = await this.client.getOrder(result.orderId);
          if (order.status === OrderStatus.FILLED) {
            actualEntryPrice = order.averagePrice ?? currentPrice.toString();
            break;
          }
          if (order.status === OrderStatus.REJECTED || order.status === OrderStatus.CANCELLED) {
            throw new Error(`Order ${order.status}: ${order.rejectReason ?? 'unknown'}`);
          }
        }
      }

      const position: Position = {
        id: randomUUID().slice(0, 8),
        ticker: `pub:${symbol}`,
        direction: thesis.direction,
        sizeUSD,
        leverage: thesis.leverageRecommendation,
        entryPrice: actualEntryPrice,
        thesisId: thesis.id,
        openedAt: new Date().toISOString(),
        status: 'open',
      };

      await addPosition(position);

      logTradeDecision({
        id: randomUUID().slice(0, 8),
        timestamp: new Date().toISOString(),
        ticker: `pub:${symbol}`,
        action: 'open',
        direction: thesis.direction,
        sizeUSD,
        leverage: thesis.leverageRecommendation,
        thesis: thesis.thesis,
        riskReasoning: thesis.riskReasoning,
      });

      log({ level: 'info', event: 'public_position_opened', data: { positionId: position.id, ticker: symbol, entryPrice: actualEntryPrice, paper: config.PAPER_TRADING } });
      return position;
    } catch (e: any) {
      log({ level: 'error', event: 'public_execution_failed', data: { ticker: symbol, error: e.message } });
      return null;
    }
  }

  async executeClose(position: Position, reason: string): Promise<void> {
    const symbol = position.ticker.replace('pub:', '');

    log({ level: 'info', event: 'public_executing_close', data: { positionId: position.id, ticker: symbol, reason, paper: config.PAPER_TRADING } });

    try {
      const currentPrice = await this.getCurrentPrice(symbol);

      if (!config.PAPER_TRADING) {
        if (!this.enableTrading) throw new Error('Trading disabled');

        const orderSide = position.direction === 'long' ? OrderSide.SELL : OrderSide.BUY;
        const quantity = position.sizeUSD / parseFloat(position.entryPrice);

        await this.client.placeOrder({
          orderId: randomUUID(),
          instrument: { symbol, type: InstrumentType.EQUITY },
          orderSide,
          orderType: OrderType.MARKET,
          expiration: { timeInForce: TimeInForce.DAY },
          quantity: quantity.toFixed(4),
        });
      }

      // Calculate P&L
      const entryPrice = parseFloat(position.entryPrice);
      const pnlPercent = position.direction === 'long'
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;
      const pnl = position.sizeUSD * pnlPercent;

      if (config.PAPER_TRADING) {
        addRealizedPnl(pnl);
        log({ level: 'info', event: 'public_paper_close', data: { ticker: symbol, pnl: pnl.toFixed(2) } });
      }

      await updatePosition(position.id, {
        status: 'closed',
        closedAt: new Date().toISOString(),
        closeReason: reason,
        currentPrice: currentPrice.toString(),
        unrealizedPnl: pnl.toFixed(2),
      });
      await updateThesis(position.thesisId, { status: 'closed' });

      logTradeDecision({
        id: randomUUID().slice(0, 8),
        timestamp: new Date().toISOString(),
        ticker: `pub:${symbol}`,
        action: 'close',
        thesis: reason,
        riskReasoning: reason,
        outcome: {
          exitPrice: currentPrice.toString(),
          pnl,
          holdDuration: `${((Date.now() - new Date(position.openedAt).getTime()) / 3600000).toFixed(1)}h`,
          exitReason: reason,
        },
      });
    } catch (e: any) {
      log({ level: 'error', event: 'public_close_failed', data: { positionId: position.id, error: e.message } });
    }
  }

  async executeReduce(position: Position, reduceTo: number, reason: string): Promise<void> {
    const symbol = position.ticker.replace('pub:', '');

    try {
      const currentPrice = await this.getCurrentPrice(symbol);

      if (!config.PAPER_TRADING) {
        if (!this.enableTrading) throw new Error('Trading disabled');

        const reduceBy = 1 - reduceTo;
        const quantity = (position.sizeUSD / parseFloat(position.entryPrice)) * reduceBy;
        const orderSide = position.direction === 'long' ? OrderSide.SELL : OrderSide.BUY;

        await this.client.placeOrder({
          orderId: randomUUID(),
          instrument: { symbol, type: InstrumentType.EQUITY },
          orderSide,
          orderType: OrderType.MARKET,
          expiration: { timeInForce: TimeInForce.DAY },
          quantity: quantity.toFixed(4),
        });
      }

      const newSizeUSD = position.sizeUSD * reduceTo;
      await updatePosition(position.id, { sizeUSD: newSizeUSD });

      log({ level: 'info', event: 'public_position_reduced', data: { positionId: position.id, ticker: symbol, from: position.sizeUSD, to: newSizeUSD, reason, paper: config.PAPER_TRADING } });
    } catch (e: any) {
      log({ level: 'error', event: 'public_reduce_failed', data: { positionId: position.id, error: e.message } });
    }
  }

  // --- LLM Tools ---

  getTools(): Record<string, any> {
    const client = this.client;

    return {
      getPublicQuotes: tool({
        description: `Get real-time quotes for stocks/ETFs on Public.com. Returns last price, bid, ask, volume.
          Use this to check current pricing of any US equity or ETF (including leveraged ETFs like TQQQ, SOXL).`,
        inputSchema: z.object({
          symbols: z.array(z.string()).describe('Stock/ETF symbols, e.g. ["NVDA", "TQQQ", "AAPL"]'),
        }),
        execute: async ({ symbols }) => {
          const quotes = await client.getQuotes(
            symbols.map(s => ({ symbol: s, type: InstrumentType.EQUITY })),
          );
          return quotes.map(q => ({
            symbol: q.instrument.symbol,
            last: q.last,
            bid: q.bid,
            ask: q.ask,
            volume: q.volume,
          }));
        },
      }),

      getOptionExpirations: tool({
        description: `Get available option expiration dates for a stock. Call this first before fetching an option chain.`,
        inputSchema: z.object({
          symbol: z.string().describe('Underlying stock symbol, e.g. "NVDA"'),
        }),
        execute: async ({ symbol }) => {
          const result = await client.getOptionExpirations({ symbol, type: InstrumentType.EQUITY });
          return { symbol: result.baseSymbol, expirations: result.expirations };
        },
      }),

      getOptionChain: tool({
        description: `Get the full options chain (calls and puts with bid/ask/volume/OI) for a stock at a specific expiration date.
          Use this to analyze options pricing, find IV skew, and identify mispriced contracts.`,
        inputSchema: z.object({
          symbol: z.string().describe('Underlying stock symbol'),
          expirationDate: z.string().describe('Expiration date from getOptionExpirations, e.g. "2026-04-18"'),
        }),
        execute: async ({ symbol, expirationDate }) => {
          const chain = await client.getOptionChain({ symbol, type: InstrumentType.EQUITY }, expirationDate);
          return {
            symbol: chain.baseSymbol,
            calls: chain.calls.map(q => ({
              symbol: q.instrument.symbol,
              last: q.last, bid: q.bid, ask: q.ask,
              volume: q.volume, openInterest: q.openInterest,
            })),
            puts: chain.puts.map(q => ({
              symbol: q.instrument.symbol,
              last: q.last, bid: q.bid, ask: q.ask,
              volume: q.volume, openInterest: q.openInterest,
            })),
          };
        },
      }),

      getOptionGreeks: tool({
        description: `Get Greeks (delta, gamma, theta, vega, rho, implied volatility) for specific option contracts.
          Use this to evaluate option pricing fairness and find IV divergences from prediction market implied probabilities.`,
        inputSchema: z.object({
          osiSymbols: z.array(z.string()).describe('OSI option symbols from the option chain'),
        }),
        execute: async ({ osiSymbols }) => {
          const result = await client.getOptionGreeks(osiSymbols);
          return result.greeks.map(g => ({
            symbol: g.symbol,
            delta: g.greeks.delta,
            gamma: g.greeks.gamma,
            theta: g.greeks.theta,
            vega: g.greeks.vega,
            iv: (parseFloat(g.greeks.impliedVolatility) * 100).toFixed(2) + '%',
          }));
        },
      }),

      searchPublicInstruments: tool({
        description: `Search for tradeable instruments on Public.com. Filter by type (EQUITY, OPTION, CRYPTO, ETF, BOND).
          Use this to find leveraged ETFs, specific stocks, or check if an instrument is available.`,
        inputSchema: z.object({
          typeFilter: z.enum(['EQUITY', 'OPTION', 'CRYPTO', 'BOND', 'INDEX']).optional(),
          tradingFilter: z.string().optional().describe('Search query, e.g. "leveraged" or "semiconductor"'),
        }),
        execute: async ({ typeFilter, tradingFilter }) => {
          const result = await client.getAllInstruments({
            typeFilter: typeFilter as InstrumentType | undefined,
            tradingFilter,
          });
          return {
            count: result.instruments.length,
            instruments: result.instruments.slice(0, 50).map(i => ({
              symbol: i.symbol,
              type: i.type,
              name: i.name,
              tradeable: i.tradeable,
              optionsEnabled: i.optionsEnabled,
            })),
          };
        },
      }),

      getPublicPortfolio: tool({
        description: `Get current Public.com portfolio — positions, equity, buying power, open orders.
          Use before making trade decisions to check exposure and available capital.`,
        inputSchema: z.object({}),
        execute: async () => {
          if (config.PAPER_TRADING) {
            const state = readPaperState();
            const positions = getOpenPositions().filter(p => p.ticker.startsWith('pub:'));
            return {
              equity: state.realizedEquity,
              buyingPower: state.realizedEquity,
              positions: positions.map(p => ({
                ticker: p.ticker,
                direction: p.direction,
                sizeUSD: p.sizeUSD,
                entryPrice: p.entryPrice,
                unrealizedPnl: p.unrealizedPnl ?? 'unknown',
              })),
            };
          }

          const portfolio = await client.getPortfolio();
          return {
            equity: portfolio.equity.reduce((sum, e) => sum + parseFloat(e.value || '0'), 0),
            buyingPower: parseFloat(portfolio.buyingPower.buyingPower || '0'),
            optionsBuyingPower: parseFloat(portfolio.buyingPower.optionsBuyingPower || '0'),
            positions: portfolio.positions.map(p => ({
              symbol: p.instrument.symbol,
              type: p.instrument.type,
              quantity: p.quantity,
              currentValue: p.currentValue,
              costBasis: p.costBasis?.unitCost,
              gain: p.costBasis?.gainValue,
              gainPct: p.costBasis?.gainPercentage,
            })),
          };
        },
      }),

      preflightOrder: tool({
        description: `Estimate cost, commission, and buying power requirement for an order BEFORE placing it. Read-only and safe to call.
          Use this to validate order parameters and check if you have enough buying power.`,
        inputSchema: z.object({
          symbol: z.string(),
          type: z.enum(['EQUITY', 'OPTION']).default('EQUITY'),
          side: z.enum(['BUY', 'SELL']),
          orderType: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
          quantity: z.string().optional(),
          amount: z.string().optional().describe('Dollar amount (for fractional/notional orders)'),
          limitPrice: z.string().optional(),
        }),
        execute: async ({ symbol, type, side, orderType, quantity, amount, limitPrice }) => {
          const result = await client.preflightOrder({
            instrument: { symbol, type: type as InstrumentType },
            orderSide: side as OrderSide,
            orderType: orderType as OrderType,
            expiration: { timeInForce: TimeInForce.DAY },
            quantity,
            amount,
            limitPrice,
          });
          return {
            orderValue: result.orderValue,
            estimatedCost: result.estimatedCost,
            estimatedQuantity: result.estimatedQuantity,
            estimatedCommission: result.estimatedCommission,
            buyingPowerRequired: result.buyingPowerRequirement,
          };
        },
      }),
    };
  }
}
