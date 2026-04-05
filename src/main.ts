import { config } from './config.js';
import { assembleDiscoveryContext } from './context/context-bus.js';
import { runDiscoveryScanner } from './agents/discovery.js';
import { generateThesis } from './agents/synthesis.js';
import { runJuryWithDebate } from './agents/jury.js';
import { validateThesis, evaluateExit } from './agents/monitor.js';
import { generateMetaReport } from './agents/meta-analysis.js';
import { spawnInvestigationSubagent, spawnDevilsAdvocate } from './agents/subagents.js';
import { runMacroRegimeAgent } from './agents/information/macro-regime.js';
import { runPredictionMarketsAgent } from './agents/information/prediction-markets.js';
import { runFundamentalsAgent } from './agents/information/fundamentals.js';
import { runFlowPositioningAgent } from './agents/information/flow-positioning.js';
import { runTechnicalContextAgent } from './agents/information/technical-context.js';
import { runMarketScannerAgent } from './agents/information/market-scanner.js';
import { executeOpen, executeClose, executeReduce, getAccountEquity, getHLPositions } from './execution/executor.js';
import { checkCircuitBreaker, isPaused } from './execution/circuit-breaker.js';
import { notify } from './execution/notifier.js';
import {
  writeCandidates, appendToHistory, ensureStateDir,
  addThesis, getActiveTheses, getOpenPositions, updatePosition, updateThesis,
  readSignalCache, appendCycleSummary,
  addRejection, getRecentRejections,
} from './state/manager.js';
import { log, writeProgress } from './logger.js';
import { initializeExchanges, getExchangeForTicker, getExchangeNames, getAllExchanges } from './exchanges/index.js';

const DISCOVERY_INTERVAL = config.DISCOVERY_INTERVAL_MS;
const LAYER1_INTERVAL = config.DISCOVERY_INTERVAL_MS;     // Layer 1 runs at same cadence as discovery
const MONITORING_INTERVAL = 5 * 60 * 1000;
const CIRCUIT_CHECK_INTERVAL = 60 * 1000;
const META_ANALYSIS_INTERVAL = 7 * 24 * 60 * 60 * 1000;

// Persisted dedup set — survives restarts
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
const DEDUP_PATH = join(config.STATE_DIR, 'evaluated-candidates.json');

function loadDedup(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(DEDUP_PATH, 'utf-8'));
    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveDedup(set: Set<string>): void {
  writeFileSync(DEDUP_PATH, JSON.stringify([...set]));
}

const evaluatedCandidates = loadDedup();

// ============================================================
// LOOP 0: Layer 1 Information Agents → Signal Cache
// ============================================================

async function layer1Loop(): Promise<void> {
  while (true) {
    if (isPaused()) { await sleep(LAYER1_INTERVAL); continue; }

    try {
      log({ level: 'info', event: 'layer1_cycle_start' });
      writeProgress('Layer 1 information agents running');

      // Run info agents in parallel — skip exchange-specific ones based on active exchanges
      const activeExchanges = getExchangeNames();
      const hasHL = activeExchanges.includes('hyperliquid');
      const hasPublic = activeExchanges.includes('public');
      const agents: Promise<any>[] = [
        runMacroRegimeAgent(),
        runPredictionMarketsAgent(),
        // HL-specific: flow positioning and technical context need HL data
        ...(hasHL ? [runFlowPositioningAgent(), runTechnicalContextAgent()] : []),
        // Public.com-specific: market scanner screens the entire US equity universe
        ...(hasPublic ? [runMarketScannerAgent()] : []),
      ];
      const results = await Promise.allSettled(agents);

      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        log({ level: 'warn', event: 'layer1_partial_failure', data: { failed: failed.length } });
      }

      log({ level: 'info', event: 'layer1_cycle_complete' });
    } catch (error) {
      log({ level: 'error', event: 'layer1_error', data: { error: String(error) } });
    }

    await sleep(LAYER1_INTERVAL);
  }
}

