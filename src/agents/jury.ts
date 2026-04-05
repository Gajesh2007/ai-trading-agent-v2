import { generateText, Output, stepCountIs } from 'ai';
import { getModel, getModelLabel, getProviderOptions, getProviderName } from '../model-router.js';
import { JuryAnalysisSchema, EvaluatorVerdictSchema, type JuryAnalysis, type EvaluatorVerdict, type JuryResult } from '../schemas/evaluation.js';
import { analystToolset, evaluatorToolset } from '../tools/index.js';
import type { DiscoveryCandidate } from '../schemas/discovery.js';
import type { DiscoveryContext } from '../context/context-bus.js';
import { log, logLLMCall, extractToolCalls } from '../logger.js';
import { readTradeDecisions, getActiveTheses } from '../state/manager.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../utils/cache.js';
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
- **getRecentRejections**: Check what was recently rejected and why — avoid repeating failed theses.
- **getPastDecisions**: See full decision history with outcomes.
- **runSimulation**: Run Python code for quantitative analysis (expected value, Kelly criterion, etc.).

## When you receive evaluator feedback
If the evaluator sends your analysis back with specific concerns, you MUST address each point directly. Either:
1. Change your recommendation based on their valid criticism, OR
2. Counter their argument with NEW evidence (web search, simulation, fresh data)
Do NOT just restate your original position — that wastes everyone's time.`;

