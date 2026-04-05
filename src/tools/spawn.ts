/**
 * spawnResearch — lets any agent dynamically spin up sub-agents.
 *
 * Uses AI SDK's ToolLoopAgent for proper subagent lifecycle.
 * The parent agent calls spawnResearch as a tool, passing natural
 * language instructions. The sub-agent runs with its own tools
 * and returns findings.
 *
 * Multiple spawnResearch calls from the same parent = parallel sub-agents
 * (AI SDK executes tool calls concurrently).
 */

import { ToolLoopAgent, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { getModel, getModelLabel, getProviderName } from '../model-router.js';
import { getCacheProviderOptions, mergeProviderOptions } from '../utils/cache.js';
import { getWebToolsForProvider } from './web-search.js';
import { getAllExchangeTools } from '../exchanges/index.js';
import { hyperliquidTools } from './hyperliquid.js';
import { predictionMarketTools } from './prediction-markets.js';
import { portfolioTools } from './portfolio.js';
import { simulationTools } from './simulation.js';
import { historyTools } from './history.js';
import { log } from '../logger.js';

// Build tool set based on requested access level
function buildSubagentTools(toolAccess: 'full' | 'web_only' | 'exchange_only', provider: string): Record<string, any> {
  const tools: Record<string, any> = {};
  if (toolAccess === 'full' || toolAccess === 'web_only') {
    Object.assign(tools, getWebToolsForProvider(provider));
  }
  if (toolAccess === 'full' || toolAccess === 'exchange_only') {
    Object.assign(tools, getAllExchangeTools());
    Object.assign(tools, hyperliquidTools);
    Object.assign(tools, predictionMarketTools);
  }
  if (toolAccess === 'full') {
    Object.assign(tools, portfolioTools);
    Object.assign(tools, simulationTools);
    Object.assign(tools, historyTools);
  }
  return tools;
}

// Create a ToolLoopAgent configured for a specific access level and model tier
function createResearchAgent(
  toolAccess: 'full' | 'web_only' | 'exchange_only',
  modelTier: 'cheap' | 'frontier',
): ToolLoopAgent {
  const role = modelTier === 'frontier' ? 'synthesis' : 'discovery';
  const provider = getProviderName(role);

  return new ToolLoopAgent({
    model: getModel(role),
    providerOptions: mergeProviderOptions(getCacheProviderOptions(role, provider)),
    instructions: `You are a research sub-agent spawned to investigate a specific question or task.

Your job:
1. Complete the research task you are given
2. Use your tools to gather REAL data — do NOT speculate or make up numbers
3. Be thorough but focused — you're one of potentially many parallel agents
4. Return a clear, structured answer the parent agent can act on

If the task mentions specific tickers, investigate those.
If it's open-ended, use your tools to discover relevant information.`,
    tools: buildSubagentTools(toolAccess, provider),
    stopWhen: stepCountIs(100),
  });
}

export const spawnTools = {
  spawnResearch: tool({
    description: `Spawn a research sub-agent to investigate a specific question or ticker. The sub-agent is an independent AI agent with its own tools (web search, exchange data, options chains, etc.) that runs autonomously and returns its findings to you.

USE THIS TO PARALLELIZE YOUR WORK. When you call spawnResearch multiple times in the same response, all sub-agents run in parallel. You are a portfolio manager — deploy your analysts:

- Investigating multiple tickers? Spawn one agent per ticker.
- Need to check options AND news? Spawn two agents.
- Found 20 interesting stocks in the watchlist? Spawn 20 agents to deep-dive each one simultaneously.
- Want to verify a claim? Spawn a fact-checker agent.

Examples of good tasks:
- "Investigate NVDA options chain for the nearest expiration. Check if put IV is low relative to the 65% tariff probability from Polymarket. Get current stock price and recent news."
- "Search for all biotech stocks with FDA catalysts in the next 5 days. Get current prices and check options pricing."
- "Deep-dive LLY — FDA panel vote Thursday. Get option chain, check IV rank, search for analyst consensus."
- "What stocks are most affected by 'Will there be a US government shutdown?' Check current prices of defense contractors, govt IT vendors."`,
    inputSchema: z.object({
      task: z.string().describe('Natural language description of what to research. Be specific about what data to gather and what question to answer.'),
      context: z.string().optional().describe('Additional context (e.g. prediction market data, your own observations) to pass to the sub-agent.'),
      toolAccess: z.enum(['full', 'web_only', 'exchange_only']).default('full')
        .describe('"full" = web search + exchange data + portfolio + simulation. "web_only" = just web search. "exchange_only" = just market data tools.'),
      modelTier: z.enum(['cheap', 'frontier']).default('cheap')
        .describe('"cheap" = fast model for data gathering. "frontier" = strongest model for complex analysis/reasoning.'),
    }),
    execute: async ({ task, context, toolAccess, modelTier }, { abortSignal }) => {
      log({ level: 'info', event: 'subagent_spawned', data: { task: task.slice(0, 120), toolAccess, modelTier } });

      const agent = createResearchAgent(toolAccess, modelTier);
      const prompt = context ? `## Task\n${task}\n\n## Context\n${context}` : task;

      try {
        const result = await agent.generate({ prompt, abortSignal });
        log({ level: 'info', event: 'subagent_complete', data: { task: task.slice(0, 80), responseLength: result.text.length } });
        return result.text;
      } catch (e: any) {
        log({ level: 'warn', event: 'subagent_failed', data: { task: task.slice(0, 80), error: e.message } });
        return `Sub-agent failed: ${e.message}`;
      }
    },
  }),
};