// Run fundamentals separately on a slower cadence (every hour)
async function fundamentalsLoop(): Promise<void> {
  while (true) {
    if (isPaused()) { await sleep(3600000); continue; }
    try {
      await runFundamentalsAgent();
    } catch (error) {
      log({ level: 'error', event: 'fundamentals_error', data: { error: String(error) } });
    }
    await sleep(3600000); // 1 hour — web search heavy
  }
}

// ============================================================
// LOOP 1: Discovery → Synthesis → Jury → Evaluator → Execute
// ============================================================

async function discoveryLoop(): Promise<void> {
  // Wait for first Layer 1 cycle to populate signal cache
  await sleep(5000);

  while (true) {
    if (isPaused()) { await sleep(DISCOVERY_INTERVAL); continue; }

    try {
      log({ level: 'info', event: 'discovery_cycle_start' });
      writeProgress('Discovery cycle started');

      const ctx = await assembleDiscoveryContext();
      if (ctx.assets.length === 0) {
        log({ level: 'error', event: 'discovery_abort', data: { reason: 'No assets fetched' } });
        await sleep(DISCOVERY_INTERVAL);
        continue;
      }

      // Discovery scanner now receives pre-processed signals from Layer 1
      const discoveryResult = await runDiscoveryScanner(ctx);
      writeCandidates(discoveryResult);
      appendToHistory(discoveryResult);

      log({ level: 'info', event: 'discovery_complete', data: { candidatesFound: discoveryResult.candidates.length } });
      writeProgress(`Discovery found ${discoveryResult.candidates.length} candidates`);

      if (discoveryResult.candidates.length === 0) {
        await sleep(DISCOVERY_INTERVAL);
        continue;
      }

      const equity = await getAccountEquity();
      const effectiveEquity = equity > 0 ? equity : config.PAPER_STARTING_EQUITY;
      const openPositions = getOpenPositions();
      const openTickers = new Set(openPositions.map(p => p.ticker));

      // Track each candidate's journey through the pipeline
      const candidateResults: Array<{
        ticker: string;
        direction: string;
        synthesisResult: 'trade' | 'no-trade';
        noTradeReason?: string;
        juryAgreement?: string;
        juryConviction?: number;
        evaluatorDecision?: string;
        evaluatorScore?: number;
        executed?: boolean;
        positionId?: string;
      }> = [];

      for (const candidate of discoveryResult.candidates) {
        if (isPaused()) break;

        const dedupKey = `${candidate.ticker}-${candidate.direction}-${candidate.catalyst}`;
        if (evaluatedCandidates.has(dedupKey)) continue;
        evaluatedCandidates.add(dedupKey);
        saveDedup(evaluatedCandidates);

        if (openTickers.has(candidate.ticker)) {
          log({ level: 'info', event: 'candidate_skipped_existing_position', data: { ticker: candidate.ticker } });
          continue;
        }


        const result: typeof candidateResults[0] = {
          ticker: candidate.ticker,
          direction: candidate.direction,
          synthesisResult: 'no-trade',
        };

        try {
          // Synthesis
          const synthesis = await generateThesis(candidate, ctx);
          if (!synthesis.shouldTrade || !synthesis.thesis) {
            result.noTradeReason = synthesis.noTradeReason ?? 'Synthesis rejected';
            addRejection({
              ticker: candidate.ticker, direction: candidate.direction,
              evaluatorScore: 0, evaluatorReasoning: result.noTradeReason,
              stage: 'synthesis', rejectedAt: new Date().toISOString(),
            });
            candidateResults.push(result);
            continue;
          }
          result.synthesisResult = 'trade';

          // Jury + Evaluator debate (multi-round, same conversation context)
          const { juryResult, verdict } = await runJuryWithDebate(candidate, ctx);
          result.juryAgreement = juryResult.agreement;
          result.juryConviction = juryResult.avgConviction;
          result.evaluatorDecision = verdict.decision;
          result.evaluatorScore = verdict.weightedScore;

          await notify('evaluator_verdict',
            `${verdict.decision}: ${candidate.ticker} ${juryResult.consensusDirection}`,
            `Score: ${verdict.weightedScore}/10\n${verdict.reasoning}`,
          );

          if (verdict.decision !== 'APPROVE') {
            log({ level: 'info', event: 'trade_rejected', data: { ticker: candidate.ticker, decision: verdict.decision } });
            writeProgress(`REJECTED: ${candidate.ticker} ${juryResult.consensusDirection} (${verdict.decision}, score ${verdict.weightedScore})`);
            addRejection({
              ticker: candidate.ticker, direction: candidate.direction,
              evaluatorScore: verdict.weightedScore,
              evaluatorReasoning: verdict.reasoning.slice(0, 500),
              stage: 'evaluator', rejectedAt: new Date().toISOString(),
            });
            candidateResults.push(result);
            continue;
          }

          // Size multiplier from jury agreement
          let sizeMultiplier = 1.0;
          if (juryResult.agreement === 'unanimous' && juryResult.avgConviction >= 7) {
            sizeMultiplier = 1.0;
          } else if (juryResult.agreement === 'unanimous') {
            sizeMultiplier = 0.6;
          } else if (juryResult.agreement === 'majority') {
            sizeMultiplier = 0.5;
          }

          const adjustedThesis = {
            ...synthesis.thesis,
            positionSizeRecommendation: synthesis.thesis.positionSizeRecommendation * sizeMultiplier,
          };
          if (verdict.revisedSize !== undefined) {
            adjustedThesis.positionSizeRecommendation = verdict.revisedSize;
          }

          await addThesis(adjustedThesis);

          await notify('thesis_generated',
            `${adjustedThesis.ticker} ${adjustedThesis.direction} (conviction: ${adjustedThesis.conviction}/10)`,
            `${adjustedThesis.thesis}\nSize: ${(adjustedThesis.positionSizeRecommendation * 100).toFixed(0)}% of $${effectiveEquity.toFixed(0)} | Leverage: ${adjustedThesis.leverageRecommendation}x | Agreement: ${juryResult.agreement}`,
          );

          // Route execution to the correct exchange based on ticker prefix
          let position;
          try {
            const exchange = getExchangeForTicker(adjustedThesis.ticker);
            position = await exchange.executeOpen(adjustedThesis, effectiveEquity);
          } catch {
            // Fallback to Hyperliquid executor for backward compat
            position = await executeOpen(adjustedThesis, effectiveEquity);
          }

          if (position) {
            result.executed = true;
            result.positionId = position.id;
            await notify('position_opened',
              `OPENED: ${position.ticker} ${position.direction}`,
              `Size: $${position.sizeUSD.toFixed(2)} | Leverage: ${position.leverage}x | Entry: ${position.entryPrice}`,
            );
            writeProgress(`OPENED: ${position.ticker} ${position.direction} $${position.sizeUSD.toFixed(2)} @ ${position.entryPrice}`);
          }

          candidateResults.push(result);
        } catch (candidateError) {
          log({ level: 'error', event: 'candidate_processing_error', data: { ticker: candidate.ticker, error: String(candidateError) } });
          result.noTradeReason = `Error: ${String(candidateError).slice(0, 200)}`;
          candidateResults.push(result);
        }
      }

      // Write structured cycle summary
      appendCycleSummary({
        cycleId: discoveryResult.scanMetadata.cycleId,
        timestamp: new Date().toISOString(),
        candidatesFound: discoveryResult.candidates.length,
        candidates: candidateResults,
        equity: effectiveEquity,
        openPositions: getOpenPositions().length,
      });
    } catch (error) {
      log({ level: 'error', event: 'discovery_loop_error', data: { error: String(error) } });
    }

    await sleep(DISCOVERY_INTERVAL);
  }
}

