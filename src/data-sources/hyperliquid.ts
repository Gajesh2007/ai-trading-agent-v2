import { HttpTransport } from '@nktkas/hyperliquid';
import {
  metaAndAssetCtxs,
  perpCategories,
  perpDexs,
  predictedFundings,
  allMids,
} from '@nktkas/hyperliquid/api/info';
import type { HLAsset } from '../schemas/discovery.js';
import { log } from '../logger.js';
import { withRetry } from '../utils/retry.js';

const transport = new HttpTransport();

export interface HLDex {
  name: string;
  fullName: string;
  assets: string[];
}

// Equity perps live on separate DEXs (xyz, flx, km, vntl, cash, etc.)
// perpCategories tells us which are stocks/commodities/indices/fx/preipo

export async function fetchDexList(): Promise<HLDex[]> {
  const dexs = await perpDexs({ transport });
  return dexs
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .map(d => ({
      name: d.name,
      fullName: d.fullName,
      assets: d.assetToStreamingOiCap.map(([a]) => a),
    }));
}

export async function fetchCategories(): Promise<Map<string, string>> {
  return withRetry(async () => {
    const cats = await perpCategories({ transport });
    const map = new Map<string, string>();
    for (const [coin, category] of cats) {
      map.set(coin, category);
    }
    return map;
  }, { label: 'fetchCategories' });
}

export async function fetchPerpsForDex(dexName: string): Promise<HLAsset[]> {
  return withRetry(async () => {
    const [meta, ctxs] = await metaAndAssetCtxs({ transport }, { dex: dexName });
    return meta.universe.map((asset, i) => ({
      symbol: asset.name,
      markPx: ctxs[i]?.markPx ?? '0',
      fundingRate: ctxs[i]?.funding ?? '0',
      openInterest: ctxs[i]?.openInterest ?? '0',
      prevDayPx: ctxs[i]?.prevDayPx ?? '0',
      dayNtlVlm: ctxs[i]?.dayNtlVlm ?? '0',
      maxLeverage: asset.maxLeverage,
    }));
  }, { label: `fetchPerps-${dexName || 'main'}` });
}

const TARGET_DEX = 'xyz';

export async function fetchAllTradableAssets(): Promise<{
  assets: HLAsset[];
  categories: Map<string, string>;
}> {
  const [categories, assets] = await Promise.all([
    fetchCategories(),
    fetchPerpsForDex(TARGET_DEX),
  ]);

  return { assets, categories };
}

export async function fetchPredictedFundingRates() {
  return withRetry(() => predictedFundings({ transport }), { label: 'fetchFundingRates' });
}

export async function fetchAllMidPrices() {
  return allMids({ transport });
}
