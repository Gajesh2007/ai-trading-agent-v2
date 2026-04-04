import { HttpTransport } from '@nktkas/hyperliquid';
import { clearinghouseState, metaAndAssetCtxs, allMids } from '@nktkas/hyperliquid/api/info';
import { order } from '@nktkas/hyperliquid/api/exchange';
import { privateKeyToAccount } from 'viem/accounts';
import type { Thesis } from '../schemas/thesis.js';
import type { Position, TradeDecision } from '../schemas/position.js';
import { addPosition, updatePosition, updateThesis, logTradeDecision, getOpenPositions } from '../state/manager.js';
import { log } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { config } from '../config.js';
import { randomUUID } from 'crypto';

const transport = new HttpTransport();

// ============================================================
// Price & Asset Index (always real — used in both modes)
// ============================================================

let assetIndexCache: Map<string, number> | null = null;
let assetIndexCacheTime = 0;
const CACHE_TTL = 60_000;

async function resolveAssetIndex(ticker: string): Promise<number> {
  const now = Date.now();
  if (!assetIndexCache || now - assetIndexCacheTime > CACHE_TTL) {
    const [meta] = await metaAndAssetCtxs({ transport }, { dex: 'xyz' });
    assetIndexCache = new Map();
    for (let i = 0; i < meta.universe.length; i++) {
      assetIndexCache.set(meta.universe[i].name, i);
    }
    assetIndexCacheTime = now;
  }
  const idx = assetIndexCache.get(ticker);
  if (idx === undefined) throw new Error(`Asset "${ticker}" not found in XYZ DEX universe`);
  return idx;
}

export async function getCurrentPrice(ticker: string): Promise<number> {
  const mids = await allMids({ transport }, { dex: 'xyz' });
  const mid = (mids as Record<string, string>)[ticker];
  if (!mid) throw new Error(`No mid price for ${ticker}`);
  return parseFloat(mid);
}

// ============================================================
// Paper Trading State (persisted to disk)
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const PAPER_STATE_PATH = join(config.STATE_DIR, 'paper-equity.json');

interface PaperState {
  realizedEquity: number; // Starting capital + all realized P&L
  lastUpdated: string;
}

function readPaperState(): PaperState {
  try {
    return JSON.parse(readFileSync(PAPER_STATE_PATH, 'utf-8'));
  } catch {
    return { realizedEquity: config.PAPER_STARTING_EQUITY, lastUpdated: new Date().toISOString() };
  }
}

function writePaperState(state: PaperState): void {
  writeFileSync(PAPER_STATE_PATH, JSON.stringify(state, null, 2));
}

function addRealizedPnl(pnl: number): void {
  const state = readPaperState();
  state.realizedEquity += pnl;
  state.lastUpdated = new Date().toISOString();
  writePaperState(state);
}

async function updatePaperEquity(): Promise<number> {
  const state = readPaperState();
  let equity = state.realizedEquity;
  const positions = getOpenPositions();

  // Add unrealized P&L from open positions using live prices
  for (const pos of positions) {
    try {
      const currentPrice = await getCurrentPrice(pos.ticker);
      const entryPrice = parseFloat(pos.entryPrice);
      const notional = pos.sizeUSD * pos.leverage;
      const pnlPercent = pos.direction === 'long'
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;
      equity += notional * pnlPercent;
    } catch {
      // Can't get price — skip this position's unrealized
    }
  }

  return equity;
}

// ============================================================
// Account State (mode-aware)
// ============================================================

export async function getAccountEquity(): Promise<number> {
  if (config.PAPER_TRADING) {
    return await updatePaperEquity();
  }

  const walletAddress = process.env.HL_WALLET_ADDRESS;
  if (!walletAddress) return 0;

  try {
    return await withRetry(async () => {
      const state = await clearinghouseState(
        { transport },
        { user: walletAddress as `0x${string}`, dex: 'xyz' },
      );
      return parseFloat(state.marginSummary.accountValue);
    }, { label: 'getAccountEquity' });
  } catch (e: any) {
    log({ level: 'warn', event: 'equity_fetch_failed', data: { error: e.message } });
    return 0;
  }
}

