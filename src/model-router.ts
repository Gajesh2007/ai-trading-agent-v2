import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { config, validateModelConfig } from './config.js';

type ModelRole =
  | 'discovery'        // Layer 1 — scans for ideas
  | 'synthesis'        // Layer 2 — generates theses
  | 'analystA'         // Layer 2 — jury member
  | 'analystB'         // Layer 2 — jury member
  | 'analystC'         // Layer 2 — jury member
  | 'evaluator'        // Layer 2 — skeptical critic
  | 'thesisValidator'  // Layer 3 — cheap continuous monitoring
  | 'exitEvaluator'    // Layer 3 — confirms exits
  | 'metaAnalysis';    // Layer 4 — learns from decisions

function resolveProviderAndId(role: ModelRole): { provider: string; id: string } {
  const envPrefix = `MODEL_${role.toUpperCase()}`;
  const provider = process.env[`${envPrefix}_PROVIDER`] ?? config.MODEL_PROVIDER;
  const id = process.env[`${envPrefix}_ID`] ?? config.MODEL_ID;
  return { provider, id };
}

// Roles that get max reasoning effort
const MAX_EFFORT_ROLES: Set<ModelRole> = new Set([
  'synthesis', 'analystA', 'analystB', 'evaluator', 'exitEvaluator', 'metaAnalysis',
]);

function buildModel(provider: string, id: string) {
  switch (provider) {
    case 'anthropic':
      return anthropic(id);
    case 'openai':
      return openai(id);
    case 'openrouter': {
      const openrouter = createOpenRouter({ apiKey: config.OPENROUTER_API_KEY! });
      return openrouter(id);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function getModel(role: ModelRole = 'discovery') {
  validateModelConfig();
  const { provider, id } = resolveProviderAndId(role);
  return buildModel(provider, id);
}

/**
 * Returns providerOptions for the given role.
 * High-stakes roles get max reasoning effort:
 * - Anthropic: adaptive thinking + max effort
 * - OpenAI: xHigh reasoning effort
 */
export function getProviderOptions(role: ModelRole = 'discovery'): Record<string, any> | undefined {
  if (!MAX_EFFORT_ROLES.has(role)) return undefined;

  const { provider } = resolveProviderAndId(role);

  if (provider === 'anthropic') {
    return {
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: 'max',
      },
    };
  }

  if (provider === 'openai') {
    return {
      openai: {
        reasoningEffort: 'xhigh',
      },
    };
  }

  return undefined;
}

export function getModelLabel(role: ModelRole = 'discovery'): string {
  const { provider, id } = resolveProviderAndId(role);
  const effort = MAX_EFFORT_ROLES.has(role)
    ? (provider === 'anthropic' ? '+max' : provider === 'openai' ? '+xhigh' : '')
    : '';
  return `${provider}/${id}${effort}`;
}
