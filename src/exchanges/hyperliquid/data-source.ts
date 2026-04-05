// Re-export from the existing data source — keeps backward compat
export {
  fetchAllTradableAssets,
  fetchPerpsForDex,
  fetchPredictedFundingRates,
  fetchAllMidPrices,
  fetchDexList,
  fetchCategories,
  type HLDex,
} from '../../data-sources/hyperliquid.js';
