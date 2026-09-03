import {
  QueryOrderResult,
  CancelOrderResult,
  PlaceOrderResult,
} from '../../src/modules/trade/mapi.types';

export const ORDER = {
  OPEN_1: '900000000000000001',
  OPEN_2: '900000000000000002',
  PARTIAL: '900000000000000003',
  FULL: '900000000000000004',
  UNKNOWN: '900000000000000005',
  SYS_ERR: '900000000000000006',
} as const;

export const E2E = {
  OPEN_GID: 'E2E-OG-OPEN-001',
  CLOSE_GID: 'E2E-OG-CLOSE-001',
  OPEN_GID_PARTIAL: 'E2E-OG-OPEN-PART',
  CLOSE_GID_PARTIAL: 'E2E-OG-CLOSE-PART',
} as const;

export type QueryPreset =
  | 'OPEN'
  | 'PARTIAL'
  | 'PARTIAL_2'
  | 'FULL'
  | 'CANCELLED'
  | 'CANCELLED_PARTIAL'
  | 'UNKNOWN'
  | 'TIMEOUT';
export type CancelPreset = 'OK' | 'FAKE_UNKNOWN' | 'FAIL_OPEN' | 'FAIL_FILLED' | 'SYS';

export type MockSignal = {
  accountGID: string;
  /** 如 bac_BTC_PC_long */
  positionKey: string;
  orderGID: string;
  orderSide: 'open' | 'close' | 'buy' | 'sell';
  quantity: number;
  price: number;
  signalAt?: number;
};

const QUERY: Record<Exclude<QueryPreset, 'TIMEOUT'>, QueryOrderResult> = {
  OPEN: { status: '0', filledAmt: 0, priceAvg: 0, tradeFee: 0, errorMsg: '' },
  PARTIAL: { status: '1', filledAmt: 0.004, priceAvg: 50100, tradeFee: -0.1, errorMsg: '' },
  PARTIAL_2: { status: '1', filledAmt: 0.006, priceAvg: 50120, tradeFee: -0.15, errorMsg: '' },
  FULL: { status: '2', filledAmt: 0.01, priceAvg: 50200, tradeFee: -0.25, errorMsg: '' },
  CANCELLED: { status: '-1', filledAmt: 0, priceAvg: 0, tradeFee: 0, errorMsg: '' },
  CANCELLED_PARTIAL: {
    status: '-1',
    filledAmt: 0.004,
    priceAvg: 50100,
    tradeFee: -0.1,
    errorMsg: '',
  },
  UNKNOWN: { status: '', filledAmt: 0, priceAvg: 0, tradeFee: 0, errorMsg: 'Unknown order sent.' },
};

function extractOrderId(body: any): string {
  const fromOrder =
    body?.order?.apiBillID ||
    body?.order?.orderID ||
    body?.orderId ||
    body?.orderID ||
    '';
  return String(fromOrder).trim();
}

export class MapiMockRegistry {
  private queryByOrder = new Map<string, QueryPreset>();
  private queryOverride = new Map<string, QueryOrderResult>();
  private cancelByOrder = new Map<string, CancelPreset>();
  private defaultQuery: QueryPreset = 'OPEN';
  private defaultCancel: CancelPreset = 'OK';
  private placeOrderIdSeq = 0;
  private calls: { endpoint: string; orderId?: string; body: any }[] = [];
  private placeOrderCount = 0;
  private placedAmount = new Map<string, number>();
  private signals: MockSignal[] = [];
  private accounts: { value: string; name: string }[] = [];

