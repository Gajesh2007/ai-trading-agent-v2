import { generateText, Output, stepCountIs } from 'ai';
import { getModel, getModelLabel, getProviderOptions, getProviderName } from '../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../utils/cache.js';
import { monitorToolset, exitEvaluatorToolset } from '../tools/index.js';
import { ValidationResultSchema, ExitDecisionSchema, type ValidationResult, type ExitDecision } from '../schemas/position.js';
import type { Thesis } from '../schemas/thesis.js';
import type { Position } from '../schemas/position.js';
import type { DiscoveryContext } from '../context/context-bus.js';
import { assembleMonitoringContext } from '../context/context-bus.js';
import { log, logLLMCall, extractToolCalls } from '../logger.js';
import { withRetry } from '../utils/retry.js';

const VALIDATOR_PROMPT = `You are a thesis validator for an autonomous trading system. For each open position, you check whether the original thesis is still valid.

## Your Job
1. Check each falsification condition against current market data
2. Score overall thesis validity (0-10, where 10 = thesis fully intact)
3. Decide: HOLD, REDUCE, or EXIT

## Key Principle
The question is NOT "has the price moved against us?"
The question IS "does the information edge that justified this trade still exist?"

A 2% drawdown with thesis intact is NOT an exit signal.
A 2% gain with thesis invalidated IS an exit signal.

## Scoring Guide
- 8-10: Thesis fully intact, edge persists
- 6-7: Minor concerns but core thesis holds
- 4-5: Significant doubt, consider reducing
- 1-3: Thesis likely invalidated, recommend exit
- 0: Falsification condition clearly triggered

## Anomaly Detection
If you notice something unexpected (sudden prediction market move, unusual funding rate, news-driven gap), flag anomalyDetected: true. This triggers escalation to a more powerful model for review.

## Your Tools — use them to check falsification conditions
- **web_search**: Search for breaking news that might invalidate the thesis. Check if the catalyst has changed.
- **fetchWebPage**: Read articles about recent developments.
- **refreshXYZAssets**: Get fresh price/funding/OI data to check against the thesis.
- **searchPolymarket**: Check if prediction market odds have shifted since the thesis was created.
- **getFundingRates**: Check if positioning has changed (crowding/unwinding).`;

const EXIT_EVALUATOR_PROMPT = `You are reviewing whether to exit or reduce a position. You receive the original thesis, current market state, and a preliminary assessment from a monitoring agent.

## Your Decision Framework
The question is NOT "has the price moved against us?"
The question IS "does the information edge that justified this trade still exist?"

Consider:
1. Has any falsification condition been triggered?
2. Has the market priced in our thesis? (edge gone)
3. Has new countervailing information emerged?
4. Has the time window passed?
5. Is the monitoring agent being too cautious? (drawdowns during valid theses are buying opportunities, not exit signals)

## Your Tools — do your own research before deciding
- **web_search**: Search for news the monitoring agent may have missed. Check primary sources.
- **fetchWebPage**: Read full articles about developments affecting this position.
- **refreshXYZAssets**: Get fresh market data to verify the monitoring agent's claims.
- **searchPolymarket**: Check current prediction market odds against the thesis.
- **getFundingRates**: Verify positioning claims.

## CRITICAL: Distinguish noise from signal
The monitoring agent may panic on normal volatility. Your job is to provide the adult supervision. Override the cheap model when it's wrong — and log WHY for meta-learning.`;

