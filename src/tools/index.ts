import { hyperliquidTools } from './hyperliquid.js';
import { predictionMarketTools } from './prediction-markets.js';
import { getWebToolsForProvider } from './web-search.js';
import { portfolioTools } from './portfolio.js';
import { simulationTools } from './simulation.js';
import { macroTools } from './macro.js';
import { eventMappingTools } from './event-mapping.js';
import { stopLossTools } from './stop-loss.js';
import { builtinTools } from './builtin.js';

function getProviderForRole(role: string): string {
  const envPrefix = `MODEL_${role.toUpperCase()}`;
  return process.env[`${envPrefix}_PROVIDER`] ?? process.env.MODEL_PROVIDER ?? 'anthropic';
}

type ToolCategory = 'hl' | 'pred' | 'web' | 'portfolio' | 'sim' | 'macro' | 'eventMap' | 'stopLoss' | 'readFile' | 'grep' | 'bash';

function buildToolset(role: string, categories: ToolCategory[]) {
  const provider = getProviderForRole(role);
  const tools: Record<string, any> = {};

  if (categories.includes('hl')) Object.assign(tools, hyperliquidTools);
  if (categories.includes('pred')) Object.assign(tools, predictionMarketTools);
  if (categories.includes('web')) Object.assign(tools, getWebToolsForProvider(provider));
  if (categories.includes('portfolio')) Object.assign(tools, portfolioTools);
  if (categories.includes('sim')) Object.assign(tools, simulationTools);
  if (categories.includes('macro')) Object.assign(tools, macroTools);
  if (categories.includes('eventMap')) Object.assign(tools, eventMappingTools);
  if (categories.includes('stopLoss')) Object.assign(tools, stopLossTools);
  // Built-in tools (scoped per role)
  if (categories.includes('readFile')) {
    tools.readFile = builtinTools.readFile;
    tools.listFiles = builtinTools.listFiles;
  }
  if (categories.includes('grep')) tools.grepFiles = builtinTools.grepFiles;
  if (categories.includes('bash')) tools.bash = builtinTools.bash;

  return tools;
}

// --- Scoped toolsets per agent role ---

/** Discovery: find opportunities (stays lean) */
export const discoveryToolset = buildToolset('discovery', ['hl', 'pred', 'web', 'macro', 'eventMap']);

/** Synthesis: generate thesis */
export const synthesisToolset = buildToolset('synthesis', ['hl', 'pred', 'web', 'portfolio', 'sim', 'macro', 'eventMap', 'readFile']);

/** Jury analysts: each gets provider-specific web tools + research tools */
export function analystToolset(role: 'analystA' | 'analystB' | 'analystC') {
  return buildToolset(role, ['hl', 'pred', 'web', 'portfolio', 'sim', 'macro', 'eventMap', 'readFile', 'bash']);
}

/** Evaluator: reviews proposals + can dig into history */
export const evaluatorToolset = buildToolset('evaluator', ['web', 'portfolio', 'sim', 'macro', 'readFile', 'grep', 'bash']);

/** Monitor: validate theses (stays fast — cheap model) */
export const monitorToolset = buildToolset('thesisValidator', ['hl', 'pred', 'web', 'macro', 'readFile']);

/** Exit evaluator: confirms exits + can research */
export const exitEvaluatorToolset = buildToolset('exitEvaluator', ['hl', 'pred', 'web', 'macro', 'readFile']);

/** Meta-analysis: full access to history */
export const metaAnalysisToolset = buildToolset('metaAnalysis', ['web', 'portfolio', 'readFile', 'grep', 'bash']);

/** Executor: only gets stop-loss */
export const executorToolset = buildToolset('discovery', ['hl', 'stopLoss']);
