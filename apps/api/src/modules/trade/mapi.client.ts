import * as crypto from 'crypto';
import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PostLogService } from '../postlog/postlog.service';
import { runMapiOffload, shouldOffloadMapiPath, stopMapiOffload } from './mapi-offload';
import {
  compactDepthToMids,
  parseJsonPreservingLargeIds,
  stripEnvelopeKeepMeta,
} from './mapi-offload-lib';

export type MapiRequestOptions = {
  userId?: string;
  exchange?: Exchange;
  proxyIp?: string;
  /** 触发功能标签（写入 PostLog.feature） */
  feature?: string;
  /** 写入日志时脱敏后的 body */
  logBody?: any;
  /** true=不写中间件日志（高频轮询用） */
  skipLog?: boolean;
  /** true=仅失败时写日志 */
  logFailOnly?: boolean;
  /**
   * 在 worker_threads 里 fetch + JSON.parse。
   * 大包（GetDepth / CryptoSymbolList / MultiAccountList / PublicHttpProxyList）走 heavy 线程；
   * LastOrderRecords 走独立 signal 线程，避免被盘口堵住。
   * false 强制主线程。
   */
  offload?: boolean;
  /** GetDepth：工作线程内压成第一档中间价，主线程不再持有整本盘口 */
  offloadCompact?: 'depth-mids';
};

/** 中间件请求失败，附带 HTTP 状态与原始响应体 */
export class MapiRequestError extends Error {
  statusCode: number;
  responseBody: any;
  url?: string;

  constructor(message: string, opts: { statusCode?: number; responseBody?: any; url?: string } = {}) {
    super(message);
    this.name = 'MapiRequestError';
    this.statusCode = opts.statusCode ?? 0;
    this.responseBody = opts.responseBody ?? null;
    this.url = opts.url;
  }
}

const CFG_MIDDLEWARE_BASE = 'trade_middleware_base';
const CFG_MIDDLEWARE_SERVICE_KEY = 'trade_middleware_service_key';

@Injectable()
export class MapiClient implements OnModuleDestroy {
  private readonly logger = new Logger(MapiClient.name);
  private cachedBase: string | null = null;
  private cachedServiceKey: string | null = null;

  constructor(
    private postLog: PostLogService,
    private prisma: PrismaService,
  ) {}

  async onModuleDestroy() {
    await stopMapiOffload();
  }

  /** 环境变量默认值（无后台覆盖时使用） */
  envDefaultBase(): string {
    return (process.env.TRADE_MIDDLEWARE_BASE || 'http://127.0.0.1:1820').replace(/\/$/, '');
  }

  private envDefaultServiceKey(): string {
    return process.env.TRADE_SERVICE_KEY || '';
  }

  private maskKey(key: string): string {
    const k = String(key || '');
    if (!k) return '';
    if (k.length <= 8) return '****';
    return `${k.slice(0, 2)}****${k.slice(-4)}`;
  }

