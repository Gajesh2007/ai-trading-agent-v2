import { generateText, Output, stepCountIs } from 'ai';
import { getModel, getModelLabel, getProviderName } from '../../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../../utils/cache.js';
import { PredictionMarketSignalSchema } from '../../schemas/signals.js';
import { writeSignalCache } from '../../state/manager.js';
import { log, logLLMCall, extractToolCalls } from '../../logger.js';
import { withRetry } from '../../utils/retry.js';
import { fetchPolymarketEvents } from '../../data-sources/polymarket.js';
import { fetchKalshiEvents } from '../../data-sources/kalshi.js';
import { getWebToolsForProvider } from '../../tools/web-search.js';

const PROMPT = `You are a prediction market analyst. Extract actionable signals from Polymarket and Kalshi odds for equity-relevant events.

## Your Job
1. Identify events with significant odds or recent shifts
2. For each relevant event, determine which XYZ equity perps would be affected
3. Assess whether the equity market has already priced in the event
4. Flag any event where odds shifted >15% recently as an ANOMALY

## Key Principle
The most valuable signal is DIVERGENCE between prediction market odds and equity pricing.
When Kalshi says 70% chance of a tariff but semiconductor stocks haven't moved, that's edge.

## Output
Produce a PredictionMarketSignal with the most actionable events. Filter aggressively — only include events that could impact tradeable XYZ assets. Sports events, celebrity events, and distant-future events are NOT relevant.`;

export async function runPredictionMarketsAgent(): Promise<void> {
  const startTime = Date.now();

  const [kalshiEvents, polymarketEvents] = await Promise.allSettled([
    fetchKalshiEvents(),
    fetchPolymarketEvents(),
  ]);

  const allEvents = [
    ...(kalshiEvents.status === 'fulfilled' ? kalshiEvents.value : []),
    ...(polymarketEvents.status === 'fulfilled' ? polymarketEvents.value : []),
  ];

  const provider = process.env.MODEL_DISCOVERY_PROVIDER ?? process.env.MODEL_PROVIDER ?? 'anthropic';
  const userPrompt = `Prediction market events (${allEvents.length} total):\n${JSON.stringify(
    allEvents.map(e => ({
      source: e.source,
      title: e.title,
      category: e.category,
      markets: e.markets.slice(0, 3).map(m => ({ question: m.question, yesPrice: m.yesPrice, volume: m.volume })),
    })),
    null, 2,
  )}`;
  const result = await withRetry(
    () => generateText({
      model: getModel('discovery'),
      providerOptions: mergeProviderOptions(getCacheProviderOptions('discovery', getProviderName('discovery'))),
      output: Output.object({ schema: PredictionMarketSignalSchema }),
      tools: getWebToolsForProvider(provider),
      stopWhen: stepCountIs(50),
      messages: [
        ...cachedSystemPrompt(PROMPT, getProviderName('discovery')),
        { role: 'user' as const, content: userPrompt },
      ],
    }),
    { label: 'pred-markets-agent', maxAttempts: 2 },
  );

  const signal = result.output;
  if (signal) {
    writeSignalCache('prediction-markets', { ...signal, updatedAt: new Date().toISOString() });
    const anomalies = signal.events.filter(e => e.isAnomaly);
    log({
      level: 'info',
      event: 'signal_cache_updated',
      data: { agent: 'prediction-markets', eventCount: signal.events.length, anomalies: anomalies.length },
    });
  }

  logLLMCall({
    cycleId: 'layer1-predmarkets',
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
