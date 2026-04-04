import { z } from 'zod';

export const FalsificationConditionSchema = z.object({
  condition: z.string().describe('Specific, measurable condition that would invalidate the thesis'),
  metric: z.string().describe('What to check — e.g. "Polymarket odds", "VIX level", "funding rate"'),
  threshold: z.string().describe('Concrete threshold — e.g. "drops below 50%", "crosses 25"'),
});

export const ThesisSchema = z.object({
  id: z.string(),
  ticker: z.string(),
  direction: z.enum(['long', 'short']),
  conviction: z.number().describe('1-10 scale'),
  thesis: z.string().describe('The core thesis — what edge exists and why'),
  falsificationConditions: z.array(FalsificationConditionSchema)
    .describe('Concrete conditions that would invalidate this thesis'),
  timeHorizon: z.string().describe('How long this edge should persist'),
  positionSizeRecommendation: z.number()
    .describe('Fraction of capital to risk (0-1)'),
  leverageRecommendation: z.number().describe('Leverage multiplier, e.g. 1-50'),
  riskReasoning: z.string()
    .describe('Why this size and leverage — what is the risk logic'),
  keyRisks: z.array(z.string()),
  reasoningChain: z.string()
    .describe('Step-by-step reasoning that led to this thesis'),
  entryContext: z.object({
    markPrice: z.string(),
    fundingRate: z.string(),
    predictionMarketOdds: z.string().optional(),
  }),
  createdAt: z.string(),
  status: z.enum(['active', 'invalidated', 'expired', 'closed']),
  candidateId: z.string().describe('Links back to discovery candidate'),
});

export type Thesis = z.infer<typeof ThesisSchema>;
export type FalsificationCondition = z.infer<typeof FalsificationConditionSchema>;

// What the LLM produces (we add id, createdAt, status, candidateId after)
export const ThesisGenerationOutputSchema = z.object({
  shouldTrade: z.boolean().describe('Whether this candidate warrants a trade'),
  thesis: z.object({
    ticker: z.string(),
    direction: z.enum(['long', 'short']),
    conviction: z.number().describe('1-10 scale'),
    thesis: z.string(),
    falsificationConditions: z.array(FalsificationConditionSchema),
    timeHorizon: z.string(),
    positionSizeRecommendation: z.number(),
    leverageRecommendation: z.number().describe('Leverage multiplier, e.g. 1-50'),
    riskReasoning: z.string(),
    keyRisks: z.array(z.string()),
    reasoningChain: z.string(),
    entryContext: z.object({
      markPrice: z.string(),
      fundingRate: z.string(),
      predictionMarketOdds: z.string().optional(),
    }),
  }).optional().describe('Only present if shouldTrade is true'),
  noTradeReason: z.string().optional()
    .describe('Why this candidate does not warrant a trade'),
});

export type ThesisGenerationOutput = z.infer<typeof ThesisGenerationOutputSchema>;
