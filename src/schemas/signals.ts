import { z } from 'zod';

export const MacroRegimeSignalSchema = z.object({
  regime: z.enum(['risk-on', 'risk-off', 'transitional', 'crisis']),
  vix: z.number(),
  dollarIndex: z.number().optional(),
  sp500Trend: z.enum(['up', 'down', 'flat']),
  keyDrivers: z.array(z.string()),
  sectorRotation: z.array(z.object({
    from: z.string(),
    to: z.string(),
    reasoning: z.string(),
  })).optional(),
  updatedAt: z.string(),
});

export const PredictionMarketSignalSchema = z.object({
  events: z.array(z.object({
    source: z.enum(['kalshi', 'polymarket']),
    title: z.string(),
    currentOdds: z.number(),
    oddsDirection: z.enum(['rising', 'falling', 'stable']),
    equityImplications: z.array(z.object({
      ticker: z.string(),
      direction: z.enum(['bullish', 'bearish']),
      reasoning: z.string(),
    })),
    divergenceFromEquity: z.boolean(),
    edgeAssessment: z.string(),
    confidence: z.number().describe('1-10 scale'),
    isAnomaly: z.boolean().describe('True if odds shifted >15% in 48 hours'),
  })),
  updatedAt: z.string(),
});

export const FundamentalsSignalSchema = z.object({
  upcomingEarnings: z.array(z.object({
    ticker: z.string(),
    earningsDate: z.string(),
    daysUntil: z.number(),
    consensus: z.string().optional(),
    sentiment: z.enum(['positive', 'negative', 'mixed', 'unknown']),
  })),
  sectorHighlights: z.array(z.object({
    sector: z.string(),
    signal: z.string(),
    affectedTickers: z.array(z.string()),
  })),
  updatedAt: z.string(),
});

export const FlowPositioningSignalSchema = z.object({
  fundingAnomalies: z.array(z.object({
    ticker: z.string(),
    fundingRate: z.string(),
    signal: z.enum(['crowded_long', 'crowded_short', 'neutral']),
    magnitude: z.enum(['mild', 'moderate', 'extreme']),
  })),
  openInterestShifts: z.array(z.object({
    ticker: z.string(),
    direction: z.enum(['increasing', 'decreasing']),
    magnitude: z.enum(['small', 'large']),
  })),
  updatedAt: z.string(),
});

export const TechnicalContextSignalSchema = z.object({
  assets: z.array(z.object({
    ticker: z.string(),
    priceVsPrevDay: z.number().describe('Percentage change from previous day'),
    momentum: z.enum(['strong_up', 'up', 'flat', 'down', 'strong_down']),
    volumeSignal: z.enum(['high', 'normal', 'low']),
    notablePattern: z.string().optional(),
  })),
  updatedAt: z.string(),
});

// --- Market Scanner (Public.com universe screening) ---

export const MarketScannerSignalSchema = z.object({
  watchlist: z.array(z.object({
    ticker: z.string().describe('Stock/ETF symbol, e.g. "NVDA"'),
    reason: z.enum([
      'unusual_options_activity',
      'volume_anomaly',
      'big_mover',
      'earnings_proximity',
      'sector_rotation',
      'news_catalyst',
      'iv_anomaly',
      'prediction_market_linked',
      'institutional_flow',
      'technical_breakout',
    ]),
    details: z.string().describe('Why this ticker was flagged — be specific'),
    urgency: z.enum(['watch', 'investigate', 'urgent']),
    sector: z.string().optional(),
    currentPrice: z.string().optional(),
    dailyChangePercent: z.number().optional(),
    volumeVsAvg: z.number().optional().describe('Volume as multiple of 20d average'),
  })),
  sectorHeatmap: z.array(z.object({
    sector: z.string(),
    etfSymbol: z.string(),
    performance: z.enum(['strong_up', 'up', 'flat', 'down', 'strong_down']),
    flowSignal: z.string().optional(),
  })).optional(),
  marketBreadth: z.object({
    advancers: z.number().optional(),
    decliners: z.number().optional(),
    sentiment: z.enum(['bullish', 'bearish', 'mixed', 'neutral']),
  }).optional(),
  catalystCalendar: z.array(z.object({
    ticker: z.string(),
    event: z.string(),
    date: z.string(),
    daysUntil: z.number(),
  })).optional(),
  updatedAt: z.string(),
});

export type MacroRegimeSignal = z.infer<typeof MacroRegimeSignalSchema>;
export type PredictionMarketSignal = z.infer<typeof PredictionMarketSignalSchema>;
export type FundamentalsSignal = z.infer<typeof FundamentalsSignalSchema>;
export type FlowPositioningSignal = z.infer<typeof FlowPositioningSignalSchema>;
export type TechnicalContextSignal = z.infer<typeof TechnicalContextSignalSchema>;
export type MarketScannerSignal = z.infer<typeof MarketScannerSignalSchema>;