export async function getHLPositions(): Promise<Array<{
  coin: string;
  szi: string;
  entryPx: string;
  unrealizedPnl: string;
  leverage: number;
  liquidationPx: string | null;
}>> {
  if (config.PAPER_TRADING) {
    // In paper mode, derive exchange-like position data from local state
    const positions = getOpenPositions();
    const result = [];
    for (const pos of positions) {
      try {
        const currentPrice = await getCurrentPrice(pos.ticker);
        const entryPrice = parseFloat(pos.entryPrice);
        const notional = pos.sizeUSD * pos.leverage;
        const pnlPercent = pos.direction === 'long'
          ? (currentPrice - entryPrice) / entryPrice
          : (entryPrice - currentPrice) / entryPrice;
        const unrealizedPnl = notional * pnlPercent;

        result.push({
          coin: pos.ticker,
          szi: pos.direction === 'long'
            ? (notional / entryPrice).toFixed(6)
            : (-notional / entryPrice).toFixed(6),
          entryPx: pos.entryPrice,
          unrealizedPnl: unrealizedPnl.toFixed(2),
          leverage: pos.leverage,
          liquidationPx: null,
        });
      } catch {
        // Price fetch failed — return stale data
        result.push({
          coin: pos.ticker,
          szi: '0',
          entryPx: pos.entryPrice,
          unrealizedPnl: pos.unrealizedPnl ?? '0',
          leverage: pos.leverage,
          liquidationPx: null,
        });
      }
    }
    return result;
  }

  const walletAddress = process.env.HL_WALLET_ADDRESS;
  if (!walletAddress) return [];

  try {
    const state = await clearinghouseState(
      { transport },
      { user: walletAddress as `0x${string}`, dex: 'xyz' },
    );
    return state.assetPositions
      .filter(ap => parseFloat(ap.position.szi) !== 0)
      .map(ap => ({
        coin: ap.position.coin,
        szi: ap.position.szi,
        entryPx: ap.position.entryPx,
        unrealizedPnl: ap.position.unrealizedPnl,
        leverage: ap.position.leverage.value,
        liquidationPx: ap.position.liquidationPx,
      }));
  } catch {
    return [];
  }
}

// ============================================================
// Order Execution (mode-aware)
// ============================================================

function getWallet() {
  const key = process.env.HL_PRIVATE_KEY;
  if (!key) throw new Error('HL_PRIVATE_KEY not set');
  return privateKeyToAccount(key as `0x${string}`);
}

export async function executeOpen(thesis: Thesis, equity: number): Promise<Position | null> {
  const sizeUSD = thesis.positionSizeRecommendation * equity;
  const symbol = thesis.ticker;

  try {
    const currentPrice = await getCurrentPrice(symbol);

    log({
      level: 'info',
      event: 'executing_open',
      data: {
        paper: config.PAPER_TRADING,
        ticker: symbol,
        direction: thesis.direction,
        sizeUSD: sizeUSD.toFixed(2),
        leverage: thesis.leverageRecommendation,
        currentPrice,
      },
    });

    let actualEntryPrice = currentPrice.toString();

    if (config.PAPER_TRADING) {
      // Simulate fill with 0.1% slippage
      const slippage = thesis.direction === 'long' ? 1.001 : 0.999;
      actualEntryPrice = (currentPrice * slippage).toFixed(2);
      log({ level: 'info', event: 'paper_fill', data: { ticker: symbol, price: actualEntryPrice } });
    } else {
      const wallet = getWallet();
      const assetIndex = await resolveAssetIndex(symbol);
      const sz = (sizeUSD * thesis.leverageRecommendation) / currentPrice;
      const isBuy = thesis.direction === 'long';
      const slippageMultiplier = isBuy ? 1.005 : 0.995;
      const limitPrice = currentPrice * slippageMultiplier;

      const result = await order(
        { transport, wallet },
        {
          orders: [{
            a: assetIndex,
            b: isBuy,
            p: limitPrice.toFixed(2),
            s: sz.toFixed(6),
            r: false,
            t: { limit: { tif: 'Ioc' } },
          }],
          grouping: 'na',
        },
      );

      const status = result.response.data.statuses[0];
      if (status && typeof status === 'object' && 'filled' in status) {
        actualEntryPrice = status.filled.avgPx;
      }
    }

    const position: Position = {
      id: randomUUID().slice(0, 8),
      ticker: symbol,
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
      ticker: symbol,
      action: 'open',
      direction: thesis.direction,
      sizeUSD,
      leverage: thesis.leverageRecommendation,
      thesis: thesis.thesis,
      riskReasoning: thesis.riskReasoning,
    });

    log({ level: 'info', event: 'position_opened', data: { positionId: position.id, ticker: symbol, entryPrice: actualEntryPrice, paper: config.PAPER_TRADING } });
    return position;
  } catch (e: any) {
    log({ level: 'error', event: 'execution_failed', data: { ticker: symbol, error: e.message } });
    return null;
  }
}

