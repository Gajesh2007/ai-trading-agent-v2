import { z } from 'zod';
import { ThesisGenerationOutputSchema } from './thesis.js';

export const JuryAnalysisSchema = z.object({
  ticker: z.string(),
  direction: z.enum(['long', 'short', 'no-trade']),
  conviction: z.number().describe('1-10 scale'),
  thesis: z.string(),
  falsificationConditions: z.array(z.string()),
  timeHorizon: z.string(),
  positionSizeRecommendation: z.number(),
  leverageRecommendation: z.number().describe('Leverage multiplier, e.g. 1-50'),
  riskReasoning: z.string(),
  keyRisks: z.array(z.string()),
  reasoningChain: z.string(),
});

export type JuryAnalysis = z.infer<typeof JuryAnalysisSchema>;

export const EvaluatorGradeSchema = z.object({
  thesisQuality: z.number().describe('1-10 scale'),
  falsificationSpecificity: z.number().describe('1-10 scale'),
  informationCompleteness: z.number().describe('1-10 scale'),
  riskReward: z.number().describe('1-10 scale'),
  edgeDecay: z.number().describe('1-10 scale'),
});

export const EvaluatorVerdictSchema = z.object({
  decision: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']),
  grades: EvaluatorGradeSchema,
  weightedScore: z.number(),
  reasoning: z.string(),
  feedback: z.string().optional()
    .describe('Specific feedback if SEND_BACK — what to investigate further'),
  revisedConviction: z.number().describe('1-10 scale').optional()
    .describe('Evaluator\'s own conviction if different from jury'),
  revisedSize: z.number().optional()
    .describe('Evaluator\'s recommended position size if different'),
});

export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

export const JuryResultSchema = z.object({
  ticker: z.string(),
  analyses: z.array(JuryAnalysisSchema),
  agreement: z.enum(['unanimous', 'majority', 'split']),
  consensusDirection: z.enum(['long', 'short', 'no-trade']),
  avgConviction: z.number(),
  dissent: z.string().optional(),
});

export type JuryResult = z.infer<typeof JuryResultSchema>;