// ============================================================
// LOOP 2: Position Monitoring → Sync → Validate → Exit
// ============================================================

async function monitoringLoop(): Promise<void> {
  while (true) {
    await sleep(MONITORING_INTERVAL);
    if (isPaused()) continue;

    const localPositions = getOpenPositions();
    if (localPositions.length === 0) continue;

    try {
      // Sync with exchanges — route each position to correct exchange
      const hlPositions = await getHLPositions();
      for (const localPos of localPositions) {
        // Public.com positions: sync via adapter
        if (localPos.ticker.startsWith('pub:')) {
          try {
            const exchange = getExchangeForTicker(localPos.ticker);
            const exPositions = await exchange.getPositions();
            const symbol = localPos.ticker.replace('pub:', '');
            const exPos = exPositions.find(p => p.symbol === symbol);
            if (exPos) {
              await updatePosition(localPos.id, { unrealizedPnl: exPos.unrealizedPnl, currentPrice: exPos.currentPrice });
            }
          } catch (e) {
            log({ level: 'warn', event: 'public_sync_failed', data: { ticker: localPos.ticker, error: String(e) } });
          }
          continue;
        }

        // Hyperliquid positions: existing logic
        const hlPos = hlPositions.find(p =>
          p.coin === localPos.ticker || p.coin === localPos.ticker.replace('xyz:', '')
        );

        if (!hlPos) {
          log({ level: 'warn', event: 'position_closed_externally', data: { positionId: localPos.id, ticker: localPos.ticker } });
          await updatePosition(localPos.id, { status: 'closed', closedAt: new Date().toISOString(), closeReason: 'closed_externally_or_liquidated' });
          await updateThesis(localPos.thesisId, { status: 'closed' });
          await notify('position_closed', `EXTERNAL CLOSE: ${localPos.ticker}`, 'Position no longer exists on exchange');
          continue;
        }

        await updatePosition(localPos.id, { unrealizedPnl: hlPos.unrealizedPnl });
      }

      const openPositions = getOpenPositions();
      if (openPositions.length === 0) continue;

      const ctx = await assembleDiscoveryContext();
      const activeTheses = getActiveTheses();

      // Check for crowding alerts from flow agent
      const crowdingAlert = readSignalCache('crowding-alert') as any;
      if (crowdingAlert?.positions?.length > 0) {
        log({ level: 'warn', event: 'crowding_alert_detected', data: { tickers: crowdingAlert.positions.map((p: any) => p.ticker) } });
        writeProgress(`CROWDING ALERT: ${crowdingAlert.positions.map((p: any) => `${p.ticker} (${p.signal})`).join(', ')}`);
      }

      for (const position of openPositions) {
        if (isPaused()) break;

        const thesis = activeTheses.find(t => t.id === position.thesisId);
        if (!thesis) continue;

        const asset = ctx.assets.find(a => a.symbol === thesis.ticker);
        if (asset) await updatePosition(position.id, { currentPrice: asset.markPx });

        // If flow agent flagged this position's ticker as crowded, force validation
        const isCrowded = crowdingAlert?.positions?.some((p: any) =>
          p.ticker === thesis.ticker || p.ticker === thesis.ticker.replace('xyz:', '')
        );
        if (isCrowded) {
          log({ level: 'warn', event: 'crowding_forced_validation', data: { ticker: thesis.ticker } });
        }

        // Time expiry check
        if (thesis.timeHorizon) {
          const hoursOpen = (Date.now() - new Date(thesis.createdAt).getTime()) / 3600000;
          const horizonMatch = thesis.timeHorizon.match(/(\d+)\s*(hour|day|week)/i);
          if (horizonMatch) {
            const amount = parseInt(horizonMatch[1]);
            const unit = horizonMatch[2].toLowerCase();
            const maxHours = unit === 'hour' ? amount : unit === 'day' ? amount * 24 : amount * 168;
            if (hoursOpen > maxHours) {
              try { const ex = getExchangeForTicker(position.ticker); await ex.executeClose(position, `Time horizon expired (${thesis.timeHorizon})`); }
              catch { await executeClose(position, `Time horizon expired (${thesis.timeHorizon})`); }
              await updateThesis(thesis.id, { status: 'expired' });
              await notify('position_closed', `EXPIRED: ${position.ticker}`, `Time horizon: ${thesis.timeHorizon}`);
              writeProgress(`EXPIRED: ${position.ticker} after ${hoursOpen.toFixed(1)}h`);
              continue;
            }
          }
        }

        try {
          const validation = await validateThesis(thesis, position, ctx);

          // Spawn investigation subagent on anomaly
          if (validation.anomalyDetected && validation.anomalyDetails) {
            spawnInvestigationSubagent({
              type: 'thesis_anomaly',
              details: validation.anomalyDetails,
              parentAgent: 'thesis-validator',
            }); // Fire-and-forget — results feed into next cycle via signal cache
          }

          if (validation.thesisScore >= 6 && validation.action === 'HOLD') continue;

          // Escalate to frontier model
          const exitDecision = await evaluateExit(thesis, position, validation, ctx);

          if (exitDecision.action === 'EXIT') {
            try { const ex = getExchangeForTicker(position.ticker); await ex.executeClose(position, exitDecision.reasoning); }
            catch { await executeClose(position, exitDecision.reasoning); }
            await updateThesis(thesis.id, { status: 'invalidated' });
            await notify('position_closed',
              `EXIT: ${position.ticker} ${position.direction}`,
              `Edge remaining: ${exitDecision.edgeRemaining}/10\n${exitDecision.reasoning}`,
            );
            writeProgress(`EXIT: ${position.ticker} — ${exitDecision.reasoning.slice(0, 100)}`);
          } else if (exitDecision.action === 'REDUCE' && exitDecision.reduceTo !== undefined) {
            try { const ex = getExchangeForTicker(position.ticker); await ex.executeReduce(position, exitDecision.reduceTo, exitDecision.reasoning); }
            catch { await executeReduce(position, exitDecision.reduceTo, exitDecision.reasoning); }
            await notify('position_closed',
              `REDUCED: ${position.ticker} to ${(exitDecision.reduceTo * 100).toFixed(0)}%`,
              exitDecision.reasoning,
            );
            writeProgress(`REDUCED: ${position.ticker} to ${(exitDecision.reduceTo * 100).toFixed(0)}%`);
          }
        } catch (validationError) {
          log({ level: 'error', event: 'validation_error', data: { positionId: position.id, error: String(validationError) } });
        }
      }
    } catch (error) {
      log({ level: 'error', event: 'monitoring_loop_error', data: { error: String(error) } });
    }
  }
}

