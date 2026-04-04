import { generateText, Output, stepCountIs } from 'ai';
import { getModel, getModelLabel, getProviderName } from '../../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../../utils/cache.js';
import { MacroRegimeSignalSchema } from '../../schemas/signals.js';
import { writeSignalCache } from '../../state/manager.js';
import { log, logLLMCall, extractToolCalls } from '../../logger.js';
import { withRetry } from '../../utils/retry.js';
import { getCurrentPrice } from '../../execution/executor.js';
import { getWebToolsForProvider } from '../../tools/web-search.js';

const PROMPT = `You are a macro regime classifier. Analyze the current macro indicators and classify the market regime.

## Indicators Provided
You receive VIX, DXY, SP500, gold, oil, EUR, JPY prices from Hyperliquid XYZ perps.

## Your Job
1. Classify the regime: risk-on, risk-off, transitional, or crisis
2. Identify key drivers (what's moving the macro picture)
3. Identify any sector rotation opportunities (money flowing from X to Y)
4. Use web search to check for recent Fed commentary, economic data releases, or geopolitical events

## Output
Produce a structured MacroRegimeSignal.`;

export async function runMacroRegimeAgent(): Promise<void> {
  const startTime = Date.now();

  // Fetch live macro prices
  const indicators: Record<string, number | string> = {};
  for (const [ticker, key] of [['xyz:VIX', 'vix'], ['xyz:DXY', 'dxy'], ['xyz:SP500', 'sp500'], ['xyz:GOLD', 'gold'], ['xyz:CL', 'oil'], ['xyz:EUR', 'eur'], ['xyz:JPY', 'jpy']] as const) {
    try { indicators[key] = await getCurrentPrice(ticker); } catch { indicators[key] = 'unavailable'; }
  }

  const provider = process.env.MODEL_DISCOVERY_PROVIDER ?? process.env.MODEL_PROVIDER ?? 'anthropic';
  const userPrompt = `Current macro indicators:\n${JSON.stringify(indicators, null, 2)}\n\nTimestamp: ${new Date().toISOString()}`;
  const result = await withRetry(
    () => generateText({
      model: getModel('discovery'),
      providerOptions: mergeProviderOptions(getCacheProviderOptions('discovery', getProviderName('discovery'))),
      output: Output.object({ schema: MacroRegimeSignalSchema }),
      tools: getWebToolsForProvider(provider),
      stopWhen: stepCountIs(10),
      messages: [
        ...cachedSystemPrompt(PROMPT, getProviderName('discovery')),
        { role: 'user' as const, content: userPrompt },
      ],
    }),
    { label: 'macro-regime-agent', maxAttempts: 2 },
  );

  const signal = result.output;
  if (signal) {
    writeSignalCache('macro-regime', { ...signal, updatedAt: new Date().toISOString() });
    log({ level: 'info', event: 'signal_cache_updated', data: { agent: 'macro-regime', regime: signal.regime } });
  }

  logLLMCall({
    cycleId: 'layer1-macro',
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
