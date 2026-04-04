import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import type { DiscoveryOutput } from '../schemas/discovery.js';
import type { Thesis } from '../schemas/thesis.js';
import type { Position, TradeDecision } from '../schemas/position.js';

export function ensureStateDir(): void {
  mkdirSync(config.STATE_DIR, { recursive: true });
}

// --- Mutex for concurrent write safety ---
// Single-process mutex — prevents interleaved read-modify-write in async loops
const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  while (locks.has(key)) {
    await locks.get(key);
  }
  let resolve: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  locks.set(key, promise);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    resolve!();
  }
}

// --- Atomic JSON helpers ---

function readJSON<T>(filename: string): T | null {
  const path = join(config.STATE_DIR, filename);
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJSON(filename: string, data: unknown): void {
  ensureStateDir();
  const path = join(config.STATE_DIR, filename);
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function appendJSONL(filename: string, data: unknown): void {
  ensureStateDir();
  appendFileSync(join(config.STATE_DIR, filename), JSON.stringify(data) + '\n');
}

function readJSONL<T>(filename: string): T[] {
  const path = join(config.STATE_DIR, filename);
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

// --- Discovery ---

export function readCandidates(): DiscoveryOutput | null {
  return readJSON<DiscoveryOutput>('discovery-candidates.json');
}

export function writeCandidates(output: DiscoveryOutput): void {
  writeJSON('discovery-candidates.json', output);
}

export function appendToHistory(output: DiscoveryOutput): void {
  appendJSONL('discovery-history.jsonl', output);
}

// --- Thesis Registry ---

export function readTheses(): Thesis[] {
  return readJSON<Thesis[]>('thesis-registry.json') ?? [];
}

export function writeTheses(theses: Thesis[]): void {
  writeJSON('thesis-registry.json', theses);
}

export async function addThesis(thesis: Thesis): Promise<void> {
  await withLock('theses', () => {
    const theses = readTheses();
    theses.push(thesis);
    writeTheses(theses);
  });
}

export async function updateThesis(id: string, update: Partial<Thesis>): Promise<void> {
  await withLock('theses', () => {
    const theses = readTheses();
    const idx = theses.findIndex(t => t.id === id);
    if (idx >= 0) {
      theses[idx] = { ...theses[idx], ...update };
      writeTheses(theses);
    }
  });
}

export function getActiveTheses(): Thesis[] {
  return readTheses().filter(t => t.status === 'active');
}

// --- Positions ---

export function readPositions(): Position[] {
  return readJSON<Position[]>('positions.json') ?? [];
}

export function writePositions(positions: Position[]): void {
  writeJSON('positions.json', positions);
}

export function getOpenPositions(): Position[] {
  return readPositions().filter(p => p.status === 'open');
}

export async function addPosition(position: Position): Promise<void> {
  await withLock('positions', () => {
    const positions = readPositions();
    positions.push(position);
    writePositions(positions);
  });
}

export async function updatePosition(id: string, update: Partial<Position>): Promise<void> {
  await withLock('positions', () => {
    const positions = readPositions();
    const idx = positions.findIndex(p => p.id === id);
    if (idx >= 0) {
      positions[idx] = { ...positions[idx], ...update };
      writePositions(positions);
    }
  });
}

// --- Trade Decisions Log ---

export function logTradeDecision(decision: TradeDecision): void {
  appendJSONL('decisions-log.jsonl', decision);
}

export function readTradeDecisions(limit = 50): TradeDecision[] {
  const all = readJSONL<TradeDecision>('decisions-log.jsonl');
  return all.slice(-limit);
}

// --- Portfolio State ---

export interface PortfolioSnapshot {
  timestamp: string;
  equity: number;
  positions: Position[];
  activeTheses: Thesis[];
}

export function getPortfolioSnapshot(): PortfolioSnapshot {
  return {
    timestamp: new Date().toISOString(),
    equity: 0,
    positions: getOpenPositions(),
    activeTheses: getActiveTheses(),
  };
}

// --- Signal Cache ---

const SIGNAL_CACHE_DIR = join(config.STATE_DIR, 'signal-cache');

export function writeSignalCache(agent: string, data: unknown): void {
  mkdirSync(SIGNAL_CACHE_DIR, { recursive: true });
  const path = join(SIGNAL_CACHE_DIR, `${agent}.json`);
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function readSignalCache(agent: string): unknown | null {
  try {
    return JSON.parse(readFileSync(join(SIGNAL_CACHE_DIR, `${agent}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

export function readAllSignalCaches(): Record<string, unknown> {
  const agents = ['macro-regime', 'prediction-markets', 'fundamentals', 'flow-positioning', 'technical-context'];
  const result: Record<string, unknown> = {};
  for (const agent of agents) {
    const data = readSignalCache(agent);
    if (data) result[agent] = data;
  }
  return result;
}

// --- Cycle Summaries (structured review log) ---

export function appendCycleSummary(summary: {
  cycleId: string;
  timestamp: string;
  candidatesFound: number;
  candidates: Array<{
    ticker: string;
    direction: string;
    synthesisResult: 'trade' | 'no-trade';
    noTradeReason?: string;
    juryAgreement?: string;
    juryConviction?: number;
    evaluatorDecision?: string;
    evaluatorScore?: number;
    executed?: boolean;
    positionId?: string;
  }>;
  equity: number;
  openPositions: number;
}): void {
  appendJSONL('cycle-summaries.jsonl', summary);
}

export function readCycleSummaries(limit = 50): unknown[] {
  return readJSONL('cycle-summaries.jsonl').slice(-limit);
}