  /**
   * 真竞态测试用：阻塞某个 orderId 的 QueryOrder 返回，制造 interleaving。
   * 仅用于测试，不影响正常业务逻辑。
   */
  private queryGateByOrder = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      released: boolean;
      waitCount: number;
      waiters: { minCalls: number; resolve: () => void }[];
    }
  >();

  reset() {
    this.queryByOrder.clear();
    this.queryOverride.clear();
    this.cancelByOrder.clear();
    this.defaultQuery = 'OPEN';
    this.defaultCancel = 'OK';
    this.placeOrderIdSeq = 0;
    this.calls = [];
    this.placeOrderCount = 0;
    this.placedAmount.clear();
    this.signals = [];
    this.accounts = [];
    this.queryGateByOrder.clear();
  }

  /**
   * 开启某 orderId 的 QueryOrder 闸门：直到 release 后，该 orderId 的 resolveQuery 都会 await。
   */
  setQueryGate(orderId: string) {
    const oid = String(orderId);
    if (this.queryGateByOrder.has(oid)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.queryGateByOrder.set(oid, {
      promise,
      resolve,
      released: false,
      waitCount: 0,
      waiters: [],
    });
  }

  /**
   * 等待某 orderId 至少被 QueryOrder 阻塞了 minCalls 次（通常用于两条并发链都走到 Query）。
   */
  async waitForQueryGateCalls(orderId: string, minCalls: number, timeoutMs = 2000) {
    const oid = String(orderId);
    const gate = this.queryGateByOrder.get(oid);
    if (!gate) throw new Error(`queryGate not set for orderId=${oid}`);
    if (gate.waitCount >= minCalls) return;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`waitForQueryGateCalls timeout orderId=${oid}`)), timeoutMs);
      gate.waiters.push({
        minCalls,
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
      });
    });
  }

  /**
   * 放行某 orderId 的 QueryOrder 闸门，让所有 await 的 resolveQuery 同时继续。
   */
  releaseQueryGate(orderId: string) {
    const oid = String(orderId);
    const gate = this.queryGateByOrder.get(oid);
    if (!gate) return;
    if (gate.released) return;
    gate.released = true;
    gate.resolve();
    this.queryGateByOrder.delete(oid);
  }

  setAccounts(list: { value: string; name: string }[]) {
    this.accounts = [...list];
  }

  clearSignals() {
    this.signals = [];
  }

  pushSignal(sig: MockSignal) {
    this.signals.push({
      ...sig,
      signalAt: sig.signalAt ?? Date.now(),
    });
  }

  setQuery(orderId: string, preset: QueryPreset) {
    this.queryByOrder.set(orderId, preset);
    this.queryOverride.delete(orderId);
  }

  setQueryOverride(orderId: string, data: QueryOrderResult) {
    this.queryOverride.set(orderId, data);
    this.queryByOrder.delete(orderId);
  }

  setCancel(orderId: string, preset: CancelPreset) {
    this.cancelByOrder.set(orderId, preset);
  }

  setDefaultQuery(preset: QueryPreset) {
    this.defaultQuery = preset;
  }

  setDefaultCancel(preset: CancelPreset) {
    this.defaultCancel = preset;
  }

  getCalls() {
    return [...this.calls];
  }

  getPlaceOrderCount() {
    return this.placeOrderCount;
  }

  getLastPlacedOrderId(): string | null {
    const places = this.calls.filter((c) => c.endpoint.includes('PlaceOrder'));
    const last = places[places.length - 1];
    if (!last) return null;
    const id = extractOrderId(last.body);
    return id || null;
  }

  private buildLastOrderRecords(): Record<string, Record<string, unknown>> {
    const root: Record<string, Record<string, unknown>> = {};
    for (const s of this.signals) {
      if (!root[s.accountGID]) root[s.accountGID] = {};
      const t = s.signalAt ?? Date.now();
      root[s.accountGID][s.positionKey] = {
        orderGID: s.orderGID,
        orderTime: new Date(t).toISOString(),
        timestamp: t,
        price: s.price,
        quantity: s.quantity,
        orderSide: s.orderSide,
      };
    }
    return root;
  }

  private async resolveQuery(orderId: string): Promise<QueryOrderResult> {
    const override = this.queryOverride.get(orderId);
    if (override) return { ...override };

    const gate = this.queryGateByOrder.get(orderId);
    if (gate && !gate.released) {
      gate.waitCount++;
      const ready = gate.waiters.filter((w) => gate.waitCount >= w.minCalls);
      gate.waiters = gate.waiters.filter((w) => gate.waitCount < w.minCalls);
      for (const w of ready) w.resolve();
      await gate.promise;
    }

    const preset = this.queryByOrder.get(orderId) || this.defaultQuery;
    if (preset === 'TIMEOUT') {
      throw new Error('ETIMEDOUT: mock query timeout');
    }
    const base = { ...QUERY[preset] };
    const placed = this.placedAmount.get(orderId);
    if (placed != null && placed > 0) {
      if (preset === 'FULL' || preset === 'PARTIAL' || preset === 'CANCELLED_PARTIAL') {
        base.filledAmt = placed;
      }
      if (preset === 'PARTIAL' && placed < 0.006) {
        base.filledAmt = placed * 0.4;
        base.status = '1';
      }
    }
    return base;
  }

  async get<T = any>(endpoint: string, _opts?: any): Promise<{ data: T }> {
    const ep = String(endpoint || '').toLowerCase();
    if (ep.includes('lastorderrecords')) {
      return { data: this.buildLastOrderRecords() as T };
    }
    if (ep.includes('multiaccountlist')) {
      return { data: this.accounts as T };
    }
    if (ep.includes('publichttpproxylist')) {
      return { data: [] as T };
    }
    return { data: [] as T };
  }

  async post<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    const ep = String(endpoint || '').replace(/^mapi\//, 'mapi/');
    const orderId = extractOrderId(body);
    this.calls.push({ endpoint: ep, orderId: orderId || undefined, body });

    if (ep.includes('PlaceOrder')) {
      this.placeOrderCount++;
      this.placeOrderIdSeq++;
      const id = `9100000000000000${String(this.placeOrderIdSeq).padStart(2, '0')}`;
      const coinAmt = Number(body?.order?.coinAmt ?? 0.01);
      this.placedAmount.set(id, coinAmt);
      const data: PlaceOrderResult = {
        successed: true,
        orderID: id,
        coinAmt,
        price: Number(body?.order?.price ?? 50000),
        size: coinAmt,
        instrumentID: 'BTC-USDT',
      } as PlaceOrderResult;
      return { data: data as T };
    }

    if (ep.includes('QueryOrder')) {
      return { data: (await this.resolveQuery(orderId)) as T };
    }

    if (ep.includes('CancelOrder')) {
      const preset = (orderId && this.cancelByOrder.get(orderId)) || this.defaultCancel;
      if (preset === 'SYS') {
        throw new Error('ECONNRESET: mock cancel system error');
      }
      const map: Record<Exclude<CancelPreset, 'SYS'>, CancelOrderResult> = {
        OK: { successed: true, errorMsg: 'Success' },
        FAKE_UNKNOWN: { successed: true, errorMsg: '错误：Unknown order sent.' },
        FAIL_OPEN: { successed: false, errorMsg: '订单仍挂单' },
        FAIL_FILLED: { successed: false, errorMsg: '订单已完全成交 already filled' },
      };
      return { data: map[preset] as T };
    }

    if (ep.includes('CryptoSymbolList')) {
      return {
        data: [
          {
            apiCode: 'bac',
            apiName: 'Binance',
            coinName: 'BTC',
            equalCoinName: 'PC',
            minAmt: 0.001,
            minSize: 0.001,
            pricePrecision: 2,
            priceStep: 0.01,
            settleCoin: 'USDT',
            boardLotSize: 0,
            symbol: 'BTC/PC',
          },
        ] as T,
      };
    }

    if (ep.includes('QueryBalance') || ep.includes('Test')) {
      return { data: { errorMsg: '', assets: [] } as T };
    }

    return { data: {} as T };
  }
}

export const mapiMock = new MapiMockRegistry();