export async function validateThesis(
  thesis: Thesis,
  position: Position,
  ctx: DiscoveryContext,
): Promise<ValidationResult> {
  const startTime = Date.now();
  const monCtx = assembleMonitoringContext(ctx, thesis, position);

  const prompt = `## Position to Validate
Ticker: ${thesis.ticker}
Direction: ${thesis.direction}
Entry Price: ${thesis.entryContext.markPrice}
Current Price: ${monCtx.currentAsset?.markPx ?? 'unknown'}
Current Funding: ${monCtx.currentAsset?.fundingRate ?? 'unknown'}
Unrealized PnL: ${position.unrealizedPnl ?? 'unknown'}
Time in position: since ${position.openedAt}

## Original Thesis
${thesis.thesis}

## Falsification Conditions
${thesis.falsificationConditions.map((fc, i) => `${i + 1}. [${fc.metric}] ${fc.condition} — threshold: ${fc.threshold}`).join('\n')}

## Entry Context
Mark Price: ${thesis.entryContext.markPrice}
Funding Rate: ${thesis.entryContext.fundingRate}
${thesis.entryContext.predictionMarketOdds ? `Prediction Market Odds: ${thesis.entryContext.predictionMarketOdds}` : ''}

## Layer 1 Signals
${Object.keys(monCtx.signals).length > 0 ? JSON.stringify(monCtx.signals, null, 2) : 'No cached signals.'}

## Prediction Market Events (filtered for ${thesis.ticker})
${JSON.stringify(
    (monCtx.relevantEvents.length > 0 ? monCtx.relevantEvents : [...ctx.kalshiEvents, ...ctx.polymarketEvents].slice(0, 15)).map(e => ({
      source: e.source, title: e.title,
      markets: e.markets.slice(0, 2).map(m => ({ question: m.question, yesPrice: m.yesPrice })),
    })),
    null, 2,
  )}

Check each falsification condition. Score the thesis validity. Recommend HOLD, REDUCE, or EXIT.`;

  const result = await withRetry(
    () => generateText({
      model: getModel('thesisValidator'),
      providerOptions: mergeProviderOptions(getProviderOptions('thesisValidator'), getCacheProviderOptions('thesisValidator', getProviderName('thesisValidator'))),
      output: Output.object({ schema: ValidationResultSchema }),
      tools: monitorToolset,
      stopWhen: stepCountIs(100),
      messages: [
        ...cachedSystemPrompt(VALIDATOR_PROMPT, getProviderName('thesisValidator')),
        { role: 'user' as const, content: prompt },
      ],
    }),
    { label: 'thesis-validator-llm', maxAttempts: 2 },
  );

  const durationMs = Date.now() - startTime;
  const validation = result.output;
  if (!validation) {
    log({ level: 'error', event: 'thesis_validation_no_output', data: { thesisId: thesis.id } });
    return { thesisId: thesis.id, ticker: thesis.ticker, thesisScore: 5, action: 'HOLD' as const, reasoning: 'Model failed to produce structured output — defaulting to HOLD', falsificationTriggered: [], edgeRemaining: 5, anomalyDetected: false };
  }

  logLLMCall({
    cycleId: `validate-${thesis.id}`,
    model: getModelLabel('thesisValidator'),
    systemPrompt: VALIDATOR_PROMPT,
    userPrompt: prompt,
    response: validation,
    usage: result.usage ? {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    } : undefined,
    durationMs,
    candidateCount: 0,
    toolCalls: extractToolCalls(result),
  });

  log({
    level: validation.action !== 'HOLD' ? 'warn' : 'info',
    event: 'thesis_validation',
    data: {
      thesisId: thesis.id,
      ticker: thesis.ticker,
      score: validation.thesisScore,
      action: validation.action,
      falsificationTriggered: validation.falsificationTriggered,
      anomaly: validation.anomalyDetected,
    },
  });

  return validation;
}

export async function evaluateExit(
  thesis: Thesis,
  position: Position,
  cheapAssessment: ValidationResult,
  ctx: DiscoveryContext,
): Promise<ExitDecision> {
  const startTime = Date.now();
  const asset = ctx.assets.find(a => a.symbol === thesis.ticker);

  const prompt = `## Position Under Review
Ticker: ${thesis.ticker} | Direction: ${thesis.direction}
Entry: ${thesis.entryContext.markPrice} | Current: ${asset?.markPx ?? 'unknown'}
PnL: ${position.unrealizedPnl ?? 'unknown'}
Open since: ${position.openedAt}

## Original Thesis
${thesis.thesis}

## Falsification Conditions
${thesis.falsificationConditions.map(fc => `- [${fc.metric}] ${fc.condition} (${fc.threshold})`).join('\n')}

## Monitoring Agent Assessment (cheap model)
Score: ${cheapAssessment.thesisScore}/10
Action: ${cheapAssessment.action}
Reasoning: ${cheapAssessment.reasoning}
Falsification triggered: ${cheapAssessment.falsificationTriggered.join(', ') || 'none'}
${cheapAssessment.anomalyDetected ? `ANOMALY: ${cheapAssessment.anomalyDetails}` : ''}

## Current Market
Price: ${asset?.markPx ?? '?'} | Funding: ${asset?.fundingRate ?? '?'} | OI: ${asset?.openInterest ?? '?'}

Do you agree with the monitoring agent's assessment? Override if the cheap model is panicking on noise.`;

  const result = await withRetry(
    () => generateText({
      model: getModel('exitEvaluator'),
      providerOptions: mergeProviderOptions(getProviderOptions('exitEvaluator'), getCacheProviderOptions('exitEvaluator', getProviderName('exitEvaluator'))),
      output: Output.object({ schema: ExitDecisionSchema }),
      tools: exitEvaluatorToolset,
      stopWhen: stepCountIs(100),
      messages: [
        ...cachedSystemPrompt(EXIT_EVALUATOR_PROMPT, getProviderName('exitEvaluator')),
        { role: 'user' as const, content: prompt },
      ],
    }),
    { label: 'exit-evaluator-llm', maxAttempts: 2 },
  );

  const durationMs = Date.now() - startTime;
  const decision = result.output;
  if (!decision) {
    log({ level: 'error', event: 'exit_eval_no_output', data: { thesisId: thesis.id } });
    return { action: 'HOLD' as const, reasoning: 'Model failed to produce structured output — defaulting to HOLD', edgeRemaining: 5 };
  }

  logLLMCall({
    cycleId: `exit-eval-${thesis.id}`,
    model: getModelLabel('exitEvaluator'),
    systemPrompt: EXIT_EVALUATOR_PROMPT,
    userPrompt: prompt,
    response: decision,
    usage: result.usage ? {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    } : undefined,
    durationMs,
    candidateCount: 0,
    toolCalls: extractToolCalls(result),
  });

  log({
    level: decision.action !== 'HOLD' ? 'warn' : 'info',
    event: 'exit_evaluation',
    data: {
      thesisId: thesis.id,
      ticker: thesis.ticker,
      cheapAction: cheapAssessment.action,
      finalAction: decision.action,
      edgeRemaining: decision.edgeRemaining,
      overridden: cheapAssessment.action !== decision.action,
    },
  });

  return decision;
}
