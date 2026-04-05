import { generateText, Output, stepCountIs } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getModel, getModelLabel, getProviderName } from '../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../utils/cache.js';
import { DiscoveryCandidateSchema } from '../schemas/discovery.js';
import type { DiscoveryOutput } from '../schemas/discovery.js';
import { discoveryToolset } from '../tools/index.js';
import type { DiscoveryContext } from '../context/context-bus.js';
import { log, logLLMCall, extractToolCalls } from '../logger.js';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';

// Schema for what the LLM produces (we add id + discoveredAt after)
const LLMOutputSchema = z.object({
  candidates: z.array(DiscoveryCandidateSchema),
});

const SYSTEM_PROMPT = `You are a discovery scanner for an autonomous trading system. Your job is to identify trade opportunities by finding DIVERGENCES between prediction market odds and asset pricing on Hyperliquid.

## Your Universe
You trade exclusively on the XYZ DEX on Hyperliquid. All symbols are prefixed "xyz:". Available assets include:
- **Stocks**: xyz:NVDA, xyz:TSLA, xyz:AAPL, xyz:META, xyz:MSFT, xyz:GOOGL, xyz:AMD, xyz:AMZN, xyz:NFLX, xyz:PLTR, xyz:COIN, xyz:MSTR, xyz:INTC, xyz:HOOD, xyz:MU, xyz:RIVN, xyz:GME, xyz:BABA, xyz:TSM, xyz:ORCL, xyz:COST, xyz:LLY, etc.
- **Commodities**: xyz:GOLD, xyz:SILVER, xyz:CL (crude), xyz:COPPER, xyz:NATGAS, xyz:PALLADIUM, xyz:PLATINUM, xyz:BRENTOIL, xyz:ALUMINIUM
- **Indices**: xyz:SP500, xyz:VIX, xyz:XYZ100, xyz:JP225, xyz:KR200
- **FX**: xyz:DXY, xyz:EUR, xyz:JPY

And prediction markets from Polymarket and Kalshi covering politics, economics, crypto regulation, and macro events.

## Your Two Discovery Paths

### Path A: Prediction-Market-First (PRIMARY)
1. Scan prediction market events for ones with significant odds or recent odds shifts
2. Determine which XYZ perps would be affected by each event
3. Check whether the perp's current price/funding already reflects those odds
4. If NOT → this is a divergence → candidate trade

Example: "Polymarket prices 65% chance of semiconductor tariffs, but xyz:NVDA hasn't sold off and funding is neutral. The market hasn't priced in the regulatory headwind."

### Path B: Catalyst & Flow (SECONDARY)
1. Check for funding rate anomalies (extreme positive = crowded long, extreme negative = crowded short)
2. Look for macro catalysts that create sector rotation opportunities
3. Spot divergences between index perps (xyz:SP500, xyz:VIX) and individual stock perps

## Output Rules

**YOUR DEFAULT OUTPUT IS AN EMPTY CANDIDATES ARRAY.** Being flat is free. Being wrong costs money.

A position is only justified when you have identified a SPECIFIC, MEASURABLE information edge the market has not yet priced in.

- "NVDA might go up" is NOT a trade.
- "Polymarket prices 65% chance of event X, but xyz:NVDA hasn't moved and funding is neutral — divergence" IS a trade.

If nothing crosses your threshold, return \`{ "candidates": [] }\`. This is the correct and expected output most of the time.

## For each candidate, provide:
- **ticker**: The XYZ perp symbol (e.g. "xyz:NVDA", "xyz:GOLD", "xyz:SP500")
- **direction**: long or short
- **conviction**: low, medium, or high (high = clear divergence with catalyst)
- **catalyst**: The specific event driving this
- **reasoning**: Full chain of logic — what the prediction market says, what the asset price implies, where the gap is
- **predictionMarketSignal**: Source, event, current odds, direction (if Path A)
- **equityContext**: Current price and funding rate from the context
- **discoveryPath**: prediction_market_first or catalyst_flow
- **timeHorizon**: How long this edge might persist

## Your Tools
You receive pre-fetched data in the context, but you also have tools for deeper research. USE THEM — don't rely only on the pre-fetched data.

- **web_search**: Search the web for breaking news, earnings reports, regulatory announcements, Fed commentary. Use this to verify catalysts and find information not in the pre-fetched data.
- **fetchWebPage**: Read the full content of a URL found via web search.
- **refreshXYZAssets**: Get fresh price/funding/OI data for all XYZ DEX assets.
- **getFundingRates**: Get predicted funding rates — extreme rates signal crowded positioning.
- **searchPolymarket**: Search Polymarket by category for specific prediction market events.

Search the web for recent news on any ticker or event that looks promising. Check if a catalyst is real before flagging it as a candidate.`;

