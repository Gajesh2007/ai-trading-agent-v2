import { log } from '../logger.js';

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000, label = 'operation' } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLast = attempt === maxAttempts;

      // Don't retry validation/auth errors — they won't resolve
      const code = error?.status ?? error?.code ?? error?.response?.status;
      if (code === 401 || code === 403 || code === 422) throw error;

      if (isLast) throw error;

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      log({
        level: 'warn',
        event: 'retry',
        data: { label, attempt, maxAttempts, delayMs: delay, error: error.message ?? String(error) },
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error('unreachable');
}
