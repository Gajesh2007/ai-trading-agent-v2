import { generateText, Output, stepCountIs } from 'ai';
import { getModel, getModelLabel, getProviderOptions } from '../model-router.js';
import { JuryAnalysisSchema, EvaluatorVerdictSchema, type JuryAnalysis, type EvaluatorVerdict, type JuryResult } from '../schemas/evaluation.js';
import { analystToolset, evaluatorToolset } from '../tools/index.js';
import type { DiscoveryCandidate } from '../schemas/discovery.js';
import type { DiscoveryContext } from '../context/context-bus.js';
import { log, logLLMCall, extractToolCalls } from '../logger.js';
import { readTradeDecisions, getActiveTheses } from '../state/manager.js';
import { withRetry } from '../utils/retry.js';
import { z } from 'zod';

const ANALYST_PROMPT = `You are an independent analyst on a trading jury. You receive a trade candidate and market context. Produce your independent analysis.

## Rules
- Your default output direction is "no-trade". Only recommend long/short with genuine, specific edge.
- Be specific about falsification conditions — concrete metrics and thresholds.
- Use getPortfolioState to check current equity. Recommend position size as a fraction of equity, with leverage and explicit risk reasoning.
- Your reasoning chain must be step-by-step and falsifiable.
- You do NOT see other analysts' outputs. Your analysis must be independent.

## Your Tools — USE THEM for independent research
- **web_search**: Search for breaking news, earnings, macro data. Do your own research — don't just parrot the candidate's reasoning.
- **fetchWebPage**: Read full articles and filings.
- **refreshXYZAssets**: Get fresh prices and funding rates.
- **searchPolymarket**: Verify prediction market odds independently.
- **getPortfolioState**: Check current positions and exposure.
- **getTradeHistory**: Review past trade outcomes for calibration.
- **runSimulation**: Run Python code for quantitative analysis (expected value, Kelly criterion, etc.).`;

const EVALUATOR_PROMPT = `You are a senior risk officer reviewing trade proposals from an analyst team. You are a SKEPTIC by nature. Your job is to find holes in their reasoning.

## Grading Criteria (weighted)

1. THESIS QUALITY (30%): Is the causal chain clear and falsifiable? Are they confusing correlation with causation? Is the edge specifically identified or is it vague hand-waving?

2. FALSIFICATION SPECIFICITY (25%): Are the falsification conditions concrete and measurable? "If macro deteriorates" is garbage. "If VIX crosses 25 and stays above for 2 sessions" is useful.

3. INFORMATION COMPLETENESS (20%): Did the analysts use all available signals? Did they check prediction market odds? Did they verify positioning isn't crowded? Missing any of these is a yellow flag.

4. RISK/REWARD (15%): Is the proposed size appropriate for conviction? Is the asymmetry actually there or are they seeing what they want?

5. EDGE DECAY (10%): How quickly will this edge disappear? If everyone can see this, it's not an edge.

## Decision Framework

APPROVE: All criteria score ≥7/10, no red flags, weighted score ≥7.0
SEND_BACK: Any criterion scores <5/10, with specific feedback on what to investigate
REJECT: Fundamental logical flaw, or risk/reward clearly doesn't work

## CRITICAL: You must not be a yes-man.
If you find yourself approving >60% of proposals, your threshold is too low. The best traders have high rejection rates.

## No-Trade Default
An empty portfolio is not a problem to solve. If no opportunities meet your criteria, the correct output is "no actionable trades." Your job is to protect capital, not deploy it.

## Your Tools — verify the analysts' claims
- **getPortfolioState**: Check current positions. Are we already exposed to this sector?
- **getTradeHistory**: Has a similar thesis failed recently?
- **web_search**: Fact-check the analysts' claims. Search for news they may have missed.
- **fetchWebPage**: Read primary sources if an analyst cites something you want to verify.
- **runSimulation**: Run your own expected value or risk calculations to validate the analysts' sizing.

## Context
You also see the portfolio's recent trade history. Factor in:
- Are we overexposed to a correlated sector?
- Has a similar thesis failed recently?
- Is the proposed size reasonable given current positions?`;

function buildAnalystPrompt(
  candidate: DiscoveryCandidate & { id: string; discoveredAt: string },
  ctx: DiscoveryContext,
): string {
  return `## Trade Candidate
${JSON.stringify(candidate, null, 2)}

## Market Context
${JSON.stringify(
    ctx.assets.filter(a => a.symbol === candidate.ticker),
    null, 2,
  )}

## Prediction Market Events (most relevant)
${JSON.stringify(
    [...ctx.kalshiEvents, ...ctx.polymarketEvents].slice(0, 20).map(e => ({
      source: e.source, title: e.title,
      markets: e.markets.slice(0, 2).map(m => ({ question: m.question, yesPrice: m.yesPrice })),
    })),
    null, 2,
  )}

Produce your independent analysis.`;
}

