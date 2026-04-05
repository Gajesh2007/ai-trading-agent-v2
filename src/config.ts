import 'dotenv/config';
import { join } from 'path';

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function envOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}

export const config = Object.freeze({
  // Model
  MODEL_PROVIDER: env('MODEL_PROVIDER', 'anthropic') as 'anthropic' | 'openai' | 'openrouter',
  MODEL_ID: env('MODEL_ID', 'claude-sonnet-4-20250514'),

  // API keys
  ANTHROPIC_API_KEY: envOptional('ANTHROPIC_API_KEY'),
  OPENAI_API_KEY: envOptional('OPENAI_API_KEY'),
  OPENROUTER_API_KEY: envOptional('OPENROUTER_API_KEY'),

  // Kalshi (optional)
  KALSHI_API_KEY: envOptional('KALSHI_API_KEY'),
  KALSHI_PRIVATE_KEY_PEM: envOptional('KALSHI_PRIVATE_KEY_PEM'),

  // Exchanges (comma-separated: "hyperliquid", "public", or "hyperliquid,public")
  EXCHANGES: env('EXCHANGES', 'hyperliquid'),

  // Public.com (optional)
  PUBLIC_API_SECRET: envOptional('PUBLIC_API_SECRET'),
  PUBLIC_ACCOUNT_ID: envOptional('PUBLIC_ACCOUNT_ID'),
  PUBLIC_ENABLE_TRADING: env('PUBLIC_ENABLE_TRADING', 'false') === 'true',

  // Paper trading — real data, simulated execution
  PAPER_TRADING: env('PAPER_TRADING', 'true') === 'true',
  PAPER_STARTING_EQUITY: parseFloat(env('PAPER_STARTING_EQUITY', '200')),

  // Timing
  DISCOVERY_INTERVAL_MS: parseInt(env('DISCOVERY_INTERVAL_MS', '900000'), 10),

  // Paths (configurable for multi-instance)
  STATE_DIR: env('STATE_DIR', join(process.cwd(), 'workspace', 'state')),
  LOG_DIR: env('LOG_DIR', join(process.cwd(), 'logs')),
});

/** Validates that the chosen model provider has an API key. Call before using the model. */
export function validateModelConfig(): void {
  const providerKeyMap = {
    anthropic: config.ANTHROPIC_API_KEY,
    openai: config.OPENAI_API_KEY,
    openrouter: config.OPENROUTER_API_KEY,
  } as const;

  if (!providerKeyMap[config.MODEL_PROVIDER]) {
    throw new Error(
      `MODEL_PROVIDER is "${config.MODEL_PROVIDER}" but ${config.MODEL_PROVIDER.toUpperCase()}_API_KEY is not set`
    );
  }
}