  /** 文档基础地址: http://域名或公网IP:1820 — 优先 SystemConfig，否则 env */
  async resolveBaseUrl(): Promise<string> {
    if (this.cachedBase) return this.cachedBase;
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_MIDDLEWARE_BASE },
    });
    const fromDb = row?.value?.trim();
    const base = (fromDb || this.envDefaultBase()).replace(/\/$/, '');
    this.cachedBase = base;
    return base;
  }

  /** 文档 ServiceKey — 优先 SystemConfig，否则 env */
  async resolveServiceKey(): Promise<string> {
    if (this.cachedServiceKey != null) return this.cachedServiceKey;
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_MIDDLEWARE_SERVICE_KEY },
    });
    const fromDb = row?.value?.trim();
    const key = fromDb || this.envDefaultServiceKey();
    this.cachedServiceKey = key;
    return key;
  }

  invalidateCache() {
    this.cachedBase = null;
    this.cachedServiceKey = null;
  }

  async getMiddlewareConfig() {
    const baseRow = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_MIDDLEWARE_BASE },
    });
    const keyRow = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_MIDDLEWARE_SERVICE_KEY },
    });
    const base = await this.resolveBaseUrl();
    const serviceKey = await this.resolveServiceKey();
    return {
      base,
      fromDb: !!baseRow?.value?.trim(),
      envDefault: this.envDefaultBase(),
      serviceKeyFromDb: !!keyRow?.value?.trim(),
      serviceKeyConfigured: !!serviceKey,
      serviceKeyMasked: this.maskKey(serviceKey),
    };
  }

  async setMiddlewareConfig(params: { base: string; serviceKey?: string }) {
    const normalized = String(params.base || '')
      .trim()
      .replace(/\/$/, '');
    if (!normalized) {
      throw new BadRequestException('中间件地址不能为空');
    }
    if (!/^https?:\/\//i.test(normalized)) {
      throw new BadRequestException('中间件地址需以 http:// 或 https:// 开头');
    }
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_MIDDLEWARE_BASE },
      create: {
        key: CFG_MIDDLEWARE_BASE,
        value: normalized,
        remark: '交易中间件基础地址 (文档 :1820)',
      },
      update: { value: normalized },
    });

    // serviceKey 有传才更新；空串 = 清除后台配置，回退 env
    if (params.serviceKey !== undefined) {
      const key = String(params.serviceKey).trim();
      if (!key) {
        await this.prisma.systemConfig.deleteMany({
          where: { key: CFG_MIDDLEWARE_SERVICE_KEY },
        });
      } else {
        await this.prisma.systemConfig.upsert({
          where: { key: CFG_MIDDLEWARE_SERVICE_KEY },
          create: {
            key: CFG_MIDDLEWARE_SERVICE_KEY,
            value: key,
            remark: '交易中间件 ServiceKey (签名鉴权)',
          },
          update: { value: key },
        });
      }
    }

    this.invalidateCache();
    return this.getMiddlewareConfig();
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    // 文档鉴权: MD5(Language:Nonce:Timestamp:VersionCode:ClientType:ServiceKey)
    const language = process.env.TRADE_LANGUAGE || 'zh-Hans';
    const nonce = crypto.randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const versionCode = process.env.TRADE_VERSION_CODE || '20260012';
    const clientType = process.env.TRADE_CLIENT_TYPE || 'win';
    const serviceKey = await this.resolveServiceKey();
    const raw = `${language}:${nonce}:${timestamp}:${versionCode}:${clientType}:${serviceKey}`;
    const signature = crypto.createHash('md5').update(raw).digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-Client-Language': language,
      'X-Client-Nonce': nonce,
      'X-Client-Timestamp': timestamp,
      'X-Client-VersionCode': versionCode,
      'X-Client-ClientType': clientType,
      'X-Client-Signature': signature,
    };
  }

  private offloadTimeoutMs(baseTimeoutMs: number): number {
    const extra = Number(process.env.MAPI_OFFLOAD_TIMEOUT_MS || 60_000);
    return Math.max(baseTimeoutMs, Number.isFinite(extra) ? extra : 60_000);
  }

  private async fetchParseOnMainThread(params: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: any;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ statusCode: number; responseBody: any; bytes: number }> {
    const res = await fetch(params.url, {
      method: params.method,
      headers: params.headers,
      body:
        params.method === 'POST' && params.body != null
          ? JSON.stringify(params.body)
          : undefined,
      signal: params.signal,
    });
    const text = await res.text();
    const parsed = text ? parseJsonPreservingLargeIds(text) : null;
    return {
      statusCode: res.status,
      responseBody:
        parsed == null || parsed === ''
          ? { message: `HTTP ${res.status} (empty body)`, url: params.url }
          : parsed,
      bytes: text ? Buffer.byteLength(text) : 0,
    };
  }

  /** 脱敏: 默认去掉 apiSecret / passphrase / apiKey 明文；排障可开 POST_LOG_PLAIN_SECRETS=true */
  private redact(body: any): any {
    if (body == null) return body;
    const keepPlain =
      (process.env.POST_LOG_PLAIN_SECRETS || '').toLowerCase() === 'true' ||
      process.env.POST_LOG_PLAIN_SECRETS === '1';
    if (keepPlain) {
      try {
        return JSON.parse(JSON.stringify(body));
      } catch {
        return { note: 'unserializable' };
      }
    }
    try {
      const clone = JSON.parse(JSON.stringify(body));
      if (clone?.account) {
        if (clone.account.apiSecret) clone.account.apiSecret = '***';
        if (clone.account.apiKey) {
          const k = String(clone.account.apiKey);
          clone.account.apiKey = k.length > 8 ? `${k.slice(0, 4)}****${k.slice(-4)}` : '****';
        }
        if (clone.account.passphrase) clone.account.passphrase = '***';
      }
      return clone;
    } catch {
      return { note: 'unserializable' };
    }
  }

  /**
   * 按接口文档精细判断 data 层业务失败（外层信封 success 仍可能为 true）。
   * - PlaceOrder: successed=false，失败原因在 orderID（部分实现另有 errorMsg）
   * - CancelOrder: successed=false，失败原因在 errorMsg
   * - QueryBalance / QueryAssets / QueryPosition: 非空 errorMsg
   * - QueryOrder: status 为空串表示出错；99=无状态不当事失败；errorMsg 为可选说明
   * - 其它接口: 不因 errorMsg 误判（避免列表类误伤）
   */
  private businessFailureMessage(endpoint: string, data: any): string | null {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
    const ep = String(endpoint || '')
      .replace(/^\//, '')
      .split('?')[0];

    if (ep === 'mapi/PlaceOrder') {
      // 外层信封可为 success=true；业务成败必须 successed===true。
      // coinAmt/price/size 有值不代表成功；失败时 orderID 存原因。
      if (data.successed !== true) {
        const msg = String(data.orderID || data.errorMsg || data.message || '').trim();
        if (msg && !/^(Success|OK)$/i.test(msg)) return msg;
        return '下单失败(中间件未返回 successed=true)';
      }
      return null;
    }

    if (ep === 'mapi/CancelOrder') {
      // 中间件常见坑：successed=true 仍带 errorMsg（如 Unknown order sent.）→ 必须当失败
      const err = String(data.errorMsg || '').trim();
      if (err && !/^(Success|OK|成功)$/i.test(err)) return err;
      if (data.successed === true) return null;
      const msg = String(data.message || data.orderID || '').trim();
      return msg || '撤单失败(中间件未返回 successed=true)';
    }

    if (ep === 'mapi/QueryBalance' || ep === 'mapi/QueryAssets' || ep === 'mapi/QueryPosition') {
      const err = String(data.errorMsg || '').trim();
      return err || null;
    }

    if (ep === 'mapi/QueryOrder') {
      const status = data.status == null ? '' : String(data.status).trim();
      // 文档: 空字符通常意味着有错误；99=无状态，不应做任何处理（不当失败）
      if (status === '') {
        const msg = String(data.errorMsg || data.message || '').trim();
        return msg || '查单失败';
      }
      return null;
    }

    return null;
  }

  private async fetchParseBody(params: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: any;
    timeoutMs: number;
    signal: AbortSignal;
    path: string;
    opts: MapiRequestOptions;
    useOffload: boolean;
  }): Promise<{ statusCode: number; responseBody: any; bytes: number }> {
    if (params.useOffload) {
      try {
        const off = await runMapiOffload({
          url: params.url,
          method: params.method,
          headers: params.headers,
          body:
            params.method === 'POST' && params.body != null
              ? JSON.stringify(params.body)
              : undefined,
          timeoutMs: params.timeoutMs,
          compact: params.opts.offloadCompact === 'depth-mids' ? 'depth-mids' : null,
        });
        if (!off.ok) {
          const err = new Error(off.error || 'mapi 工作线程请求失败');
          if (String(off.error || '').includes('超时')) err.name = 'AbortError';
          throw err;
        }
        const ep = String(params.path).split('?')[0];
        if (ep !== 'mapi/LastOrderRecords') {
          this.logger.log(
            `mapi 工作线程 ${ep} ${(off.bytes / 1024).toFixed(1)}KiB${
              params.opts.offloadCompact ? ' 已压中间价' : ''
            }`,
          );
        }
        return {
          statusCode: off.statusCode,
          responseBody: off.parsed,
          bytes: off.bytes,
        };
      } catch (e: any) {
        const msg = String(e?.message || '');
        const infra =
          msg.includes('找不到工作线程') ||
          msg.includes('工作线程退出') ||
          msg.includes('工作线程已停止') ||
          /Cannot find module/i.test(msg);
        if (!infra) throw e;
        this.logger.warn(
          `mapi 工作线程不可用，回退主线程 ${params.path}: ${msg}`,
        );
      }
    }
    return this.fetchParseOnMainThread({
      url: params.url,
      method: params.method,
      headers: params.headers,
      body: params.body,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  }

  async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    opts: MapiRequestOptions = {},
  ): Promise<{ data: T; statusCode: number; latencyMs: number }> {
    const base = await this.resolveBaseUrl();
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = await this.buildHeaders();
    const started = Date.now();
    let statusCode = 0;
    /** 始终尽量保留「源 body」写入 PostLog：原始回包，或联不通时的错误对象 */
    let responseBody: any = null;
    let success = false;

    // 下单/请求超时 (毫秒), 默认 15s；大包 offload 另用 MAPI_OFFLOAD_TIMEOUT_MS
    const baseTimeoutMs = Number(process.env.TRADE_REQUEST_TIMEOUT_MS || 15000);
    const useOffload = shouldOffloadMapiPath(path, opts);
    const timeoutMs = useOffload ? this.offloadTimeoutMs(baseTimeoutMs) : baseTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

    try {
      const fetched = await this.fetchParseBody({
        url,
        method,
        headers,
        body,
        timeoutMs,
        signal: controller.signal,
        path,
        opts,
        useOffload,
      });
      statusCode = fetched.statusCode;
      responseBody = fetched.responseBody;
      const httpOk = statusCode >= 200 && statusCode < 300;
      // 文档统一响应信封: { success, httpCode, message, data, errors }
      const envelope =
        responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody) && 'success' in responseBody;
      const bizOk = envelope ? responseBody.success === true : httpOk;
      if (!(httpOk && bizOk)) {
        // HTTP 失败或信封 success≠true：源 body 已在 responseBody，PostLog success=false
        const errs =
          responseBody && Array.isArray(responseBody.errors) && responseBody.errors.length
            ? responseBody.errors.join('; ')
            : '';
        const msg =
          (responseBody && (responseBody.message || responseBody.msg || responseBody.error)) ||
          errs ||
          `中间件错误 HTTP ${statusCode}`;
        throw new MapiRequestError(typeof msg === 'string' ? msg : JSON.stringify(msg), {
          statusCode,
          responseBody,
          url,
        });
      }
      if (opts.offloadCompact === 'depth-mids') {
        const rawPayload = envelope ? responseBody.data : responseBody;
        responseBody = stripEnvelopeKeepMeta(
          responseBody,
          compactDepthToMids(rawPayload),
        );
      }
      // 有信封则剥出 data, 否则返回原始体
      const payload = (envelope ? responseBody.data : responseBody) as T;
      const dataFail = this.businessFailureMessage(path, payload);
      if (dataFail) {
        // HTTP/信封已通，data 层业务失败：仍落完整源回包，PostLog success=false
        throw new MapiRequestError(dataFail, {
          statusCode,
          responseBody,
          url,
        });
      }
      success = true;
      return { data: payload, statusCode, latencyMs: Date.now() - started };
    } catch (e: any) {
      success = false;
      if (!statusCode) statusCode = 0;
      const msg =
        e?.name === 'AbortError'
          ? `请求超时 (${timeoutMs}ms)`
          : e?.message || String(e);
      if (!(e instanceof MapiRequestError)) {
        // 联不通 / 超时 / DNS 等：无 HTTP 回包，也要记一条可查的源记录
        responseBody = {
          error: msg,
          url,
          transport: true,
        };
        throw new MapiRequestError(msg, {
          statusCode,
          responseBody,
          url,
        });
      }
      // 保证 finally 落库用的是错误上的源 body（避免仍为 null）
      if (e.responseBody != null) {
        responseBody = e.responseBody;
      } else if (responseBody == null) {
        responseBody = { error: e.message || msg, url };
      }
      throw e;
    } finally {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      const writeLog =
        !opts.skipLog && (!opts.logFailOnly || !success);
      if (writeLog) {
        await this.postLog
          .record({
            userId: opts.userId,
            exchange: opts.exchange,
            direction: 'OUTBOUND',
            feature: opts.feature,
            endpoint: path,
            path,
            method,
            proxyIp: opts.proxyIp,
            requestBody: opts.logBody ?? this.redact(body),
            // 成功/失败都写源 body；仅用 success 区分
            responseBody: responseBody ?? { error: 'no response body', url },
            statusCode,
            latencyMs,
            success,
          })
          .catch((err) => this.logger.warn(`写 POST 日志失败: ${err?.message}`));
      }
    }
  }

  get<T = any>(path: string, opts?: MapiRequestOptions) {
    return this.request<T>('GET', path, undefined, opts);
  }

  post<T = any>(path: string, body: any, opts?: MapiRequestOptions) {
    return this.request<T>('POST', path, body, opts);
  }
}
