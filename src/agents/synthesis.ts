import { generateText, Output, stepCountIs } from 'ai';
import { randomUUID } from 'crypto';
import { getModel, getModelLabel, getProviderOptions } from '../model-router.js';
import { ThesisGenerationOutputSchema, type ThesisGenerationOutput, type Thesis } from '../schemas/thesis.js';
import { synthesisToolset } from '../tools/index.js';
import type { DiscoveryCandidate } from '../schemas/discovery.js';
import type { DiscoveryContext } from '../context/context-bus.js';
import { assembleSynthesisContext } from '../context/context-bus.js';
import { log, logLLMCall, extractToolCalls } from '../logger.js';
import { withRetry } from '../utils/retry.js';

const SYSTEM_PROMPT = `You are a thesis generator for an autonomous trading system. You receive a trade candidate from the discovery scanner and must decide whether it warrants a real trade, and if so, produce a detailed thesis.

## Your Job
1. Evaluate the discovery candidate's reasoning
2. Verify the claimed divergence still exists (use tools if needed)
3. If the edge is real, produce a structured thesis with:
   - Clear causal chain (why this trade works)
   - SPECIFIC, MEASURABLE falsification conditions (not vague — concrete metrics and thresholds)
   - Position sizing and leverage recommendation with explicit risk reasoning
   - Time horizon for the edge

## Falsification Conditions
These are CRITICAL. Each must be:
- **Specific**: "VIX crosses 25 and holds for 2 sessions" not "if macro deteriorates"
- **Measurable**: tied to a number, price, or prediction market odds
- **Checkable**: a monitoring agent must be able to verify this against live data

Bad: "If sentiment turns negative"
Good: "If Polymarket 'semiconductor tariff' odds drop below 40% (currently 65%)"

## Risk Reasoning
You have full discretion over sizing and leverage. Use the getPortfolioState tool to check current equity. Explain WHY your recommended size and leverage are appropriate for this specific thesis. Consider:
- Conviction level (higher conviction → larger size is justified)
- Time horizon (shorter → higher leverage may be appropriate)
- Liquidity of the perp (check dayNtlVlm)
- Number of concurrent positions

## Your Tools
- **web_search**: Search for breaking news, earnings, regulatory events. ALWAYS verify the catalyst with a web search before generating a thesis.
- **fetchWebPage**: Read full articles, SEC filings, earnings transcripts.
- **refreshXYZAssets**: Get fresh price/funding/OI data.
- **getFundingRates**: Check if positioning is crowded.
- **searchPolymarket**: Look up specific prediction market events and current odds.
- **getPortfolioState**: Check current positions and exposure before sizing.
- **getTradeHistory**: Review past trades for patterns — have similar theses worked or failed?
- **runSimulation**: Run Python code for Kelly criterion sizing, Monte Carlo, expected value calculations.

## Output
Set shouldTrade to false if:
- The divergence has already closed
- The edge is too vague to be actionable
- Risk/reward doesn't justify the trade
- You can't define concrete falsification conditions

Set shouldTrade to true only when you have genuine, specific, measurable edge.`;

export async function generateThesis(
  candidate: DiscoveryCandidate & { id: string; discoveredAt: string },
  ctx: DiscoveryContext,
): Promise<{ shouldTrade: boolean; thesis?: Thesis; noTradeReason?: string }> {
  const startTime = Date.now();
  const synthCtx = assembleSynthesisContext(ctx, candidate.ticker);

  const prompt = `## Candidate to Evaluate
${JSON.stringify(candidate, null, 2)}

## Current Market Context (filtered for ${candidate.ticker})
${JSON.stringify(synthCtx.relevantAssets, null, 2)}

## Relevant Prediction Market Events
${JSON.stringify(
  synthCtx.relevantEvents.length > 0
    ? synthCtx.relevantEvents.map(e => ({ source: e.source, title: e.title, markets: e.markets.slice(0, 3).map(m => ({ question: m.question, yesPrice: m.yesPrice })) }))
    : [...ctx.kalshiEvents, ...ctx.polymarketEvents].slice(0, 20).map(e => ({ source: e.source, title: e.title, markets: e.markets.slice(0, 2).map(m => ({ question: m.question, yesPrice: m.yesPrice })) })),
  null, 2,
)}

## Layer 1 Pre-Processed Signals
${Object.keys(synthCtx.signals).length > 0 ? JSON.stringify(synthCtx.signals, null, 2) : 'No cached signals yet.'}

Evaluate this candidate. Should we trade it? If yes, produce a full thesis.`;

  const result = await withRetry(
    () => generateText({
      model: getModel('synthesis'),
      providerOptions: getProviderOptions('synthesis'),
      output: Output.object({ schema: ThesisGenerationOutputSchema }),
      tools: synthesisToolset,
      stopWhen: stepCountIs(100),
      system: SYSTEM_PROMPT,
      prompt,
    }),
    { label: 'synthesis-llm', maxAttempts: 2 },
  );

  const durationMs = Date.now() - startTime;
  const output = result.output;

  logLLMCall({
    cycleId: candidate.id,
    model: getModelLabel('synthesis'),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: prompt,
    response: output,
    usage: result.usage ? {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    } : undefined,
    durationMs,
    candidateCount: output?.shouldTrade ? 1 : 0,
    toolCalls: extractToolCalls(result),
  });

  if (!output?.shouldTrade || !output.thesis) {
    log({
      level: 'info',
      event: 'thesis_rejected',
      data: { ticker: candidate.ticker, reason: output?.noTradeReason ?? 'No thesis produced' },
    });
    return { shouldTrade: false, noTradeReason: output?.noTradeReason };
  }

  const thesis: Thesis = {
    ...output.thesis,
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: 'active',
    candidateId: candidate.id,
  };

  log({
    level: 'info',
    event: 'thesis_generated',
    data: {
      id: thesis.id,
      ticker: thesis.ticker,
      direction: thesis.direction,
      conviction: thesis.conviction,
      size: thesis.positionSizeRecommendation,
      leverage: thesis.leverageRecommendation,
    },
  });

  return { shouldTrade: true, thesis };
}
