import { generateText, Output } from 'ai';
import { getModel, getModelLabel, getProviderName } from '../../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../../utils/cache.js';
import { TechnicalContextSignalSchema } from '../../schemas/signals.js';
import { writeSignalCache } from '../../state/manager.js';
import { log, logLLMCall, extractToolCalls } from '../../logger.js';
import { withRetry } from '../../utils/retry.js';
import { fetchPerpsForDex } from '../../data-sources/hyperliquid.js';

const PROMPT = `You are a technical context classifier. Analyze price action and volume for XYZ DEX assets.

## Your Job
1. Calculate % change from previous day for each asset
2. Classify momentum: strong_up (>3%), up (1-3%), flat (-1 to 1%), down (-3 to -1%), strong_down (<-3%)
3. Classify volume: high (>2x typical), normal, low (<0.5x typical)
4. Note any notable patterns (gap up/down, reversal, breakout)

## Output
Produce a TechnicalContextSignal. Focus on assets with notable moves — skip flat/low-volume assets.`;

export async function runTechnicalContextAgent(): Promise<void> {
  const startTime = Date.now();

  const assets = await fetchPerpsForDex('xyz');

  const userPrompt = `XYZ DEX assets:\n${JSON.stringify(
    assets.map(a => ({
      symbol: a.symbol,
      markPx: a.markPx,
      prevDayPx: a.prevDayPx,
      dayNtlVlm: a.dayNtlVlm,
    })),
    null, 2,
  )}`;
  const result = await withRetry(
    () => generateText({
      model: getModel('discovery'),
      providerOptions: mergeProviderOptions(getCacheProviderOptions('discovery', getProviderName('discovery'))),
      output: Output.object({ schema: TechnicalContextSignalSchema }),
      messages: [
        ...cachedSystemPrompt(PROMPT, getProviderName('discovery')),
        { role: 'user' as const, content: userPrompt },
      ],
    }),
    { label: 'technical-context-agent', maxAttempts: 2 },
  );

  const signal = result.output;
  if (signal) {
    writeSignalCache('technical-context', { ...signal, updatedAt: new Date().toISOString() });
    log({
      level: 'info',
      event: 'signal_cache_updated',
      data: { agent: 'technical-context', assetCount: signal.assets.length },
    });
  }

  logLLMCall({
    cycleId: 'layer1-technical',
    model: getModelLabel('discovery'),
    systemPrompt: PROMPT,
    userPrompt,
    response: signal,
    durationMs: Date.now() - startTime,
    candidateCount: 0,
    usage: result.usage ? { promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0 } : undefined,
    toolCalls: extractToolCalls(result),
  });
}
