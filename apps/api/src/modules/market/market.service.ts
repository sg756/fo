import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Exchange } from '@prisma/client';
import {
  DEFAULT_POLL_MS,
  formatErrorRaw,
  httpErrorFromResponse,
  isAccessBlockedError,
  resolveBackoffMs,
} from '../../common/poll-backoff';
import { toApiCode } from '../trade/exchange-codes';
import { parseFirstLevelMidFromDepthValue as parseMidFromLib } from '../trade/mapi-offload-lib';
import { MapiClient } from '../trade/mapi.client';

export type MarketTicker = {
  symbol: string; // BTCUSDT
  pair: string; // BTC/USDT
  price: string;
  priceNum: number;
  change: number; // 24h %
  high: string;
  low: string;
  volume: string;
  spark: number[]; // 最近价格采样, 供火花图
  updatedAt: number;
};

/** 持仓/估值按交易所取价 */
export type ExchangePriceQuery = {
  exchange: string;
  coinName: string;
  /** spot | future；缺省按 future（永续持仓） */
  market?: 'spot' | 'future';
};

/**
 * 按文档解析单条盘口 VALUE 数组的第一档中间价。
 * [ts, askPx×n, askQty×n, bidPx×n, bidQty×n]，n=(len-1)/4
 */
export function parseFirstLevelMidFromDepthValue(value: any): number | null {
  return parseMidFromLib(value);
}

/** 在 GetDepth 字典中按 币_计价或周期_apiCode 查找第一档中间价 */
export function lookupDepthMid(
  depthMap: Record<string, any> | null | undefined,
  opts: { coinName: string; apiCode: string; market?: 'spot' | 'future' },
): number | null {
  if (!depthMap || typeof depthMap !== 'object') return null;
  const coin = String(opts.coinName || '')
    .trim()
    .toUpperCase()
    .replace(/USDT$/i, '');
  const api = String(opts.apiCode || '').trim().toLowerCase();
  if (!coin || !api) return null;
  const equal = opts.market === 'spot' ? 'USDT' : 'PC';

  const prefer = `${coin}_${equal}_${api}`.toUpperCase();
  const fromPrefer = parseFirstLevelMidFromDepthValue(depthMap[prefer]);
  if (fromPrefer) return fromPrefer;

  const apiU = api.toUpperCase();
  const prefix = `${coin}_`;
  for (const k of Object.keys(depthMap)) {
    const u = k.toUpperCase();
    if (u === prefer) continue;
    if (u.startsWith(prefix) && u.endsWith(`_${apiU}`)) {
      const mid = parseFirstLevelMidFromDepthValue(depthMap[k]);
      if (mid) return mid;
    }
  }
  return null;
}

/**
 * 行情采集: Node 定时拉取公网行情 (默认 Binance 主流币), 缓存后供 App 查询。
 * 持仓标记价：无参 mapi/GetDepth 全量字典，按文档第一档中间价，1 分钟后台刷新。
 * App 主行情正常 90s；封禁/限流优先跟 Retry-After/reset 头。
 */
