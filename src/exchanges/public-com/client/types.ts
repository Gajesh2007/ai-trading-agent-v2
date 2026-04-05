// TypeScript types mirroring Public.com API models
// Adapted from github.com/Gajesh2007/public-com-mcp

export enum InstrumentType {
  ALT = 'ALT',
  BOND = 'BOND',
  CRYPTO = 'CRYPTO',
  EQUITY = 'EQUITY',
  INDEX = 'INDEX',
  MULTI_LEG_INSTRUMENT = 'MULTI_LEG_INSTRUMENT',
  OPTION = 'OPTION',
  TREASURY = 'TREASURY',
}

export interface OrderInstrument {
  symbol: string;
  type: InstrumentType;
}

export enum QuoteOutcome {
  SUCCESS = 'SUCCESS',
  UNKNOWN = 'UNKNOWN',
}

export interface Quote {
  instrument: OrderInstrument;
  outcome: QuoteOutcome;
  last?: string;
  lastTimestamp?: string;
  bid?: string;
  bidSize?: number;
  bidTimestamp?: string;
  ask?: string;
  askSize?: number;
  askTimestamp?: string;
  volume?: number;
  openInterest?: number;
}

export interface OptionExpirationsResponse {
  baseSymbol: string;
  expirations: string[];
}

export interface OptionChainResponse {
  baseSymbol: string;
  calls: Quote[];
  puts: Quote[];
}

export interface GreekValues {
  delta: string;
  gamma: string;
  theta: string;
  vega: string;
  rho: string;
  impliedVolatility: string;
}

export interface OptionGreeks {
  symbol: string;
  greeks: GreekValues;
}

export interface GreeksResponse {
  greeks: OptionGreeks[];
}

export interface Account {
  accountId: string;
  accountNumber: string;
  accountType: string;
  accountStatus: string;
}

export interface AccountsResponse {
  accounts: Account[];
}

export interface BuyingPower {
  cashOnlyBuyingPower: string;
  buyingPower: string;
  optionsBuyingPower: string;
}

export interface PortfolioEquity {
  type: string;
  value: string;
  percentageOfPortfolio?: string;
}

export interface PortfolioInstrument {
  symbol: string;
  name: string;
  type: InstrumentType;
}

export interface CostBasis {
  totalCost?: string;
  unitCost?: string;
  gainValue?: string;
  gainPercentage?: string;
}

export interface PortfolioPosition {
  instrument: PortfolioInstrument;
  quantity: string;
  currentValue?: string;
  percentOfPortfolio?: string;
  costBasis?: CostBasis;
}

export interface Portfolio {
  accountId: string;
  accountType: string;
  buyingPower: BuyingPower;
  equity: PortfolioEquity[];
  positions: PortfolioPosition[];
  orders: Order[];
}

export interface HistoryEvent {
  eventType: string;
  timestamp: string;
  description: string;
  amount?: string;
  instrument?: OrderInstrument;
}

export interface HistoryResponsePage {
  events: HistoryEvent[];
  continuationToken?: string;
}

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOP = 'STOP',
  STOP_LIMIT = 'STOP_LIMIT',
}

export enum TimeInForce {
  DAY = 'DAY',
  GTD = 'GTD',
}

export enum OpenCloseIndicator {
  OPEN = 'OPEN',
  CLOSE = 'CLOSE',
}

export enum EquityMarketSession {
  CORE = 'CORE',
  EXTENDED = 'EXTENDED',
}

export interface OrderExpirationRequest {
  timeInForce: TimeInForce;
  expirationTime?: string;
}

export interface PreflightRequest {
  instrument: OrderInstrument;
  orderSide: OrderSide;
  orderType: OrderType;
  expiration: OrderExpirationRequest;
  quantity?: string;
  amount?: string;
  limitPrice?: string;
  stopPrice?: string;
  openCloseIndicator?: OpenCloseIndicator;
  equityMarketSession?: EquityMarketSession;
}

export interface PreflightResponse {
  instrument: OrderInstrument;
  cusip?: string;
  rootSymbol?: string;
  estimatedCommission?: string;
  orderValue: string;
  estimatedQuantity?: string;
  estimatedCost?: string;
  buyingPowerRequirement?: string;
  estimatedProceeds?: string;
}

export enum LegInstrumentType {
  EQUITY = 'EQUITY',
  OPTION = 'OPTION',
}

export interface LegInstrument {
  symbol: string;
  type: LegInstrumentType;
}

export interface OrderLegRequest {
  instrument: LegInstrument;
  side: OrderSide;
  openCloseIndicator?: OpenCloseIndicator;
  ratioQuantity?: number;
}

export interface PreflightMultiLegRequest {
  orderType: OrderType;
  expiration: OrderExpirationRequest;
  quantity?: number;
  limitPrice: string;
  legs: OrderLegRequest[];
}

export interface PreflightMultiLegResponse {
  baseSymbol: string;
  strategyName?: string;
  legs: Array<{
    instrument: OrderInstrument;
    side: OrderSide;
    openCloseIndicator?: OpenCloseIndicator;
    ratioQuantity: number;
  }>;
  estimatedCommission?: string;
  orderValue: string;
  estimatedQuantity?: string;
  estimatedCost?: string;
  buyingPowerRequirement?: string;
  estimatedProceeds?: string;
}

export interface OrderRequest {
  orderId: string;
  instrument: OrderInstrument;
  orderSide: OrderSide;
  orderType: OrderType;
  expiration: OrderExpirationRequest;
  quantity?: string;
  amount?: string;
  limitPrice?: string;
  stopPrice?: string;
  openCloseIndicator?: OpenCloseIndicator;
  equityMarketSession?: EquityMarketSession;
}

export interface OrderResponse {
  orderId: string;
}

export interface MultilegOrderRequest {
  orderId: string;
  quantity: number;
  type: OrderType;
  limitPrice?: string;
  expiration: OrderExpirationRequest;
  legs: OrderLegRequest[];
}

export interface MultilegOrderResult {
  orderId: string;
}

export enum OrderStatus {
  NEW = 'NEW',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  CANCELLED = 'CANCELLED',
  QUEUED_CANCELLED = 'QUEUED_CANCELLED',
  FILLED = 'FILLED',
  REJECTED = 'REJECTED',
  PENDING_REPLACE = 'PENDING_REPLACE',
  PENDING_CANCEL = 'PENDING_CANCEL',
  EXPIRED = 'EXPIRED',
  REPLACED = 'REPLACED',
}

export interface OrderLeg {
  instrument: LegInstrument;
  side: OrderSide;
  openCloseIndicator?: OpenCloseIndicator;
  ratioQuantity?: number;
}

export interface Order {
  orderId: string;
  instrument: OrderInstrument;
  createdAt?: string;
  type: OrderType;
  side: OrderSide;
  status: OrderStatus;
  quantity?: string;
  notionalValue?: string;
  expiration?: {
    timeInForce: TimeInForce;
    expirationTime?: string;
  };
  limitPrice?: string;
  stopPrice?: string;
  closedAt?: string;
  openCloseIndicator?: OpenCloseIndicator;
  filledQuantity?: string;
  averagePrice?: string;
  legs?: OrderLeg[];
  rejectReason?: string;
}

export interface Instrument {
  symbol: string;
  type: InstrumentType;
  name?: string;
  tradeable?: boolean;
  fractionalTradingEnabled?: boolean;
  optionsEnabled?: boolean;
}

export interface InstrumentsResponse {
  instruments: Instrument[];
}

export interface InstrumentsRequest {
  typeFilter?: InstrumentType;
  tradingFilter?: string;
}
