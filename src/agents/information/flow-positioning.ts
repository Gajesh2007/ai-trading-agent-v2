import { generateText, Output } from 'ai';
import { getModel, getModelLabel, getProviderName } from '../../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../../utils/cache.js';
import { FlowPositioningSignalSchema } from '../../schemas/signals.js';
import { writeSignalCache, getOpenPositions } from '../../state/manager.js';
import { log, logLLMCall, extractToolCalls } from '../../logger.js';
import { withRetry } from '../../utils/retry.js';
import { fetchPerpsForDex, fetchPredictedFundingRates } from '../../data-sources/hyperliquid.js';

const PROMPT = `You are a flow and positioning analyst. Analyze funding rates and open interest to detect crowded positioning.

## Rules
- Funding rate > +0.01% (per 8h) = mildly crowded long
- Funding rate > +0.05% = moderately crowded long
- Funding rate > +0.1% = extremely crowded long (potential short squeeze setup)
- Same logic inverted for negative funding (crowded short)
- Large open interest + extreme funding = highest conviction signal

## Output
Produce a FlowPositioningSignal. Only include assets with notable funding anomalies or OI shifts.`;

export async function runFlowPositioningAgent(): Promise<void> {
  const startTime = Date.now();

  const [assets, fundings] = await Promise.all([
    fetchPerpsForDex('xyz'),
    fetchPredictedFundingRates(),
  ]);

  const userPrompt = `XYZ DEX assets with funding rates:\n${JSON.stringify(
    assets.map(a => ({ symbol: a.symbol, fundingRate: a.fundingRate, openInterest: a.openInterest, dayNtlVlm: a.dayNtlVlm })),
    null, 2,
  )}\n\nPredicted fundings:\n${JSON.stringify(fundings, null, 2).slice(0, 5000)}`;
  const result = await withRetry(
    () => generateText({
      model: getModel('discovery'),
      providerOptions: mergeProviderOptions(getCacheProviderOptions('discovery', getProviderName('discovery'))),
      output: Output.object({ schema: FlowPositioningSignalSchema }),
      messages: [
        ...cachedSystemPrompt(PROMPT, getProviderName('discovery')),
        { role: 'user' as const, content: userPrompt },
      ],
    }),
    { label: 'flow-positioning-agent', maxAttempts: 2 },
  );

  const signal = result.output;
  if (signal) {
    writeSignalCache('flow-positioning', { ...signal, updatedAt: new Date().toISOString() });

    // Check if any open position's ticker has a crowding signal → flag for re-evaluation
    const openPositions = getOpenPositions();
    const extremeCrowding = signal.fundingAnomalies.filter(a => a.magnitude === 'extreme');
    const crowdedOpenPositions = extremeCrowding.filter(a =>
      openPositions.some(p => p.ticker === a.ticker || p.ticker.replace('xyz:', '') === a.ticker)
    );

    if (crowdedOpenPositions.length > 0) {
      // Write a crowding alert — monitoring loop will pick this up and re-evaluate
      writeSignalCache('crowding-alert', {
        positions: crowdedOpenPositions.map(a => ({
          ticker: a.ticker,
          signal: a.signal,
          fundingRate: a.fundingRate,
        })),
        triggeredAt: new Date().toISOString(),
      });
      log({
        level: 'warn',
        event: 'crowding_detected_on_open_position',
        data: { tickers: crowdedOpenPositions.map(a => a.ticker) },
      });
    }

    log({
      level: 'info',
      event: 'signal_cache_updated',
      data: { agent: 'flow-positioning', anomalies: signal.fundingAnomalies.length, extremeCrowding: extremeCrowding.length },
    });
  }

  logLLMCall({
    cycleId: 'layer1-flow',
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