export async function runJury(
  candidate: DiscoveryCandidate & { id: string; discoveredAt: string },
  ctx: DiscoveryContext,
): Promise<JuryResult> {
  const startTime = Date.now();
  const roles = ['analystA', 'analystB', 'analystC'] as const;
  const prompt = buildAnalystPrompt(candidate, ctx);

  // Run all 3 analysts in parallel
  const results = await Promise.allSettled(
    roles.map(role =>
      withRetry(
        () => generateText({
          model: getModel(role),
          providerOptions: getProviderOptions(role),
          output: Output.object({ schema: z.object({ analysis: JuryAnalysisSchema }) }),
          tools: analystToolset(role),
          stopWhen: stepCountIs(100),
          system: ANALYST_PROMPT,
          prompt,
        }),
        { label: `jury-${role}`, maxAttempts: 2 },
      )
    )
  );

  const analyses: JuryAnalysis[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.output?.analysis) {
      analyses.push(r.value.output.analysis);
      logLLMCall({
        cycleId: `jury-${candidate.id}-${roles[i]}`,
        model: getModelLabel(roles[i] as any),
        systemPrompt: ANALYST_PROMPT,
        userPrompt: prompt,
        response: r.value.output,
        usage: r.value.usage ? {
          promptTokens: r.value.usage.inputTokens ?? 0,
          completionTokens: r.value.usage.outputTokens ?? 0,
        } : undefined,
        durationMs: Date.now() - startTime,
        candidateCount: r.value.output.analysis.direction !== 'no-trade' ? 1 : 0,
        toolCalls: extractToolCalls(r.value),
      });
    } else {
      log({ level: 'warn', event: 'jury_analyst_failed', data: { role: roles[i], error: String(r.status === 'rejected' ? r.reason : 'no output') } });
    }
  }

  if (analyses.length === 0) {
    return {
      ticker: candidate.ticker,
      analyses: [],
      agreement: 'split',
      consensusDirection: 'no-trade',
      avgConviction: 0,
    };
  }

  // Aggregate
  const directions = analyses.map(a => a.direction);
  const convictions = analyses.map(a => a.conviction);
  const avgConviction = convictions.reduce((a, b) => a + b, 0) / convictions.length;

  const directionCounts: Record<string, number> = {};
  for (const d of directions) directionCounts[d] = (directionCounts[d] ?? 0) + 1;
  const topDirection = Object.entries(directionCounts).sort((a, b) => b[1] - a[1])[0];

  let agreement: 'unanimous' | 'majority' | 'split';
  if (new Set(directions).size === 1) agreement = 'unanimous';
  else if (topDirection[1] >= 2) agreement = 'majority';
  else agreement = 'split';

  const consensusDirection = topDirection[0] as 'long' | 'short' | 'no-trade';

  // Extract dissent
  let dissent: string | undefined;
  if (agreement === 'majority') {
    const dissenter = analyses.find(a => a.direction !== consensusDirection);
    if (dissenter) dissent = dissenter.reasoningChain;
  }

  log({
    level: 'info',
    event: 'jury_complete',
    data: { ticker: candidate.ticker, agreement, consensusDirection, avgConviction, analyseCount: analyses.length },
  });

  return { ticker: candidate.ticker, analyses, agreement, consensusDirection, avgConviction, dissent };
}

export async function runEvaluator(
  juryResult: JuryResult,
  candidate: DiscoveryCandidate & { id: string; discoveredAt: string },
): Promise<EvaluatorVerdict> {
  const startTime = Date.now();
  const recentDecisions = readTradeDecisions(10);
  const activeTheses = getActiveTheses();

  const prompt = `## Jury Result
Agreement: ${juryResult.agreement}
Consensus: ${juryResult.consensusDirection}
Average Conviction: ${juryResult.avgConviction}

## Individual Analyst Outputs (identities hidden)
${juryResult.analyses.map((a, i) => `### Analyst ${i + 1}
Direction: ${a.direction} | Conviction: ${a.conviction}/10
Thesis: ${a.thesis}
Falsification: ${a.falsificationConditions.join('; ')}
Risk reasoning: ${a.riskReasoning}
Size: ${a.positionSizeRecommendation} | Leverage: ${a.leverageRecommendation}x
Reasoning: ${a.reasoningChain}
`).join('\n')}

${juryResult.dissent ? `## Dissenting View\n${juryResult.dissent}` : ''}

## Current Portfolio
Active theses: ${activeTheses.length}
${activeTheses.map(t => `- ${t.ticker} ${t.direction} (conviction ${t.conviction})`).join('\n') || 'None'}

## Recent Trade History
${recentDecisions.slice(-5).map(d => `- ${d.ticker} ${d.action} ${d.direction ?? ''} → ${d.outcome ? `PnL: $${d.outcome.pnl}` : 'open'}`).join('\n') || 'No recent trades'}

Grade this proposal and render your verdict.`;

  const result = await withRetry(
    () => generateText({
      model: getModel('evaluator'),
      providerOptions: getProviderOptions('evaluator'),
      output: Output.object({ schema: EvaluatorVerdictSchema }),
      tools: evaluatorToolset,
      stopWhen: stepCountIs(100),
      system: EVALUATOR_PROMPT,
      prompt,
    }),
    { label: 'evaluator-llm', maxAttempts: 2 },
  );

  const durationMs = Date.now() - startTime;
  const verdict = result.output;
  if (!verdict) {
    log({ level: 'error', event: 'evaluator_no_output', data: { ticker: juryResult.ticker } });
    return { decision: 'REJECT' as const, grades: { thesisQuality: 0, falsificationSpecificity: 0, informationCompleteness: 0, riskReward: 0, edgeDecay: 0 }, weightedScore: 0, reasoning: 'Evaluator failed to produce structured output — defaulting to REJECT' };
  }

  logLLMCall({
    cycleId: `evaluator-${candidate.id}`,
    model: getModelLabel('evaluator'),
    systemPrompt: EVALUATOR_PROMPT,
    userPrompt: prompt,
    response: verdict,
    usage: result.usage ? {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    } : undefined,
    durationMs,
    candidateCount: verdict.decision === 'APPROVE' ? 1 : 0,
    toolCalls: extractToolCalls(result),
  });

  log({
    level: 'info',
    event: 'evaluator_verdict',
    data: {
      ticker: juryResult.ticker,
      decision: verdict.decision,
      weightedScore: verdict.weightedScore,
      grades: verdict.grades,
    },
  });

  return verdict;
}