// ============================================================
// LOOP 3: Circuit Breaker
// ============================================================

async function circuitBreakerLoop(): Promise<void> {
  while (true) {
    await sleep(CIRCUIT_CHECK_INTERVAL);
    try {
      const state = await checkCircuitBreaker();
      if (state.triggered) {
        writeProgress(`CIRCUIT BREAKER: equity $${state.equity.toFixed(2)} < $50. System paused.`);
      }
    } catch (error) {
      log({ level: 'error', event: 'circuit_breaker_error', data: { error: String(error) } });
    }
  }
}

// ============================================================
// LOOP 4: Execution Watcher
// ============================================================

async function executionWatcherLoop(): Promise<void> {
  while (true) {
    await sleep(30000); // Check every 30s
    if (isPaused()) continue;

    try {
      const openPositions = getOpenPositions();
      if (openPositions.length === 0) continue;

      // Refresh P&L for all open positions (exchange-aware)
      const hlPositions = await getHLPositions();
      for (const pos of openPositions) {
        // Public.com positions: refresh via adapter
        if (pos.ticker.startsWith('pub:')) {
          try {
            const exchange = getExchangeForTicker(pos.ticker);
            const price = await exchange.getCurrentPrice(pos.ticker.replace('pub:', ''));
            const entryPrice = parseFloat(pos.entryPrice);
            const pnlPct = pos.direction === 'long'
              ? (price - entryPrice) / entryPrice
              : (entryPrice - price) / entryPrice;
            await updatePosition(pos.id, {
              unrealizedPnl: (pos.sizeUSD * pnlPct).toFixed(2),
              currentPrice: price.toString(),
            });
          } catch { /* price fetch failed — skip */ }
          continue;
        }

        // Hyperliquid positions
        const hlPos = hlPositions.find(p =>
          p.coin === pos.ticker || p.coin === pos.ticker.replace('xyz:', '')
        );
        if (hlPos) {
          await updatePosition(pos.id, {
            unrealizedPnl: hlPos.unrealizedPnl,
            currentPrice: hlPos.entryPx,
          });
        }
      }
    } catch (error) {
      log({ level: 'error', event: 'execution_watcher_error', data: { error: String(error) } });
    }
  }
}

