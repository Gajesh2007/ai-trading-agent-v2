import { ToolLoopAgent, generateText, Output, stepCountIs } from 'ai';
import { z } from 'zod';
import { getModel, getModelLabel, getProviderName } from '../../model-router.js';
import { cachedSystemPrompt, getCacheProviderOptions, mergeProviderOptions } from '../../utils/cache.js';
import { MarketScannerSignalSchema } from '../../schemas/signals.js';
import { writeSignalCache, readSignalCache } from '../../state/manager.js';
import { log, logLLMCall, extractToolCalls } from '../../logger.js';
import { withRetry } from '../../utils/retry.js';
import { getWebToolsForProvider } from '../../tools/web-search.js';
import { getAllExchangeTools } from '../../exchanges/index.js';
import { spawnTools } from '../../tools/spawn.js';
import { fetchPolymarketEvents } from '../../data-sources/polymarket.js';
import { fetchKalshiEvents } from '../../data-sources/kalshi.js';

// ============================================================
// Sub-agent schemas — what each sub-agent produces
// ============================================================

const SubagentFindingsSchema = z.object({
  tickers: z.array(z.object({
    ticker: z.string(),
    reason: z.string(),
    urgency: z.enum(['watch', 'investigate', 'urgent']),
    details: z.string(),
    sector: z.string().optional(),
    currentPrice: z.string().optional(),
    dailyChangePercent: z.number().optional(),
    volumeVsAvg: z.number().optional(),
  })),
});

// ============================================================
// Sub-agent definitions — each is a specialist
// ============================================================

interface SubagentConfig {
  name: string;
  prompt: string;
  userPrompt: string | (() => Promise<string>);
  needsExchangeTools: boolean;
}