@Injectable()
export class MarketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private inBackoff = false;
  private readonly pollMs = Math.max(30_000, Number(process.env.MARKET_POLL_MS || DEFAULT_POLL_MS));
  /** App 行情页用（Binance 主流币） */
  private tickers = new Map<string, MarketTicker>();
  private sparks = new Map<string, number[]>();
  /** 交易所维度标记价: EXCHANGE:MARKET:COIN → { price, updatedAt } */
  private exchangeQuotes = new Map<string, { price: number; updatedAt: number }>();
  /**
   * GetDepth 全量字典缓存（文档无参数，一次返回全部）。
   * 避免按币重复打同一接口。
   */
  private depthBundle: {
    map: Record<string, any>;
    fetchedAt: number;
    bytes: number;
    keyCount: number;
  } | null = null;
  private depthInflight: Promise<Record<string, any> | null> | null = null;
  private depthTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  /** 最近一次失败的原始现场（限流头 / body 片段等） */
  private lastErrorRaw: string | null = null;
  /** 最近一次失败对象（用于准确判定 418/429/业务限流） */
  private lastFail: unknown = null;

  constructor(private moduleRef: ModuleRef) {}

  onModuleInit() {
    if ((process.env.MARKET_ENABLED || 'true').toLowerCase() === 'false') {
      this.logger.warn('MarketService 已禁用');
      return;
    }
    this.logger.log(
      `MarketService 已启动: 正常=${(this.pollMs / 1000).toFixed(0)}s, 封禁退避=优先响应头/按所默认(上限见 MARKET_BAN_BACKOFF_MAX_MS), 源=${this.sourceBase()}, 持仓补价=mapi/GetDepth(工作线程+1分钟缓存)`,
    );
    void this.loop();
    void this.refreshDepthCache();
    this.depthTimer = setInterval(
      () => void this.refreshDepthCache(),
      this.depthTtlMs(),
    );
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.depthTimer) {
      clearInterval(this.depthTimer);
      this.depthTimer = null;
    }
  }

  private scheduleNext(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop() {
    const ok = await this.refresh();
    if (ok) {
      if (this.inBackoff) {
        this.inBackoff = false;
        this.logger.log(`行情已恢复，改回 ${(this.pollMs / 1000).toFixed(0)}s 轮询`);
      }
      this.scheduleNext(this.pollMs);
      return;
    }
    const blocked = this.inBackoff || isAccessBlockedError(this.lastFail ?? this.lastError);
    if (blocked) {
      const entering = !this.inBackoff;
      this.inBackoff = true;
      const { ms, reason } = resolveBackoffMs(this.lastFail, { exchange: 'BINANCE' });
      this.logger.warn(
        `行情${entering ? '进入' : '继续'}封禁退避 ${(ms / 1000).toFixed(0)}s (${reason}) | ${this.lastError}`,
      );
      if (this.lastErrorRaw) {
        this.logger.warn(`行情封禁原始现场: ${this.lastErrorRaw}`);
      }
      this.scheduleNext(ms);
      return;
    }
    this.logger.warn(`行情刷新失败(不退避，${(this.pollMs / 1000).toFixed(0)}s 后再试): ${this.lastError}`);
    if (this.lastErrorRaw) {
      this.logger.warn(`行情失败原始现场: ${this.lastErrorRaw}`);
    }
    this.scheduleNext(this.pollMs);
  }

  private sourceBase() {
    return (process.env.MARKET_SOURCE_URL || 'https://api.binance.com').replace(/\/$/, '');
  }

  private symbols(): string[] {
    const raw =
      process.env.MARKET_SYMBOLS ||
      'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT';
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  /** @returns 是否拉行情成功 */
  async refresh(): Promise<boolean> {
    try {
      const list = await this.fetchBinance24h(this.symbols());
      for (const t of list) {
        const hist = this.sparks.get(t.symbol) || [];
        hist.push(t.priceNum);
        while (hist.length > 24) hist.shift();
        this.sparks.set(t.symbol, hist);
        t.spark = hist.length >= 2 ? [...hist] : this.fallbackSpark(t.change);
        this.tickers.set(t.symbol, t);
        // 同步写入币安现货维度，供无指定交易所时的兜底
        this.putQuote('BINANCE', 'spot', t.symbol.replace(/USDT$/, ''), t.priceNum, t.updatedAt);
      }
      this.lastError = null;
      this.lastErrorRaw = null;
      this.lastFail = null;
      return true;
    } catch (e: any) {
      this.lastFail = e;
      this.lastError = e?.message || String(e);
      this.lastErrorRaw = formatErrorRaw(e);
      this.logger.warn(`行情刷新失败: ${this.lastError}`);
      this.logger.warn(`行情刷新原始现场: ${this.lastErrorRaw}`);
      return false;
    }
  }

  private fallbackSpark(change: number): number[] {
    const base = 50;
    const dir = change >= 0 ? 1 : -1;
    const amp = Math.min(8, Math.max(2, Math.abs(change) * 0.8));
    return Array.from({ length: 16 }, (_, i) => {
      const t = i / 15;
      const trend = dir * amp * t;
      const wave = Math.sin(t * Math.PI * 2.2) * amp * 0.35;
      const noise = Math.sin(t * Math.PI * 5.1 + 0.7) * amp * 0.12;
      return base + trend + wave + noise;
    });
  }

  private toPair(symbol: string): string {
    if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}/USDT`;
    if (symbol.endsWith('USD')) return `${symbol.slice(0, -3)}/USD`;
    return symbol;
  }

  private formatPrice(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }

  private async fetchBinance24h(symbols: string[]): Promise<MarketTicker[]> {
    const url24 = `${this.sourceBase()}/api/v3/ticker/24hr`;
    const url = `${this.sourceBase()}/api/v3/ticker/price`;
    // 用 24hr 保留涨跌；失败则退 ticker/price（封禁/限流不回退，避免继续打）
    try {
      const res = await fetch(url24, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        throw await httpErrorFromResponse(res, '行情源', { bodyText, url: url24 });
      }
      const all = (await res.json()) as any[];
      if (!Array.isArray(all)) throw new Error('行情源返回格式异常');
      const want = new Set(symbols);
      const now = Date.now();
      const out: MarketTicker[] = [];
      for (const row of all) {
        const symbol = String(row.symbol || '').toUpperCase();
        if (!want.has(symbol)) continue;
        const priceNum = Number(row.lastPrice ?? row.price ?? 0);
        const change = Number(row.priceChangePercent ?? 0);
        out.push({
          symbol,
          pair: this.toPair(symbol),
          price: this.formatPrice(priceNum),
          priceNum,
          change,
          high: this.formatPrice(Number(row.highPrice ?? 0)),
          low: this.formatPrice(Number(row.lowPrice ?? 0)),
          volume: String(row.quoteVolume ?? row.volume ?? '0'),
          spark: [],
          updatedAt: now,
        });
      }
      return symbols.map((s) => out.find((t) => t.symbol === s)).filter((t): t is MarketTicker => !!t);
    } catch (e) {
      if (isAccessBlockedError(e)) throw e;
      this.logger.warn(`24hr 失败回退 price | ${(e as any)?.message || e} | raw=${formatErrorRaw(e)}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        const bodyText = await res.text();
        throw await httpErrorFromResponse(res, '行情源', { bodyText, url });
      }
      const all = (await res.json()) as any[];
      const want = new Set(symbols);
      const now = Date.now();
      return all
        .filter((r) => want.has(String(r.symbol || '').toUpperCase()))
        .map((row) => {
          const symbol = String(row.symbol || '').toUpperCase();
          const priceNum = Number(row.price ?? 0);
          return {
            symbol,
            pair: this.toPair(symbol),
            price: this.formatPrice(priceNum),
            priceNum,
            change: 0,
            high: '—',
            low: '—',
            volume: '0',
            spark: [],
            updatedAt: now,
          } as MarketTicker;
        });
    }
  }

  list(tab?: string, q?: string): { items: MarketTicker[]; updatedAt: number | null; error: string | null } {
    let items = [...this.tickers.values()];
    if (tab === 'gainers') items = items.filter((t) => t.change > 0).sort((a, b) => b.change - a.change);
    else if (tab === 'losers') items = items.filter((t) => t.change < 0).sort((a, b) => a.change - b.change);
    else if (tab === 'favorites') items = items.slice(0, 3);
    else items = items.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    if (q?.trim()) {
      const qq = q.trim().toLowerCase();
      items = items.filter(
        (t) => t.pair.toLowerCase().includes(qq) || t.symbol.toLowerCase().includes(qq),
      );
    }

    const updatedAt = items.reduce<number | null>(
      (m, t) => (m == null ? t.updatedAt : Math.max(m, t.updatedAt)),
      null,
    );
    return { items, updatedAt, error: this.lastError };
  }

  /** 资产计价: 返回 baseAsset -> USDT 价（Binance 现货缓存，兼容旧逻辑） */
  priceMap(): Record<string, number> {
    const map: Record<string, number> = { USDT: 1, USD: 1, USDC: 1 };
    for (const t of this.tickers.values()) {
      const base = t.pair.split('/')[0];
      if (base) map[base] = t.priceNum;
    }
    return map;
  }

  private quoteKey(exchange: string, market: 'spot' | 'future', coin: string) {
    return `${String(exchange || 'BINANCE').toUpperCase()}:${market}:${coin.toUpperCase()}`;
  }

  private putQuote(
    exchange: string,
    market: 'spot' | 'future',
    coin: string,
    price: number,
    updatedAt = Date.now(),
  ) {
    if (!(price > 0)) return;
    this.exchangeQuotes.set(this.quoteKey(exchange, market, coin), { price, updatedAt });
  }

  /**
   * 市价折张标记价：只读后台线程已刷好的内存盘口，不现场打 GetDepth。
   */
  resolveDepthMark(opts: {
    exchange: Exchange;
    coinName: string;
    accountType?: string;
  }): number | null {
    const market: 'spot' | 'future' =
      String(opts.accountType || '').toLowerCase() === 'spot' ? 'spot' : 'future';
    const coin = String(opts.coinName || '')
      .trim()
      .toUpperCase()
      .replace(/USDT$/i, '');
    if (!coin) return null;
    const cached = this.getPrice(coin, opts.exchange, { market });
    if (cached && cached > 0) return cached;
    const apiCode = toApiCode(opts.exchange, market === 'spot' ? 'spot' : 'future');
    const mid = lookupDepthMid(this.peekDepthMap(), { coinName: coin, apiCode, market });
    if (mid && mid > 0) {
      this.putQuote(opts.exchange, market, coin, mid);
      return mid;
    }
    return null;
  }

  /** 只读内存盘口（后台线程写入）。请求路径不要用这个去触发刷新。 */
  cachedDepthMap(): Record<string, any> | null {
    return this.depthBundle?.map ?? null;
  }

  /**
   * 取价。
   * - 传 exchange：只读该所缓存；没有则返回 null（不回退币安）
   * - 不传：用 Binance 主流币 / 现货缓存（App 行情）
   */
  getPrice(
    asset: string,
    exchange?: string,
    opts?: { market?: 'spot' | 'future' },
  ): number | null {
    const a = String(asset || '').trim().toUpperCase();
    if (!a) return null;
    if (a === 'USDT' || a === 'USD' || a === 'USDC') return 1;

    const market = opts?.market === 'spot' ? 'spot' : 'future';
    if (exchange) {
      const hit = this.exchangeQuotes.get(this.quoteKey(exchange, market, a));
      if (hit && hit.price > 0) return hit.price;
      // 同所另一市场兜底（仍属该所缓存，不跨所）
      const alt = this.exchangeQuotes.get(
        this.quoteKey(exchange, market === 'spot' ? 'future' : 'spot', a),
      );
      if (alt && alt.price > 0) return alt.price;
      return null;
    }

    const map = this.priceMap();
    return map[a] ?? null;
  }

  private normalizeQuery(q: string | ExchangePriceQuery): ExchangePriceQuery | null {
    if (typeof q === 'string') {
      const coin = q.trim().toUpperCase();
      if (!coin || coin === 'USDT' || coin === 'USD' || coin === 'USDC') return null;
      return { exchange: 'BINANCE', coinName: coin, market: 'spot' };
    }
    const coin = String(q.coinName || '').trim().toUpperCase();
    if (!coin || coin === 'USDT' || coin === 'USD' || coin === 'USDC') return null;
    const exchange = String(q.exchange || 'BINANCE').trim().toUpperCase() || 'BINANCE';
    const market = q.market === 'spot' ? 'spot' : 'future';
    return { exchange, coinName: coin, market };
  }

  /**
   * 按「交易所 + 币」补齐标记价。只读 1 分钟盘口缓存，不在请求路径上等 GetDepth。
   */
  async ensurePrices(
    queries: Array<string | ExchangePriceQuery>,
    opts?: { maxAgeMs?: number },
  ): Promise<void> {
    const maxAgeMs = Math.max(1000, opts?.maxAgeMs ?? this.depthTtlMs());
    const now = Date.now();
    const need: ExchangePriceQuery[] = [];
    const seen = new Set<string>();
    for (const raw of queries) {
      const q = this.normalizeQuery(raw);
      if (!q) continue;
      const key = this.quoteKey(q.exchange, q.market || 'future', q.coinName);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = this.exchangeQuotes.get(key);
      if (!hit || !(hit.price > 0) || now - hit.updatedAt > maxAgeMs) {
        need.push(q);
      }
    }
    if (!need.length) return;

    const depthMap = this.peekDepthMap();
    if (!depthMap) return;

    for (const q of need) {
      const market = (q.market || 'future') as 'spot' | 'future';
      const exchange = String(q.exchange || '').toUpperCase() as Exchange;
      const coin = String(q.coinName || '')
        .trim()
        .toUpperCase()
        .replace(/USDT$/i, '');
      if (!coin) continue;
      const apiCode = toApiCode(exchange, market === 'spot' ? 'spot' : 'future');
      const mid = lookupDepthMid(depthMap, { coinName: coin, apiCode, market });
      if (mid && mid > 0) {
        this.putQuote(q.exchange, market, coin, mid);
      }
    }
  }

  private depthTtlMs() {
    return Math.max(10_000, Number(process.env.MARKET_POSITION_PRICE_TTL_MS || 60_000));
  }

  /** 只读内存；过期也不在这里拉 GetDepth，等定时线程 */
  private peekDepthMap(): Record<string, any> | null {
    return this.depthBundle?.map ?? null;
  }

  /** 后台拉全量 GetDepth：工作线程 fetch+parse，只把第一档中间价带回主线程（1 分钟一次） */
  private async refreshDepthCache(): Promise<Record<string, any> | null> {
    if (this.depthInflight) return this.depthInflight;

    this.depthInflight = (async () => {
      const mapi = this.getMapi();
      if (!mapi) {
        this.logger.warn('持仓补价跳过: MapiClient 不可用');
        return this.depthBundle?.map ?? null;
      }
      try {
        const { data } = await mapi.get('mapi/GetDepth', {
          skipLog: true,
          feature: '持仓盘口补价',
          offloadCompact: 'depth-mids',
        });
        const map =
          data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, any>)
            : null;
        if (!map) {
          this.logger.warn('GetDepth 回包非字典');
          return this.depthBundle?.map ?? null;
        }
        const keyCount = Object.keys(map).length;
        this.depthBundle = { map, fetchedAt: Date.now(), bytes: 0, keyCount };
        this.logger.log(
          `GetDepth 已缓存中间价: ${keyCount} 个币对, TTL=${(this.depthTtlMs() / 1000).toFixed(0)}s`,
        );
        return map;
      } catch (e: any) {
        this.logger.warn(`GetDepth 失败: ${e?.message || e}`);
        return this.depthBundle?.map ?? null;
      } finally {
        this.depthInflight = null;
      }
    })();

    return this.depthInflight;
  }

  private getMapi(): MapiClient | null {
    try {
      return this.moduleRef.get(MapiClient, { strict: false });
    } catch {
      return null;
    }
  }
}
