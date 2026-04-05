// HTTP client for Public.com API
// Adapted from github.com/Gajesh2007/public-com-mcp

import { AuthManager } from './auth.js';
import type {
  AccountsResponse,
  GreeksResponse,
  HistoryResponsePage,
  Instrument,
  InstrumentsRequest,
  InstrumentsResponse,
  InstrumentType,
  MultilegOrderRequest,
  MultilegOrderResult,
  OptionChainResponse,
  OptionExpirationsResponse,
  Order,
  OrderInstrument,
  OrderRequest,
  OrderResponse,
  Portfolio,
  PreflightMultiLegRequest,
  PreflightMultiLegResponse,
  PreflightRequest,
  PreflightResponse,
  Quote,
} from './types.js';

const BASE_URL = 'https://api.public.com';

export class PublicApiError extends Error {
  constructor(
    public statusCode: number,
    public responseData: unknown,
  ) {
    const message =
      typeof responseData === 'object' && responseData !== null && 'message' in responseData
        ? String((responseData as { message: string }).message)
        : `API Error ${statusCode}`;
    super(message);
    this.name = 'PublicApiError';
  }
}

interface RequestOptions {
  params?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export class PublicApiClient {
  private authManager: AuthManager;
  private defaultAccountId: string | null;

  constructor(apiSecretKey: string, defaultAccountId?: string) {
    this.authManager = new AuthManager(apiSecretKey);
    this.defaultAccountId = defaultAccountId ?? null;
  }

  private getAccountId(accountId?: string): string {
    const id = accountId ?? this.defaultAccountId;
    if (!id) {
      throw new Error('No account ID provided. Set PUBLIC_ACCOUNT_ID or pass accountId parameter.');
    }
    return id;
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, options?: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await this.authManager.getAccessToken();
    headers['Authorization'] = `Bearer ${token}`;

    const url = new URL(path, BASE_URL);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            value.forEach(v => url.searchParams.append(key, v));
          } else {
            url.searchParams.set(key, value);
          }
        }
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      let errorData: unknown;
      try { errorData = await response.json(); } catch { errorData = await response.text(); }
      throw new PublicApiError(response.status, errorData);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // --- Account ---
  async getAccounts(): Promise<AccountsResponse> {
    return this.request<AccountsResponse>('GET', '/userapigateway/trading/account');
  }

  async getPortfolio(accountId?: string): Promise<Portfolio> {
    const id = this.getAccountId(accountId);
    return this.request<Portfolio>('GET', `/userapigateway/trading/${id}/portfolio/v2`);
  }

  async getHistory(options?: { startTime?: string; endTime?: string; continuationToken?: string }, accountId?: string): Promise<HistoryResponsePage> {
    const id = this.getAccountId(accountId);
    return this.request<HistoryResponsePage>('GET', `/userapigateway/trading/${id}/history`, {
      params: { startTime: options?.startTime, endTime: options?.endTime, continuationToken: options?.continuationToken },
    });
  }

  // --- Market Data ---
  async getQuotes(instruments: OrderInstrument[], accountId?: string): Promise<Quote[]> {
    const id = this.getAccountId(accountId);
    const response = await this.request<{ quotes: Quote[] }>('POST', `/userapigateway/marketdata/${id}/quotes`, {
      body: { instruments },
    });
    return response.quotes;
  }

  async getAllInstruments(request?: InstrumentsRequest): Promise<InstrumentsResponse> {
    return this.request<InstrumentsResponse>('GET', '/userapigateway/trading/instruments', {
      params: request ? { typeFilter: request.typeFilter, tradingFilter: request.tradingFilter } : undefined,
    });
  }

  async getInstrument(symbol: string, instrumentType: InstrumentType): Promise<Instrument> {
    return this.request<Instrument>('GET', `/userapigateway/trading/instruments/${symbol}/${instrumentType}`);
  }

  // --- Options ---
  async getOptionExpirations(instrument: OrderInstrument, accountId?: string): Promise<OptionExpirationsResponse> {
    const id = this.getAccountId(accountId);
    return this.request<OptionExpirationsResponse>('POST', `/userapigateway/marketdata/${id}/option-expirations`, {
      body: { instrument },
    });
  }

  async getOptionChain(instrument: OrderInstrument, expirationDate: string, accountId?: string): Promise<OptionChainResponse> {
    const id = this.getAccountId(accountId);
    return this.request<OptionChainResponse>('POST', `/userapigateway/marketdata/${id}/option-chain`, {
      body: { instrument, expirationDate },
    });
  }

  async getOptionGreeks(osiSymbols: string[], accountId?: string): Promise<GreeksResponse> {
    const id = this.getAccountId(accountId);
    return this.request<GreeksResponse>('GET', `/userapigateway/option-details/${id}/greeks`, {
      params: { osiSymbols },
    });
  }

  // --- Preflight ---
  async preflightOrder(request: PreflightRequest, accountId?: string): Promise<PreflightResponse> {
    const id = this.getAccountId(accountId);
    return this.request<PreflightResponse>('POST', `/userapigateway/trading/${id}/preflight/single-leg`, { body: request });
  }

  async preflightMultiLeg(request: PreflightMultiLegRequest, accountId?: string): Promise<PreflightMultiLegResponse> {
    const id = this.getAccountId(accountId);
    return this.request<PreflightMultiLegResponse>('POST', `/userapigateway/trading/${id}/preflight/multi-leg`, { body: request });
  }

  // --- Orders ---
  async placeOrder(request: OrderRequest, accountId?: string): Promise<OrderResponse> {
    const id = this.getAccountId(accountId);
    return this.request<OrderResponse>('POST', `/userapigateway/trading/${id}/order`, { body: request });
  }

  async placeMultilegOrder(request: MultilegOrderRequest, accountId?: string): Promise<MultilegOrderResult> {
    const id = this.getAccountId(accountId);
    return this.request<MultilegOrderResult>('POST', `/userapigateway/trading/${id}/order/multileg`, { body: request });
  }

  async getOrder(orderId: string, accountId?: string): Promise<Order> {
    const id = this.getAccountId(accountId);
    return this.request<Order>('GET', `/userapigateway/trading/${id}/order/${orderId}`);
  }

  async cancelOrder(orderId: string, accountId?: string): Promise<void> {
    const id = this.getAccountId(accountId);
    await this.request<void>('DELETE', `/userapigateway/trading/${id}/order/${orderId}`);
  }
}
