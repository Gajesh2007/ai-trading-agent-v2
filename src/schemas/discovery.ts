import { z } from 'zod';

// --- Hyperliquid asset data ---

export const HLAssetSchema = z.object({
  symbol: z.string(),
  markPx: z.string(),
  fundingRate: z.string(),
  openInterest: z.string(),
  prevDayPx: z.string(),
  dayNtlVlm: z.string(),
  maxLeverage: z.number(),
});

export type HLAsset = z.infer<typeof HLAssetSchema>;

// --- Prediction market events (normalized across Kalshi + Polymarket) ---

export const PredictionMarketSchema = z.object({
  id: z.string(),
  question: z.string(),
  yesPrice: z.number().describe('Price 0-1'),
  volume: z.number().optional(),
  endDate: z.string().optional(),
});

export const PredictionEventSchema = z.object({
  source: z.enum(['kalshi', 'polymarket']),
  id: z.string(),
  title: z.string(),
  category: z.string().optional(),
  markets: z.array(PredictionMarketSchema),
});

export type PredictionEvent = z.infer<typeof PredictionEventSchema>;

// --- Discovery candidate (LLM output) ---

export const DiscoveryCandidateSchema = z.object({
  ticker: z.string().describe('Hyperliquid perp symbol, e.g. "NVDA"'),
  direction: z.enum(['long', 'short']),
  conviction: z.enum(['low', 'medium', 'high']),
  catalyst: z.string().describe('What event or signal drives this idea'),
  reasoning: z.string().describe('Full reasoning chain — why this is a trade'),
  predictionMarketSignal: z.object({
    source: z.enum(['kalshi', 'polymarket']),
    eventTitle: z.string(),
    currentOdds: z.number(),
    oddsDirection: z.enum(['rising', 'falling', 'stable']),
  }).optional().describe('The prediction market signal, if Path A discovery'),
  equityContext: z.object({
    currentPrice: z.string(),
    fundingRate: z.string(),
  }),
  discoveryPath: z.enum(['prediction_market_first', 'catalyst_flow']),
  timeHorizon: z.string().describe('How long this edge might persist'),
});

export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;

// --- Full discovery output (candidates + metadata) ---

export const ScanMetadataSchema = z.object({
  cycleId: z.string(),
  timestamp: z.string(),
  hlAssetsScanned: z.number(),
  kalshiEventsScanned: z.number(),
  polymarketEventsScanned: z.number(),
  modelUsed: z.string(),
  durationMs: z.number(),
});

export const DiscoveryOutputSchema = z.object({
  candidates: z.array(DiscoveryCandidateSchema.extend({
    id: z.string(),
    discoveredAt: z.string(),
  })),
  scanMetadata: ScanMetadataSchema,
});

export type DiscoveryOutput = z.infer<typeof DiscoveryOutputSchema>;