function buildUserPrompt(ctx: DiscoveryContext, cycleId: string): string {
  // Summarize assets by category, showing only those with meaningful volume
  const assetsByCategory: Record<string, Array<{ symbol: string; markPx: string; fundingRate: string; dayNtlVlm: string }>> = {};
  for (const asset of ctx.assets) {
    const cat = ctx.categories[asset.symbol] ?? 'crypto';
    (assetsByCategory[cat] ??= []).push({
      symbol: asset.symbol,
      markPx: asset.markPx,
      fundingRate: asset.fundingRate,
      dayNtlVlm: asset.dayNtlVlm,
    });
  }

  // Summarize prediction events
  const predEvents = [...ctx.kalshiEvents, ...ctx.polymarketEvents].map(e => ({
    source: e.source,
    title: e.title,
    category: e.category,
    markets: e.markets.map(m => ({
      question: m.question,
      yesPrice: m.yesPrice,
      volume: m.volume,
    })),
  }));

  // Layer 1 pre-processed signals (if available)
  const hasSignals = Object.keys(ctx.signals).length > 0;

  return `## Discovery Cycle ${cycleId}
Timestamp: ${ctx.fetchedAt}

${hasSignals ? `## Pre-Processed Signals (from Layer 1 agents)
${JSON.stringify(ctx.signals, null, 2)}

` : ''}## XYZ DEX Assets by Category
${JSON.stringify(assetsByCategory, null, 2)}

## Prediction Market Events (${predEvents.length} total)
${JSON.stringify(predEvents, null, 2)}

${ctx.errors.length > 0 ? `\n## Data Source Issues\n${ctx.errors.join('\n')}` : ''}

${ctx.recentRejections.length > 0 ? `## Recently Rejected (DO NOT re-surface unless conditions materially changed)
${[...new Map(ctx.recentRejections.map(r => [`${r.ticker}-${r.direction}`, r])).values()]
  .map(r => `- ${r.ticker} ${r.direction} (score ${r.evaluatorScore}, ${r.stage}) — ${r.evaluatorReasoning.slice(0, 150)}`)
  .join('\n')}

These tickers+directions were recently evaluated and rejected. Only re-surface one if you have NEW information that wasn't available when it was rejected (e.g. prediction market odds shifted >10%, major news broke, fundamentals changed).
` : ''}
Analyze the above data${hasSignals ? ' and pre-processed signals' : ''}. Identify any divergences between prediction market odds and XYZ asset pricing. Return candidates or an empty array.`;
}

export async function runDiscoveryScanner(ctx: DiscoveryContext): Promise<DiscoveryOutput> {
  const cycleId = randomUUID();
  const startTime = Date.now();

  log({ level: 'info', event: 'discovery_start', data: { cycleId } });

  const userPrompt = buildUserPrompt(ctx, cycleId);
  const result = await withRetry(
    () => generateText({
      model: getModel(),
      output: Output.object({ schema: LLMOutputSchema }),
      tools: discoveryToolset,
      stopWhen: stepCountIs(100),
      providerOptions: mergeProviderOptions(getCacheProviderOptions('discovery', getProviderName())),
      messages: [
        ...cachedSystemPrompt(SYSTEM_PROMPT, getProviderName()),
        { role: 'user' as const, content: userPrompt },
      ],
    }),
    { label: 'discovery-llm', maxAttempts: 2 },
  );

  const durationMs = Date.now() - startTime;

  const candidates = (result.output?.candidates ?? []).map((c, i) => ({
    ...c,
    id: `${cycleId.slice(0, 8)}-${i}`,
    discoveredAt: new Date().toISOString(),
  }));

  const output: DiscoveryOutput = {
    candidates,
    scanMetadata: {
      cycleId,
      timestamp: new Date().toISOString(),
      hlAssetsScanned: ctx.assets.length,
      kalshiEventsScanned: ctx.kalshiEvents.length,
      polymarketEventsScanned: ctx.polymarketEvents.length,
      modelUsed: getModelLabel(),
      durationMs,
    },
  };

  logLLMCall({
    cycleId,
    model: getModelLabel(),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    response: result.output,
    toolCalls: extractToolCalls(result),
    usage: result.usage ? {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    } : undefined,
    durationMs,
    candidateCount: candidates.length,
  });

  return output;
}