export async function executeClose(position: Position, reason: string): Promise<void> {
  const symbol = position.ticker;

  log({
    level: 'info',
    event: 'executing_close',
    data: { positionId: position.id, ticker: symbol, reason, paper: config.PAPER_TRADING },
  });

  try {
    const currentPrice = await getCurrentPrice(symbol);

    if (!config.PAPER_TRADING) {
      const wallet = getWallet();
      const assetIndex = await resolveAssetIndex(symbol);
      const sz = (position.sizeUSD * position.leverage) / parseFloat(position.entryPrice);
      const slippageMultiplier = position.direction === 'short' ? 1.005 : 0.995;
      const limitPrice = currentPrice * slippageMultiplier;

      await order(
        { transport, wallet },
        {
          orders: [{
            a: assetIndex,
            b: position.direction === 'short',
            p: limitPrice.toFixed(2),
            s: sz.toFixed(6),
            r: true,
            t: { limit: { tif: 'Ioc' } },
          }],
          grouping: 'na',
        },
      );
    }

    // Calculate P&L
    const entryPrice = parseFloat(position.entryPrice);
    const notional = position.sizeUSD * position.leverage;
    const pnlPercent = position.direction === 'long'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;
    const pnl = notional * pnlPercent;

    // Update paper equity
    if (config.PAPER_TRADING) {
      addRealizedPnl(pnl);
      const newEquity = readPaperState().realizedEquity;
      log({ level: 'info', event: 'paper_close', data: { ticker: symbol, pnl: pnl.toFixed(2), realizedEquity: newEquity.toFixed(2) } });
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
      ticker: symbol,
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

    log({ level: 'info', event: 'position_closed', data: { positionId: position.id, pnl: pnl.toFixed(2), reason } });
  } catch (e: any) {
    log({ level: 'error', event: 'close_failed', data: { positionId: position.id, error: e.message } });
  }
}

export async function executeReduce(position: Position, reduceTo: number, reason: string): Promise<void> {
  const symbol = position.ticker;

  try {
    const currentPrice = await getCurrentPrice(symbol);

    if (!config.PAPER_TRADING) {
      const wallet = getWallet();
      const assetIndex = await resolveAssetIndex(symbol);
      const reduceBy = 1 - reduceTo;
      const fullSz = (position.sizeUSD * position.leverage) / parseFloat(position.entryPrice);
      const reduceSz = fullSz * reduceBy;
      const slippageMultiplier = position.direction === 'short' ? 1.005 : 0.995;
      const limitPrice = currentPrice * slippageMultiplier;

      await order(
        { transport, wallet },
        {
          orders: [{
            a: assetIndex,
            b: position.direction === 'short',
            p: limitPrice.toFixed(2),
            s: reduceSz.toFixed(6),
            r: true,
            t: { limit: { tif: 'Ioc' } },
          }],
          grouping: 'na',
        },
      );
    }

    const newSizeUSD = position.sizeUSD * reduceTo;
    await updatePosition(position.id, { sizeUSD: newSizeUSD });

    log({
      level: 'info',
      event: 'position_reduced',
      data: { positionId: position.id, ticker: symbol, from: position.sizeUSD, to: newSizeUSD, reason, paper: config.PAPER_TRADING },
    });
  } catch (e: any) {
    log({ level: 'error', event: 'reduce_failed', data: { positionId: position.id, error: e.message } });
  }
}
