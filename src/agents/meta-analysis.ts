import { generateText, Output, stepCountIs } from 'ai';
import { metaAnalysisToolset } from '../tools/index.js';
import { z } from 'zod';
import { getModel, getModelLabel, getProviderOptions, getProviderName } from '../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../utils/cache.js';
import { readTradeDecisions, readTheses, readPositions } from '../state/manager.js';
import { log, logLLMCall, extractToolCalls } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const ReportSchema = z.object({
  summary: z.string().describe('Executive summary of trading performance'),
  totalTrades: z.number(),
  winRate: z.number(),
  totalPnl: z.number(),
  bestTrade: z.object({
    ticker: z.string(),
    pnl: z.number(),
    thesis: z.string(),
  }).optional(),
  worstTrade: z.object({
    ticker: z.string(),
    pnl: z.number(),
    thesis: z.string(),
  }).optional(),
  signalAnalysis: z.object({
    predictionMarketAccuracy: z.string(),
    fundingRateSignalValue: z.string(),
    mostPredictiveSignal: z.string(),
  }),
  failureModes: z.array(z.object({
    pattern: z.string(),
    frequency: z.number(),
    recommendation: z.string(),
  })),
  promptRefinements: z.array(z.object({
    agent: z.string(),
    currentBehavior: z.string(),
    suggestedChange: z.string(),
    reasoning: z.string(),
  })),
  juryAnalysis: z.object({
    agreementRate: z.string(),
    evaluatorApprovalRate: z.string(),
    dissenterAccuracy: z.string(),
    modelPerformanceNotes: z.string(),
  }),
});

export type MetaReport = z.infer<typeof ReportSchema>;

const SYSTEM_PROMPT = `You are a meta-analysis agent reviewing the trading system's performance. Your job is to find patterns in wins and losses, identify which signals and agents were most predictive, and suggest concrete improvements.

## What to Analyze
1. **Win/loss patterns**: Which types of trades worked? Which didn't? Was direction right but timing wrong?
2. **Signal value**: Were prediction market divergences actually predictive? Did funding rate signals lead to good trades?
3. **Agent accuracy**: Did the jury agree on winners? Did the evaluator block good trades or let bad ones through?
4. **Failure modes**: Common patterns in losses — was it thesis quality, exit timing, or sizing?
5. **Prompt refinements**: Specific, actionable changes to agent prompts based on observed behavior

## Rules
- Be specific and quantitative, not vague
- Reference actual trades and outcomes
- Only suggest prompt changes with clear evidence from the data
- If the sample size is too small, say so instead of overfitting to noise`;

export async function generateMetaReport(): Promise<MetaReport> {
  const startTime = Date.now();
  const decisions = readTradeDecisions(100);
  const theses = readTheses();
  const positions = readPositions();

  const closedPositions = positions.filter(p => p.status === 'closed');

  const prompt = `## Trade Decisions (${decisions.length} total)
${JSON.stringify(decisions, null, 2)}

## Theses (${theses.length} total)
${JSON.stringify(theses, null, 2)}

## Positions (${positions.length} total, ${closedPositions.length} closed)
${JSON.stringify(positions, null, 2)}

Analyze the above data and produce a comprehensive meta-analysis report.`;

  const result = await withRetry(
    () => generateText({
      model: getModel('metaAnalysis'),
      providerOptions: mergeProviderOptions(getProviderOptions('metaAnalysis'), getCacheProviderOptions('metaAnalysis', getProviderName('metaAnalysis'))),
      output: Output.object({ schema: ReportSchema }),
      tools: metaAnalysisToolset,
      stopWhen: stepCountIs(100),
      messages: [
        ...cachedSystemPrompt(SYSTEM_PROMPT, getProviderName('metaAnalysis')),
        { role: 'user' as const, content: prompt },
      ],
    }),
    { label: 'meta-analysis-llm', maxAttempts: 2 },
  );

  const durationMs = Date.now() - startTime;
  const report = result.output;
  if (!report) {
    log({ level: 'error', event: 'meta_analysis_no_output' });
    return { summary: 'Failed to generate report', totalTrades: 0, winRate: 0, totalPnl: 0, signalAnalysis: { predictionMarketAccuracy: 'N/A', fundingRateSignalValue: 'N/A', mostPredictiveSignal: 'N/A' }, failureModes: [], promptRefinements: [], juryAnalysis: { agreementRate: 'N/A', evaluatorApprovalRate: 'N/A', dissenterAccuracy: 'N/A', modelPerformanceNotes: 'N/A' } };
  }

  logLLMCall({
    cycleId: 'meta-analysis',
    model: getModelLabel('metaAnalysis'),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: prompt,
    response: report,
    usage: result.usage ? {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    } : undefined,
    durationMs,
    candidateCount: 0,
    toolCalls: extractToolCalls(result),
  });

  // Write report to disk
  const reportDir = join(config.STATE_DIR, '..', 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `meta-report-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  log({
    level: 'info',
    event: 'meta_report_generated',
    data: {
      totalTrades: report.totalTrades,
      winRate: report.winRate,
      totalPnl: report.totalPnl,
      failureModes: report.failureModes.length,
      promptRefinements: report.promptRefinements.length,
      path: reportPath,
    },
  });

  return report;
}