function buildSubagents(): SubagentConfig[] {
  const timestamp = new Date().toISOString();
  const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });

  return [
    // --- Unusual Options Activity Scanner ---
    {
      name: 'options-flow',
      prompt: `You are an options flow analyst. Your ONLY job is to find stocks with unusual options activity right now.

Search the web for:
- "unusual options activity today"
- "large options sweeps today"
- "smart money options flow"
- "biggest options trades today"
- "options volume leaders today"
- "unusual call activity" and "unusual put activity"

For each ticker you find with unusual flow, report: what was the trade (calls/puts, strike, expiry, size), why it's unusual (volume vs open interest, sweep vs block), and whether it's bullish or bearish.

Return ONLY tickers where the options flow is genuinely unusual — not just high volume on popular names.`,
      userPrompt: `Scan for unusual options activity now. ${dayOfWeek} ${timestamp}`,
      needsExchangeTools: false,
    },

    // --- Volume Anomaly Scanner ---
    {
      name: 'volume-scanner',
      prompt: `You are a volume anomaly detector. Your ONLY job is to find stocks trading on abnormally high volume today.

Search the web for:
- "stocks with unusual volume today"
- "volume leaders today"
- "stocks volume spike today"
- "most active stocks today"

High volume (>2x 20-day average) often signals institutional accumulation or distribution before a move. Report what's driving the volume if you can find it.`,
      userPrompt: `Find stocks with abnormal volume. ${dayOfWeek} ${timestamp}`,
      needsExchangeTools: false,
    },

    // --- Big Movers Scanner ---
    {
      name: 'big-movers',
      prompt: `You are a price movement scanner. Your ONLY job is to find stocks making significant moves (>3% in either direction) and identify WHY.

Search the web for:
- "biggest stock movers today"
- "stocks gap up today" and "stocks gap down today"
- "top gainers today" and "top losers today"
- "stocks making new highs" and "stocks making new lows"

For each mover, find the CATALYST. A big move without a clear catalyst is more interesting (potential inside information or positioning).`,
      userPrompt: `Find today's biggest stock movers and their catalysts. ${dayOfWeek} ${timestamp}`,
      needsExchangeTools: false,
    },

    // --- Earnings & Catalyst Calendar ---
    {
      name: 'catalyst-calendar',
      prompt: `You are a catalyst calendar analyst. Your ONLY job is to find upcoming binary events that could move individual stocks in the next 1-5 days.

Search the web for:
- "earnings this week" and "earnings tomorrow"
- "FDA decisions this week" and "FDA calendar"
- "fed speakers this week"
- "economic data releases this week"
- "index rebalance" and "stock index changes"
- "lockup expiration"
- "ex-dividend dates this week"
- "IPO lockup expiry"

For each event: what stock is affected, what date, and how material is the potential move?`,
      userPrompt: `Build the catalyst calendar for the next 5 days. ${dayOfWeek} ${timestamp}`,
      needsExchangeTools: false,
    },

    // --- Sector Rotation Scanner ---
    {
      name: 'sector-rotation',
      prompt: `You are a sector rotation analyst. Your ONLY job is to identify which sectors money is flowing INTO and OUT OF right now.

Search the web for:
- "sector performance today"
- "sector rotation"
- "sector ETF flows"
- "money flow by sector"

Then use getPublicQuotes to check sector ETF prices: SPY, QQQ, XLK, XLF, XLE, XLV, XLI, XLP, XLU, XLC, XLRE, XLB, XLY, IWM, DIA.

Also check leveraged ETFs: TQQQ, SQQQ, SOXL, SOXS, UPRO, SPXS, LABU, LABD, FNGU, FNGD.

Identify: which sectors are leading, which are lagging, and any sector that's diverging from the overall market direction (that's the trade).`,
      userPrompt: `Analyze sector rotation and flows now. ${dayOfWeek} ${timestamp}`,
      needsExchangeTools: true,
    },

    // --- IV Rank Scanner ---
    {
      name: 'iv-scanner',
      prompt: `You are an implied volatility analyst. Your ONLY job is to find stocks where options implied volatility is anomalously high or low.

Search the web for:
- "highest IV rank stocks today"
- "highest implied volatility stocks"
- "IV percentile scanner"
- "cheap options stocks" (low IV = potentially underpriced options)
- "expensive options stocks" (high IV = market expects a move)

High IV rank (>80th percentile) means options are expensive — the market expects a big move. If you can identify WHY, that's valuable. If IV is high but there's no obvious catalyst, someone may know something.

Low IV rank before a known catalyst = potentially cheap options = opportunity.`,
      userPrompt: `Scan for IV anomalies across the market. ${dayOfWeek} ${timestamp}`,
      needsExchangeTools: false,
    },

    // --- Institutional Flow Scanner ---
    {
      name: 'institutional-flow',
      prompt: `You are an institutional flow analyst. Your ONLY job is to find evidence of large institutional positioning.

Search the web for:
- "dark pool trades today" or "dark pool activity"
- "block trades today"
- "13F filings recent" (what are hedge funds buying/selling)
- "insider buying today" and "insider selling today"
- "short interest changes" and "most shorted stocks"
- "institutional ownership changes"
- "congress stock trades" (congressional trading disclosure)

Insider buying is one of the strongest signals — executives buying their own stock with real money. Short interest spikes signal potential squeeze setups.`,
      userPrompt: `Find institutional flow signals. ${dayOfWeek} ${timestamp}`,
      needsExchangeTools: false,
    },

    // --- Prediction Market Event Mapper ---
    {
      name: 'event-mapper',
      prompt: `You are a prediction market event mapper. You receive prediction market events and your ONLY job is to figure out which PUBLIC STOCKS each event affects.

For each prediction market event:
1. What companies/sectors are directly affected?
2. What are the second-order effects? (e.g., tariffs on China → affects companies with China supply chain)
3. How material is the event to each stock's price?

Be creative about connections. "Will there be a government shutdown?" affects defense contractors (delayed payments), government IT vendors, Treasury ETFs. "Will the Fed cut rates?" affects banks, REITs, homebuilders, growth tech.

Use getPublicQuotes to verify the stocks you identify are tradeable and get current prices.`,
      userPrompt: async () => {
        const [polyEvents, kalshiEvents] = await Promise.allSettled([
          fetchPolymarketEvents(),
          fetchKalshiEvents(),
        ]);
        const events = [
          ...(polyEvents.status === 'fulfilled' ? polyEvents.value : []),
          ...(kalshiEvents.status === 'fulfilled' ? kalshiEvents.value : []),
        ];
        const topEvents = events.slice(0, 30).map(e => ({
          source: e.source,
          title: e.title,
          markets: e.markets.slice(0, 3).map(m => ({ question: m.question, yesPrice: m.yesPrice })),
        }));
        return `Map these prediction market events to affected stocks:\n${JSON.stringify(topEvents, null, 2)}`;
      },
      needsExchangeTools: true,
    },

    // --- News Catalyst Hunter ---
    {
      name: 'news-hunter',
      prompt: `You are a financial news hunter. Your ONLY job is to find BREAKING or DEVELOPING news stories that could move individual stocks in the next 1-4 days but that the market may not have fully priced in.

Search the web for:
- "breaking stock news today"
- "market moving news"
- "regulatory news stocks"
- "antitrust news"
- "trade policy news" and "tariff news"
- "M&A rumors"
- "analyst upgrades downgrades today"
- "stock halted" (halts often precede big moves on resumption)
- "SEC investigation"

Focus on actionable catalysts with a specific timeline, not generic market commentary.`,
      userPrompt: `Hunt for market-moving news catalysts. ${new Date().toLocaleDateString('en-US', { weekday: 'long' })} ${new Date().toISOString()}`,
      needsExchangeTools: false,
    },
  ];
}

// ============================================================
// Orchestrator — spins up all sub-agents in parallel
// ============================================================

