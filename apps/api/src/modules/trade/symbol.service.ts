import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MapiClient } from './mapi.client';
import { SymbolPairInfo } from './mapi.types';

/** 定时自动刷新间隔：默认 30 分钟（可用 SYMBOL_CACHE_REFRESH_MS 覆盖） */
const REFRESH_MS = Number(process.env.SYMBOL_CACHE_REFRESH_MS || 30 * 60 * 1000);

export type SymbolLoadResult = {
  items: SymbolPairInfo[];
  /** 本次是否从中间件成功写入了新缓存 */
  refreshed: boolean;
  /** 中间件失败或返回空时的说明 */
  error?: string;
};

/**
 * 交易对规范缓存 (mapi/CryptoSymbolList)。
 * - 启动预热
 * - 定时自动刷新（默认 30 分钟）
 * - 手动 force 刷新
 * - 检索未命中时强制补拉一次再查（不做本地 fallback）
 */
@Injectable()
export class SymbolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SymbolService.name);
  private cache: SymbolPairInfo[] = [];
  private fetchedAt = 0;
  private inflight: Promise<SymbolLoadResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private mapi: MapiClient) {}

  async onModuleInit() {
    void this.load(true).then((r) => {
      if (!r.items.length) {
        this.logger.warn('启动预热交易对规范为空（中间件可能未就绪），将按定时/未命中再试');
      }
    });
    const ms = Math.max(60_000, REFRESH_MS);
    this.timer = setInterval(() => {
      void this.load(true).catch((e) =>
        this.logger.warn(`定时刷新交易对规范失败: ${e?.message || e}`),
      );
    }, ms);
    this.logger.log(`交易对规范自动刷新间隔 ${Math.round(ms / 60000)} 分钟`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private key(apiCode: string, coin: string, equalCoin: string): string {
    return `${String(apiCode).toLowerCase()}|${String(coin).toUpperCase()}|${String(
      equalCoin,
    ).toUpperCase()}`;
  }

  private lookup(apiCode: string, coin: string, equalCoin: string): SymbolPairInfo | undefined {
    const wantKey = this.key(apiCode, coin, equalCoin);
    let hit = this.cache.find(
      (s) => this.key(s.apiCode, s.coinName, s.equalCoinName) === wantKey,
    );
    if (hit) return hit;

    // 兼容合约 apiCode 变体 (bac vs ba)
    const wantPrefix = String(apiCode).toLowerCase().replace(/[cf]$/, '');
    hit = this.cache.find(
      (s) =>
        String(s.apiCode).toLowerCase().replace(/[cf]$/, '') === wantPrefix &&
        String(s.coinName).toUpperCase() === String(coin).toUpperCase() &&
        String(s.equalCoinName).toUpperCase() === String(equalCoin).toUpperCase(),
    );
    return hit;
  }

  /**
   * 拉取并缓存全部交易对规范。
   * force=true：手动/定时/未命中补拉，忽略间隔直接请求中间件。
   * force=false：仅当缓存为空时拉取。
   */
  async load(force = false): Promise<SymbolLoadResult> {
    if (!force && this.cache.length) {
      return { items: this.cache, refreshed: false };
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const { data } = await this.mapi.get<SymbolPairInfo[] | { data?: SymbolPairInfo[] }>(
          'mapi/CryptoSymbolList',
          { skipLog: true, feature: '交易对规范' },
        );
        const list: SymbolPairInfo[] = Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.data)
            ? (data as any).data
            : [];
        if (list.length) {
          this.cache = list;
          this.fetchedAt = Date.now();
          this.logger.log(`交易对规范已缓存: ${list.length} 条`);
          return { items: this.cache, refreshed: true };
        }
        this.logger.warn('CryptoSymbolList 返回为空');
        return {
          items: this.cache,
          refreshed: false,
          error: '中间件返回为空',
        };
      } catch (e: any) {
        const error = e?.message || '拉取交易对规范失败';
        this.logger.warn(`拉取交易对规范失败: ${error}`);
        return { items: this.cache, refreshed: false, error };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** 只读内存缓存，不触发刷新（列表展示用） */
  peek(apiCode: string, coin: string, equalCoin: string): SymbolPairInfo | undefined {
    if (!this.cache.length) return undefined;
    return this.lookup(apiCode, coin, equalCoin);
  }

  /**
   * 按 (apiCode, coin, equalCoin) 检索。
   * 先查内存；未命中则强制刷新一次再查。仍无则返回 undefined（调用方应报错，禁止 fallback）。
   */
  async find(
    apiCode: string,
    coin: string,
    equalCoin: string,
  ): Promise<SymbolPairInfo | undefined> {
    if (!this.cache.length) await this.load(true);
    let hit = this.lookup(apiCode, coin, equalCoin);
    if (hit) return hit;

    this.logger.log(
      `交易对未命中，强制刷新后重试: ${apiCode}/${coin}/${equalCoin}`,
    );
    await this.load(true);
    return this.lookup(apiCode, coin, equalCoin);
  }

  /** 供后台查看；force 手动刷新 */
  async list(force = false): Promise<SymbolLoadResult> {
    return this.load(force);
  }

  stats() {
    return {
      count: this.cache.length,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      refreshMs: Math.max(60_000, REFRESH_MS),
    };
  }
}
