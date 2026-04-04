import { appendFileSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  data?: unknown;
  durationMs?: number;
  tokens?: { input: number; output: number };
}

function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(config.LOG_DIR, `discovery-${date}.jsonl`);
}

export function log(entry: Omit<LogEntry, 'timestamp'>): void {
  const full: LogEntry = { timestamp: new Date().toISOString(), ...entry };
  const line = JSON.stringify(full);

  mkdirSync(config.LOG_DIR, { recursive: true });
  appendFileSync(getLogPath(), line + '\n');

  const prefix = entry.level === 'error' ? '✗' : entry.level === 'warn' ? '⚠' : '·';
  console.log(`${prefix} [${entry.level}] ${entry.event}`, entry.data ?? '');
}

export function logLLMCall(params: {
  cycleId: string;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  response?: unknown;
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>;
  usage?: { promptTokens: number; completionTokens: number };
  durationMs: number;
  candidateCount: number;
}): void {
  // Structured metadata log
  log({
    level: 'info',
    event: 'llm_call',
    data: {
      cycleId: params.cycleId,
      model: params.model,
      candidateCount: params.candidateCount,
      toolCallCount: params.toolCalls?.length ?? 0,
    },
    durationMs: params.durationMs,
    tokens: params.usage
      ? { input: params.usage.promptTokens, output: params.usage.completionTokens }
      : undefined,
  });

  // Full prompt/response log (separate file to keep main log lean)
  const detailPath = join(config.LOG_DIR, `llm-detail-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(config.LOG_DIR, { recursive: true });
  appendFileSync(detailPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    cycleId: params.cycleId,
    model: params.model,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    response: params.response,
    toolCalls: params.toolCalls,
    usage: params.usage,
    durationMs: params.durationMs,
  }) + '\n');
}

/** Extract tool calls from AI SDK generateText result steps */
export function extractToolCalls(result: { steps?: any[] }): Array<{ name: string; args: unknown; result: unknown }> | undefined {
  if (!result.steps) return undefined;
  const calls = result.steps.flatMap((s: any) =>
    (s.toolCalls ?? []).map((tc: any) => ({
      name: tc.toolName,
      args: tc.args,
      result: tc.result,
    }))
  );
  return calls.length > 0 ? calls : undefined;
}

// --- progress.md — human-readable session log ---

const PROGRESS_PATH = join(process.cwd(), 'workspace', 'progress.md');

export function writeProgress(entry: string): void {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `- **${timestamp}** — ${entry}\n`;

  try {
    const existing = readFileSync(PROGRESS_PATH, 'utf-8');
    writeFileSync(PROGRESS_PATH, existing + line);
  } catch {
    writeFileSync(PROGRESS_PATH, `# Trading Agent Progress Log\n\n${line}`);
  }
}