async function runSubagent(config: SubagentConfig): Promise<{ name: string; tickers: any[] }> {
  const startTime = Date.now();
  const provider = getProviderName('discovery');

  const tools: Record<string, any> = {
    ...getWebToolsForProvider(provider),
    ...(config.needsExchangeTools ? getAllExchangeTools() : {}),
    ...spawnTools, // Sub-agents can spawn their own sub-agents for deeper research
  };

  const agent = new ToolLoopAgent({
    model: getModel('discovery'),
    providerOptions: mergeProviderOptions(getCacheProviderOptions('discovery', provider)),
    instructions: config.prompt,
    tools,
    output: Output.object({ schema: SubagentFindingsSchema }),
    stopWhen: stepCountIs(100),
  });

  const userPrompt = typeof config.userPrompt === 'function'
    ? await config.userPrompt()
    : config.userPrompt;

  const result = await withRetry(
    () => agent.generate({ prompt: userPrompt }),
    { label: `scanner-${config.name}`, maxAttempts: 1 },
  );

  const findings = result.output?.tickers ?? [];

  logLLMCall({
    cycleId: `scanner-${config.name}`,
    model: getModelLabel('discovery'),
    systemPrompt: config.prompt,
    userPrompt,
    response: result.output,
    durationMs: Date.now() - startTime,
    candidateCount: findings.length,
    usage: result.usage ? { promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0 } : undefined,
    toolCalls: extractToolCalls(result),
  });

  log({
    level: 'info',
    event: 'scanner_subagent_complete',
    data: { name: config.name, tickersFound: findings.length, durationMs: Date.now() - startTime },
  });

  return { name: config.name, tickers: findings };
}

export async function runMarketScannerAgent(): Promise<void> {
  const startTime = Date.now();
  const subagents = buildSubagents();

  log({ level: 'info', event: 'market_scanner_start', data: { subagentCount: subagents.length } });

  // Fire ALL sub-agents in parallel — this is the swarm
  const results = await Promise.allSettled(
    subagents.map(config => runSubagent(config)),
  );

  // Collect and deduplicate findings
  const tickerMap = new Map<string, any>();

  for (const result of results) {
    if (result.status === 'rejected') {
      log({ level: 'warn', event: 'scanner_subagent_failed', data: { error: String(result.reason) } });
      continue;
    }

    const { name, tickers } = result.value;
    for (const t of tickers) {
      const existing = tickerMap.get(t.ticker);
      if (existing) {
        // Merge: upgrade urgency, append reasons
        if (t.urgency === 'urgent' || (t.urgency === 'investigate' && existing.urgency === 'watch')) {
          existing.urgency = t.urgency;
        }
        existing.details += ` | [${name}] ${t.details}`;
        existing.sources = (existing.sources ?? 1) + 1;
        // More sub-agents flagging the same ticker = higher conviction
        if (existing.sources >= 3) existing.urgency = 'urgent';
        else if (existing.sources >= 2 && existing.urgency === 'watch') existing.urgency = 'investigate';
      } else {
        tickerMap.set(t.ticker, { ...t, sources: 1 });
      }
    }
  }

  // Sort: urgent first, then by number of sources (more signals = more interesting)
  const watchlist = [...tickerMap.values()]
    .sort((a, b) => {
      const urgencyOrder = { urgent: 0, investigate: 1, watch: 2 };
      const urgDiff = (urgencyOrder[a.urgency as keyof typeof urgencyOrder] ?? 2) - (urgencyOrder[b.urgency as keyof typeof urgencyOrder] ?? 2);
      if (urgDiff !== 0) return urgDiff;
      return (b.sources ?? 1) - (a.sources ?? 1);
    });

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  // Build sector heatmap from sector-rotation subagent if available
  const sectorResult = results.find(r =>
    r.status === 'fulfilled' && r.value.name === 'sector-rotation'
  );

  // Build catalyst calendar from catalyst-calendar subagent if available
  const catalystResult = results.find(r =>
    r.status === 'fulfilled' && r.value.name === 'catalyst-calendar'
  );

  const signal = {
    watchlist: watchlist.map(w => ({
      ticker: w.ticker,
      reason: w.reason ?? 'news_catalyst',
      details: w.details,
      urgency: w.urgency,
      sector: w.sector,
      currentPrice: w.currentPrice,
      dailyChangePercent: w.dailyChangePercent,
      volumeVsAvg: w.volumeVsAvg,
    })),
    updatedAt: new Date().toISOString(),
  };

  writeSignalCache('market-scanner', signal);

  log({
    level: 'info',
    event: 'market_scanner_complete',
    data: {
      subagentsRun: subagents.length,
      succeeded,
      failed,
      totalTickersFlagged: watchlist.length,
      urgent: watchlist.filter(w => w.urgency === 'urgent').length,
      investigate: watchlist.filter(w => w.urgency === 'investigate').length,
      multiSignal: watchlist.filter(w => (w.sources ?? 1) >= 2).length,
      durationMs: Date.now() - startTime,
    },
  });
}
