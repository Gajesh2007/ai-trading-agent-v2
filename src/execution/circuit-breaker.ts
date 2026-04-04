import { getAccountEquity } from './executor.js';
import { getOpenPositions, updatePosition, updateThesis } from '../state/manager.js';
import { executeClose } from './executor.js';
import { log } from '../logger.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const CIRCUIT_BREAKER_EQUITY = 50;
const PAUSED_FILE = join(config.STATE_DIR, 'circuit-breaker-paused');

export interface CircuitBreakerState {
  triggered: boolean;
  equity: number;
  checkedAt: string;
}

export function isPaused(): boolean {
  try {
    readFileSync(PAUSED_FILE, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function setPaused(paused: boolean): void {
  if (paused) {
    writeFileSync(PAUSED_FILE, new Date().toISOString());
  } else {
    try { require('fs').unlinkSync(PAUSED_FILE); } catch {}
  }
}

export async function checkCircuitBreaker(): Promise<CircuitBreakerState> {
  const equity = await getAccountEquity();
  const state: CircuitBreakerState = {
    triggered: false,
    equity,
    checkedAt: new Date().toISOString(),
  };

  // Skip check if no exchange connection (equity = 0)
  if (equity === 0) return state;

  if (equity < CIRCUIT_BREAKER_EQUITY) {
    state.triggered = true;
    setPaused(true);

    log({
      level: 'error',
      event: 'circuit_breaker_triggered',
      data: { equity, threshold: CIRCUIT_BREAKER_EQUITY },
    });

    const openPositions = getOpenPositions();
    for (const pos of openPositions) {
      try {
        await executeClose(pos, `Circuit breaker: equity $${equity.toFixed(2)} < $${CIRCUIT_BREAKER_EQUITY}`);
      } catch (e: any) {
        log({ level: 'error', event: 'circuit_breaker_close_failed', data: { positionId: pos.id, error: e.message } });
        updatePosition(pos.id, { status: 'closed', closedAt: new Date().toISOString(), closeReason: 'circuit_breaker' });
        updateThesis(pos.thesisId, { status: 'closed' });
      }
    }

    log({
      level: 'error',
      event: 'system_paused',
      data: { reason: 'Circuit breaker triggered. All positions closed. System paused. Delete workspace/state/circuit-breaker-paused to resume.' },
    });
  }

  return state;
}
