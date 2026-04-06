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
import { getExchangeNames } from '../exchanges/index.js';

// Schema for what the LLM produces (we add id + discoveredAt after)
const LLMOutputSchema = z.object({
  candidates: z.array(DiscoveryCandidateSchema),
});

function buildSystemPrompt(activeExchanges: string[]): string {
  const hasHL = activeExchanges.includes('hyperliquid');
  const hasPublic = activeExchanges.includes('public');

  let universe = '';
  let discoveryPaths = '';
  let tools = '';

  if (hasHL) {
    universe += `
### Hyperliquid XYZ DEX (Perpetual Futures)
Prefix tickers with "xyz:" — e.g. "xyz:NVDA", "xyz:GOLD", "xyz:SP500"

**CRITICAL: We ONLY trade equities, commodities, and indices. NO CRYPTO. NO PRE-IPO. Never propose crypto tokens or pre-IPO perps.**

Available assets — EQUITIES, COMMODITIES, AND INDICES ONLY:
- **Stocks**: xyz:NVDA, xyz:TSLA, xyz:AAPL, xyz:META, xyz:MSFT, xyz:GOOGL, xyz:AMD, xyz:AMZN, xyz:NFLX, xyz:PLTR, xyz:INTC, xyz:HOOD, xyz:MU, xyz:RIVN, xyz:GME, xyz:BABA, xyz:TSM, xyz:ORCL, xyz:COST, xyz:LLY, etc.
- **Commodities**: xyz:GOLD, xyz:SILVER, xyz:CL (crude), xyz:COPPER, xyz:NATGAS, xyz:PALLADIUM, xyz:PLATINUM, xyz:BRENTOIL, xyz:ALUMINIUM
- **Indices**: xyz:SP500, xyz:VIX, xyz:XYZ100, xyz:JP225, xyz:KR200
- **FX**: xyz:DXY, xyz:EUR, xyz:JPY

We PREFER leveraged positions. Use the leverage available on HL (up to 50x) to amplify conviction trades. Features: funding rates (signal crowded positioning), 24/7 trading.`;
  }

  if (hasPublic) {
    universe += `
### Public.com (US Equities, Options, Leveraged ETFs)
Prefix tickers with "pub:" — e.g. "pub:NVDA", "pub:TQQQ", "pub:SPY"

**CRITICAL: NO CRYPTO. Only equities, ETFs, options, and commodities. We PREFER leveraged products when we have conviction.**

Available assets include:
- **All US stocks**: Any NYSE/NASDAQ listed equity (NVDA, AAPL, TSLA, META, etc.)
- **Leveraged ETFs (PREFERRED)**: pub:TQQQ (3x QQQ), pub:SOXL (3x semis), pub:UPRO (3x S&P), pub:TNA (3x small cap), pub:LABU (3x biotech), pub:FNGU (3x FANG+), pub:NUGT (3x gold miners), etc.
- **Inverse ETFs (PREFERRED for bearish)**: pub:SQQQ (3x inverse QQQ), pub:SPXS (3x inverse S&P), pub:SOXS (3x inverse semis), pub:FNGD (3x inverse FANG+), pub:DUST (3x inverse gold miners), etc.
- **Options**: Calls and puts on any optionable stock — with Greeks (delta, gamma, theta, vega, IV). Options provide built-in leverage.
- **Sector ETFs**: pub:XLK (tech), pub:XLF (financials), pub:XLE (energy), pub:XLV (healthcare), etc.
- **Commodity ETFs**: pub:GLD (gold), pub:SLV (silver), pub:USO (oil), pub:UNG (nat gas)
Features: Spot equities, options (single-leg and multi-leg strategies), no funding rates, market hours + extended hours.`;
  }

  // Discovery paths
  discoveryPaths += `
### Path A: Prediction-Market-First (PRIMARY — works on ALL exchanges)
1. Scan prediction market events for ones with significant odds or recent odds shifts
2. Determine which assets would be affected by each event
3. Check whether the asset's current price already reflects those odds
4. If NOT → this is a divergence → candidate trade

Example: "Polymarket prices 65% chance of semiconductor tariffs, but NVDA hasn't sold off — the market hasn't priced in the regulatory headwind."`;

  if (hasHL) {
    discoveryPaths += `

### Path B: Funding Rate & Flow (Hyperliquid only)
1. Check for funding rate anomalies (extreme positive = crowded long, extreme negative = crowded short)
2. Look for macro catalysts that create sector rotation opportunities
3. Spot divergences between index perps (xyz:SP500, xyz:VIX) and individual stock perps`;
  }

  if (hasPublic) {
    discoveryPaths += `

### Path C: Options IV Divergence (Public.com)
You have access to the ENTIRE US stock market. Don't just look at the pre-fetched data — USE YOUR TOOLS to investigate any stock that prediction markets or news suggest is interesting.

**How to discover:**
1. Read prediction market events — which companies/sectors are they about?
2. Use **getPublicQuotes** to check current stock prices for those tickers
3. Use **getOptionExpirations** → **getOptionChain** → **getOptionGreeks** to check options pricing
4. Compare: Does the options market's implied move match what prediction markets are pricing?
5. If NOT → the options are mispriced → candidate trade

**Concrete examples:**
- Prediction market: "70% chance of semiconductor export controls" → call getPublicQuotes(["NVDA", "AMD", "AVGO", "LRCX", "AMAT"]) → call getOptionChain for nearest expiry → if put IV is only 25% but event implies 40% move → buy puts
- News: "FDA panel votes Thursday on LLY obesity drug" → call getPublicQuotes(["LLY"]) → check option chain around the event date → if options are cheap relative to the binary outcome → buy straddle
- Prediction market shift: "tariff odds jumped 20 points" → call searchPublicInstruments to find affected companies → check which ones haven't moved yet

### Path D: Sector & Leveraged ETF Flows (Public.com)
The pre-fetched data includes sector ETFs (XLK, XLE, XLF, etc.) and leveraged products (TQQQ, SOXL, etc.) as an orientation layer. Use these to:
1. Read sector ETF prices — which sectors are moving? Which are lagging?
2. Cross-reference with prediction market events — does the sector move match what prediction markets imply?
3. If a sector ETF hasn't reacted to a prediction market shift, the leveraged version amplifies the trade
4. Use **searchPublicInstruments** to find other stocks in that sector if you want individual name exposure

### Path E: News & Catalyst Discovery (Public.com)
Use **web_search** aggressively to find catalysts the prediction markets haven't created events for:
1. Search for upcoming earnings, FDA decisions, antitrust rulings, trade policy announcements
2. For each catalyst found, use **getPublicQuotes** to check the stock price
3. If the catalyst is material but the stock/options haven't moved → divergence
4. This is how you discover tickers that aren't in any pre-fetched list — the ENTIRE Public.com universe is available via tools`;
  }

  if (hasHL && hasPublic) {
    discoveryPaths += `

### Cross-Exchange Vehicle Selection
When you find a divergence, choose the BEST way to express it:
- **Perps (xyz: on Hyperliquid)**: Short-term directional plays, 24/7 access, up to 50x leverage, funding cost
- **Spot stock (pub: on Public.com)**: Longer holds, no ongoing cost, fractional shares
- **Leveraged ETF (pub: on Public.com)**: Built-in 2-3x amplification, no margin needed, daily rebalance decay on multi-day holds
- **Options (pub: on Public.com)**: Defined-risk, asymmetric payoff, event-driven plays, can profit from vol expansion
- **Inverse ETF (pub: on Public.com)**: Short exposure without borrowing, available during market hours only

Example: "Semiconductor tariff odds rising" → you could short xyz:NVDA perp (24/7, leveraged) OR buy pub:SOXS (3x inverse semis ETF, no margin) OR buy NVDA puts on Public.com (defined risk, asymmetric). Pick the one with the best risk/reward for THIS specific thesis.`;
  }

  // Tools section
  tools = `
## Your Tools
You receive pre-fetched data in the context, but you also have tools for deeper research. USE THEM — don't rely only on the pre-fetched data.

- **web_search**: Search the web for breaking news, earnings reports, regulatory announcements, Fed commentary.
- **fetchWebPage**: Read the full content of a URL found via web search.`;

  if (hasHL) {
    tools += `
- **refreshXYZAssets**: Get fresh price/funding/OI data for all XYZ DEX assets.
- **getFundingRates**: Get predicted funding rates — extreme rates signal crowded positioning.`;
  }

  if (hasPublic) {
    tools += `
- **getPublicQuotes**: Get real-time quotes for US stocks and ETFs.
- **getOptionExpirations**: Get available option expiration dates for a stock.
- **getOptionChain**: Get full options chain (calls + puts with bid/ask/volume/OI).
- **getOptionGreeks**: Get Greeks (delta, gamma, theta, vega, IV) for option contracts.
- **searchPublicInstruments**: Search for tradeable instruments (stocks, ETFs, etc).
- **getPublicPortfolio**: Check Public.com portfolio state.
- **preflightOrder**: Estimate order cost and buying power requirement.`;
  }

  tools += `
- **searchPolymarket**: Search Polymarket by category for specific prediction market events.
- **getRecentRejections**: Check what was recently rejected and WHY. ALWAYS call this before producing candidates.
- **getPastDecisions**: Review past trade decisions and outcomes for calibration.
- **getCycleSummaries**: See recent cycle results.

### Sub-Agent Spawning (YOUR SUPERPOWER)
- **spawnResearch**: Spawn a sub-agent to investigate a specific question or ticker. The sub-agent runs independently with its own tools and returns findings. You can spawn MANY of these in parallel.
- **spawnParallelResearch**: Spawn MULTIPLE sub-agents at once. Pass an array of tasks, get all results back.

**USE THIS AGGRESSIVELY.** You are not one analyst — you are a portfolio manager who can deploy an army of analysts. Examples:
- The watchlist has 30 tickers? Spawn 30 agents: "Deep-dive {ticker} — check options chain, recent news, prediction market connections"
- Found 5 prediction market events? Spawn 5 agents: "Which stocks does '{event}' affect? Get current prices and check if they've priced it in"
- Want to verify a thesis? Spawn an agent: "Fact-check: is {claim} true? Search for evidence"

The more you parallelize, the better your coverage. Think like a PM running a desk, not a single analyst.

IMPORTANT: Before producing ANY candidates, call getRecentRejections first. If a ticker+direction was rejected, explain what NEW information justifies re-evaluation.`;

  return `You are a discovery scanner for an autonomous trading system. Your job is to identify trade opportunities by finding DIVERGENCES between prediction market odds and asset pricing.

## Your Universe
${universe}

And prediction markets from Polymarket and Kalshi covering politics, economics, crypto regulation, and macro events.

## Your Discovery Paths
${discoveryPaths}

## Output Rules

**YOUR DEFAULT OUTPUT IS AN EMPTY CANDIDATES ARRAY.** Being flat is free. Being wrong costs money.

A position is only justified when you have identified a SPECIFIC, MEASURABLE information edge the market has not yet priced in.

- "NVDA might go up" is NOT a trade.
- "Polymarket prices 65% chance of event X, but NVDA hasn't moved and funding is neutral — divergence" IS a trade.

If nothing crosses your threshold, return \`{ "candidates": [] }\`. This is the correct and expected output most of the time.

## For each candidate, provide:
- **ticker**: Exchange-prefixed symbol (e.g. "xyz:NVDA" for Hyperliquid, "pub:NVDA" for Public.com)
- **exchange**: "hyperliquid" or "public"
- **instrument**: "perp", "spot", "option", or "etf"
- **direction**: long or short
- **conviction**: low, medium, or high (high = clear divergence with catalyst)
- **catalyst**: The specific event driving this
- **reasoning**: Full chain of logic
- **predictionMarketSignal**: Source, event, current odds, direction (if Path A)
- **equityContext**: Current price (and funding rate if perp)
- **discoveryPath**: prediction_market_first, catalyst_flow, options_iv_divergence, or leveraged_etf
- **timeHorizon**: How long this edge might persist
${tools}`;
}

