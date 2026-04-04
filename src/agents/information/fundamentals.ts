import { generateText, Output, stepCountIs } from 'ai';
import { getModel, getModelLabel } from '../../model-router.js';
import { FundamentalsSignalSchema } from '../../schemas/signals.js';
import { writeSignalCache } from '../../state/manager.js';
import { log, logLLMCall, extractToolCalls } from '../../logger.js';
import { withRetry } from '../../utils/retry.js';
import { getWebToolsForProvider } from '../../tools/web-search.js';

const PROMPT = `You are a fundamentals analyst. Research upcoming earnings and sector-specific catalysts for stocks in the XYZ perps universe.

## XYZ Stock Universe
AAPL, AMD, AMZN, BABA, COIN, COST, GME, GOOGL, HOOD, INTC, LLY, META, MSFT, MSTR, MU, NFLX, NVDA, ORCL, PLTR, RIVN, TSLA, TSM, SOFTBANK, SMSN

## Your Job
1. Use web search to find upcoming earnings dates for these stocks
2. Note any recent analyst revisions (upgrades/downgrades)
3. Identify sector-level catalysts (regulatory, M&A, product launches)
4. Summarize sentiment for each upcoming earnings

## IMPORTANT: Output Format
You MUST produce valid JSON matching this exact structure:
{
  "upcomingEarnings": [{ "ticker": "NVDA", "earningsDate": "2026-04-15", "daysUntil": 11, "consensus": "EPS $1.20", "sentiment": "positive" }],
  "sectorHighlights": [{ "sector": "semiconductors", "signal": "...", "affectedTickers": ["NVDA", "AMD"] }]
}

If you can't find earnings data, return empty arrays. Do NOT return prose — only the JSON object.`;

export async function runFundamentalsAgent(): Promise<void> {
  const startTime = Date.now();

  try {
    const provider = process.env.MODEL_SYNTHESIS_PROVIDER ?? process.env.MODEL_PROVIDER ?? 'anthropic';
    const userPrompt = `Current date: ${new Date().toISOString().slice(0, 10)}\n\nSearch for upcoming earnings and fundamental catalysts for the XYZ stock universe.`;
    const result = await withRetry(
      () => generateText({
        model: getModel('synthesis'),
        output: Output.object({ schema: FundamentalsSignalSchema }),
        tools: getWebToolsForProvider(provider),
        stopWhen: stepCountIs(20),
        system: PROMPT,
        prompt: userPrompt,
      }),
      { label: 'fundamentals-agent', maxAttempts: 2 },
    );

    const signal = result.output;
    if (signal) {
      writeSignalCache('fundamentals', { ...signal, updatedAt: new Date().toISOString() });
      log({
        level: 'info',
        event: 'signal_cache_updated',
        data: { agent: 'fundamentals', earningsCount: signal.upcomingEarnings.length, sectorHighlights: signal.sectorHighlights.length },
      });
    } else {
      log({ level: 'warn', event: 'fundamentals_no_output', data: { reason: 'Model did not produce structured output' } });
    }

    logLLMCall({
      cycleId: 'layer1-fundamentals',
      model: getModelLabel('synthesis'),
      systemPrompt: PROMPT,
      userPrompt,
      response: signal,
      durationMs: Date.now() - startTime,
      candidateCount: 0,
      usage: result.usage ? { promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0 } : undefined,
      toolCalls: extractToolCalls(result),
    });
  } catch (e: any) {
    // Don't let fundamentals failure crash the system — it's supplementary data
    log({ level: 'warn', event: 'fundamentals_failed', data: { error: e.message } });
  }
}
