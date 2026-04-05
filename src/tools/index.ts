import { hyperliquidTools } from './hyperliquid.js';
import { predictionMarketTools } from './prediction-markets.js';
import { getWebToolsForProvider } from './web-search.js';
import { portfolioTools } from './portfolio.js';
import { simulationTools } from './simulation.js';
import { macroTools } from './macro.js';
import { eventMappingTools } from './event-mapping.js';
import { stopLossTools } from './stop-loss.js';
import { builtinTools } from './builtin.js';
import { historyTools } from './history.js';
import { spawnTools } from './spawn.js';
import { getAllExchangeTools } from '../exchanges/index.js';

function getProviderForRole(role: string): string {
  const envPrefix = `MODEL_${role.toUpperCase()}`;
  return process.env[`${envPrefix}_PROVIDER`] ?? process.env.MODEL_PROVIDER ?? 'anthropic';
}

type ToolCategory = 'hl' | 'pred' | 'web' | 'portfolio' | 'sim' | 'macro' | 'eventMap' | 'stopLoss' | 'readFile' | 'grep' | 'bash' | 'history' | 'exchange' | 'spawn';

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
  if (categories.includes('history')) Object.assign(tools, historyTools);
  if (categories.includes('exchange')) Object.assign(tools, getAllExchangeTools());
  if (categories.includes('spawn')) Object.assign(tools, spawnTools);
  if (categories.includes('readFile')) {
    tools.readFile = builtinTools.readFile;
    tools.listFiles = builtinTools.listFiles;
  }
  if (categories.includes('grep')) tools.grepFiles = builtinTools.grepFiles;
  if (categories.includes('bash')) tools.bash = builtinTools.bash;

  return tools;
}

// --- Scoped toolsets per agent role ---

/** Discovery: find opportunities across all exchanges + spawn sub-agents for deep dives */
export const discoveryToolset = buildToolset('discovery', ['hl', 'pred', 'web', 'macro', 'eventMap', 'history', 'exchange', 'spawn']);

/** Synthesis: generate thesis + spawn research agents */
export const synthesisToolset = buildToolset('synthesis', ['hl', 'pred', 'web', 'portfolio', 'sim', 'macro', 'eventMap', 'readFile', 'history', 'exchange', 'spawn']);

/** Jury analysts: research + spawn sub-agents for verification */
export function analystToolset(role: 'analystA' | 'analystB' | 'analystC') {
  return buildToolset(role, ['hl', 'pred', 'web', 'portfolio', 'sim', 'macro', 'eventMap', 'readFile', 'bash', 'history', 'exchange', 'spawn']);
}

/** Evaluator: reviews proposals + full history access */
export const evaluatorToolset = buildToolset('evaluator', ['web', 'portfolio', 'sim', 'macro', 'readFile', 'grep', 'bash', 'history', 'exchange']);

/** Monitor: validate theses */
export const monitorToolset = buildToolset('thesisValidator', ['hl', 'pred', 'web', 'macro', 'readFile', 'exchange']);

/** Exit evaluator: confirms exits */
export const exitEvaluatorToolset = buildToolset('exitEvaluator', ['hl', 'pred', 'web', 'macro', 'readFile', 'exchange']);

/** Meta-analysis: full access to everything */
export const metaAnalysisToolset = buildToolset('metaAnalysis', ['web', 'portfolio', 'readFile', 'grep', 'bash', 'history', 'exchange']);

/** Executor: only gets stop-loss */
export const executorToolset = buildToolset('discovery', ['hl', 'stopLoss']);
