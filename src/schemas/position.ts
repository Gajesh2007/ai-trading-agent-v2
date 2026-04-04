import { z } from 'zod';

export const PositionSchema = z.object({
  id: z.string(),
  ticker: z.string(),
  direction: z.enum(['long', 'short']),
  sizeUSD: z.number(),
  leverage: z.number(),
  entryPrice: z.string(),
  currentPrice: z.string().optional(),
  unrealizedPnl: z.string().optional(),
  thesisId: z.string(),
  openedAt: z.string(),
  closedAt: z.string().optional(),
  closeReason: z.string().optional(),
  status: z.enum(['open', 'closed', 'liquidated']),
});

export type Position = z.infer<typeof PositionSchema>;

export const ValidationResultSchema = z.object({
  thesisId: z.string(),
  ticker: z.string(),
  thesisScore: z.number().describe('0-10 scale'),
  action: z.enum(['HOLD', 'REDUCE', 'EXIT']),
  reasoning: z.string(),
  falsificationTriggered: z.array(z.string()),
  edgeRemaining: z.number().describe('0-10 scale'),
  anomalyDetected: z.boolean(),
  anomalyDetails: z.string().optional(),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ExitDecisionSchema = z.object({
  action: z.enum(['HOLD', 'REDUCE', 'EXIT']),
  reasoning: z.string(),
  edgeRemaining: z.number().describe('0-10 scale'),
  revisedFalsification: z.array(z.string()).optional(),
  reduceTo: z.number().optional().describe('Fraction to keep, 0-1')
    .describe('If REDUCE — what fraction of current size to keep'),
});

export type ExitDecision = z.infer<typeof ExitDecisionSchema>;

export const TradeDecisionSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  ticker: z.string(),
  action: z.enum(['open', 'close', 'reduce']),
  direction: z.enum(['long', 'short']).optional(),
  sizeUSD: z.number().optional(),
  leverage: z.number().optional(),
  thesis: z.string(),
  riskReasoning: z.string(),
  juryAgreement: z.string().optional(),
  evaluatorVerdict: z.string().optional(),
  evaluatorScore: z.number().optional(),
  outcome: z.object({
    exitPrice: z.string(),
    pnl: z.number(),
    holdDuration: z.string(),
    exitReason: z.string(),
  }).optional(),
});

export type TradeDecision = z.infer<typeof TradeDecisionSchema>;