const EVALUATOR_PROMPT = `You are a senior risk officer reviewing trade proposals from an analyst team. You are a SKEPTIC by nature. Your job is to find holes in their reasoning.

## Grading Criteria (weighted)

1. THESIS QUALITY (30%): Is the causal chain clear and falsifiable? Are they confusing correlation with causation? Is the edge specifically identified or is it vague hand-waving?

2. FALSIFICATION SPECIFICITY (25%): Are the falsification conditions concrete and measurable? "If macro deteriorates" is garbage. "If VIX crosses 25 and stays above for 2 sessions" is useful.

3. INFORMATION COMPLETENESS (20%): Did the analysts use all available signals? Did they check prediction market odds? Did they verify positioning isn't crowded? Missing any of these is a yellow flag.

4. RISK/REWARD (15%): Is the proposed size appropriate for conviction? Is the asymmetry actually there or are they seeing what they want?

5. EDGE DECAY (10%): How quickly will this edge disappear? If everyone can see this, it's not an edge.

## Decision Framework

APPROVE: Weighted score ≥7.0, no red flags. The thesis is sound.
SEND_BACK: Score 3-7, or any criterion <5. Your feedback is sent DIRECTLY to the analysts — they see your exact words IN THEIR CONVERSATION CONTEXT and must address each point. This is a real debate. Be specific: what to verify, what data to check, what flaw to fix. Use this generously — debate improves outcomes.
REJECT: Score <3 ONLY. Fundamental logical flaw so severe that no amount of additional research can fix it. Use this rarely — most ideas deserve at least one round of debate.

## CRITICAL: Prefer SEND_BACK over REJECT.
A score of 4.5 is NOT a reject — it's a "send back with specific feedback." REJECT is reserved for ideas that are structurally broken (e.g. the market doesn't exist, the causal logic is backwards, the data is fabricated). If there's ANY chance additional research could improve the thesis, use SEND_BACK.

## No-Trade Default
An empty portfolio is not a problem to solve. If no opportunities meet your criteria, the correct output is "no actionable trades." Your job is to protect capital, not deploy it.

## Your Tools — verify the analysts' claims
- **getPortfolioState**: Check current positions. Are we already exposed to this sector?
- **getTradeHistory**: Has a similar thesis failed recently?
- **getRecentRejections**: What did you reject before? Are the analysts making the same mistakes?
- **getPastDecisions**: Full decision history with outcomes.
- **getCycleSummaries**: See how recent cycles played out.
- **web_search**: Fact-check the analysts' claims. Search for news they may have missed.
- **fetchWebPage**: Read primary sources if an analyst cites something you want to verify.
- **runSimulation**: Run your own expected value or risk calculations to validate the analysts' sizing.

## When reviewing a second round
If you sent back feedback and the analysts responded, evaluate WHETHER THEY ACTUALLY ADDRESSED YOUR CONCERNS. Did they bring new evidence? Did they run the simulation you asked for? Did they check the data source you pointed out? Or did they just restate their position? If they genuinely addressed your concerns, you can raise the score. If they didn't, maintain or lower it.

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

// Max rounds of evaluator↔analyst debate per candidate
const MAX_DEBATE_ROUNDS = 3;

type Message = { role: 'system' | 'user' | 'assistant'; content: string; providerOptions?: any };

export async function runJuryWithDebate(
  candidate: DiscoveryCandidate & { id: string; discoveredAt: string },
  ctx: DiscoveryContext,
): Promise<{ juryResult: JuryResult; verdict: EvaluatorVerdict }> {
  const startTime = Date.now();
  const roles = ['analystA', 'analystB', 'analystC'] as const;
  const candidatePrompt = buildAnalystPrompt(candidate, ctx);

  // Each analyst maintains its own message history across rounds
  const analystHistories: Message[][] = roles.map(role => [
    ...cachedSystemPrompt(ANALYST_PROMPT, getProviderName(role)),
    { role: 'user' as const, content: candidatePrompt },
  ]);

  // Evaluator maintains its message history across rounds
  const evaluatorHistory: Message[] = [
    ...cachedSystemPrompt(EVALUATOR_PROMPT, getProviderName('evaluator')),
  ];

  let juryResult: JuryResult | null = null;
  let verdict: EvaluatorVerdict | null = null;

  for (let round = 0; round < MAX_DEBATE_ROUNDS; round++) {
    const isFirstRound = round === 0;
    log({ level: 'info', event: 'debate_round', data: { round: round + 1, ticker: candidate.ticker } });

    // --- Run all 3 analysts in parallel (continuing their conversations) ---
    const analystResults = await Promise.allSettled(
      roles.map((role, i) =>
        withRetry(
          () => generateText({
            model: getModel(role),
            providerOptions: mergeProviderOptions(getProviderOptions(role), getCacheProviderOptions(role, getProviderName(role))),
            output: Output.object({ schema: z.object({ analysis: JuryAnalysisSchema }) }),
            tools: analystToolset(role),
            stopWhen: stepCountIs(100),
            messages: analystHistories[i],
          }),
          { label: `jury-${role}-r${round}`, maxAttempts: 2 },
        )
      )
    );

    const analyses: JuryAnalysis[] = [];
    for (let i = 0; i < analystResults.length; i++) {
      const r = analystResults[i];
      if (r.status === 'fulfilled' && r.value.output?.analysis) {
        analyses.push(r.value.output.analysis);
        // Append assistant response to this analyst's history
        analystHistories[i].push({
          role: 'assistant' as const,
          content: JSON.stringify(r.value.output.analysis),
        });
        logLLMCall({
          cycleId: `jury-${candidate.id}-${roles[i]}-r${round}`,
          model: getModelLabel(roles[i] as any),
          systemPrompt: ANALYST_PROMPT,
          userPrompt: analystHistories[i].filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n---\n'),
          response: r.value.output,
          toolCalls: extractToolCalls(r.value),
          usage: r.value.usage ? { promptTokens: r.value.usage.inputTokens ?? 0, completionTokens: r.value.usage.outputTokens ?? 0 } : undefined,
          durationMs: Date.now() - startTime,
          candidateCount: r.value.output.analysis.direction !== 'no-trade' ? 1 : 0,
        });
      } else {
        log({ level: 'warn', event: 'jury_analyst_failed', data: { role: roles[i], round, error: String(r.status === 'rejected' ? r.reason : 'no output') } });
      }
    }

    if (analyses.length === 0) {
      return {
        juryResult: { ticker: candidate.ticker, analyses: [], agreement: 'split', consensusDirection: 'no-trade', avgConviction: 0 },
        verdict: { decision: 'REJECT', grades: { thesisQuality: 0, falsificationSpecificity: 0, informationCompleteness: 0, riskReward: 0, edgeDecay: 0 }, weightedScore: 0, reasoning: 'All analysts failed to produce output' },
      };
    }

    // --- Aggregate jury ---
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
    const dissenter = agreement === 'majority' ? analyses.find(a => a.direction !== consensusDirection) : undefined;

    juryResult = { ticker: candidate.ticker, analyses, agreement, consensusDirection, avgConviction, dissent: dissenter?.reasoningChain };

    log({ level: 'info', event: 'jury_complete', data: { ticker: candidate.ticker, round: round + 1, agreement, consensusDirection, avgConviction } });

    if (consensusDirection === 'no-trade') {
      return {
        juryResult,
        verdict: { decision: 'REJECT', grades: { thesisQuality: 0, falsificationSpecificity: 0, informationCompleteness: 0, riskReward: 0, edgeDecay: 0 }, weightedScore: 0, reasoning: 'Jury consensus: no-trade' },
      };
    }

    // --- Run evaluator (continuing its conversation) ---
    const recentDecisions = readTradeDecisions(10);
    const activeTheses = getActiveTheses();

    const evaluatorUserMsg = `## ${isFirstRound ? 'Jury Result' : `Jury Response (Round ${round + 1})`}
Agreement: ${agreement}
Consensus: ${consensusDirection}
Average Conviction: ${avgConviction.toFixed(1)}

