import { generateText, Output, stepCountIs } from 'ai';
import { z } from 'zod';
import { getModel, getModelLabel, getProviderOptions, getProviderName } from '../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../utils/cache.js';
import { discoveryToolset } from '../tools/index.js';
import { log, logLLMCall, extractToolCalls } from '../logger.js';
import { withRetry } from '../utils/retry.js';

// --- Anomaly Investigation Subagent ---

const InvestigationSchema = z.object({
  rootCause: z.string().describe('What is driving this signal?'),
  persistence: z.enum(['temporary', 'structural']).describe('Is this temporary or structural?'),
  equityImpact: z.array(z.object({
    ticker: z.string(),
    direction: z.enum(['bullish', 'bearish']),
    magnitude: z.enum(['low', 'medium', 'high']),
    reasoning: z.string(),
  })),
  confidence: z.number().describe('1-10 scale'),
  timeSensitivity: z.enum(['act_now', 'monitor', 'low_urgency']),
  summary: z.string(),
});

export type InvestigationResult = z.infer<typeof InvestigationSchema>;

export async function spawnInvestigationSubagent(anomaly: {
  type: string;
  details: string;
  parentAgent: string;
}): Promise<InvestigationResult | null> {
  const startTime = Date.now();

  log({ level: 'info', event: 'subagent_spawned', data: { type: 'investigation', parentAgent: anomaly.parentAgent, anomalyType: anomaly.type } });

  const investigationSystemPrompt = `You are an investigation subagent. A monitoring agent has detected an anomaly and escalated it to you for deep investigation.

Your task: Investigate this anomaly thoroughly.
- Use web search to find recent news, filings, or events that explain it
- Check prediction market odds for related events
- Verify with fresh market data

Be thorough. This investigation drives a real trading decision.`;

  const investigationUserPrompt = `INVESTIGATION BRIEF
===================
Parent agent: ${anomaly.parentAgent}
Anomaly type: ${anomaly.type}
Details: ${anomaly.details}

Investigate this anomaly. What's driving it? Is it temporary or structural? Which XYZ assets are affected?`;

  try {
    const result = await withRetry(
      () => generateText({
        model: getModel('synthesis'),
        providerOptions: mergeProviderOptions(getProviderOptions('synthesis'), getCacheProviderOptions('synthesis', getProviderName('synthesis'))),
        output: Output.object({ schema: InvestigationSchema }),
        tools: discoveryToolset,
        stopWhen: stepCountIs(100),
        messages: [
          ...cachedSystemPrompt(investigationSystemPrompt, getProviderName('synthesis')),
          { role: 'user' as const, content: investigationUserPrompt },
        ],
      }),
      { label: 'investigation-subagent', maxAttempts: 2 },
    );

    const output = result.output;

    logLLMCall({
      cycleId: `investigate-${anomaly.type}`,
      model: getModelLabel('synthesis'),
      systemPrompt: investigationSystemPrompt,
      userPrompt: investigationUserPrompt,
      response: output,
      durationMs: Date.now() - startTime,
      candidateCount: output?.equityImpact.length ?? 0,
      usage: result.usage ? { promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0 } : undefined,
      toolCalls: extractToolCalls(result),
    });

    if (output) {
      log({ level: 'info', event: 'investigation_complete', data: { confidence: output.confidence, timeSensitivity: output.timeSensitivity, assetsAffected: output.equityImpact.length } });
    }

    return output ?? null;
  } catch (e: any) {
    log({ level: 'error', event: 'investigation_failed', data: { error: e.message } });
    return null;
  }
}

// --- Devil's Advocate Subagent ---

const DevilsAdvocateSchema = z.object({
  resolution: z.object({
    direction: z.enum(['long', 'short', 'no-trade']),
    conviction: z.number().describe('1-10 scale'),
    reasoning: z.string(),
  }),
  gapAnalysis: z.string().describe('What each analyst saw that the others missed'),
  recommendation: z.string(),
});

export type DevilsAdvocateResult = z.infer<typeof DevilsAdvocateSchema>;

export async function spawnDevilsAdvocate(analystOutputs: Array<{
  direction: string;
  conviction: number;
  reasoningChain: string;
}>): Promise<DevilsAdvocateResult | null> {
  const startTime = Date.now();

  log({ level: 'info', event: 'subagent_spawned', data: { type: 'devils_advocate', analystCount: analystOutputs.length } });

  const devilsAdvocateSystemPrompt = `You are a devil's advocate. The analyst jury has produced a SPLIT decision — no consensus on direction. Your job is to investigate what each analyst is seeing that the others aren't.

The truth is in the gap between their analyses. One of them may have noticed something the others missed. Or they may all be wrong.

Do your own research. Don't just summarize their views — investigate independently and form your own conclusion.`;

  const devilsAdvocateUserPrompt = `SPLIT JURY — Devil's Advocate Investigation
============================================

${analystOutputs.map((a, i) => `Analyst ${i + 1}: ${a.direction} (conviction ${a.conviction}/10)
Reasoning: ${a.reasoningChain}
`).join('\n')}

These analysts disagree. Investigate what each is seeing. Form your own independent conclusion.`;

  try {
    const result = await withRetry(
      () => generateText({
        model: getModel('evaluator'),
        providerOptions: mergeProviderOptions(getProviderOptions('evaluator'), getCacheProviderOptions('evaluator', getProviderName('evaluator'))),
        output: Output.object({ schema: DevilsAdvocateSchema }),
        tools: discoveryToolset,
        stopWhen: stepCountIs(100),
        messages: [
          ...cachedSystemPrompt(devilsAdvocateSystemPrompt, getProviderName('evaluator')),
          { role: 'user' as const, content: devilsAdvocateUserPrompt },
        ],
      }),
      { label: 'devils-advocate', maxAttempts: 2 },
    );

    const output = result.output;

    logLLMCall({
      cycleId: 'devils-advocate',
      model: getModelLabel('evaluator'),
      systemPrompt: devilsAdvocateSystemPrompt,
      userPrompt: devilsAdvocateUserPrompt,
      response: output,
      durationMs: Date.now() - startTime,
      candidateCount: 0,
      usage: result.usage ? { promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0 } : undefined,
      toolCalls: extractToolCalls(result),
    });

    if (output) {
      log({ level: 'info', event: 'devils_advocate_complete', data: { direction: output.resolution.direction, conviction: output.resolution.conviction } });
    }

    return output ?? null;
  } catch (e: any) {
    log({ level: 'error', event: 'devils_advocate_failed', data: { error: e.message } });
    return null;
  }
}