// ============================================================
// SCHEDULED: Meta-Analysis (weekly)
// ============================================================

async function metaAnalysisLoop(): Promise<void> {
  while (true) {
    await sleep(META_ANALYSIS_INTERVAL);
    try {
      log({ level: 'info', event: 'meta_analysis_start' });
      const report = await generateMetaReport();
      await notify('evaluator_verdict',
        'Weekly Meta-Analysis',
        `Trades: ${report.totalTrades} | Win rate: ${(report.winRate * 100).toFixed(0)}% | PnL: $${report.totalPnl.toFixed(2)}\n${report.summary}`,
      );
      writeProgress(`META REPORT: ${report.totalTrades} trades, ${(report.winRate * 100).toFixed(0)}% win rate, $${report.totalPnl.toFixed(2)} PnL`);
    } catch (error) {
      log({ level: 'error', event: 'meta_analysis_error', data: { error: String(error) } });
    }
  }
}

// ============================================================
// MAIN
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  ensureStateDir();

  // Initialize exchange adapters before anything else
  initializeExchanges();
  const exchanges = getExchangeNames();

  const mode = config.PAPER_TRADING ? 'PAPER TRADING' : 'LIVE TRADING';

  log({ level: 'info', event: 'startup', data: { mode, exchanges, discoveryInterval: DISCOVERY_INTERVAL, model: `${config.MODEL_PROVIDER}/${config.MODEL_ID}` } });
  writeProgress(`System started — ${mode} — Exchanges: ${exchanges.join(', ')}`);

  console.log(`
  Trading Agent Harness
  ---------------------
  Mode:       ${mode}
  Equity:     $${config.PAPER_TRADING ? config.PAPER_STARTING_EQUITY : '(live)'}
  Exchanges:  ${exchanges.join(', ')}
  Layer 1:    every ${(LAYER1_INTERVAL / 60000).toFixed(0)} min (5 info agents → signal cache)
  Discovery:  every ${(DISCOVERY_INTERVAL / 60000).toFixed(0)} min (reads cached signals)
  Monitoring: every ${(MONITORING_INTERVAL / 60000).toFixed(0)} min (thesis validation)
  Exec Watch: every 30s (P&L refresh)
  Circuit:    every ${(CIRCUIT_CHECK_INTERVAL / 1000).toFixed(0)}s ($50 kill switch)
  Model:      ${config.MODEL_PROVIDER}/${config.MODEL_ID}
  `);

  // Run all loops concurrently
  await Promise.all([
    layer1Loop(),
    fundamentalsLoop(),
    discoveryLoop(),
    monitoringLoop(),
    executionWatcherLoop(),
    circuitBreakerLoop(),
    metaAnalysisLoop(),
  ]);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