## Individual Analyst Outputs (identities hidden)
${analyses.map((a, i) => `### Analyst ${i + 1}
Direction: ${a.direction} | Conviction: ${a.conviction}/10
Thesis: ${a.thesis}
Falsification: ${a.falsificationConditions.join('; ')}
Risk reasoning: ${a.riskReasoning}
Size: ${a.positionSizeRecommendation} | Leverage: ${a.leverageRecommendation}x
Reasoning: ${a.reasoningChain}
`).join('\n')}

${dissenter ? `## Dissenting View\n${dissenter.reasoningChain}` : ''}

${isFirstRound ? `## Current Portfolio
Active theses: ${activeTheses.length}
${activeTheses.map(t => `- ${t.ticker} ${t.direction} (conviction ${t.conviction})`).join('\n') || 'None'}

## Recent Trade History
${recentDecisions.slice(-5).map(d => `- ${d.ticker} ${d.action} ${d.direction ?? ''} → ${d.outcome ? `PnL: $${d.outcome.pnl}` : 'open'}`).join('\n') || 'No recent trades'}` : ''}

${!isFirstRound ? 'The analysts have responded to your previous feedback. Evaluate whether they ACTUALLY addressed your concerns with new evidence, or just restated their position.' : 'Grade this proposal and render your verdict.'}`;

    evaluatorHistory.push({ role: 'user' as const, content: evaluatorUserMsg });

    const evalResult = await withRetry(
      () => generateText({
        model: getModel('evaluator'),
        providerOptions: mergeProviderOptions(getProviderOptions('evaluator'), getCacheProviderOptions('evaluator', getProviderName('evaluator'))),
        output: Output.object({ schema: EvaluatorVerdictSchema }),
        tools: evaluatorToolset,
        stopWhen: stepCountIs(100),
        messages: evaluatorHistory,
      }),
      { label: `evaluator-r${round}`, maxAttempts: 2 },
    );

    verdict = evalResult.output ?? null;
    if (!verdict) {
      log({ level: 'error', event: 'evaluator_no_output', data: { ticker: candidate.ticker, round } });
      verdict = { decision: 'REJECT', grades: { thesisQuality: 0, falsificationSpecificity: 0, informationCompleteness: 0, riskReward: 0, edgeDecay: 0 }, weightedScore: 0, reasoning: 'Evaluator failed to produce output' };
    }

    // Append evaluator's response to its history
    evaluatorHistory.push({ role: 'assistant' as const, content: JSON.stringify(verdict) });

    logLLMCall({
      cycleId: `evaluator-${candidate.id}-r${round}`,
      model: getModelLabel('evaluator'),
      systemPrompt: EVALUATOR_PROMPT,
      userPrompt: evaluatorUserMsg,
      response: verdict,
      toolCalls: extractToolCalls(evalResult),
      usage: evalResult.usage ? { promptTokens: evalResult.usage.inputTokens ?? 0, completionTokens: evalResult.usage.outputTokens ?? 0 } : undefined,
      durationMs: Date.now() - startTime,
      candidateCount: verdict.decision === 'APPROVE' ? 1 : 0,
    });

    log({
      level: 'info',
      event: 'evaluator_verdict',
      data: { ticker: candidate.ticker, round: round + 1, decision: verdict.decision, score: verdict.weightedScore },
    });

    // If APPROVE or REJECT, we're done
    if (verdict.decision === 'APPROVE' || verdict.decision === 'REJECT') {
      break;
    }

    // SEND_BACK: append evaluator feedback to each analyst's conversation
    if (verdict.decision === 'SEND_BACK' && verdict.feedback) {
      const feedbackMsg = `## EVALUATOR FEEDBACK (Round ${round + 1})

The evaluator reviewed your analysis and is sending it back. You MUST address each specific concern:

${verdict.feedback}

Weighted score: ${verdict.weightedScore}/10
Grades: Thesis ${verdict.grades.thesisQuality}/10, Falsification ${verdict.grades.falsificationSpecificity}/10, Completeness ${verdict.grades.informationCompleteness}/10, Risk/Reward ${verdict.grades.riskReward}/10, Edge Decay ${verdict.grades.edgeDecay}/10

Respond with an UPDATED analysis. Use tools to verify or refute each point. If the evaluator is right about a flaw, change your recommendation. If you disagree, provide NEW EVIDENCE.`;

      for (const history of analystHistories) {
        history.push({ role: 'user' as const, content: feedbackMsg });
      }

      log({ level: 'info', event: 'evaluator_send_back', data: { ticker: candidate.ticker, round: round + 1, feedback: verdict.feedback.slice(0, 200) } });
    }
  }

  return { juryResult: juryResult!, verdict: verdict! };
}
