import { generateText, type GenerateTextResult } from 'ai';
import { logLLMCall } from '../logger.js';
import { getModelLabel } from '../model-router.js';

type ModelRole = Parameters<typeof getModelLabel>[0];

/**
 * Wrapper around generateText that automatically logs full prompts, responses,
 * tool calls, usage, and timing. Use this instead of calling generateText directly.
 */
export async function trackedGenerateText<T extends Parameters<typeof generateText>[0]>(
  params: T & { _role?: ModelRole; _cycleId?: string },
): Promise<GenerateTextResult<any, any>> {
  const startTime = Date.now();
  const role = params._role;
  const cycleId = params._cycleId ?? 'unknown';

  // Strip our custom fields before passing to AI SDK
  const { _role, _cycleId, ...sdkParams } = params;

  const result = await generateText(sdkParams as any);

  const durationMs = Date.now() - startTime;

  logLLMCall({
    cycleId,
    model: role ? getModelLabel(role) : undefined,
    systemPrompt: typeof sdkParams.system === 'string' ? sdkParams.system : undefined,
    userPrompt: typeof sdkParams.prompt === 'string' ? sdkParams.prompt : undefined,
    response: (result as any).output ?? result.text,
    toolCalls: result.steps?.flatMap(s =>
      (s as any).toolCalls?.map((tc: any) => ({
        name: tc.toolName,
        args: tc.args,
        result: tc.result,
      })) ?? []
    ),
    usage: result.usage ? {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    } : undefined,
    durationMs,
    candidateCount: 0,
  });

  return result;
}