function buildUserPrompt(ctx: DiscoveryContext, cycleId: string): string {
  // Summarize HL assets by category
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

  // Layer 1 pre-processed signals
  const hasSignals = Object.keys(ctx.signals).length > 0;

  // Public.com assets from scanner watchlist
  const publicAssets = ctx.exchangeAssets.filter(a => a.exchange === 'public');

  // Market Scanner watchlist (the scanner agent's output with reasons WHY each ticker was flagged)
  const scannerWatchlist = (ctx.signals as any)?.['market-scanner']?.watchlist;

  return `## Discovery Cycle ${cycleId}
Timestamp: ${ctx.fetchedAt}
Active Exchanges: ${ctx.activeExchanges.join(', ')}

${hasSignals ? `## Pre-Processed Signals (from Layer 1 agents)
${JSON.stringify(ctx.signals, null, 2)}

` : ''}${Object.keys(assetsByCategory).length > 0 ? `## Hyperliquid XYZ DEX Assets by Category
${JSON.stringify(assetsByCategory, null, 2)}

` : ''}${scannerWatchlist?.length > 0 ? `## Market Scanner Watchlist (${scannerWatchlist.length} tickers flagged)
The Market Scanner agent scanned the entire US stock market and flagged these tickers. Each has a reason — USE YOUR TOOLS to verify and deep-dive the ones connected to prediction market signals.
${JSON.stringify(scannerWatchlist, null, 2)}

` : ''}${publicAssets.length > 0 && !scannerWatchlist?.length ? `## Public.com Assets (live quotes)
${JSON.stringify(publicAssets.map(a => ({ symbol: a.symbol, price: a.markPx, volume: a.volume24h })), null, 2)}

` : ''}## Prediction Market Events (${predEvents.length} total)
${JSON.stringify(predEvents, null, 2)}

${ctx.errors.length > 0 ? `\n## Data Source Issues\n${ctx.errors.join('\n')}` : ''}

Analyze the above data. The Market Scanner has already screened the entire market for unusual activity — cross-reference its watchlist with prediction market events to find divergences. Use tools to deep-dive specific tickers. Before producing candidates, call getRecentRejections. Return candidates or an empty array.`;
}

export async function runDiscoveryScanner(ctx: DiscoveryContext): Promise<DiscoveryOutput> {
  const cycleId = randomUUID();
  const startTime = Date.now();

  log({ level: 'info', event: 'discovery_start', data: { cycleId, exchanges: ctx.activeExchanges } });

  const systemPrompt = buildSystemPrompt(ctx.activeExchanges);
  const userPrompt = buildUserPrompt(ctx, cycleId);

  const result = await withRetry(
    () => generateText({
      model: getModel(),
      output: Output.object({ schema: LLMOutputSchema }),
      tools: discoveryToolset,
      stopWhen: stepCountIs(100),
      providerOptions: mergeProviderOptions(getCacheProviderOptions('discovery', getProviderName())),
      messages: [
        ...cachedSystemPrompt(systemPrompt, getProviderName()),
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
    systemPrompt,
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
