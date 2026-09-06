import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  Exchange,
  FollowAbnormalKind,
  FollowFillKind,
  Prisma,
  UserPositionStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeKeyService } from '../exchange-key/exchange-key.service';
import { IpPoolService } from '../ippool/ippool.service';
import { CommissionService } from '../admin/commission.service';
import { MapiClient } from './mapi.client';
import { SymbolService } from './symbol.service';
import {
  toApiCode,
  apiName,
  fromApiCode,
  isFuturesAccountType,
  accountTypeFromEqualCoin,
  accountTypesForExchange,
  adminBalanceAccountTypes,
} from './exchange-codes';
import {
  ApiAccountInfo,
  OrderRecordInfo,
  PlaceOrderResult,
  QueryOrderResult,
  QueryPositionResult,
  SymbolPairInfo,
  mapDocStatus,
} from './mapi.types';
import { calcRealizedPnl, contractMultiplier } from './pnl.util';
import {
  formatDisplayPrice,
  isAtLeastOneContract,
  oneContractCoinAmt,
  snapCoinAmt,
  snapPrice,
} from './symbol-spec.util';
import { MarketService } from '../market/market.service';
import { formatTradeError, extractPlaceOrderId } from '../../common/trade-error';
import { MapiRequestError } from './mapi.client';
import {
  FILL_COMPLETE_EPS,
  FILL_EPS,
  canAttemptRemainderCancel,
  fillDelta,
  fillWatermarkOf,
  hasLiveRemainder,
  isOrderFillComplete,
  isQueryFillUsable,
  orderAmtOf,
  sliceFillFee,
  sliceFillPrice,
  type FillSnapshot,
} from './order-fill.util';
import {
  estimateLiquidationPrice,
  numbersDiffer,
  parseQueryPositionPayload,
  queryPositionMatchKey,
} from './query-position.util';

export type PlaceOrderDto = {
  exchange: Exchange;
  /** 现货 spot / 永续 future 等 */
  accountType?: string;
  symbol: string;
  side: string; // buy/sell 或 open/close, 透传中间件
  orderType?: string; // limit/market
  price?: number | string;
  amount: number | string;
  positionSide?: string; // long/short
  leverage?: number | string;
  reduceOnly?: boolean;
  clientOrderId?: string;
  /** 透传额外字段 */
  extra?: Record<string, any>;
  tradePassword?: string;
  /** 内部跟单 Worker 调用时跳过交易密码校验 */
  skipTradePassword?: boolean;

  // ---- 文档信号透传字段 (跟单 Worker 使用, 便于精确构造 SymbolPairInfo/下单体) ----
  /** 信号原生 apiCode (如 bac) */
  apiCode?: string;
  /** 币名 (如 BTC) */
  coinName?: string;
  /** 计价币/合约周期 (如 USDT / PC) */
  equalCoinName?: string;
  /** 是否开仓 (open/buy=true, close/sell=false) */
  isOpen?: boolean;
  /** 指定中间件主账户 GID（管理端手动平仓等） */
  accountGid?: string;
  accountName?: string;
};

/** 跟单成交检测/查单/撤单所需的订单上下文 */
export type OrderContext = {
  exchange: Exchange;
  orderId: string;
  symbol?: string;
  accountType?: string;
  apiCode?: string;
  coinName?: string;
  equalCoinName?: string;
  clientOrderId?: string;
  positionSide?: string | null;
  isOpen?: boolean | null;
  /** cancel 时 order.status 必须为 3（文档：3=撤消订单） */
  orderPurpose?: 'query' | 'cancel';
  tradeAmt?: number;
  tradePrice?: number;
  leverage?: number;
};

@Injectable()
export class TradeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TradeService.name);
  private backfillRunning = false;
  private accountListCache: { items: any[]; fetchedAt: number } | null = null;
  private accountListInflight: Promise<{ items: any[] }> | null = null;
  private accountListTimer: ReturnType<typeof setInterval> | null = null;
  private proxyListCache: { items: { ip: string; name: string }[]; fetchedAt: number } | null =
    null;
  private proxyListInflight: Promise<{ items: { ip: string; name: string }[] }> | null = null;
  private proxyListTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private prisma: PrismaService,
    private keys: ExchangeKeyService,
    @Inject(forwardRef(() => IpPoolService)) private ipPool: IpPoolService,
    private mapi: MapiClient,
    private market: MarketService,
    private commission: CommissionService,
    private symbols: SymbolService,
  ) {}

  async onModuleInit() {
    void this.refreshAccountListCache();
    this.accountListTimer = setInterval(
      () => void this.refreshAccountListCache(),
      this.accountListTtlMs(),
    );
    void this.refreshProxyListCache();
    this.proxyListTimer = setInterval(
      () => void this.refreshProxyListCache(),
      this.proxyListTtlMs(),
    );
  }

  onModuleDestroy() {
    if (this.accountListTimer) {
      clearInterval(this.accountListTimer);
      this.accountListTimer = null;
    }
    if (this.proxyListTimer) {
      clearInterval(this.proxyListTimer);
      this.proxyListTimer = null;
    }
  }

  /** MultiAccountList 后台刷新间隔，默认 1 分钟 */
  private accountListTtlMs() {
    return Math.max(10_000, Number(process.env.ACCOUNT_LIST_TTL_MS || 60_000));
  }

  /** PublicHttpProxyList 后台刷新间隔，默认与账户列表相同 */
  private proxyListTtlMs() {
    return Math.max(
      10_000,
      Number(process.env.PROXY_LIST_TTL_MS || process.env.ACCOUNT_LIST_TTL_MS || 60_000),
    );
  }

  /** 用户端已取消交易密码；内部调用可继续传 skip */
  private async assertTradePassword(_userId: string, _tradePassword?: string, _skip?: boolean) {
    return;
  }

  /**
   * 构造文档要求的 ApiAccountInfo (下单/查单/撤单/查资产通用)。
   * 默认用「本用户 Key」身份；切勿默认套信号主账户 GID（会把别人账户标识和自己的 Key 混在一起，中间件常回「接口错误」）。
   * 仅当显式传入 accountOverride（管理端指定 MultiAccountList 账户）时才覆盖 gid/name。
   * accountName：用户账号名（nickname，否则邮箱 @ 前缀），不是 Key 标签。
   */
  private async buildAccount(
    userId: string,
    exchange: Exchange,
    accountType?: string,
    accountOverride?: { gid: string; name?: string },
  ): Promise<ApiAccountInfo> {
    const cred = await this.keys.getDecrypted(userId, exchange);
    if (!cred) throw new BadRequestException(`未配置 ${exchange} API Key`);
    const [rec, user] = await Promise.all([
      this.prisma.exchangeKey.findFirst({
        where: { userId, exchange, active: true },
        select: { id: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { nickname: true, email: true },
      }),
    ]);
    const gid = accountOverride?.gid?.trim() || rec?.id || userId;
    const userAccountName =
      user?.nickname?.trim() || user?.email?.split('@')[0]?.trim() || userId;
    const accountName = accountOverride?.name?.trim() || userAccountName;
    // 与 CryptoSymbolList / PlaceOrder 一致：现货 ba、合约 bac（现货码 + c）。
    // 查资产若固定基础码，中间件会落回现货全量列表，合约余额查不到。
    return {
      gid,
      apiCode: toApiCode(exchange, accountType),
      apiName: apiName(exchange),
      accountName,
      apiKey: cred.apiKey,
      apiSecret: cred.apiSecret,
      passphrase: cred.passphrase || '',
      extendedAttr: '',
      extendedAttr2: '',
      innerExtendedAttr: '',
      createTime: new Date().toISOString(),
    };
  }

  /**
   * 解析交易对字符串为 (coin, equalCoin)。
   * 支持 "BTC/USDT"、"BTC-USDT"、"BTC_USDT"、"BTCUSDT"(尾部常见计价币) 等形式。
   */
  private parseSymbolParts(symbol: string): { coin: string; equalCoin: string } {
    const s = String(symbol || '').toUpperCase().trim();
    const m = s.match(/^([A-Z0-9]+)[\/\-_]([A-Z0-9]+)$/);
    if (m) return { coin: m[1], equalCoin: m[2] };
    const quotes = ['USDT', 'USDC', 'FDUSD', 'USD', 'BTC', 'ETH', 'EUR'];
    for (const q of quotes) {
      if (s.endsWith(q) && s.length > q.length) {
        return { coin: s.slice(0, s.length - q.length), equalCoin: q };
      }
    }
    return { coin: s, equalCoin: 'USDT' };
  }

  /** 解析/检索 SymbolPairInfo: 必须命中 CryptoSymbolList 缓存，禁止本地 fallback */
  private async resolveSymbolSpec(
    exchange: Exchange,
    dto: {
      apiCode?: string;
      coinName?: string;
      equalCoinName?: string;
      symbol?: string;
      accountType?: string;
    },
  ): Promise<SymbolPairInfo> {
    let coin = dto.coinName;
    let equalCoin = dto.equalCoinName;
    if (!coin || !equalCoin) {
      const parsed = this.parseSymbolParts(dto.symbol || '');
      coin = coin || parsed.coin;
      equalCoin = equalCoin || parsed.equalCoin;
    }
    const apiCode = dto.apiCode || toApiCode(exchange, dto.accountType);
    const hit = await this.symbols.find(apiCode, coin!, equalCoin!);
    if (hit) return hit;
    throw new BadRequestException(
      `交易对规范未命中: ${apiCode}/${coin}/${equalCoin}，请确认 CryptoSymbolList 已刷新且币对存在`,
    );
  }

  private async resolveProxyIp(userId: string): Promise<{
    proxyIP: string;
    egressIp?: string;
    proxyId?: string;
  }> {
    const proxy = await this.ipPool.resolveProxyForUser(userId);
    if (!proxy) {
      // 无代理池时仍允许下单 (中间件可能本机直出); 传空串或跳过
      if ((process.env.TRADE_REQUIRE_PROXY || 'false').toLowerCase() === 'true') {
        throw new BadRequestException('无可用下单代理 IP，请联系管理员配置 IP 池');
      }
      return { proxyIP: '' };
    }
    // proxyIP 必须与中间件 PublicHttpProxyList.value 完全一致（通常是局域网 IP，如 10.0.0.14）。
    // 公网 egressIp 只给 App 白名单展示，绝不能当作 PlaceOrder/QueryBalance 的 proxyIP。
    // 中间件常见只登记纯 IP，此时勿拼接 :port。
    const host = String(proxy.host || '').trim();
    const port = Number(proxy.port);
    const proxyIP =
      Number.isFinite(port) && port > 0 ? `${host}:${port}` : host;
    return {
      proxyIP,
      egressIp: proxy.egressIp,
      proxyId: proxy.id,
    };
  }

  /**
   * 由信号语义推导 tradeType(0买/1卖) 与 isOpen。
   * 合约: 开多=买 开空=卖 平多=卖 平空=买; 现货: buy=买 sell=卖。
   */
  private deriveTradeType(dto: PlaceOrderDto, isFutures: boolean): { tradeType: number; isOpen: boolean } {
    const side = String(dto.side || '').toLowerCase();
    const dir = String(dto.positionSide || '').toLowerCase();
    // 优先使用显式 isOpen
    const isOpen =
      dto.isOpen != null ? dto.isOpen : side === 'open' || side === 'buy' || side === 'open-long';

    if (!isFutures) {
      // 现货
      const tradeType = side === 'sell' || side === '1' ? 1 : 0;
      return { tradeType, isOpen: tradeType === 0 };
    }
    // 合约
    const isShort = dir.includes('short') || dir === '2' || side.includes('short');
    if (isOpen) {
      // 开仓: 多=买(0) 空=卖(1)
      return { tradeType: isShort ? 1 : 0, isOpen: true };
    }
    // 平仓: 多=卖(1) 空=买(0)
    return { tradeType: isShort ? 0 : 1, isOpen: false };
  }

  /** 组装并调用 PlaceOrder (严格按 :1820 文档结构) */
  async placeOrder(userId: string, dto: PlaceOrderDto) {
    await this.assertTradePassword(userId, dto.tradePassword, dto.skipTradePassword);

    const accountType = dto.accountType || 'future';
    const isFutures = isFuturesAccountType(accountType);
    const { tradeType, isOpen } = this.deriveTradeType(dto, isFutures);
    // 开仓必须点卡 ≥ 后台配置门槛; 平仓不限制
    if (isOpen) {
      await this.checkOpenPointGate(userId, { assert: true });
    }

    const account = await this.buildAccount(
      userId,
      dto.exchange,
      accountType,
      dto.accountGid?.trim()
        ? { gid: dto.accountGid.trim(), name: dto.accountName?.trim() || dto.accountGid.trim() }
        : undefined,
    );
    const symbolSpec = await this.resolveSymbolSpec(dto.exchange, dto);
    // PlaceOrder：account.apiCode 须与 symbol.apiCode 一致（合约多为 bac）。
    const accountForOrder: ApiAccountInfo = {
      ...account,
      apiCode: symbolSpec.apiCode || account.apiCode,
      apiName: symbolSpec.apiName || account.apiName,
    };
    const { proxyIP, egressIp } = await this.resolveProxyIp(userId);

    // 文档: 0=限价 1=市价；未传时默认限价（跟单信号通常也不带类型）
    const orderType = /market|市价|^1$/i.test(String(dto.orderType || 'limit').trim())
      ? 1
      : 0;
    let coinAmt = snapCoinAmt(Number(dto.amount) || 0, symbolSpec);
    if (!(coinAmt > 0)) {
      throw new BadRequestException('委托数量不足（未达到 minAmt 整数倍）');
    }
    if (isFutures && !isAtLeastOneContract(coinAmt, symbolSpec)) {
      const face = oneContractCoinAmt(symbolSpec);
      throw new BadRequestException(`委托数量不足，至少需一张合约（每手 ${face}）`);
    }
    // 限价：信号/入参已有价，只按 PricePrecision 收口。
    // 市价（含对账/手动平）：自己取内存标记价，先精度再按有效 tick 对齐。
    let price = 0;
    const rawDtoPrice = dto.price != null ? Number(dto.price) : 0;
    let rawPrice = Number.isFinite(rawDtoPrice) && rawDtoPrice > 0 ? rawDtoPrice : 0;
    if (!(rawPrice > 0) && (orderType === 1 || !isOpen)) {
      rawPrice =
        Number(
          this.market.resolveDepthMark({
            exchange: dto.exchange,
            coinName: symbolSpec.coinName || dto.coinName || '',
            accountType,
          }),
        ) || 0;
    }
    if (orderType === 0) {
      price = Number(formatDisplayPrice(rawPrice, symbolSpec));
      if (!(price > 0)) {
        throw new BadRequestException('限价单须提供有效价格');
      }
    } else {
      price = snapPrice(rawPrice, symbolSpec);
      if (!(price > 0)) {
        throw new BadRequestException('市价单未能取得标记价，请稍后重试');
      }
    }
    // 文档 leverage 非必填；未传或无效时默认 1（不再传 0/5）
    const levNum = dto.leverage != null && dto.leverage !== '' ? Number(dto.leverage) : NaN;
    const leverage = Number.isFinite(levNum) && levNum > 0 ? levNum : 1;

    const body: any = {
      proxyIP,
      symbol: symbolSpec,
      account: accountForOrder,
      isOpen,
      accountType,
      leverage,
      coinAmt,
      price,
      tradeType,
      orderType,
      limitDepthOption: 0,
      baseQuoteLastPrice: price,
    };
    if (dto.extra) Object.assign(body, dto.extra);

    try {
      const { data } = await this.mapi.post<PlaceOrderResult>('mapi/PlaceOrder', body, {
        userId,
        exchange: dto.exchange,
        proxyIp: proxyIP,
      });
      // 文档: 必须 successed===true；coinAmt/size/price 有值不代表成功
      if (!data || data.successed !== true) {
        const reason =
          String(data?.orderID || (data as any)?.errorMsg || (data as any)?.message || '').trim() ||
          '下单失败（中间件未返回 successed=true）';
        const kind = isOpen ? '开仓' : '平仓';
        const ex = new BadRequestException(`${kind}失败: ${reason}`);
        (ex as any).responseBody = data;
        // 开仓不足一手仍静默。平仓失败挂在仓上：本轮首次写原因，之后覆盖最后数量+时间。
        if (isOpen && !this.isBelowMinContractError(reason)) {
          this.logger.warn(
            `PlaceOrder ${kind}失败 user=${userId} ${dto.exchange} ${dto.coinName || dto.symbol || ''} ` +
              `${dto.positionSide || ''} amt=${coinAmt}: ${reason}`,
          );
        }
        throw ex;
      }
      // 成功：orderID 为订单号；勿把中文错误文案当单号
      return { ok: true, proxyIP, egressIp, data };
    } catch (e: any) {
      if (e instanceof BadRequestException) {
        // 上面已按开/平打过业务失败日志
        throw e;
      }
      const detail = formatTradeError(e);
      if (isOpen && !this.isBelowMinContractError(detail)) {
        this.logger.warn(
          `PlaceOrder 失败 user=${userId} ${dto.exchange} ${dto.coinName || dto.symbol || ''} 开 amt=${coinAmt}: ${detail}`,
        );
      }
      if (e instanceof MapiRequestError) {
        // 保留中间件/传输层源 body，供跟单流水对照（勿只存 Nest 包装的 503）
        const ex = new ServiceUnavailableException(`下单失败: ${detail}`);
        (ex as any).responseBody = e.responseBody;
        (ex as any).statusCode = e.statusCode;
        (ex as any).url = e.url;
        throw ex;
      }
      const ex = new ServiceUnavailableException(detail || '下单中间件不可用');
      (ex as any).responseBody = e?.responseBody ?? { error: detail };
      throw ex;
    }
  }

  /** 文档 InstrumentID：交易所原生币对名，示例 BTC-USDT（非 ETH/PC） */
  private nativeInstrumentId(symbolSpec: SymbolPairInfo): string {
    const coin = String(symbolSpec.coinName || '')
      .trim()
      .toUpperCase();
    const settle = String(symbolSpec.settleCoin || '')
      .trim()
      .toUpperCase();
    if (coin && settle) return `${coin}-${settle}`;
    const eq = String(symbolSpec.equalCoinName || '')
      .trim()
      .toUpperCase();
    if (coin && eq && eq !== 'PC') return `${coin}-${eq}`;
    return String(symbolSpec.symbol || `${coin}/${eq || 'USDT'}`);
  }

  /** 文档 PositionSide：0 未知 / 1 多 / 2 空 */
  private mapOrderPositionSide(side?: string | null): number {
    const s = String(side || '').toLowerCase();
    if (s.includes('short') || s === '2') return 2;
    if (s.includes('long') || s === '1') return 1;
    return 0;
  }

  /** 文档 RecordType：现货 0买/1卖；合约 2开仓/3平仓 */
  private mapOrderRecordType(isOpen?: boolean | null, isFutures?: boolean): number {
    if (isFutures) {
      if (isOpen === true) return 2;
      if (isOpen === false) return 3;
    }
    return 0;
  }

  /**
   * ClientBillID：仅传交易所真实 clientOrderId。
   * 本地 fo_/ch_ 未提交给 PlaceOrder，带上会导致币安 Unknown order。
   */
  private resolveClientBillId(ctx: OrderContext): string {
    const cid = String(ctx.clientOrderId || '').trim();
    if (!cid) return '';
    if (/^(fo_|ch_)/i.test(cid)) return '';
    return cid;
  }

  /**
   * 撤单/查单单号：
   * 中间件 CancelOrder 实测不会把 clientBillID 映射为币安 origClientOrderId
   *（空 apiBillID 会报 orderid/origclientorderid both empty）。
   * 因此必须传正确的 apiBillID；clientBillID 仅作辅助可留空。
   */
  private resolveOrderBillIds(ctx: OrderContext): { apiBillID: string; clientBillID: string } {
    const orderId = String(ctx.orderId ?? '').trim();
    return { apiBillID: orderId, clientBillID: '' };
  }

  /** 用 clientOrderId 从币安 openOrders 回查真实 orderId（纠正 JSON number 精度丢失） */
  private async resolveBinanceOrderIdByClient(
    userId: string,
    clientOrderId: string,
  ): Promise<string | null> {
    const cid = String(clientOrderId || '').trim();
    if (!cid || /^(fo_|ch_)/i.test(cid)) return null;
    try {
      const fetched = await this.adminFetchExchangeOpenOrders({
        userId,
        exchange: 'BINANCE',
      });
      const hit = (fetched.items || []).find((o) => String(o.clientOrderId || '') === cid);
      return hit?.orderId ? String(hit.orderId) : null;
    } catch (e: any) {
      this.logger.warn(`按 clientOrderId 回查币安单号失败: ${e?.message || e}`);
      return null;
    }
  }

  /** 构造 QueryOrder/CancelOrder 所需的 OrderRecordInfo（对照中间件文档 OrderRecordInfo） */
  private buildOrderRecord(
    account: ApiAccountInfo,
    symbolSpec: SymbolPairInfo,
    ctx: OrderContext,
    isFutures: boolean,
  ): OrderRecordInfo {
    const forCancel = ctx.orderPurpose === 'cancel';
    const lev = Number(ctx.leverage);
    const bills = this.resolveOrderBillIds(ctx);
    return {
      gid: '',
      apiBillID: bills.apiBillID,
      clientBillID: bills.clientBillID,
      ruleOrPositionGID: '',
      apiCode: symbolSpec.apiCode,
      apiName: symbolSpec.apiName,
      accountGID: account.gid,
      accountName: account.accountName,
      coinsName: symbolSpec.coinName,
      equalCoinName: symbolSpec.equalCoinName,
      leverageType: Number.isFinite(lev) && lev > 0 ? lev : 0,
      ruleType: isFutures ? 1 : 0,
      positionSide: this.mapOrderPositionSide(ctx.positionSide),
      recordType: this.mapOrderRecordType(ctx.isOpen, isFutures),
      tradeAmt: Number(ctx.tradeAmt) || 0,
      avgPrice: 0,
      filledAmt: 0,
      tradePrice: Number(ctx.tradePrice) || 0,
      profitsAmt: 0,
      profitsPercent: 0,
      tradeFee: 0,
      // 文档 Status：0待确定 1部分完成 2全部完成 3撤消订单 — 撤单请求必须传 3
      status: forCancel ? 3 : 0,
      tradeRemark: '',
      instrumentID: this.nativeInstrumentId(symbolSpec),
      isConfirmed: 0,
      settleCoin: symbolSpec.settleCoin || '',
      updateTime: 0,
      createTime: 0,
      createTimeMillSeconds: 0,
    };
  }

  /** 交易所侧已无此单（已成交/已撤/不存在） */
  private isUnknownOrderMsg(msg: string): boolean {
    return /unknown order|does not exist|订单不存在|order does not exist|不存在/i.test(
      String(msg || ''),
    );
  }

  /**
   * Unknown order：视为交易所已无此挂单 → 本地跟单标 CANCELLED + 业务异常；
   * 已成数量保留并 sync 持仓（不再 DISCARD_LOCAL 整仓清掉，避免部分成孤儿仓）。
   */
  private async finalizeUnknownExchangeOrder(
    log: {
      id: string;
      userId: string;
      exchange: Exchange;
      coinName?: string | null;
      equalCoinName?: string | null;
      positionSide?: string | null;
      isOpen?: boolean | null;
      filledAmt?: Prisma.Decimal | number | null;
      avgPrice?: Prisma.Decimal | number | null;
      tradeFee?: Prisma.Decimal | number | null;
      requestBody?: string | null;
    } | null,
    reason: string,
    msg: string,
    extra?: unknown,
  ) {
    const note = `交易所已无此单(${String(msg || 'Unknown order').trim()}), 本地关闭`;
    if (log) {
      const filled = Number(log.filledAmt ?? 0) || 0;
      const fillKind =
        filled > 1e-12 ? FollowFillKind.PARTIAL : FollowFillKind.NONE;
      await this.prisma.signalFollowLog.update({
        where: { id: log.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: 'EXCHANGE',
          cancelMsg: note.slice(0, 2000),
          errorMsg: null,
          fillKind,
          abnormalKind: FollowAbnormalKind.BUSINESS,
          abnormalAt: new Date(),
          abnormalMsg: note.slice(0, 2000),
          responseBody: JSON.stringify({
            unknownOrder: true,
            priorReason: reason,
            raw: extra ?? msg,
          }),
        },
      });
      await this.syncOpenPositionFromFollowLog(log);
    }
    this.logger.warn(
      `撤单 Unknown order → 本地关闭${log ? ` log=${log.id}` : ''}: ${note}`,
    );
    return {
      ok: true as const,
      exchangeGone: true as const,
      filled: false as const,
      recorded: !!log,
      message: note,
      data: extra ?? null,
    };
  }

  /** 开仓流水有成交时回写 user_positions（部分成 / 撤后已成 / 全成） */
  async syncOpenPositionFromFollowLog(log: {
    userId: string;
    exchange: Exchange;
    coinName?: string | null;
    equalCoinName?: string | null;
    positionSide?: string | null;
    isOpen?: boolean | null;
    requestBody?: string | null;
  }) {
    let meta: any = {};
    try {
      meta = log.requestBody ? JSON.parse(log.requestBody) : {};
    } catch {
      meta = {};
    }
    const isOpen = log.isOpen != null ? log.isOpen : meta.isOpen != null ? !!meta.isOpen : null;
    if (isOpen === false) return null;
    const coinName = String(log.coinName || meta.coinName || '')
      .trim()
      .toUpperCase();
    if (!coinName) return null;
    const equalCoinName =
      String(log.equalCoinName || meta.equalCoinName || 'PC').trim().toUpperCase() || 'PC';
    const positionSide = String(log.positionSide || meta.positionSide || 'long')
      .trim()
      .toLowerCase()
      .includes('short')
      ? 'short'
      : 'long';
    try {
      return await this.syncUserPositionFromLots({
        userId: log.userId,
        exchange: log.exchange,
        coinName,
        equalCoinName,
        positionSide,
      });
    } catch (e: any) {
      this.logger.error(
        `写仓失败 user=${log.userId} ${coinName} ${positionSide}: ${e?.message || e}`,
      );
      throw e;
    }
  }

  async markFollowLogAbnormal(
    logId: string,
    kind: FollowAbnormalKind,
    msg: string,
  ) {
    if (kind === FollowAbnormalKind.NONE) {
      await this.prisma.signalFollowLog.update({
        where: { id: logId },
        data: {
          abnormalKind: FollowAbnormalKind.NONE,
          abnormalAt: null,
          abnormalMsg: null,
        },
      });
      return;
    }
    await this.prisma.signalFollowLog.update({
      where: { id: logId },
      data: {
        abnormalKind: kind,
        abnormalAt: new Date(),
        abnormalMsg: String(msg || '').slice(0, 2000),
      },
    });
  }

  /**
   * 同币同向未完结开仓挂单（先撤再开 / 平仓前先撤）。
   */
  async findSameDirectionOpenOrders(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string | null;
    positionSide?: string | null;
  }) {
    const coinName = String(params.coinName || '').trim().toUpperCase();
    if (!coinName) return [];
    const equalCoinName = String(params.equalCoinName || '').trim().toUpperCase();
    const positionSide = String(params.positionSide || 'long')
      .trim()
      .toLowerCase()
      .includes('short')
      ? 'short'
      : 'long';
    return this.prisma.signalFollowLog.findMany({
      where: {
        userId: params.userId,
        exchange: params.exchange,
        coinName,
        equalCoinName,
        positionSide,
        isOpen: true,
        status: { in: ['PLACED', 'CANCEL_FAILED', 'PENDING'] },
        orderId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * 新开/平仓信号前：撤掉同币同向未完结开仓挂单。
   * - 业务确认无单 / 撤成功 / 已成 → 可继续
   * - 系统异常（抛错/超时）→ systemError，调用方不得 PlaceOrder
   * - 仍挂单等业务撤失败 → blocked，不得 PlaceOrder
   */
  async clearSameDirectionOpenOrders(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string | null;
    positionSide?: string | null;
    cancelReason?: 'SIGNAL' | 'ADMIN' | 'EXPIRED';
  }): Promise<{
    ok: boolean;
    cleared: number;
    systemError?: boolean;
    blocked?: boolean;
    message?: string;
    systemLogIds?: string[];
  }> {
    const rows = await this.findSameDirectionOpenOrders(params);
    if (rows.length === 0) return { ok: true, cleared: 0 };

    let cleared = 0;
    const systemLogIds: string[] = [];
    for (const row of rows) {
      let meta: any = {};
      try {
        meta = row.requestBody ? JSON.parse(row.requestBody) : {};
      } catch {
        meta = {};
      }
      if (!row.orderId) continue;
      try {
        const res = await this.cancelOrder(params.userId, {
          exchange: params.exchange,
          orderId: row.orderId,
          symbol: row.symbol || undefined,
          accountType: row.accountType || 'future',
          coinName: row.coinName || meta.coinName || params.coinName,
          equalCoinName: row.equalCoinName || meta.equalCoinName || params.equalCoinName,
          clientOrderId: row.clientOrderId || undefined,
          isOpen: true,
          positionSide: row.positionSide || meta.positionSide || params.positionSide,
          cancelReason: params.cancelReason || 'SIGNAL',
          skipTradePassword: true,
        });
        if (res.ok || res.filled || (res as any).exchangeGone) {
          cleared++;
          if (row.abnormalKind !== FollowAbnormalKind.NONE) {
            await this.markFollowLogAbnormal(row.id, FollowAbnormalKind.NONE, '');
          }
          continue;
        }
        const msg = `同向旧开仓挂单未能清除 orderId=${row.orderId}`;
        await this.markFollowLogAbnormal(row.id, FollowAbnormalKind.BUSINESS, msg);
        return { ok: false, cleared, blocked: true, message: msg };
      } catch (e: any) {
        if (e instanceof BadRequestException) {
          const msg = String(e.message || e || '撤单失败');
          // Unknown 等已在 cancelOrder 内收口；其它业务失败（仍挂单）挡新开
          const still = await this.prisma.signalFollowLog.findUnique({
            where: { id: row.id },
            select: { status: true },
          });
          if (still && ['PLACED', 'CANCEL_FAILED', 'PENDING'].includes(still.status)) {
            await this.markFollowLogAbnormal(row.id, FollowAbnormalKind.BUSINESS, msg);
            return { ok: false, cleared, blocked: true, message: msg };
          }
          cleared++;
          continue;
        }
        // 系统异常：超时/抛错/中间件不可用 — 硬闸
        const msg = String(e?.message || e || '撤单系统异常');
        await this.markFollowLogAbnormal(row.id, FollowAbnormalKind.SYSTEM, msg);
        systemLogIds.push(row.id);
        return {
          ok: false,
          cleared,
          systemError: true,
          message: msg,
          systemLogIds,
        };
      }
    }
    return { ok: true, cleared };
  }

  /**
   * 系统异常未完结挂单：间隔重试撤单（默认 ≥10s），直到中间件有返回。
   */
  async retrySystemAbnormalCancels(opts?: { take?: number; minIntervalMs?: number }) {
    const take = Math.min(50, Math.max(1, opts?.take || 20));
    const minIntervalMs = Math.max(5000, opts?.minIntervalMs ?? 10_000);
    const before = new Date(Date.now() - minIntervalMs);
    const rows = await this.prisma.signalFollowLog.findMany({
      where: {
        abnormalKind: FollowAbnormalKind.SYSTEM,
        status: { in: ['PLACED', 'CANCEL_FAILED'] },
        orderId: { not: null },
        OR: [{ abnormalAt: { lte: before } }, { abnormalAt: null }],
      },
      take,
      orderBy: { abnormalAt: 'asc' },
    });
    let ok = 0;
    let fail = 0;
    for (const row of rows) {
      let meta: any = {};
      try {
        meta = row.requestBody ? JSON.parse(row.requestBody) : {};
      } catch {
        meta = {};
      }
      try {
        const res = await this.cancelOrder(row.userId, {
          exchange: row.exchange,
          orderId: row.orderId!,
          symbol: row.symbol || undefined,
          accountType: row.accountType || 'future',
          coinName: row.coinName || meta.coinName,
          equalCoinName: row.equalCoinName || meta.equalCoinName,
          clientOrderId: row.clientOrderId || undefined,
          isOpen: row.isOpen ?? meta.isOpen,
          positionSide: row.positionSide || meta.positionSide,
          cancelReason: 'SIGNAL',
          skipTradePassword: true,
        });
        if (res.ok || res.filled || (res as any).exchangeGone) {
          await this.markFollowLogAbnormal(row.id, FollowAbnormalKind.NONE, '');
          ok++;
        } else {
          fail++;
          await this.markFollowLogAbnormal(
            row.id,
            FollowAbnormalKind.SYSTEM,
            '系统异常重试撤单未确认成功',
          );
        }
      } catch (e: any) {
        fail++;
        if (e instanceof BadRequestException) {
          const still = await this.prisma.signalFollowLog.findUnique({
            where: { id: row.id },
            select: { status: true },
          });
          if (still && !['PLACED', 'CANCEL_FAILED', 'PENDING'].includes(still.status)) {
            await this.markFollowLogAbnormal(row.id, FollowAbnormalKind.NONE, '');
            ok++;
            continue;
          }
          await this.markFollowLogAbnormal(
            row.id,
            FollowAbnormalKind.BUSINESS,
            String(e.message || e),
          );
        } else {
          await this.markFollowLogAbnormal(
            row.id,
            FollowAbnormalKind.SYSTEM,
            String(e?.message || e || '系统异常重试失败'),
          );
        }
      }
    }
    return { tried: rows.length, ok, fail };
  }

  /**
   * 撤单并写入跟单撤单记录。
   * - 成功 → SignalFollowLog.status=CANCELLED + cancelledAt/cancelReason/cancelMsg
   * - Unknown order → 视为交易所已处理，本地 CANCELLED（不再 CANCEL_FAILED 重试）
   * - 其它失败 → status=CANCEL_FAILED + cancelMsg(失败原因), 并抛出明确错误供前端提醒
   * - 若撤单时发现已成交 → 标 FILLED (不算撤单失败)
   */
  async cancelOrder(
    userId: string,
    dto: {
      exchange: Exchange;
      orderId: string;
      symbol?: string;
      accountType?: string;
      apiCode?: string;
      coinName?: string;
      equalCoinName?: string;
      clientOrderId?: string;
      isOpen?: boolean;
      positionSide?: string;
      /** MANUAL 用户手撤 / EXPIRED 超时自动撤 / ADMIN 后台 / EXCHANGE 交易所侧 */
      cancelReason?: 'MANUAL' | 'EXPIRED' | 'ADMIN' | 'EXCHANGE' | 'SIGNAL' | 'REMAINDER';
      tradePassword?: string;
      skipTradePassword?: boolean;
    },
  ) {
    await this.assertTradePassword(userId, dto.tradePassword, dto.skipTradePassword);
    const accountType = dto.accountType || 'future';
    const isFutures = isFuturesAccountType(accountType);
    const reason = dto.cancelReason || 'MANUAL';
    const orderId = String(dto.orderId ?? '').trim();

    const log = await this.prisma.signalFollowLog.findFirst({
      where: {
        userId,
        orderId,
        status: { in: ['PLACED', 'CANCEL_FAILED', 'PENDING'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    let meta: any = {};
    try {
      meta = log?.requestBody ? JSON.parse(log.requestBody) : {};
    } catch {
      meta = {};
    }

    const account = await this.buildAccount(userId, dto.exchange, accountType);
    const symbolSpec = await this.resolveSymbolSpec(dto.exchange, {
      ...dto,
      coinName: dto.coinName || log?.coinName || meta.coinName,
      equalCoinName: dto.equalCoinName || log?.equalCoinName || meta.equalCoinName,
      symbol: dto.symbol || log?.symbol || meta.symbol,
      apiCode: dto.apiCode || meta.apiCode,
    });
    // 与 PlaceOrder 一致：account.apiCode 对齐 symbol（合约多为 bac）
    const accountForCancel: ApiAccountInfo = {
      ...account,
      apiCode: symbolSpec.apiCode || account.apiCode,
      apiName: symbolSpec.apiName || account.apiName,
    };

    const clientOrderId =
      dto.clientOrderId || log?.clientOrderId || meta.clientOrderId || undefined;
    let resolvedOrderId = orderId;
    // 币安：同步挂单时 JSON number 会把 orderId 弄成 …000；用 clientOrderId 回查真实单号
    if (dto.exchange === 'BINANCE' && clientOrderId) {
      const realId = await this.resolveBinanceOrderIdByClient(userId, String(clientOrderId));
      if (realId) {
        if (realId !== orderId) {
          this.logger.warn(
            `币安撤单单号校正 user=${userId} ${orderId} → ${realId} (client=${clientOrderId})`,
          );
          if (log) {
            await this.prisma.signalFollowLog.update({
              where: { id: log.id },
              data: { orderId: realId },
            });
          }
        }
        resolvedOrderId = realId;
      }
    }

    const orderCtx: OrderContext = {
      exchange: dto.exchange,
      orderId: resolvedOrderId,
      symbol: dto.symbol || log?.symbol || undefined,
      accountType,
      apiCode: dto.apiCode,
      coinName: dto.coinName || log?.coinName || undefined,
      equalCoinName: dto.equalCoinName || log?.equalCoinName || undefined,
      clientOrderId,
      positionSide: dto.positionSide || log?.positionSide || meta.positionSide || undefined,
      isOpen: dto.isOpen ?? log?.isOpen ?? meta.isOpen,
      orderPurpose: 'cancel',
      tradeAmt: Number(meta.amount ?? meta.followAmount ?? meta.coinAmt ?? 0) || 0,
      tradePrice: Number(meta.price ?? meta.tradePrice ?? 0) || 0,
      leverage: Number(meta.leverage ?? meta.leverageType ?? 0) || 0,
    };
    const order = this.buildOrderRecord(accountForCancel, symbolSpec, orderCtx, isFutures);
    const { proxyIP, egressIp } = await this.resolveProxyIp(userId);
    const body = {
      proxyIP,
      order,
      symbol: symbolSpec,
      account: accountForCancel,
      accountType,
    };

    const writeFail = async (msg: string) => {
      if (!log) return;
      await this.prisma.signalFollowLog.update({
        where: { id: log.id },
        data: {
          status: 'CANCEL_FAILED',
          cancelReason: reason,
          cancelMsg: msg.slice(0, 2000),
          errorMsg: msg.slice(0, 2000),
          responseBody: JSON.stringify({ successed: false, errorMsg: msg }),
        },
      });
    };

    try {
      const { data } = await this.mapi.post<{ successed?: boolean; errorMsg?: string }>(
        'mapi/CancelOrder',
        body,
        { userId, exchange: dto.exchange, proxyIp: proxyIP },
      );

      // 仅以 successed 判定 CancelOrder 是否成功，最终状态统一由 QueryOrder 决定
      if (!data || data.successed !== true) {
        const errMsg = String((data as any)?.errorMsg || '').trim();
        const msg =
          errMsg ||
          String((data as any)?.message || '').trim() ||
          '撤单失败(中间件未确认成功)';
        // 已成交 → FILLED；Unknown order → 交易所已无单，本地关闭
        const filledLike =
          /已成交|completely\s*filled|already\s*filled/i.test(msg) &&
          !this.isUnknownOrderMsg(msg);
        if (filledLike && log) {
          await this.prisma.signalFollowLog.update({
            where: { id: log.id },
            data: {
              status: 'FILLED',
              fillKind: FollowFillKind.FULL,
              cancelReason: `${reason}_CHECK`,
              cancelMsg: `撤单时发现已成交: ${msg}`.slice(0, 2000),
              responseBody: JSON.stringify(data),
            },
          });
          await this.syncOpenPositionFromFollowLog(log);
          return { ok: false, filled: true, data, recorded: true, message: msg };
        }
        if (this.isUnknownOrderMsg(msg)) {
          return this.finalizeUnknownExchangeOrder(log, reason, msg, data);
        }
        await writeFail(msg);
        throw new BadRequestException(`撤单失败: ${msg}`);
      }

      // 回包成功后再查单：仍挂单/部分成交则不算撤成功（防中间件假成功）
      const verify = await this.inspectOrderFill(userId, dto.exchange, resolvedOrderId, {
        symbol: orderCtx.symbol,
        accountType,
        apiCode: dto.apiCode,
        coinName: orderCtx.coinName,
        equalCoinName: orderCtx.equalCoinName,
        clientOrderId: orderCtx.clientOrderId,
        positionSide: orderCtx.positionSide || undefined,
        isOpen: orderCtx.isOpen ?? undefined,
      });
      if (verify.state === 'open' || verify.state === 'partial') {
        // 部分成：先回写已成量并写仓，再记撤失败（仍挂单）
        if (log && verify.filledAmt > 0) {
          await this.prisma.signalFollowLog.update({
            where: { id: log.id },
            data: {
              filledAmt: verify.filledAmt,
              avgPrice: verify.priceAvg || undefined,
              tradeFee: verify.tradeFee,
              fillKind: FollowFillKind.PARTIAL,
            },
          });
          try {
            await this.syncOpenPositionFromFollowLog(log);
          } catch (e: any) {
            this.logger.warn(`撤单后部分成写仓失败 log=${log.id}: ${e?.message || e}`);
          }
        }
        const msg = `撤单回包成功但交易所仍挂单(查单=${verify.state})`;
        await writeFail(msg);
        throw new BadRequestException(msg);
      }
      if (verify.state === 'filled') {
        if (log) {
          await this.prisma.signalFollowLog.update({
            where: { id: log.id },
            data: {
              status: 'FILLED',
              fillKind: FollowFillKind.FULL,
              cancelReason: `${reason}_CHECK`,
              cancelMsg: '撤单时查单已完全成交',
              filledAmt: verify.filledAmt || undefined,
              avgPrice: verify.priceAvg || undefined,
              tradeFee: verify.tradeFee,
              responseBody: JSON.stringify({ cancel: data, query: verify }),
            },
          });
          await this.syncOpenPositionFromFollowLog(log);
        }
        return { ok: false, filled: true, data, recorded: !!log, message: '委托已成交' };
      }
      if (verify.state === 'unknown' && verify.errorMsg) {
        const msg = String(verify.errorMsg).trim();
        if (this.isUnknownOrderMsg(msg)) {
          // 带上本地已记成交量，避免 Unknown 丢部分成
          const merged = log
            ? {
                ...log,
                filledAmt: Number(log.filledAmt ?? 0) > 0 ? log.filledAmt : verify.filledAmt,
                avgPrice: log.avgPrice ?? verify.priceAvg,
                tradeFee: log.tradeFee ?? verify.tradeFee,
              }
            : null;
          return this.finalizeUnknownExchangeOrder(merged, reason, msg, {
            cancel: data,
            query: verify,
          });
        }
        await writeFail(`撤单后查单未确认: ${msg}`);
        throw new BadRequestException(`撤单失败: ${msg}`);
      }

      if (log) {
        const filledAmt =
          verify.filledAmt > 0
            ? verify.filledAmt
            : Number(log.filledAmt ?? 0) > 0
              ? Number(log.filledAmt)
              : 0;
        const fillKind =
          filledAmt > 1e-12 ? FollowFillKind.PARTIAL : FollowFillKind.NONE;
        await this.prisma.signalFollowLog.update({
          where: { id: log.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: reason,
            fillKind,
            ...(filledAmt > 0
              ? {
                  filledAmt,
                  avgPrice: verify.priceAvg || log.avgPrice || undefined,
                  tradeFee: verify.tradeFee ?? log.tradeFee,
                }
              : {}),
            cancelMsg:
              reason === 'EXPIRED'
                ? '挂单超时未成交, 系统自动撤单'
                : reason === 'MANUAL'
                  ? '用户手动撤单'
                  : reason === 'ADMIN'
                    ? '运营后台撤单'
                    : reason === 'SIGNAL'
                      ? '同向新信号前撤旧开仓挂单'
                      : '已撤单',
            responseBody: JSON.stringify({
              cancel: data,
              queryState: verify.state,
              filledAmt,
            }),
            errorMsg: null,
            abnormalKind: FollowAbnormalKind.NONE,
            abnormalAt: null,
            abnormalMsg: null,
          },
        });
        if (filledAmt > 0) {
          await this.syncOpenPositionFromFollowLog(log);
        }
      }

      return { ok: true, filled: false, data, recorded: !!log };
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      const msg = e?.message || String(e) || '撤单失败';
      const filledLike =
        /filled|已成交|already\s*filled/i.test(msg) && !this.isUnknownOrderMsg(msg);
      if (filledLike && log) {
        await this.prisma.signalFollowLog.update({
          where: { id: log.id },
          data: {
            status: 'FILLED',
            fillKind: FollowFillKind.FULL,
            cancelReason: `${reason}_CHECK`,
            cancelMsg: `撤单时发现已成交: ${msg}`.slice(0, 2000),
          },
        });
        await this.syncOpenPositionFromFollowLog(log);
        return { ok: false, filled: true, recorded: true, message: msg, data: null };
      }
      if (this.isUnknownOrderMsg(msg)) {
        return this.finalizeUnknownExchangeOrder(log, reason, msg);
      }
      await writeFail(msg);
      if (log) {
        await this.markFollowLogAbnormal(log.id, FollowAbnormalKind.SYSTEM, msg);
      }
      throw new ServiceUnavailableException(`撤单失败: ${msg}`);
    }
  }

  /**
   * 运营手动撤单测试：按交易所 + 交易所订单号调 mapi/CancelOrder。
   * 用户 Key / 币对优先从 SignalFollowLog 反查；无流水则需显式 userId+coinName。
   */
  async adminCancelByOrderId(params: {
    exchange: Exchange;
    orderId: string;
    userId?: string;
    coinName?: string;
    equalCoinName?: string;
    accountType?: string;
  }) {
    const orderId = String(params.orderId || '').trim();
    if (!orderId) throw new BadRequestException('请输入交易所订单号');
    if (!params.exchange) throw new BadRequestException('请选择交易所');

    const log = await this.prisma.signalFollowLog.findFirst({
      where: {
        orderId,
        exchange: params.exchange,
        ...(params.userId?.trim() ? { userId: params.userId.trim() } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    const userId = String(params.userId || log?.userId || '').trim();
    if (!userId) {
      throw new BadRequestException(
        '未找到该订单对应的跟单用户，请确认订单号，或在接口中补充 userId',
      );
    }

    const coinName = String(params.coinName || log?.coinName || '')
      .trim()
      .toUpperCase();
    const equalCoinName = String(params.equalCoinName || log?.equalCoinName || 'PC')
      .trim()
      .toUpperCase();
    if (!coinName) {
      throw new BadRequestException(
        '本地无该订单流水且未提供币名，无法构造撤单交易对',
      );
    }

    this.logger.log(
      `手动撤单测试 exchange=${params.exchange} orderId=${orderId} user=${userId} ${coinName}/${equalCoinName}`,
    );

    try {
      const res = await this.cancelOrder(userId, {
        exchange: params.exchange,
        orderId,
        symbol: log?.symbol || `${coinName}/${equalCoinName}`,
        accountType: params.accountType || log?.accountType || 'future',
        coinName,
        equalCoinName,
        clientOrderId: log?.clientOrderId || undefined,
        isOpen: log?.isOpen ?? undefined,
        cancelReason: 'ADMIN',
        skipTradePassword: true,
      });
      return {
        ok: !!res.ok,
        filled: !!res.filled,
        recorded: !!res.recorded,
        message: res.message || (res.ok ? '撤单成功' : res.filled ? '订单已成交或不存在' : '撤单完成'),
        orderId,
        exchange: params.exchange,
        userId,
        coinName,
        equalCoinName,
        logId: log?.id || null,
        data: res.data ?? null,
      };
    } catch (e: any) {
      const msg = e?.message || String(e) || '撤单失败';
      // 测试入口：把中间件结果带回前端，不丢原因
      throw e instanceof BadRequestException || e instanceof ServiceUnavailableException
        ? e
        : new BadRequestException(msg);
    }
  }

  /**
   * 大整型订单号超过 JS 安全整数时，JSON.parse 会丢精度（常变成 …000）。
   * 先把 orderId 等字段改成字符串再 parse。
   */
  private protectLargeIdsInJson(text: string): string {
    return String(text || '').replace(
      /"(orderId|orderID|origClientOrderId|clientOrderId|apiBillID)"\s*:\s*(\d{16,})/gi,
      '"$1":"$2"',
    );
  }

  /**
   * 运营：拉取用户在交易所的当前挂单（用于拿订单号做撤单测试）。
   * 中间件无挂单列表接口，币安 U 本位合约直连 GET /fapi/v1/openOrders。
   */
  async adminFetchExchangeOpenOrders(params: {
    userId: string;
    exchange: Exchange;
  }) {
    const userId = String(params.userId || '').trim();
    if (!userId) throw new BadRequestException('请先选择用户');
    if (params.exchange !== 'BINANCE') {
      throw new BadRequestException('目前仅支持 BINANCE（U 本位合约 openOrders）');
    }

    const cred = await this.keys.getDecrypted(userId, 'BINANCE');
    if (!cred?.apiKey || !cred?.apiSecret) {
      throw new BadRequestException('该用户未配置 BINANCE API Key');
    }

    const base = (
      process.env.MARKET_BINANCE_FUTURES_URL || 'https://fapi.binance.com'
    ).replace(/\/$/, '');
    const timestamp = Date.now();
    const recvWindow = 5000;
    const qs = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createHmac('sha256', cred.apiSecret)
      .update(qs)
      .digest('hex');
    const url = `${base}/fapi/v1/openOrders?${qs}&signature=${signature}`;

    let raw: any;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': cred.apiKey },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      try {
        raw = text ? JSON.parse(this.protectLargeIdsInJson(text)) : null;
      } catch {
        try {
          raw = text ? JSON.parse(text) : null;
        } catch {
          throw new BadRequestException(`币安返回非 JSON: ${text.slice(0, 200)}`);
        }
      }
      if (!res.ok) {
        const msg = String(raw?.msg || raw?.message || text || `HTTP ${res.status}`).trim();
        throw new BadRequestException(`拉取币安挂单失败: ${msg}`);
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new ServiceUnavailableException(
        `拉取币安挂单失败: ${e?.message || e}（若 Key 做了 IP 白名单，需放行本机出口 IP）`,
      );
    }

    const list = Array.isArray(raw) ? raw : [];
    const items = list.map((o: any) => {
      const symbol = String(o.symbol || '');
      const coin = symbol.replace(/USDT$|USDC$|BUSD$/i, '') || symbol;
      const quote = symbol.endsWith('USDC')
        ? 'USDC'
        : symbol.endsWith('BUSD')
          ? 'BUSD'
          : 'USDT';
      return {
        orderId: String(o.orderId ?? ''),
        clientOrderId: o.clientOrderId ? String(o.clientOrderId) : null,
        symbol,
        coinName: coin,
        equalCoinName: 'PC',
        quote,
        side: String(o.side || ''),
        positionSide: String(o.positionSide || ''),
        type: String(o.type || ''),
        price: o.price != null ? String(o.price) : '',
        origQty: o.origQty != null ? String(o.origQty) : '',
        executedQty: o.executedQty != null ? String(o.executedQty) : '',
        status: String(o.status || ''),
        time: o.time ? new Date(Number(o.time)).toISOString() : null,
        updateTime: o.updateTime ? new Date(Number(o.updateTime)).toISOString() : null,
      };
    });

    this.logger.log(
      `拉取交易所挂单 user=${userId} BINANCE futures open=${items.length}`,
    );
    return {
      exchange: 'BINANCE' as const,
      market: 'usdt-m-futures',
      userId,
      total: items.length,
      items,
    };
  }

  /**
   * 运营/对账：币安 U 本位成交 GET /fapi/v1/userTrades + 当前仓 /fapi/v2/positionRisk。
   * 成交接口单次最多 7 天，按窗口翻页。不回传 API Key。
   */
  async adminFetchExchangeUserTrades(params: {
    userId: string;
    exchange: Exchange;
    symbol: string;
    lookbackDays?: number;
  }) {
    const userId = String(params.userId || '').trim();
    if (!userId) throw new BadRequestException('请先选择用户');
    if (params.exchange !== 'BINANCE') {
      throw new BadRequestException('目前仅支持 BINANCE（U 本位合约 userTrades）');
    }
    const symbol = String(params.symbol || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!symbol) throw new BadRequestException('请填写合约 symbol，例如 TUTUSDT');

    const cred = await this.keys.getDecrypted(userId, 'BINANCE');
    if (!cred?.apiKey || !cred?.apiSecret) {
      throw new BadRequestException('该用户未配置 BINANCE API Key');
    }

    const base = (
      process.env.MARKET_BINANCE_FUTURES_URL || 'https://fapi.binance.com'
    ).replace(/\/$/, '');
    const days = Math.min(90, Math.max(1, Number(params.lookbackDays) || 21));

    const signedGet = async (path: string, extraQs: string) => {
      const timestamp = Date.now();
      const recvWindow = 5000;
      const qs = `${extraQs ? `${extraQs}&` : ''}timestamp=${timestamp}&recvWindow=${recvWindow}`;
      const signature = createHmac('sha256', cred.apiSecret).update(qs).digest('hex');
      const url = `${base}${path}?${qs}&signature=${signature}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': cred.apiKey },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let raw: any;
      try {
        raw = text ? JSON.parse(this.protectLargeIdsInJson(text)) : null;
      } catch {
        try {
          raw = text ? JSON.parse(text) : null;
        } catch {
          throw new BadRequestException(`币安返回非 JSON: ${text.slice(0, 200)}`);
        }
      }
      if (!res.ok) {
        const msg = String(raw?.msg || raw?.message || text || `HTTP ${res.status}`).trim();
        throw new BadRequestException(`拉取币安成交失败: ${msg}`);
      }
      return raw;
    };

    let positions: any[] = [];
    try {
      const posRaw = await signedGet('/fapi/v2/positionRisk', `symbol=${symbol}`);
      positions = (Array.isArray(posRaw) ? posRaw : []).map((p: any) => ({
        symbol: String(p.symbol || symbol),
        positionAmt: String(p.positionAmt ?? '0'),
        entryPrice: String(p.entryPrice ?? '0'),
        markPrice: p.markPrice != null ? String(p.markPrice) : null,
        unRealizedProfit: p.unRealizedProfit != null ? String(p.unRealizedProfit) : null,
        leverage: p.leverage != null ? String(p.leverage) : null,
        marginType: p.marginType != null ? String(p.marginType) : null,
        positionSide: String(p.positionSide || ''),
      }));
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new ServiceUnavailableException(
        `拉取币安持仓失败: ${e?.message || e}（若 Key 做了 IP 白名单，需放行本机/服务器出口 IP）`,
      );
    }

    const trades: Array<{
      id: string;
      orderId: string;
      symbol: string;
      side: string;
      positionSide: string;
      price: string;
      qty: string;
      realizedPnl: string;
      time: string | null;
      buyer: boolean;
      maker: boolean;
    }> = [];
    const seen = new Set<string>();
    const now = Date.now();
    const start = now - days * 24 * 3600 * 1000;
    const windowMs = 7 * 24 * 3600 * 1000 - 60_000;
    try {
      for (let t0 = start; t0 < now; t0 += windowMs) {
        const t1 = Math.min(now, t0 + windowMs);
        const extra = `symbol=${symbol}&startTime=${t0}&endTime=${t1}&limit=1000`;
        const raw = await signedGet('/fapi/v1/userTrades', extra);
        const list = Array.isArray(raw) ? raw : [];
        if (list.length >= 1000) {
          this.logger.warn(
            `币安成交窗口已满 1000 笔 ${symbol} ${new Date(t0).toISOString()}~${new Date(t1).toISOString()}，可能截断`,
          );
        }
        for (const tr of list) {
          const id = String(tr.id ?? '');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          trades.push({
            id,
            orderId: String(tr.orderId ?? ''),
            symbol: String(tr.symbol || symbol),
            side: String(tr.side || ''),
            positionSide: String(tr.positionSide || ''),
            price: String(tr.price ?? ''),
            qty: String(tr.qty ?? ''),
            realizedPnl: String(tr.realizedPnl ?? '0'),
            time: tr.time ? new Date(Number(tr.time)).toISOString() : null,
            buyer: !!tr.buyer,
            maker: !!tr.maker,
          });
        }
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new ServiceUnavailableException(
        `拉取币安成交失败: ${e?.message || e}（若 Key 做了 IP 白名单，需放行本机/服务器出口 IP）`,
      );
    }

    trades.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    this.logger.log(
      `拉取交易所成交 user=${userId} ${symbol} trades=${trades.length} positions=${positions.length}`,
    );
    return {
      exchange: 'BINANCE' as const,
      market: 'usdt-m-futures',
      userId,
      symbol,
      lookbackDays: days,
      positions,
      trades,
      total: trades.length,
    };
  }

  /**
   * 运营：把用户交易所当前挂单写入本地 signal_follow_logs（PLACED），
   * 以便出现在挂单列表并可勾选撤单。币安手动挂的远价限价单靠此同步。
   */
  async adminSyncExchangeOpenOrders(params: {
    userId: string;
    exchange: Exchange;
  }) {
    const fetched = await this.adminFetchExchangeOpenOrders(params);
    const userId = fetched.userId;
    const exchange = fetched.exchange as Exchange;

    const cfg = await this.prisma.userFollowConfig.findFirst({
      where: { userId, exchange },
      include: { template: { select: { accountGid: true, accountName: true } } },
    });
    const accountGid = String(cfg?.template?.accountGid || '').trim() || null;
    const accountName = String(cfg?.template?.accountName || '').trim() || null;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const seenOrderIds = new Set<string>();

    for (const o of fetched.items) {
      const orderId = String(o.orderId || '').trim();
      if (!orderId) {
        skipped++;
        continue;
      }
      seenOrderIds.add(orderId);

      const posRaw = String(o.positionSide || '').toUpperCase();
      const sideRaw = String(o.side || '').toUpperCase();
      const positionSide = posRaw.includes('SHORT')
        ? 'short'
        : posRaw.includes('LONG')
          ? 'long'
          : sideRaw === 'SELL'
            ? 'short'
            : 'long';
      const isOpen =
        posRaw === 'BOTH' || !posRaw
          ? true
          : positionSide === 'long'
            ? sideRaw === 'BUY'
            : sideRaw === 'SELL';
      const coinName = String(o.coinName || '').toUpperCase();
      const equalCoinName = 'PC';
      const symbol = `${coinName}/${equalCoinName}`;
      const orderType = /market/i.test(String(o.type || '')) ? 'market' : 'limit';
      const signalKey = `exsync:${exchange}:${orderId}`;
      const orderGid = `exsync:${orderId}`;
      const requestBody = JSON.stringify({
        source: 'exchange_sync',
        price: o.price,
        amount: o.origQty,
        exchangeStatus: o.status,
        exchangeSymbol: o.symbol,
        side: o.side,
        positionSide: o.positionSide,
        syncedAt: new Date().toISOString(),
      });

      const patch = {
        success: true,
        status: 'PLACED' as const,
        orderId,
        clientOrderId: o.clientOrderId || undefined,
        symbol,
        side: isOpen ? 'open' : 'close',
        orderType,
        accountType: 'future',
        accountGid: accountGid || undefined,
        accountName: accountName || undefined,
        coinName,
        equalCoinName,
        positionSide,
        isOpen,
        expiresAt: null as Date | null,
        errorMsg: null as string | null,
        cancelReason: null as string | null,
        cancelMsg: null as string | null,
        cancelledAt: null as Date | null,
        requestBody,
      };

      const existingByOrder = await this.prisma.signalFollowLog.findFirst({
        where: {
          userId,
          exchange,
          orderId,
          status: { in: ['PLACED', 'CANCEL_FAILED', 'PENDING'] },
        },
      });
      if (existingByOrder) {
        await this.prisma.signalFollowLog.update({
          where: { id: existingByOrder.id },
          data: patch,
        });
        updated++;
        continue;
      }

      const existingByKey = await this.prisma.signalFollowLog.findUnique({
        where: { signalKey_userId: { signalKey, userId } },
      });
      if (existingByKey) {
        await this.prisma.signalFollowLog.update({
          where: { id: existingByKey.id },
          data: patch,
        });
        updated++;
      } else {
        await this.prisma.signalFollowLog.create({
          data: {
            signalKey,
            orderGid,
            userId,
            exchange,
            ...patch,
          },
        });
        created++;
      }
    }

    // 仅清理「交易所同步」来源、且交易所已不存在的本地挂单
    const staleWhere: Prisma.SignalFollowLogWhereInput = {
      userId,
      exchange,
      status: { in: ['PLACED', 'CANCEL_FAILED'] },
      signalKey: { startsWith: 'exsync:' },
    };
    if (seenOrderIds.size > 0) {
      staleWhere.OR = [
        { orderId: null },
        { orderId: { notIn: [...seenOrderIds] } },
      ];
    }
    const stale = await this.prisma.signalFollowLog.findMany({
      where: staleWhere,
      select: { id: true },
    });
    let closed = 0;
    if (stale.length > 0) {
      const r = await this.prisma.signalFollowLog.updateMany({
        where: { id: { in: stale.map((x) => x.id) } },
        data: {
          status: 'CANCELLED',
          cancelReason: 'EXCHANGE_SYNC',
          cancelMsg: '交易所已无此挂单（同步时清理）',
          cancelledAt: new Date(),
        },
      });
      closed = r.count;
    }

    this.logger.log(
      `同步交易所挂单 user=${userId} open=${fetched.total} created=${created} updated=${updated} closed=${closed}`,
    );
    return {
      exchange,
      market: fetched.market,
      userId,
      exchangeOpen: fetched.total,
      created,
      updated,
      skipped,
      closed,
      imported: created + updated,
    };
  }

  async queryBalance(userId: string, exchange: Exchange, accountType = 'future') {
    const account = await this.buildAccount(userId, exchange, accountType);
    const { proxyIP, egressIp } = await this.resolveProxyIp(userId);
    try {
      const { data, latencyMs } = await this.mapi.post<{ assets?: any[]; errorMsg?: string }>(
        'mapi/QueryBalance',
        { proxyIP, accountType, account },
        { userId, exchange, proxyIp: proxyIP },
      );
      const err = String((data as any)?.errorMsg || '').trim();
      if (err) {
        throw new ServiceUnavailableException(
          `${exchange}余额失败: ${err}（中间件未返回交易所原始错误码；耗时 ${latencyMs}ms；proxy=${proxyIP || '—'}；accountType=${accountType}；apiCode=${account.apiCode}）`,
        );
      }
      return this.normalizeBalance(exchange, data);
    } catch (e: any) {
      if (e instanceof ServiceUnavailableException) throw e;
      throw new ServiceUnavailableException(e?.message || '查询余额失败');
    }
  }

  /**
   * 查询单笔委托状态 (mapi/QueryOrder, 严格按文档: order+symbol+account)。
   * 返回文档 data: { status, filledAmt, priceAvg, tradeFee, errorMsg }。
   */
  async queryOrderStatus(
    userId: string,
    ctx: OrderContext & { isOpen?: boolean },
  ): Promise<QueryOrderResult> {
    const accountType = ctx.accountType || 'future';
    const isFutures = isFuturesAccountType(accountType);
    const account = await this.buildAccount(userId, ctx.exchange, accountType);
    const symbolSpec = await this.resolveSymbolSpec(ctx.exchange, ctx);
    const accountForQuery: ApiAccountInfo = {
      ...account,
      apiCode: symbolSpec.apiCode || account.apiCode,
      apiName: symbolSpec.apiName || account.apiName,
    };
    const order = this.buildOrderRecord(
      accountForQuery,
      symbolSpec,
      { ...ctx, orderId: String(ctx.orderId ?? ''), orderPurpose: ctx.orderPurpose || 'query' },
      isFutures,
    );
    const { proxyIP } = await this.resolveProxyIp(userId);
    const { data } = await this.mapi.post<QueryOrderResult>(
      'mapi/QueryOrder',
      {
        proxyIP,
        order,
        symbol: symbolSpec,
        account: accountForQuery,
        accountType,
        isOpen: ctx.isOpen ?? false,
      },
      { userId, exchange: ctx.exchange, proxyIp: proxyIP },
    );
    return data;
  }

  /**
   * 查询单笔委托成交详情 (成交检测 + 盈亏计算共用)。
   * 文档状态码: -1已撤销 0未成交 1部分成交 2完全成交 99无状态 ""错误。
   * 同时带回 FilledAmt / PriceAvg / TradeFee 供已实现盈亏计算。
   */
  async inspectOrderFill(
    userId: string,
    exchange: Exchange,
    orderId: string,
    opts?: {
      symbol?: string;
      accountType?: string;
      apiCode?: string;
      coinName?: string;
      equalCoinName?: string;
      clientOrderId?: string;
      positionSide?: string;
      placedAt?: Date;
      isOpen?: boolean;
    },
  ): Promise<{
    state: 'open' | 'partial' | 'filled' | 'cancelled' | 'unknown';
    filledAmt: number;
    priceAvg: number;
    tradeFee: number;
    errorMsg?: string;
  }> {
    const empty = { state: 'unknown' as const, filledAmt: 0, priceAvg: 0, tradeFee: 0 };
    try {
      const res = await this.queryOrderStatus(userId, {
        exchange,
        orderId: String(orderId ?? ''),
        symbol: opts?.symbol,
        accountType: opts?.accountType,
        apiCode: opts?.apiCode,
        coinName: opts?.coinName,
        equalCoinName: opts?.equalCoinName,
        clientOrderId: opts?.clientOrderId,
        positionSide: opts?.positionSide,
        isOpen: opts?.isOpen,
        orderPurpose: 'query',
      });
      const st = String(res?.status ?? '').trim();
      if (st === '' && opts?.placedAt && Date.now() - opts.placedAt.getTime() < 2500) {
        return { ...empty, errorMsg: res?.errorMsg };
      }
      return {
        state: mapDocStatus(st),
        filledAmt: Number(res?.filledAmt ?? 0) || 0,
        priceAvg: Number(res?.priceAvg ?? 0) || 0,
        tradeFee: Number(res?.tradeFee ?? 0) || 0,
        errorMsg: res?.errorMsg,
      };
    } catch (e: any) {
      return { ...empty, errorMsg: e?.message || String(e) };
    }
  }

  /** 兼容旧调用: 仅返回状态 */
  async resolveOrderFillState(
    userId: string,
    exchange: Exchange,
    orderId: string,
    opts?: {
      symbol?: string;
      accountType?: string;
      apiCode?: string;
      coinName?: string;
      equalCoinName?: string;
      clientOrderId?: string;
      placedAt?: Date;
    },
  ): Promise<'open' | 'partial' | 'filled' | 'cancelled' | 'unknown'> {
    const r = await this.inspectOrderFill(userId, exchange, orderId, opts);
    return r.state;
  }

  /**
   * 用户委托列表: 文档无「批量查委托」接口, 故以本系统跟踪的挂单(SignalFollowLog)为准,
   * 逐笔用 QueryOrder 刷新最新状态。
   */
  async listOpenOrders(userId: string) {
    // App 委托：仅挂单中 / 撤单失败；开仓/下单失败(FAILED) 只在后台挂单日志查看
    const rows = await this.prisma.signalFollowLog.findMany({
      where: { userId, status: { in: ['PLACED', 'CANCEL_FAILED'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const items = rows.map((r) => {
      const failReason = (r.errorMsg || r.cancelMsg || '').trim() || null;
      return {
        id: r.orderId || r.id,
        orderId: r.orderId,
        exchange: r.exchange,
        pair: r.symbol || r.signalKey,
        mode: r.accountType || '—',
        side: r.side || '—',
        type: r.orderType || '—',
        status: r.status,
        isOpen: r.isOpen,
        price: r.avgPrice != null ? String(r.avgPrice) : '—',
        amount: r.filledAmt != null ? String(r.filledAmt) : '—',
        filled: r.filledAmt != null ? String(r.filledAmt) : '0',
        time: r.createdAt,
        signalKey: r.signalKey,
        accountType: r.accountType,
        coinName: r.coinName,
        equalCoinName: r.equalCoinName,
        cancelReason: r.cancelReason,
        cancelMsg: r.cancelMsg,
        errorMsg: r.errorMsg,
        /** 统一失败原因文案（开仓/挂单/撤单失败） */
        failReason,
        // App 只读；撤单由系统/后台运营处理
        canCancel: false,
      };
    });
    return { items, errors: [] as { exchange: string; message: string }[] };
  }

  /**
   * 盘口价仅观察用，不挡列表：先出本地仓，再按这些币对后台刷 GetDepth。
   * 慢了下次轮询会带上缓存价。
   */
  private kickoffPositionMarkPrices(
    rows: Array<{ exchange: Exchange; coinName: string; accountType: string | null }>,
  ) {
    if (!rows.length) return;
    void this.market
      .ensurePrices(
        rows.map((r) => ({
          exchange: r.exchange,
          coinName: r.coinName,
          market: String(r.accountType || '').toLowerCase() === 'spot' ? 'spot' : 'future',
        })),
      )
      .catch((e: any) => {
        this.logger.debug(`持仓盘口补价跳过: ${e?.message || e}`);
      });
  }

  /**
   * 持仓列表：只读本地「正常」OPEN 仓（与管理端当前持仓、交易所对齐）。
   * 异常仓（平不掉的本地残留）不进 App，避免比交易所多一条。
   * 与交易所对账在 FollowerWorker 定时线程（reconcileAllOpenPositions），不堵列表。
   */
  async listPositions(
    userId: string,
    opts?: {
      accountGid?: string;
      accountName?: string;
      /** spot | future，默认不限（本地表按 accountType 筛选） */
      accountType?: string;
      exchange?: string;
    },
  ) {
    const where: Prisma.UserPositionWhereInput = {
      userId,
      status: UserPositionStatus.OPEN,
      qty: { gt: 0 },
      abnormal: false,
    };
    if (opts?.exchange) where.exchange = opts.exchange as Exchange;
    if (opts?.accountGid?.trim()) where.accountGid = opts.accountGid.trim();
    if (opts?.accountType?.trim()) {
      const at = opts.accountType.trim().toLowerCase();
      if (at === 'spot') where.accountType = 'spot';
      else if (at === 'future' || at === 'futures') {
        where.OR = [
          { accountType: { in: ['future', 'futures', 'swap', 'perp'] } },
          { accountType: null },
        ];
      }
    }

    const rows = (
      await this.prisma.userPosition.findMany({
        where,
        orderBy: { openedAt: 'desc' },
      })
    ).filter((r) => !r.abnormal);
    this.kickoffPositionMarkPrices(rows);
    const items = rows.map((r) => ({
      ...this.mapUserPositionRow(r),
      userId: r.userId,
      source: 'local' as string,
    }));
    await this.attachOpenOrderIds(items);
    return { items, errors: [] as { exchange: string; message: string }[] };
  }

  /** 本地仍 OPEN 的用户×交易所（合约；现货不走 QueryPosition） */
  async listOpenQueryPositionTargets(userId?: string): Promise<
    Array<{ userId: string; exchange: Exchange }>
  > {
    const where: Prisma.UserPositionWhereInput = {
      status: UserPositionStatus.OPEN,
      qty: { gt: 0 },
      OR: [{ accountType: null }, { NOT: { accountType: { in: ['spot', 'SPOT'] } } }],
    };
    if (userId?.trim()) where.userId = userId.trim();
    const rows = await this.prisma.userPosition.findMany({
      where,
      select: { userId: true, exchange: true },
    });
    const seen = new Set<string>();
    const out: Array<{ userId: string; exchange: Exchange }> = [];
    for (const r of rows) {
      const k = `${r.userId}|${r.exchange}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ userId: r.userId, exchange: r.exchange });
    }
    return out;
  }

  async hasPendingAlignOrders(userId: string, exchange: Exchange): Promise<boolean> {
    const row = await this.prisma.signalFollowLog.findFirst({
      where: {
        userId,
        exchange,
        status: { in: ['PLACED', 'CANCEL_FAILED', 'PENDING'] },
      },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * 用 QueryPosition 整户快照对齐本地 OPEN 仓。
   * 失败 / errorMsg：整户跳过，不把本地改空、不批量废弃。
   * 交易所多出的币跳过；数量/均价不齐覆盖；保证金 0 或没有不覆盖；
   * 本地有而快照没有该仓（币+周期+多空）则废弃本地（DISCARD_LOCAL，不下单、不计利润）。
   */
  async syncLocalPositionsFromQueryPosition(
    userId: string,
    exchange: Exchange,
  ): Promise<{
    ok: boolean;
    skipped?: string;
    overlayQty: number;
    overlayPrice: number;
    overlayLev: number;
    discarded: number;
    matched: number;
    extraSkipped: number;
  }> {
    const empty = {
      ok: false as const,
      overlayQty: 0,
      overlayPrice: 0,
      overlayLev: 0,
      discarded: 0,
      matched: 0,
      extraSkipped: 0,
    };
    if (await this.hasPendingAlignOrders(userId, exchange)) {
      return { ...empty, skipped: 'pending-orders' };
    }
    const localRows = await this.prisma.userPosition.findMany({
      where: {
        userId,
        exchange,
        status: UserPositionStatus.OPEN,
        qty: { gt: 0 },
        OR: [{ accountType: null }, { NOT: { accountType: { in: ['spot', 'SPOT'] } } }],
      },
    });
    if (localRows.length === 0) {
      return { ...empty, ok: true, skipped: 'no-open' };
    }

    let remote: ReturnType<typeof parseQueryPositionPayload>;
    try {
      const account = await this.buildAccount(userId, exchange, 'future');
      const { proxyIP } = await this.resolveProxyIp(userId);
      const { data } = await this.mapi.post<QueryPositionResult>(
        'mapi/QueryPosition',
        { proxyIP, accountType: 'future', account },
        {
          userId,
          exchange,
          proxyIp: proxyIP,
          skipLog: true,
          feature: '用户持仓对齐',
        },
      );
      const err = String((data as any)?.errorMsg || '').trim();
      if (err) {
        this.logger.warn(
          `QueryPosition 失败跳过 user=${userId} ${exchange}: ${err}`,
        );
        return { ...empty, skipped: err };
      }
      remote = parseQueryPositionPayload(data);
    } catch (e: any) {
      this.logger.warn(
        `QueryPosition 异常跳过 user=${userId} ${exchange}: ${e?.message || e}`,
      );
      return { ...empty, skipped: e?.message || 'query-failed' };
    }

    const remoteByKey = new Map<string, (typeof remote)[number]>();
    for (const p of remote) {
      remoteByKey.set(
        queryPositionMatchKey(p.coinName, p.equalCoinName, p.positionSide),
        p,
      );
    }

    let overlayQty = 0;
    let overlayPrice = 0;
    let overlayLev = 0;
    let discarded = 0;
    let matched = 0;
    const now = new Date();

    for (const loc of localRows) {
      const key = queryPositionMatchKey(loc.coinName, loc.equalCoinName, loc.positionSide);
      const hit = remoteByKey.get(key);
      if (!hit) {
        await this.prisma.userPosition.update({
          where: { id: loc.id },
          data: {
            status: UserPositionStatus.CLOSED,
            qty: 0,
            closedAt: now,
            closeKind: 'DISCARD_LOCAL',
            lastCloseFailMsg: '交易所已无该仓，本地废弃（QueryPosition）',
            lastCloseOkAt: null,
            lastCloseOkAmt: null,
            abnormal: false,
            closeRetryStopAt: null,
          },
        });
        discarded += 1;
        continue;
      }
      matched += 1;
      const patch: Prisma.UserPositionUpdateInput = {};
      const locQty = Number(loc.qty);
      const locPx = Number(loc.entryPrice);
      if (numbersDiffer(locQty, hit.positionAmt)) {
        patch.qty = new Prisma.Decimal(hit.positionAmt);
        overlayQty += 1;
      }
      if (hit.openPrice > 0 && numbersDiffer(locPx, hit.openPrice)) {
        patch.entryPrice = new Prisma.Decimal(hit.openPrice);
        overlayPrice += 1;
      }
      let nextLev: number | null = null;
      if (hit.leverage != null && hit.leverage > 0) {
        nextLev = hit.leverage;
      }
      if (nextLev != null) {
        const curLev = loc.leverage != null ? Number(loc.leverage) : NaN;
        if (!Number.isFinite(curLev) || numbersDiffer(curLev, nextLev, 1e-4)) {
          patch.leverage = new Prisma.Decimal(Math.round(nextLev * 1e4) / 1e4);
          overlayLev += 1;
        }
      }
      if (hit.liqPrice != null && hit.liqPrice > 0) {
        const cur = loc.liqPrice != null ? Number(loc.liqPrice) : NaN;
        if (!Number.isFinite(cur) || numbersDiffer(cur, hit.liqPrice)) {
          patch.liqPrice = new Prisma.Decimal(hit.liqPrice);
        }
      }
      if (hit.risk != null && hit.risk > 0) {
        const cur = loc.risk != null ? Number(loc.risk) : NaN;
        if (!Number.isFinite(cur) || numbersDiffer(cur, hit.risk, 1e-8)) {
          patch.risk = new Prisma.Decimal(hit.risk);
        }
      }
      if (Object.keys(patch).length > 0) {
        await this.prisma.userPosition.update({ where: { id: loc.id }, data: patch });
      }
    }

    const extraSkipped = [...remoteByKey.keys()].filter(
      (k) =>
        !localRows.some(
          (loc) =>
            queryPositionMatchKey(loc.coinName, loc.equalCoinName, loc.positionSide) === k,
        ),
    ).length;

    this.logger.log(
      `QueryPosition 对齐 user=${userId} ${exchange} 匹配=${matched} 改数量=${overlayQty} 改均价=${overlayPrice} 改杠杆=${overlayLev} 废弃=${discarded} 交易所多出跳过=${extraSkipped}`,
    );
    return {
      ok: true,
      overlayQty,
      overlayPrice,
      overlayLev,
      discarded,
      matched,
      extraSkipped,
    };
  }

  /** 将本地持仓行映射为 App / 管理端列表结构 */
  private mapUserPositionRow(r: {
    id: string;
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName: string;
    positionSide: string;
    accountType: string | null;
    accountGid: string | null;
    accountName: string | null;
    qty: Prisma.Decimal | number;
    entryPrice: Prisma.Decimal | number;
    leverage: Prisma.Decimal | number | null;
    liqPrice?: Prisma.Decimal | number | null;
    risk?: Prisma.Decimal | number | null;
    openedAt: Date | null;
    closedAt?: Date | null;
    status: UserPositionStatus;
    closeFailCount?: number;
    lastCloseFailAt?: Date | null;
    lastCloseFailAmt?: Prisma.Decimal | number | null;
    lastCloseFailMsg?: string | null;
    lastCloseOkAt?: Date | null;
    lastCloseOkAmt?: Prisma.Decimal | number | null;
    abnormal?: boolean;
    abnormalAt?: Date | null;
    closeRetryStopAt?: Date | null;
    closeKind?: string | null;
  }) {
    const qty = Number(r.qty);
    const entry = Number(r.entryPrice);
    const side = String(r.positionSide || 'long').toLowerCase().includes('short')
      ? 'short'
      : 'long';
    const eq = String(r.equalCoinName || '').toUpperCase();
    const at = String(r.accountType || '').toLowerCase();
    const mode =
      at === 'spot'
        ? '现货'
        : eq === 'PC' || !eq
          ? '永续合约'
          : '交割合约';
    const symbol = eq ? `${r.coinName}/${eq}` : r.coinName;
    const market: 'spot' | 'future' = at === 'spot' ? 'spot' : 'future';
    const isClosed = r.status === UserPositionStatus.CLOSED;
    const mark = isClosed ? null : this.market.getPrice(r.coinName, r.exchange, { market });
    const spec = this.symbols.peek(
      toApiCode(r.exchange, at === 'spot' ? 'spot' : 'future'),
      r.coinName,
      eq || (at === 'spot' ? 'USDT' : 'PC'),
    );
    const markText =
      !isClosed && mark != null && mark > 0 ? formatDisplayPrice(mark, spec) : '';
    let pnl: string | undefined;
    if (
      !isClosed &&
      mark != null &&
      mark > 0 &&
      Number.isFinite(mark) &&
      Number.isFinite(entry) &&
      entry > 0 &&
      qty > 0
    ) {
      const raw = side === 'short' ? (entry - mark) * qty : (mark - entry) * qty;
      pnl = String(Math.round(raw * 1e8) / 1e8);
    }
    // 库里多为空：跟单下单曾默认 5 倍，有落库杠杆则用落库值
    const notional =
      Number.isFinite(entry) && entry > 0 && qty > 0 ? Math.abs(qty * entry) : null;
    const storedLev = r.leverage != null ? Number(r.leverage) : NaN;
    const leverage =
      Number.isFinite(storedLev) && storedLev > 0
        ? storedLev
        : at !== 'spot' && notional != null
          ? 5
          : null;
    const storedLiq = r.liqPrice != null ? Number(r.liqPrice) : null;
    const storedRisk = r.risk != null ? Number(r.risk) : null;
    const liqRaw =
      isClosed || at === 'spot'
        ? null
        : estimateLiquidationPrice({
            liqPrice: storedLiq,
            risk: storedRisk,
            markPrice: mark,
            entryPrice: entry,
            leverage,
            side,
          });
    const liquidationPrice =
      liqRaw != null && liqRaw > 0
        ? formatDisplayPrice(liqRaw, spec) || String(Math.round(liqRaw * 1e8) / 1e8)
        : '—';
    const openTime = r.openedAt ? r.openedAt.toISOString() : '';
    const closeTime = r.closedAt ? r.closedAt.toISOString() : '';
    return {
      id: r.id,
      exchange: r.exchange,
      symbol,
      coinName: r.coinName,
      equalCoinName: eq || null,
      pair: symbol,
      mode,
      accountType: r.accountType || (at === 'spot' ? 'spot' : 'future'),
      accountGid: r.accountGid,
      accountName: r.accountName,
      side,
      amount: String(qty),
      entryPrice:
        Number.isFinite(entry) && entry > 0 ? formatDisplayPrice(entry, spec) || entry : null,
      /** 开仓无标记价时返回 0，便于 UI 直接展示；有价则按规范精度字符串 */
      markPrice: isClosed ? null : markText || 0,
      leverage,
      liquidationPrice,
      margin: '—',
      pnl,
      /** 已实现盈亏（CLOSED 时由 attachClosedExtras 补齐） */
      realizedPnl: null as string | null,
      openTime,
      closeTime,
      holdDuration: r.openedAt ? this.formatHoldDuration(r.openedAt) : '',
      status: r.status,
      abnormal: !!r.abnormal,
      closeFailCount: Number(r.closeFailCount || 0),
      lastCloseFailAt: r.lastCloseFailAt ? r.lastCloseFailAt.toISOString() : null,
      lastCloseFailAmt:
        r.lastCloseFailAmt != null && Number(r.lastCloseFailAmt) > 0
          ? Number(r.lastCloseFailAmt)
          : null,
      lastCloseFailMsg: r.lastCloseFailMsg || null,
      lastCloseOkAt: r.lastCloseOkAt ? r.lastCloseOkAt.toISOString() : null,
      lastCloseOkAmt:
        r.lastCloseOkAmt != null && Number(r.lastCloseOkAmt) > 0
          ? Number(r.lastCloseOkAmt)
          : null,
      abnormalAt: r.abnormalAt ? r.abnormalAt.toISOString() : null,
      closeRetryStopAt: r.closeRetryStopAt ? r.closeRetryStopAt.toISOString() : null,
      closeRetryStopped:
        !!r.abnormal &&
        !!r.closeRetryStopAt &&
        r.closeRetryStopAt.getTime() <= Date.now(),
      /** CLOSED：NORMAL 真实平仓；DISCARD_LOCAL 异常清本地 */
      closeKind: r.closeKind || (isClosed ? 'NORMAL' : null),
      /** 异常清除本地（不计利润、不匹配 ProfitRecord） */
      discardedLocal: r.closeKind === 'DISCARD_LOCAL',
      /** 开仓/平仓成交订单号（attach* 补齐） */
      orderId: null as string | null,
      orderIds: [] as string[],
      /** 最近一笔跟单信号摘要（管理端点击币名展示） */
      lastFollowSignal: null as null | {
        coinName: string | null;
        equalCoinName: string | null;
        signalPrice: any;
        signalAmount: any;
        followAmount: any;
        isOpen: boolean | null;
        signalAtMs: number | null;
        createdAt: string | null;
      },
    };
  }

  /** 从 SignalFollowLog.requestBody 解析跟单信号展示字段 */
  private parseFollowSignalFromLog(log: {
    coinName?: string | null;
    equalCoinName?: string | null;
    isOpen?: boolean | null;
    requestBody?: string | null;
    createdAt?: Date | null;
    filledAmt?: Prisma.Decimal | number | null;
    avgPrice?: Prisma.Decimal | number | null;
  }) {
    let req: any = {};
    try {
      req = log.requestBody ? JSON.parse(log.requestBody) : {};
    } catch {
      req = {};
    }
    const signalAtRaw = req.signalAt ?? req.signal_at;
    let signalAtMs: number | null = null;
    if (signalAtRaw != null && signalAtRaw !== '') {
      const n = Number(signalAtRaw);
      if (Number.isFinite(n)) signalAtMs = n > 1e12 ? n : n > 1e9 ? n * 1000 : n;
    }
    if (signalAtMs == null && log.createdAt) {
      signalAtMs = log.createdAt.getTime();
    }
    return {
      coinName: (log.coinName || req.coinName || null) as string | null,
      equalCoinName: (log.equalCoinName || req.equalCoinName || null) as string | null,
      signalPrice: req.price ?? req.signalPrice ?? (log.avgPrice != null ? Number(log.avgPrice) : null),
      signalAmount: req.signalAmount ?? null,
      followAmount: req.amount ?? (log.filledAmt != null ? Number(log.filledAmt) : null),
      isOpen: log.isOpen != null ? !!log.isOpen : req.isOpen != null ? !!req.isOpen : null,
      signalAtMs,
      createdAt: log.createdAt ? log.createdAt.toISOString() : null,
    };
  }

  /**
   * 管理端点币名时按需查询：该仓未耗尽开仓单号 + 最近一笔跟单摘要。
   * 只打一条用户×币对，可带 requestBody 解析信号价。
   */
  async getOpenFollowDetail(opts: {
    userId: string;
    exchange: string;
    coinName: string;
    equalCoinName?: string;
    positionSide?: string;
  }) {
    const userId = String(opts.userId || '').trim();
    const coinName = String(opts.coinName || '').trim().toUpperCase();
    if (!userId || !coinName) {
      throw new BadRequestException('缺少 userId / coinName');
    }
    const equal = String(opts.equalCoinName || 'PC').trim().toUpperCase() || 'PC';
    const side = String(opts.positionSide || 'long').toLowerCase().includes('short')
      ? 'short'
      : 'long';
    const exchange = String(opts.exchange || '').trim().toUpperCase();

    const logs = await this.prisma.signalFollowLog.findMany({
      where: {
        userId,
        ...(exchange ? { exchange: exchange as Exchange } : {}),
        coinName,
        equalCoinName: equal,
        isOpen: true,
        profitConsumed: false,
        orderId: { not: null },
        OR: [
          { status: 'FILLED' },
          { status: 'CANCELLED', filledAmt: { gt: 0 } },
          { status: 'PLACED', filledAmt: { gt: 0 } },
          { status: 'CANCEL_FAILED', filledAmt: { gt: 0 } },
        ],
      },
      select: {
        orderId: true,
        filledAmt: true,
        consumedAmt: true,
        avgPrice: true,
        isOpen: true,
        coinName: true,
        equalCoinName: true,
        positionSide: true,
        requestBody: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const orderIds: string[] = [];
    let lastFollowSignal: ReturnType<TradeService['parseFollowSignalFromLog']> | null = null;
    for (const log of logs) {
      const filled = Number(log.filledAmt ?? 0);
      const consumed = Number(log.consumedAmt ?? 0);
      if (!(filled - consumed > 1e-12) || !log.orderId) continue;
      const logSide = String(log.positionSide || 'long').toLowerCase().includes('short')
        ? 'short'
        : 'long';
      if (logSide !== side) continue;
      if (!orderIds.includes(log.orderId)) orderIds.push(log.orderId);
      if (!lastFollowSignal) lastFollowSignal = this.parseFollowSignalFromLog(log);
    }

    return {
      orderId: orderIds[0] ?? null,
      orderIds,
      lastFollowSignal,
    };
  }

  /**
   * 为持仓补齐仍未耗尽的开仓成交订单号（来自 SignalFollowLog）。
   * 多笔加仓时 orderIds 为全部，orderId 取最近一笔；并附带最近开仓跟单信号。
   */
  private async attachOpenOrderIds(
    items: Array<{
      userId?: string;
      exchange: Exchange | string;
      coinName?: string | null;
      equalCoinName?: string | null;
      side?: string;
      orderId?: string | null;
      orderIds?: string[];
      lastFollowSignal?: ReturnType<TradeService['parseFollowSignalFromLog']> | null;
    }>,
  ) {
    if (!items.length) return;
    const userIds = [...new Set(items.map((i) => i.userId).filter(Boolean))] as string[];
    if (!userIds.length) return;

    const logs = await this.prisma.signalFollowLog.findMany({
      where: {
        userId: { in: userIds },
        isOpen: true,
        profitConsumed: false,
        orderId: { not: null },
        OR: [
          { status: 'FILLED' },
          { status: 'CANCELLED', filledAmt: { gt: 0 } },
          { status: 'PLACED', filledAmt: { gt: 0 } },
          { status: 'CANCEL_FAILED', filledAmt: { gt: 0 } },
        ],
      },
      select: {
        userId: true,
        exchange: true,
        coinName: true,
        equalCoinName: true,
        positionSide: true,
        orderId: true,
        filledAmt: true,
        consumedAmt: true,
        avgPrice: true,
        isOpen: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 8000,
    });

    const byKey = new Map<string, string[]>();
    const signalByKey = new Map<string, ReturnType<TradeService['parseFollowSignalFromLog']>>();
    for (const log of logs) {
      const filled = Number(log.filledAmt ?? 0);
      const consumed = Number(log.consumedAmt ?? 0);
      if (!(filled - consumed > 1e-12) || !log.orderId) continue;
      const side = String(log.positionSide || 'long').toLowerCase().includes('short')
        ? 'short'
        : 'long';
      const key = [
        log.userId,
        log.exchange,
        String(log.coinName || '').toUpperCase(),
        String(log.equalCoinName || '').toUpperCase(),
        side,
      ].join('|');
      const arr = byKey.get(key) || [];
      if (!arr.includes(log.orderId)) arr.push(log.orderId);
      byKey.set(key, arr);
      if (!signalByKey.has(key)) {
        signalByKey.set(key, this.parseFollowSignalFromLog(log));
      }
    }

    for (const item of items) {
      if (!item.userId) continue;
      const side = String(item.side || 'long').toLowerCase().includes('short') ? 'short' : 'long';
      const key = [
        item.userId,
        item.exchange,
        String(item.coinName || '').toUpperCase(),
        String(item.equalCoinName || '').toUpperCase(),
        side,
      ].join('|');
      const ids = byKey.get(key) || [];
      item.orderIds = ids;
      item.orderId = ids[0] ?? null;
      item.lastFollowSignal = signalByKey.get(key) ?? null;
    }
  }

  private formatHoldDuration(openedAt: Date): string {
    const ms = Math.max(0, Date.now() - openedAt.getTime());
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}天${h}时`;
    if (h > 0) return `${h}时${m}分`;
    return `${Math.max(1, m)}分`;
  }

  /**
   * 已平仓列表：补齐平仓订单号、平仓数量、开仓均价、已实现盈亏（ProfitRecord）。
   * 异常清除本地（closeKind=DISCARD_LOCAL）不计/不展示利润。
   */
  private async attachClosedExtras(
    items: Array<{
      userId?: string;
      exchange: Exchange | string;
      coinName?: string | null;
      equalCoinName?: string | null;
      symbol?: string | null;
      side?: string;
      amount?: string;
      entryPrice?: number | null;
      orderId?: string | null;
      orderIds?: string[];
      realizedPnl?: string | null;
      closeTime?: string;
      closeKind?: string | null;
      discardedLocal?: boolean;
      lastFollowSignal?: ReturnType<TradeService['parseFollowSignalFromLog']> | null;
    }>,
  ) {
    if (!items.length) return;
    const userIds = [
      ...new Set(
        items
          .filter((i) => !i.discardedLocal && i.closeKind !== 'DISCARD_LOCAL')
          .map((i) => i.userId)
          .filter(Boolean),
      ),
    ] as string[];

    for (const item of items) {
      if (item.discardedLocal || item.closeKind === 'DISCARD_LOCAL') {
        item.realizedPnl = null;
        item.orderId = null;
        item.orderIds = [];
      }
    }

    if (!userIds.length) return;

    const [closeLogs, profits, openLots] = await Promise.all([
      this.prisma.signalFollowLog.findMany({
        where: {
          userId: { in: userIds },
          status: 'FILLED',
          isOpen: false,
          orderId: { not: null },
        },
        select: {
          userId: true,
          exchange: true,
          coinName: true,
          equalCoinName: true,
          positionSide: true,
          orderId: true,
          filledAmt: true,
          avgPrice: true,
          isOpen: true,
          requestBody: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.profitRecord.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          exchange: true,
          symbol: true,
          profit: true,
          orderId: true,
          closedAt: true,
        },
        orderBy: { closedAt: 'desc' },
        take: 5000,
      }),
      this.prisma.signalFollowLog.findMany({
        where: {
          userId: { in: userIds },
          isOpen: true,
          OR: [
            { status: 'FILLED' },
            { status: 'CANCELLED', filledAmt: { gt: 0 } },
            { status: 'PLACED', filledAmt: { gt: 0 } },
            { status: 'CANCEL_FAILED', filledAmt: { gt: 0 } },
          ],
        },
        select: {
          userId: true,
          exchange: true,
          coinName: true,
          equalCoinName: true,
          positionSide: true,
          filledAmt: true,
          avgPrice: true,
        },
      }),
    ]);

    const closeByKey = new Map<
      string,
      {
        orderIds: string[];
        filledAmt: number;
        createdAt: Date;
        signal: ReturnType<TradeService['parseFollowSignalFromLog']>;
      }
    >();
    for (const log of closeLogs) {
      if (!log.orderId) continue;
      const side = String(log.positionSide || 'long').toLowerCase().includes('short')
        ? 'short'
        : 'long';
      const key = [
        log.userId,
        log.exchange,
        String(log.coinName || '').toUpperCase(),
        String(log.equalCoinName || '').toUpperCase(),
        side,
      ].join('|');
      const cur = closeByKey.get(key);
      if (!cur) {
        closeByKey.set(key, {
          orderIds: [log.orderId],
          filledAmt: Number(log.filledAmt ?? 0) || 0,
          createdAt: log.createdAt,
          signal: this.parseFollowSignalFromLog(log),
        });
      } else if (!cur.orderIds.includes(log.orderId)) {
        cur.orderIds.push(log.orderId);
      }
    }

    const profitByKey = new Map<string, { profit: string; orderId: string | null; closedAt: Date }[]>();
    for (const p of profits) {
      const key = `${p.userId}|${p.exchange}|${String(p.symbol || '').toUpperCase()}`;
      const arr = profitByKey.get(key) || [];
      arr.push({
        profit: String(p.profit),
        orderId: p.orderId,
        closedAt: p.closedAt,
      });
      profitByKey.set(key, arr);
    }

    const entryByKey = new Map<string, { qty: number; cost: number }>();
    for (const o of openLots) {
      const filled = Number(o.filledAmt ?? 0);
      const px = Number(o.avgPrice ?? 0);
      if (!(filled > 1e-12) || !(Number.isFinite(px) && px > 0)) continue;
      const side = String(o.positionSide || 'long').toLowerCase().includes('short') ? 'short' : 'long';
      const key = [
        o.userId,
        o.exchange,
        String(o.coinName || '').toUpperCase(),
        String(o.equalCoinName || '').toUpperCase(),
        side,
      ].join('|');
      const cur = entryByKey.get(key) || { qty: 0, cost: 0 };
      cur.qty += filled;
      cur.cost += filled * px;
      entryByKey.set(key, cur);
    }

    for (const item of items) {
      if (!item.userId) continue;
      if (item.discardedLocal || item.closeKind === 'DISCARD_LOCAL') continue;
      const side = String(item.side || 'long').toLowerCase().includes('short') ? 'short' : 'long';
      const eq = String(item.equalCoinName || '').toUpperCase();
      const coin = String(item.coinName || '').toUpperCase();
      const posKey = [item.userId, item.exchange, coin, eq, side].join('|');
      const close = closeByKey.get(posKey);
      if (close?.orderIds?.length) {
        item.orderIds = close.orderIds;
        item.orderId = close.orderIds[0] ?? null;
        if (close.filledAmt > 1e-12) {
          item.amount = String(Math.round(close.filledAmt * 1e10) / 1e10);
        }
        item.lastFollowSignal = close.signal;
      }
      if (!(Number(item.entryPrice) > 0)) {
        const lot = entryByKey.get(posKey);
        if (lot && lot.qty > 1e-12 && lot.cost > 0) {
          item.entryPrice = Math.round((lot.cost / lot.qty) * 1e8) / 1e8;
        }
      }

      const symbol = String(item.symbol || (eq ? `${coin}/${eq}` : coin)).toUpperCase();
      const candidates = profitByKey.get(`${item.userId}|${item.exchange}|${symbol}`) || [];
      if (!candidates.length) continue;
      const closeMs = item.closeTime ? Date.parse(item.closeTime) : NaN;
      let best = candidates[0];
      if (Number.isFinite(closeMs)) {
        let bestDiff = Infinity;
        for (const c of candidates) {
          const d = Math.abs(c.closedAt.getTime() - closeMs);
          if (d < bestDiff) {
            bestDiff = d;
            best = c;
          }
        }
      }
      item.realizedPnl = best.profit;
      // 列表字段 pnl 在已平仓语义下也用已实现，避免前端回退读到未实现
      (item as any).pnl = best.profit;
      if (!item.orderId && best.orderId) {
        item.orderId = best.orderId;
        item.orderIds = [best.orderId];
      }
    }
  }

  /**
   * 按开仓成交流水重算并 upsert 本地持仓（幂等）。
   * qty = Σ(filledAmt - consumedAmt)；持仓中均价按剩余量加权。
   * 全平后剩余为 0，均价改为按全部开仓成交量加权（或保留上次有效均价），避免写成 0。
   */
  async syncUserPositionFromLots(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string | null;
    positionSide?: string | null;
  }) {
    const coinName = String(params.coinName || '').trim().toUpperCase();
    if (!coinName) return null;
    const equalCoinName = String(params.equalCoinName || '').trim().toUpperCase();
    const positionSide = String(params.positionSide || 'long')
      .trim()
      .toLowerCase()
      .includes('short')
      ? 'short'
      : 'long';

    const opens = await this.prisma.signalFollowLog.findMany({
      where: {
        userId: params.userId,
        exchange: params.exchange,
        isOpen: true,
        coinName,
        equalCoinName,
        positionSide,
        OR: [
          { status: 'FILLED' },
          { status: 'CANCELLED', filledAmt: { gt: 0 } },
          { status: 'PLACED', filledAmt: { gt: 0 } },
          { status: 'CANCEL_FAILED', filledAmt: { gt: 0 } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        filledAmt: true,
        consumedAmt: true,
        avgPrice: true,
        accountType: true,
        accountGid: true,
        accountName: true,
        createdAt: true,
        profitConsumed: true,
        requestBody: true,
      },
    });

    let qty = 0;
    let cost = 0;
    let filledQty = 0;
    let filledCost = 0;
    let openedAt: Date | null = null;
    let accountType: string | null = null;
    let accountGid: string | null = null;
    let accountName: string | null = null;
    let leverage: number | null = null;

    for (const o of opens) {
      const filled = Number(o.filledAmt ?? 0);
      const consumed = Number(o.consumedAmt ?? 0);
      const px = Number(o.avgPrice ?? 0);
      if (filled > 1e-12) {
        filledQty += filled;
        if (Number.isFinite(px) && px > 0) filledCost += filled * px;
        if (!openedAt || o.createdAt < openedAt) openedAt = o.createdAt;
        accountType = o.accountType || accountType;
        accountGid = o.accountGid || accountGid;
        accountName = o.accountName || accountName;
        if (!(leverage != null && leverage > 0)) {
          try {
            const meta = o.requestBody ? JSON.parse(o.requestBody) : {};
            const lev = Number(meta.leverage ?? meta.leverageType ?? 0);
            if (Number.isFinite(lev) && lev > 0) leverage = lev;
          } catch {
            /* ignore */
          }
        }
      }
      const remain = Math.max(0, filled - consumed);
      if (!(remain > 1e-12)) continue;
      qty += remain;
      if (Number.isFinite(px) && px > 0) cost += remain * px;
    }

    let entryPrice = qty > 1e-12 && cost > 0 ? cost / qty : 0;
    if (!(entryPrice > 0) && filledQty > 1e-12 && filledCost > 0) {
      entryPrice = filledCost / filledQty;
    }
    if (!(entryPrice > 0)) {
      const prev = await this.prisma.userPosition.findUnique({
        where: {
          user_pos_uniq: {
            userId: params.userId,
            exchange: params.exchange,
            coinName,
            equalCoinName,
            positionSide,
          },
        },
        select: { entryPrice: true },
      });
      const prevEntry = Number(prev?.entryPrice ?? 0);
      if (prevEntry > 0) entryPrice = prevEntry;
    }
    const status = qty > 1e-12 ? UserPositionStatus.OPEN : UserPositionStatus.CLOSED;
    const now = new Date();
    const isOpen = status === UserPositionStatus.OPEN;

    return this.prisma.userPosition.upsert({
      where: {
        user_pos_uniq: {
          userId: params.userId,
          exchange: params.exchange,
          coinName,
          equalCoinName,
          positionSide,
        },
      },
      create: {
        userId: params.userId,
        exchange: params.exchange,
        coinName,
        equalCoinName,
        positionSide,
        accountType,
        accountGid,
        accountName,
        qty,
        entryPrice,
        leverage: leverage != null && leverage > 0 ? leverage : undefined,
        status,
        closeKind: isOpen ? null : 'NORMAL',
        openedAt: isOpen ? openedAt || now : null,
        closedAt: isOpen ? null : now,
      },
      update: {
        accountType: accountType ?? undefined,
        accountGid: accountGid ?? undefined,
        accountName: accountName ?? undefined,
        qty,
        entryPrice,
        ...(leverage != null && leverage > 0 ? { leverage } : {}),
        status,
        // 真实成交回写：开仓清空 closeKind；平仓标 NORMAL（覆盖异常清本地，因已有真实配对）
        closeKind: isOpen ? null : 'NORMAL',
        openedAt: isOpen ? openedAt || undefined : undefined,
        closedAt: isOpen ? null : now,
        ...(isOpen
          ? {
              closeFailCount: 0,
              lastCloseFailAt: null,
              lastCloseFailAmt: null,
              lastCloseFailMsg: null,
              lastCloseOkAt: null,
              lastCloseOkAmt: null,
              abnormal: false,
              abnormalAt: null,
              closeRetryStopAt: null,
            }
          : {}),
      },
    });
  }

  /**
   * 本地是否仍有可平持仓（读 user_positions）。
   */
  async hasOpenLocalPosition(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string | null;
    positionSide?: string | null;
  }): Promise<boolean> {
    const qty = await this.getOpenLocalQty(params);
    return qty > 1e-12;
  }

  /**
   * 本地 OPEN 持仓数量；无仓返回 0。
   */
  async getOpenLocalQty(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string | null;
    positionSide?: string | null;
  }): Promise<number> {
    const coinName = String(params.coinName || '').trim().toUpperCase();
    if (!coinName) return 0;
    const equalCoinName = String(params.equalCoinName || '').trim().toUpperCase();
    const positionSide = String(params.positionSide || 'long')
      .trim()
      .toLowerCase()
      .includes('short')
      ? 'short'
      : 'long';
    const row = await this.prisma.userPosition.findFirst({
      where: {
        userId: params.userId,
        exchange: params.exchange,
        coinName,
        equalCoinName,
        positionSide,
        status: UserPositionStatus.OPEN,
        qty: { gt: 0 },
      },
      select: { qty: true },
    });
    const qty = Number(row?.qty ?? 0);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  }

  /**
   * 平仓数量兜底：不超过本地持仓；达到满仓比例（默认 90%）则抬到全平，避免交易所残留碎仓。
   */
  resolveCloseAmount(
    requested: number,
    localQty: number,
    fullCloseRatio = 0.9,
  ): { amount: number; fullClose: boolean; clamped: boolean } {
    const req = Math.abs(Number(requested) || 0);
    const pos = Math.max(0, Number(localQty) || 0);
    if (!(req > 0) || !(pos > 0)) {
      return { amount: req, fullClose: false, clamped: false };
    }
    const ratio = Math.min(1, Math.max(0, Number(fullCloseRatio) || 0.9));
    if (req + 1e-12 >= pos * ratio) {
      return { amount: pos, fullClose: true, clamped: req < pos - 1e-12 };
    }
    if (req > pos) {
      return { amount: pos, fullClose: true, clamped: true };
    }
    return { amount: req, fullClose: false, clamped: false };
  }

  /**
   * 一手/一张对应的币数量。文档：BoardLotSize=每手，为 0 则用 MinAmt。
   * MinSize 是张数，PriceStep 是价格，都不参与此计算。
   */
  private minPlaceQtyFromSpec(spec: {
    boardLotSize?: number | null;
    minAmt?: number | null;
    minSize?: number | null;
  }): number {
    return oneContractCoinAmt(spec);
  }

  private isBelowMinContractError(err: unknown): boolean {
    const msg = String((err as any)?.message || err || '');
    return /至少需一张|委托数量不足|lot size|min (qty|amount|size)|below min/i.test(msg);
  }

  private isWaitMarkPriceError(err: unknown): boolean {
    const msg = String((err as any)?.message || err || '');
    return /未能取得标记价|WAIT_MARK_PRICE/i.test(msg);
  }

  /** 对账市价平：内存没价就跳过，等后台 GetDepth 线程刷到再平 */
  private peekReconcileMark(params: {
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string;
  }): number {
    return (
      Number(
        this.market.resolveDepthMark({
          exchange: params.exchange,
          coinName: params.coinName,
          accountType: accountTypeFromEqualCoin(params.equalCoinName || 'PC'),
        }),
      ) || 0
    );
  }

  /** 中间件已拒过的「不够一张」：同一差额不再打 PlaceOrder */
  private exchangeMinFloor = new Map<string, { amt: number; at: number }>();
  private static readonly EXCHANGE_MIN_FLOOR_TTL_MS = 6 * 60 * 60_000;

  private exchangeMinFloorKey(params: {
    userId: string;
    coinName: string;
    positionSide: string;
    kind: 'excess' | 'orphan';
  }): string {
    return `${params.userId}:${params.coinName}:${params.positionSide}:${params.kind}`;
  }

  private rememberedBelowMinAmt(key: string): number {
    const hit = this.exchangeMinFloor.get(key);
    if (!hit) return 0;
    if (Date.now() - hit.at > TradeService.EXCHANGE_MIN_FLOOR_TTL_MS) {
      this.exchangeMinFloor.delete(key);
      return 0;
    }
    return hit.amt;
  }

  private rememberExchangeBelowMin(key: string, amount: number) {
    if (!(amount > 0)) return;
    const prev = this.rememberedBelowMinAmt(key);
    this.exchangeMinFloor.set(key, {
      amt: Math.max(prev, amount),
      at: Date.now(),
    });
  }

  private async resolveMinPlaceQty(params: {
    exchange: Exchange;
    coinName: string;
    equalCoinName: string;
  }): Promise<number> {
    try {
      const spec = await this.resolveSymbolSpec(params.exchange, {
        coinName: params.coinName,
        equalCoinName: params.equalCoinName,
        accountType: accountTypeFromEqualCoin(params.equalCoinName),
        symbol: `${params.coinName}/${params.equalCoinName}`,
      });
      return this.minPlaceQtyFromSpec(spec);
    } catch {
      return 0;
    }
  }

  /** 按交易对步进/一张下取整，得到可传 PlaceOrder 的干净数量 */
  async snapPlaceQty(params: {
    exchange: Exchange;
    coinName?: string;
    equalCoinName?: string;
    accountType?: string;
    symbol?: string;
    apiCode?: string;
    amount: number;
  }): Promise<number> {
    const amount = Number(params.amount);
    if (!(amount > 0)) return 0;
    try {
      const accountType =
        params.accountType || accountTypeFromEqualCoin(params.equalCoinName || 'PC');
      const spec = await this.resolveSymbolSpec(params.exchange, {
        apiCode: params.apiCode,
        coinName: params.coinName,
        equalCoinName: params.equalCoinName,
        symbol: params.symbol,
        accountType,
      });
      return snapCoinAmt(amount, spec);
    } catch {
      return 0;
    }
  }

  /**
   * 按交易对规范判断委托量是否不够一张 / 不够 minAmt 整数倍。
   * 够才允许打 PlaceOrder；不够是正常情况，调用方应静默跳过。
   */
  async isBelowMinPlaceQty(params: {
    exchange: Exchange;
    coinName?: string;
    equalCoinName?: string;
    accountType?: string;
    symbol?: string;
    apiCode?: string;
    amount: number;
  }): Promise<boolean> {
    const amount = Number(params.amount);
    if (!(amount > 0)) return true;
    try {
      const accountType =
        params.accountType || accountTypeFromEqualCoin(params.equalCoinName || 'PC');
      const spec = await this.resolveSymbolSpec(params.exchange, {
        apiCode: params.apiCode,
        coinName: params.coinName,
        equalCoinName: params.equalCoinName,
        symbol: params.symbol,
        accountType,
      });
      const snapped = snapCoinAmt(amount, spec);
      if (!(snapped > 0)) return true;
      return isFuturesAccountType(accountType) && !isAtLeastOneContract(snapped, spec);
    } catch {
      return false;
    }
  }

  /** 对账容差：本地 ≤ 应有量 × (1+tol) 则不纠；与跟单 ≥90% 全平同一 10% 带宽 */
  static readonly RECONCILE_TOLERANCE = 0.1;
  private reconcileInFlight = new Set<string>();
  private positionsCache = new Map<
    string,
    { at: number; rows: ReturnType<TradeService['parseSignalPositions']> }
  >();
  private static readonly POSITIONS_CACHE_TTL_MS = 5_000;

  /**
   * 解析 mapi/Positions data：key = apiCode_币_周期_long|short → PositionSize / PositionPrice
   */
  parseSignalPositions(data: any): Array<{
    key: string;
    apiCode: string;
    coinName: string;
    equalCoinName: string;
    positionSide: 'long' | 'short';
    exchange?: Exchange;
    size: number;
    price: number;
  }> {
    const root =
      data && typeof data === 'object' && 'data' in data && !Array.isArray((data as any).data)
        ? (data as any).data
        : data;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return [];
    const out: Array<{
      key: string;
      apiCode: string;
      coinName: string;
      equalCoinName: string;
      positionSide: 'long' | 'short';
      exchange?: Exchange;
      size: number;
      price: number;
    }> = [];
    for (const key of Object.keys(root)) {
      const parts = key.split('_');
      if (parts.length < 4) continue;
      const apiCode = parts[0];
      const sideRaw = parts[parts.length - 1].toLowerCase();
      if (sideRaw !== 'long' && sideRaw !== 'short') continue;
      const equalCoinName = parts[parts.length - 2].toUpperCase();
      const coinName = parts.slice(1, parts.length - 2).join('_').toUpperCase();
      if (!coinName) continue;
      const raw = root[key] || {};
      const size = Number(raw.PositionSize ?? raw.positionSize ?? raw.size ?? 0);
      const price = Number(raw.PositionPrice ?? raw.positionPrice ?? raw.price ?? 0);
      out.push({
        key,
        apiCode,
        coinName,
        equalCoinName,
        positionSide: sideRaw,
        exchange: fromApiCode(apiCode),
        size: Number.isFinite(size) ? size : 0,
        price: Number.isFinite(price) ? price : 0,
      });
    }
    return out;
  }

  /** GET mapi/Positions?AccountGID= 信号账户持仓（短缓存，全量对账复用） */
  async fetchSignalPositions(
    accountGid: string,
    opts?: { skipLog?: boolean; bypassCache?: boolean },
  ): Promise<ReturnType<TradeService['parseSignalPositions']>> {
    const gid = String(accountGid || '').trim();
    if (!gid) return [];
    if (!opts?.bypassCache) {
      const hit = this.positionsCache.get(gid);
      if (hit && Date.now() - hit.at < TradeService.POSITIONS_CACHE_TTL_MS) {
        return hit.rows;
      }
    }
    const { data } = await this.mapi.get(
      `mapi/Positions?AccountGID=${encodeURIComponent(gid)}`,
      {
        skipLog: opts?.skipLog !== false,
        feature: '信号持仓',
      },
    );
    const rows = this.parseSignalPositions(data);
    this.positionsCache.set(gid, { at: Date.now(), rows });
    return rows;
  }

  /** 用户对该信号账户的开仓比例 = investAmount / maxPrincipal */
  async resolveOpenRatio(
    userId: string,
    exchange: Exchange,
    accountGid: string,
  ): Promise<number | null> {
    const gid = String(accountGid || '').trim();
    if (!gid) return null;
    const cfg = await this.prisma.userFollowConfig.findFirst({
      where: {
        userId,
        exchange,
        template: { accountGid: gid },
      },
      select: {
        investAmount: true,
        template: { select: { maxPrincipal: true } },
      },
    });
    const invest = Number(cfg?.investAmount ?? 0);
    const maxP = Number(cfg?.template?.maxPrincipal ?? 0);
    if (!(invest > 0) || !(maxP > 0)) return null;
    return invest / maxP;
  }

  private reconcileLockKey(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName: string;
    positionSide: string;
  }) {
    return [
      params.userId,
      params.exchange,
      params.coinName,
      params.equalCoinName,
      params.positionSide,
    ].join('|');
  }

  private symbolReconcileKey(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName: string;
  }) {
    return [
      params.userId,
      params.exchange,
      params.coinName,
      params.equalCoinName,
      '*',
    ].join('|');
  }

  /**
   * 平仓单 EXPIRED / 外部撤单后异步对账（该用户 + 该币两侧）。
   * 反向开仓场景会先清与信号不一致的旧方向，再按最新 Positions 校准。
   */
  scheduleReconcileAfterCloseCancel(params: {
    userId: string;
    exchange: Exchange;
    coinName?: string | null;
    equalCoinName?: string | null;
    positionSide?: string | null;
    accountGid?: string | null;
    reason?: string;
  }) {
    const coinName = String(params.coinName || '').trim().toUpperCase();
    if (!coinName) return;
    const equalCoinName = String(params.equalCoinName || 'PC').trim().toUpperCase() || 'PC';
    void this.reconcileUserSymbol({
      userId: params.userId,
      exchange: params.exchange,
      coinName,
      equalCoinName,
      accountGid: params.accountGid || undefined,
      reason: params.reason || 'close-cancel',
    }).catch((e: any) =>
      this.logger.warn(
        `平仓撤单后对账失败 user=${params.userId} ${coinName}: ${e?.message || e}`,
      ),
    );
  }

  /**
   * 同币双侧对账：先独有强平（信号已无该方向 / 反向残留），再多的平。
   * 覆盖「平仓未成 → 信号已反向开仓 → 对账按最新 Positions 清旧仓」的闭环。
   */
  async reconcileUserSymbol(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string;
    accountGid?: string;
    reason?: string;
  }): Promise<{
    actions: Array<{
      positionSide: string;
      action: string;
      message?: string;
      closeAmt?: number;
    }>;
    orphan: number;
    excess: number;
    noop: number;
    skipped: number;
  }> {
    const coinName = String(params.coinName || '').trim().toUpperCase();
    const equalCoinName = String(params.equalCoinName || 'PC').trim().toUpperCase() || 'PC';
    const symLock = this.symbolReconcileKey({
      userId: params.userId,
      exchange: params.exchange,
      coinName,
      equalCoinName,
    });
    if (this.reconcileInFlight.has(symLock)) {
      return { actions: [], orphan: 0, excess: 0, noop: 0, skipped: 1 };
    }
    this.reconcileInFlight.add(symLock);

    const stats = {
      actions: [] as Array<{
        positionSide: string;
        action: string;
        message?: string;
        closeAmt?: number;
      }>,
      orphan: 0,
      excess: 0,
      noop: 0,
      skipped: 0,
    };

    try {
      const locals = await this.prisma.userPosition.findMany({
        where: {
          userId: params.userId,
          exchange: params.exchange,
          coinName,
          equalCoinName,
          status: UserPositionStatus.OPEN,
          qty: { gt: 0 },
        },
        select: {
          positionSide: true,
          accountGid: true,
          qty: true,
        },
      });
      if (!locals.length) {
        return stats;
      }

      const accountGid = String(
        params.accountGid || locals.find((l) => l.accountGid)?.accountGid || '',
      ).trim();
      if (!accountGid) {
        stats.skipped = locals.length;
        return stats;
      }

      let signalRows: ReturnType<TradeService['parseSignalPositions']> = [];
      try {
        signalRows = await this.fetchSignalPositions(accountGid, { skipLog: true });
      } catch (e: any) {
        this.logger.warn(
          `同币对账拉 Positions 失败 gid=${accountGid}: ${e?.message || e}`,
        );
        stats.skipped = locals.length;
        return stats;
      }

      const eps = 1e-8;
      const classified = locals.map((row) => {
        const positionSide = String(row.positionSide || 'long')
          .toLowerCase()
          .includes('short')
          ? 'short'
          : 'long';
        const match = signalRows.find(
          (r) =>
            r.coinName === coinName &&
            r.equalCoinName === equalCoinName &&
            r.positionSide === positionSide &&
            (!r.exchange || r.exchange === params.exchange),
        );
        const signalSize = match ? Math.max(0, match.size) : 0;
        return {
          positionSide,
          signalSize,
          orphan: signalSize <= eps,
        };
      });

      // 先清与信号不一致的旧方向，再校准信号仍有仓的一侧
      classified.sort((a, b) => Number(b.orphan) - Number(a.orphan));

      if (classified.some((c) => c.orphan) && classified.length > 1) {
        this.logger.log(
          `同币对账优先清不一致方向 reason=${params.reason || '-'} user=${params.userId} ` +
            `${coinName}/${equalCoinName} sides=${classified
              .map((c) => `${c.positionSide}${c.orphan ? '(orphan)' : ''}`)
              .join(',')}`,
        );
      }

      for (const c of classified) {
        try {
          const res = await this.reconcileUserPosition({
            userId: params.userId,
            exchange: params.exchange,
            coinName,
            equalCoinName,
            positionSide: c.positionSide,
            accountGid,
            reason: params.reason,
          });
          stats.actions.push({
            positionSide: c.positionSide,
            action: res.action,
            message: res.message,
            closeAmt: res.closeAmt,
          });
          if (res.action === 'orphan_close') stats.orphan++;
          else if (res.action === 'excess_close') stats.excess++;
          else if (res.action === 'skip') stats.skipped++;
          else stats.noop++;
        } catch (e: any) {
          stats.skipped++;
          stats.actions.push({
            positionSide: c.positionSide,
            action: 'error',
            message: e?.message || String(e),
          });
          // 平仓失败已记在仓上（本轮首次一条，之后只改时间），这里不再刷屏
        }
      }
      return stats;
    } finally {
      this.reconcileInFlight.delete(symLock);
    }
  }

  /**
   * 单仓对账：独有强平 + 多的平（约 10% 容差），市价；不做少的补。
   */
  async reconcileUserPosition(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string;
    positionSide: string;
    accountGid?: string;
    reason?: string;
  }): Promise<{
    action: 'skip' | 'orphan_close' | 'excess_close' | 'noop';
    localQty?: number;
    expected?: number;
    signalSize?: number;
    closeAmt?: number;
    message?: string;
  }> {
    const coinName = String(params.coinName || '').trim().toUpperCase();
    const equalCoinName = String(params.equalCoinName || 'PC').trim().toUpperCase() || 'PC';
    const positionSide = String(params.positionSide || 'long')
      .trim()
      .toLowerCase()
      .includes('short')
      ? 'short'
      : 'long';
    const lock = this.reconcileLockKey({
      userId: params.userId,
      exchange: params.exchange,
      coinName,
      equalCoinName,
      positionSide,
    });
    if (this.reconcileInFlight.has(lock)) {
      return { action: 'skip', message: 'in-flight' };
    }
    this.reconcileInFlight.add(lock);
    try {
      const pos = await this.prisma.userPosition.findFirst({
        where: {
          userId: params.userId,
          exchange: params.exchange,
          coinName,
          equalCoinName,
          positionSide,
          status: UserPositionStatus.OPEN,
          qty: { gt: 0 },
        },
      });
      if (!pos) {
        return { action: 'noop', localQty: 0, message: 'no-local-open' };
      }
      const localQty = Number(pos.qty);
      if (!(localQty > 0)) {
        return { action: 'noop', localQty: 0, message: 'qty-zero' };
      }

      const accountGid = String(params.accountGid || pos.accountGid || '').trim();
      if (!accountGid) {
        return { action: 'skip', localQty, message: 'no-accountGid' };
      }

      let signalSize = 0;
      try {
        const signalRows = await this.fetchSignalPositions(accountGid, { skipLog: true });
        const match = signalRows.find(
          (r) =>
            r.coinName === coinName &&
            r.equalCoinName === equalCoinName &&
            r.positionSide === positionSide &&
            (!r.exchange || r.exchange === params.exchange),
        );
        signalSize = match ? Math.max(0, match.size) : 0;
      } catch (e: any) {
        this.logger.warn(
          `对账拉 Positions 失败 gid=${accountGid}: ${e?.message || e}`,
        );
        return { action: 'skip', localQty, message: `positions-error:${e?.message || e}` };
      }

      const openRatio = await this.resolveOpenRatio(params.userId, params.exchange, accountGid);
      const eps = 1e-8;
      const tol = TradeService.RECONCILE_TOLERANCE;

      // 信号无仓 / Size≈0 → 独有强平（不依赖比例）；反向后旧方向走这里
      if (signalSize <= eps) {
        const minQty = await this.resolveMinPlaceQty({
          exchange: params.exchange,
          coinName,
          equalCoinName,
        });
        const orphanKey = this.exchangeMinFloorKey({
          userId: params.userId,
          coinName,
          positionSide,
          kind: 'orphan',
        });
        const orphanFloor = this.rememberedBelowMinAmt(orphanKey);
        const orphanAmt = await this.snapPlaceQty({
          exchange: params.exchange,
          coinName,
          equalCoinName,
          symbol: `${coinName}/${equalCoinName}`,
          amount: localQty,
        });
        if (
          !(orphanAmt > eps) ||
          (minQty > 0 && orphanAmt + 1e-12 < minQty) ||
          (orphanFloor > 0 && orphanAmt <= orphanFloor + 1e-12)
        ) {
          return {
            action: 'skip',
            localQty,
            signalSize,
            closeAmt: orphanAmt,
            message: 'below-min-contract',
          };
        }
        if (!(this.peekReconcileMark({ exchange: params.exchange, coinName, equalCoinName }) > 0)) {
          return {
            action: 'skip',
            localQty,
            signalSize,
            closeAmt: orphanAmt,
            message: 'wait-mark-price',
          };
        }
        try {
          await this.adminClosePosition({
            userId: params.userId,
            exchange: params.exchange,
            coinName,
            equalCoinName,
            positionSide,
            amount: orphanAmt,
            accountType: accountTypeFromEqualCoin(equalCoinName),
            accountGid,
            accountName: pos.accountName || undefined,
            source: 'RECONCILE_ORPHAN',
            remark: `信号账户已空仓对账市价强平(${params.reason || 'reconcile'})`,
          });
        } catch (e: any) {
          if (this.isWaitMarkPriceError(e)) {
            return {
              action: 'skip',
              localQty,
              signalSize,
              closeAmt: orphanAmt,
              message: 'wait-mark-price',
            };
          }
          if (this.isBelowMinContractError(e)) {
            this.rememberExchangeBelowMin(orphanKey, orphanAmt);
            return {
              action: 'skip',
              localQty,
              signalSize,
              closeAmt: orphanAmt,
              message: 'below-min-contract',
            };
          }
          throw e;
        }
        return {
          action: 'orphan_close',
          localQty,
          expected: 0,
          signalSize: 0,
          closeAmt: orphanAmt,
        };
      }

      if (openRatio == null || !(openRatio > 0)) {
        return {
          action: 'skip',
          localQty,
          signalSize,
          message: 'no-openRatio',
        };
      }

      const expected = signalSize * openRatio;
      // 容差内：不纠
      if (localQty <= expected * (1 + tol) + eps) {
        return {
          action: 'noop',
          localQty,
          expected,
          signalSize,
          message: 'within-tolerance',
        };
      }

      const excess = localQty - expected;
      const resolved = this.resolveCloseAmount(excess, localQty, 0.9);
      if (!(resolved.amount > eps)) {
        return { action: 'noop', localQty, expected, signalSize, message: 'excess-too-small' };
      }

      const closeAmt = await this.snapPlaceQty({
        exchange: params.exchange,
        coinName,
        equalCoinName,
        symbol: `${coinName}/${equalCoinName}`,
        amount: resolved.amount,
      });
      const minQty = await this.resolveMinPlaceQty({
        exchange: params.exchange,
        coinName,
        equalCoinName,
      });
      const excessKey = this.exchangeMinFloorKey({
        userId: params.userId,
        coinName,
        positionSide,
        kind: 'excess',
      });
      const excessFloor = this.rememberedBelowMinAmt(excessKey);
      if (
        !(closeAmt > eps) ||
        (minQty > 0 && closeAmt + 1e-12 < minQty) ||
        (excessFloor > 0 && closeAmt <= excessFloor + 1e-12)
      ) {
        return {
          action: 'skip',
          localQty,
          expected,
          signalSize,
          closeAmt,
          message: 'below-min-contract',
        };
      }
      if (!(this.peekReconcileMark({ exchange: params.exchange, coinName, equalCoinName }) > 0)) {
        return {
          action: 'skip',
          localQty,
          expected,
          signalSize,
          closeAmt,
          message: 'wait-mark-price',
        };
      }

      try {
        await this.adminClosePosition({
          userId: params.userId,
          exchange: params.exchange,
          coinName,
          equalCoinName,
          positionSide,
          amount: closeAmt,
          accountType: accountTypeFromEqualCoin(equalCoinName),
          accountGid,
          accountName: pos.accountName || undefined,
          source: 'RECONCILE_EXCESS',
          remark: `本地偏多对账市价平差额(${params.reason || 'reconcile'})`,
        });
      } catch (e: any) {
        if (this.isWaitMarkPriceError(e)) {
          return {
            action: 'skip',
            localQty,
            expected,
            signalSize,
            closeAmt,
            message: 'wait-mark-price',
          };
        }
        if (this.isBelowMinContractError(e)) {
          this.rememberExchangeBelowMin(excessKey, closeAmt);
          return {
            action: 'skip',
            localQty,
            expected,
            signalSize,
            closeAmt,
            message: 'below-min-contract',
          };
        }
        throw e;
      }
      return {
        action: 'excess_close',
        localQty,
        expected,
        signalSize,
        closeAmt,
      };
    } finally {
      this.reconcileInFlight.delete(lock);
    }
  }

  /**
   * 全量 OPEN 仓对账（定时兜底）：按用户+币分组，先清不一致方向再校准。
   */
  async reconcileAllOpenPositions(reason = 'cron'): Promise<{
    scanned: number;
    groups: number;
    orphan: number;
    excess: number;
    noop: number;
    skipped: number;
    errors: number;
  }> {
    const rows = await this.prisma.userPosition.findMany({
      where: {
        status: UserPositionStatus.OPEN,
        qty: { gt: 0 },
        accountGid: { not: null },
        abnormal: false,
      },
      take: 500,
      orderBy: { updatedAt: 'asc' },
      select: {
        userId: true,
        exchange: true,
        coinName: true,
        equalCoinName: true,
        accountGid: true,
      },
    });

    const groupMap = new Map<
      string,
      {
        userId: string;
        exchange: Exchange;
        coinName: string;
        equalCoinName: string;
        accountGid?: string;
      }
    >();
    for (const row of rows) {
      const key = [
        row.userId,
        row.exchange,
        row.coinName,
        row.equalCoinName,
      ].join('|');
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          userId: row.userId,
          exchange: row.exchange,
          coinName: row.coinName,
          equalCoinName: row.equalCoinName,
          accountGid: row.accountGid || undefined,
        });
      }
    }

    const stats = {
      scanned: rows.length,
      groups: groupMap.size,
      orphan: 0,
      excess: 0,
      noop: 0,
      skipped: 0,
      errors: 0,
    };

    for (const g of groupMap.values()) {
      try {
        const res = await this.reconcileUserSymbol({
          userId: g.userId,
          exchange: g.exchange,
          coinName: g.coinName,
          equalCoinName: g.equalCoinName,
          accountGid: g.accountGid,
          reason,
        });
        stats.orphan += res.orphan;
        stats.excess += res.excess;
        stats.noop += res.noop;
        stats.skipped += res.skipped;
      } catch (e: any) {
        stats.errors++;
        this.logger.warn(
          `全量对账分组失败 user=${g.userId} ${g.coinName}: ${e?.message || e}`,
        );
      }
    }

    if (stats.errors) {
      this.logger.warn(
        `仓位对账(${reason}): scanned=${stats.scanned} groups=${stats.groups} ` +
          `orphan=${stats.orphan} excess=${stats.excess} noop=${stats.noop} ` +
          `skipped=${stats.skipped} errors=${stats.errors}`,
      );
    }
    return stats;
  }

  /**
   * 异常持仓限频重试平仓（默认每 5 分钟由 Worker 调用）。
   * 超过 closeRetryStopAt 后不再自动尝试，仅保留列表供人工清除。
   */
  async reconcileAbnormalOpenPositions(reason = 'abnormal-cron'): Promise<{
    scanned: number;
    tried: number;
    ok: number;
    failed: number;
    skipped: number;
  }> {
    const now = new Date();
    const minGapMs = Math.max(
      60_000,
      Number(process.env.POSITION_ABNORMAL_RETRY_MS || 5 * 60_000),
    );
    const rows = await this.prisma.userPosition.findMany({
      where: {
        status: UserPositionStatus.OPEN,
        qty: { gt: 0 },
        abnormal: true,
        OR: [{ closeRetryStopAt: null }, { closeRetryStopAt: { gt: now } }],
      },
      take: 200,
      orderBy: { lastCloseFailAt: 'asc' },
    });
    const stats = { scanned: rows.length, tried: 0, ok: 0, failed: 0, skipped: 0 };
    for (const row of rows) {
      if (
        row.lastCloseFailAt &&
        now.getTime() - row.lastCloseFailAt.getTime() < minGapMs
      ) {
        stats.skipped++;
        continue;
      }
      stats.tried++;
      try {
        await this.reconcileUserPosition({
          userId: row.userId,
          exchange: row.exchange,
          coinName: row.coinName,
          equalCoinName: row.equalCoinName,
          positionSide: row.positionSide,
          accountGid: row.accountGid || undefined,
          reason,
        });
        stats.ok++;
      } catch (e: any) {
        stats.failed++;
        this.logger.warn(
          `异常持仓重试失败 id=${row.id} ${row.coinName} ${row.positionSide}: ${e?.message || e}`,
        );
      }
    }
    if (stats.scanned > 0) {
      this.logger.log(
        `异常持仓重试(${reason}): scanned=${stats.scanned} tried=${stats.tried} ok=${stats.ok} fail=${stats.failed} skip=${stats.skipped}`,
      );
    }
    return stats;
  }

  /**
   * 从 SignalFollowLog 未耗尽开仓回填 user_positions（仅管理端手动）。
   * 启动时不要调用：重启以 QueryPosition 为准，避免流水覆盖已对齐的数量/均价。
   */
  async backfillUserPositionsFromLogs(reason = 'manual') {
    if (this.backfillRunning) {
      return { skipped: true as const, reason: 'already-running' };
    }
    this.backfillRunning = true;
    try {
      const opens = await this.prisma.signalFollowLog.findMany({
        where: {
          isOpen: true,
          profitConsumed: false,
          coinName: { not: null },
          OR: [
            { status: 'FILLED' },
            { status: 'CANCELLED', filledAmt: { gt: 0 } },
            { status: 'PLACED', filledAmt: { gt: 0 } },
            { status: 'CANCEL_FAILED', filledAmt: { gt: 0 } },
          ],
        },
        select: {
          userId: true,
          exchange: true,
          coinName: true,
          equalCoinName: true,
          positionSide: true,
        },
      });
      const keys = new Map<string, {
        userId: string;
        exchange: Exchange;
        coinName: string;
        equalCoinName: string;
        positionSide: string;
      }>();
      for (const o of opens) {
        const coin = String(o.coinName || '').toUpperCase();
        if (!coin) continue;
        const eq = String(o.equalCoinName || '').toUpperCase();
        const side = String(o.positionSide || 'long').toLowerCase().includes('short')
          ? 'short'
          : 'long';
        const k = `${o.userId}|${o.exchange}|${coin}|${eq}|${side}`;
        if (!keys.has(k)) {
          keys.set(k, {
            userId: o.userId,
            exchange: o.exchange,
            coinName: coin,
            equalCoinName: eq,
            positionSide: side,
          });
        }
      }
      let upserted = 0;
      for (const p of keys.values()) {
        await this.syncUserPositionFromLots(p);
        upserted++;
      }
      this.logger.log(
        `持仓回填完成 reason=${reason} keys=${keys.size} upserted=${upserted}`,
      );
      return { ok: true as const, keys: keys.size, upserted };
    } catch (e: any) {
      this.logger.warn(`持仓回填失败 reason=${reason}: ${e?.message || e}`);
      return { ok: false as const, error: e?.message || String(e) };
    } finally {
      this.backfillRunning = false;
    }
  }

  /** 只读后台线程已缓存的盘口中间价，不现场打 GetDepth */
  async getDepth(_symbol?: string, _exchange?: Exchange) {
    const map = this.market.cachedDepthMap();
    if (!map) {
      throw new ServiceUnavailableException('盘口缓存未就绪，请稍后重试');
    }
    return map;
  }

  async lastOrderRecords() {
    try {
      const { data } = await this.mapi.get('mapi/LastOrderRecords', { skipLog: true });
      return data;
    } catch (e: any) {
      throw new ServiceUnavailableException(e?.message || '拉取信号失败');
    }
  }

  /** 中间件基础地址 / ServiceKey（跟单不再依赖单一主账户配置） */
  async getMiddlewareConfig() {
    const base = await this.mapi.getMiddlewareConfig();
    const account = await this.getSignalAccountConfig();
    return { ...base, ...account };
  }

  async setMiddlewareConfig(params: {
    base: string;
    serviceKey?: string;
    accountGid?: string;
    accountName?: string;
  }) {
    await this.mapi.setMiddlewareConfig({
      base: params.base,
      serviceKey: params.serviceKey,
    });
    if (params.accountGid !== undefined) {
      await this.setSignalAccount(params.accountGid, params.accountName);
    }
    return this.getMiddlewareConfig();
  }

  private static readonly CFG_ACCOUNT_GID = 'trade_middleware_account_gid';
  private static readonly CFG_ACCOUNT_NAME = 'trade_middleware_account_name';

  async getSignalAccountConfig() {
    const gidRow = await this.prisma.systemConfig.findUnique({
      where: { key: TradeService.CFG_ACCOUNT_GID },
    });
    const nameRow = await this.prisma.systemConfig.findUnique({
      where: { key: TradeService.CFG_ACCOUNT_NAME },
    });
    return {
      accountGid: gidRow?.value?.trim() || '',
      accountName: nameRow?.value?.trim() || '',
      accountGidFromDb: !!gidRow?.value?.trim(),
    };
  }

  async setSignalAccount(gid: string, name?: string) {
    const g = String(gid || '').trim();
    if (!g) {
      await this.prisma.systemConfig.deleteMany({
        where: {
          key: {
            in: [TradeService.CFG_ACCOUNT_GID, TradeService.CFG_ACCOUNT_NAME],
          },
        },
      });
      return this.getSignalAccountConfig();
    }
    await this.prisma.systemConfig.upsert({
      where: { key: TradeService.CFG_ACCOUNT_GID },
      create: {
        key: TradeService.CFG_ACCOUNT_GID,
        value: g,
        remark: '跟单信号主账户 GID (MultiAccountList.value)',
      },
      update: { value: g },
    });
    const n = String(name || '').trim();
    if (n) {
      await this.prisma.systemConfig.upsert({
        where: { key: TradeService.CFG_ACCOUNT_NAME },
        create: {
          key: TradeService.CFG_ACCOUNT_NAME,
          value: n,
          remark: '跟单信号主账户名称',
        },
        update: { value: n },
      });
    }
    return this.getSignalAccountConfig();
  }

  /**
   * 解析跟单用主账户 GID：
   * 1) 后台已配置 → 用配置
   * 2) 未配置且 MultiAccountList 仅 1 个 → 自动用该账户
   * 3) 否则 null（多账户未选 / 拉列表失败）
   */
  async resolveSignalAccountGid(): Promise<{
    gid: string;
    name: string;
    source: 'config' | 'auto';
  } | null> {
    const cfg = await this.getSignalAccountConfig();
    if (cfg.accountGid) {
      return {
        gid: cfg.accountGid,
        name: cfg.accountName || cfg.accountGid,
        source: 'config',
      };
    }
    try {
      const { items } = await this.multiAccountList();
      if (items.length === 1) {
        const only = items[0];
        const gid = String(only.value ?? only.gid ?? '').trim();
        if (!gid) return null;
        return {
          gid,
          name: String(only.name || gid),
          source: 'auto',
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** 中间件连通性测试 (mapi/Test) */
  async middlewareTest() {
    const base = await this.mapi.resolveBaseUrl();
    const started = Date.now();
    try {
      const { data, statusCode, latencyMs } = await this.mapi.get('mapi/Test', {
        feature: '连通性测试',
      });
      return {
        ok: true,
        latencyMs: latencyMs ?? Date.now() - started,
        base,
        statusCode,
        data: data ?? null,
        message: null as string | null,
        responseBody: null as any,
      };
    } catch (e: any) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        base,
        statusCode: e?.statusCode ?? null,
        data: null,
        message: e?.message || '连接失败',
        responseBody: e?.responseBody ?? null,
      };
    }
  }

  /** 后台刷新 MultiAccountList 写入内存；失败保留旧缓存。 */
  private async refreshAccountListCache(): Promise<{ items: any[] }> {
    if (this.accountListInflight) return this.accountListInflight;
    this.accountListInflight = (async () => {
      try {
        const { data } = await this.mapi.get('mapi/MultiAccountList', { skipLog: true });
        const items = Array.isArray(data) ? data : [];
        this.accountListCache = { items, fetchedAt: Date.now() };
        this.logger.log(`中间件账户列表已缓存: ${items.length} 个`);
        return { items };
      } catch (e: any) {
        this.logger.warn(`刷新账户列表失败: ${e?.message || e}`);
        return { items: this.accountListCache?.items ?? [] };
      } finally {
        this.accountListInflight = null;
      }
    })();
    return this.accountListInflight;
  }

  /**
   * 主账户列表：请求只读内存缓存（1 分钟后台自动刷新）。
   * force=true 时才同步打中间件（管理端「拉取账户列表」）。
   */
  async multiAccountList(opts?: { skipLog?: boolean; force?: boolean }) {
    if (opts?.force) {
      return this.refreshAccountListCache();
    }
    if (!this.accountListCache) {
      return this.refreshAccountListCache();
    }
    if (Date.now() - this.accountListCache.fetchedAt >= this.accountListTtlMs()) {
      void this.refreshAccountListCache();
    }
    return { items: this.accountListCache.items };
  }

  /** 交易对规范列表 (mapi/CryptoSymbolList, 带内存缓存) */
  async cryptoSymbolList(force = false) {
    const result = await this.symbols.list(force);
    return {
      ...this.symbols.stats(),
      items: result.items,
      refreshed: result.refreshed,
      error: result.error || null,
    };
  }

  private mapPublicHttpProxyItems(data: any): { ip: string; name: string }[] {
    const raw = Array.isArray(data)
      ? data
      : Array.isArray((data as any)?.items)
        ? (data as any).items
        : Array.isArray((data as any)?.data)
          ? (data as any).data
          : [];
    return raw.map((p: any) => ({
      ip: String(p?.value ?? p?.ip ?? p?.host ?? '').trim(),
      name: String(p?.name ?? p?.label ?? '').trim(),
    }));
  }

  /** 后台刷新 PublicHttpProxyList；失败保留旧缓存。 */
  private async refreshProxyListCache(): Promise<{ items: { ip: string; name: string }[] }> {
    if (this.proxyListInflight) return this.proxyListInflight;
    this.proxyListInflight = (async () => {
      try {
        const { data } = await this.mapi.get('mapi/PublicHttpProxyList', {
          skipLog: true,
          feature: '代理列表',
        });
        const items = this.mapPublicHttpProxyItems(data);
        this.proxyListCache = { items, fetchedAt: Date.now() };
        this.logger.log(`中间件代理列表已缓存: ${items.length} 个`);
        return { items };
      } catch (e: any) {
        this.logger.warn(`刷新代理列表失败: ${e?.message || e}`);
        if (this.proxyListCache) return { items: this.proxyListCache.items };
        throw new ServiceUnavailableException({
          message: e?.message || '获取中间件代理列表失败',
          statusCode: e?.statusCode ?? 0,
          responseBody: e?.responseBody ?? null,
          url: e?.url,
        });
      } finally {
        this.proxyListInflight = null;
      }
    })();
    return this.proxyListInflight;
  }

  /**
   * 中间件公共代理列表 (mapi/PublicHttpProxyList)
   * 文档/实际约定：name=公网IP（交易所白名单），value=代理连接地址（host 或 host:port）
   * 默认只读内存缓存（后台按 PROXY_LIST_TTL_MS 刷新）；force=true 才同步打中间件。
   */
  async publicHttpProxyList(opts?: { force?: boolean }): Promise<{
    items: { ip: string; name: string }[];
  }> {
    if (opts?.force) {
      return this.refreshProxyListCache();
    }
    if (!this.proxyListCache) {
      return this.refreshProxyListCache();
    }
    if (Date.now() - this.proxyListCache.fetchedAt >= this.proxyListTtlMs()) {
      void this.refreshProxyListCache();
    }
    return { items: this.proxyListCache.items };
  }

  async getPointBalance(userId: string): Promise<number> {
    const card = await this.prisma.pointCard.findUnique({ where: { userId } });
    return Number(card?.balance ?? 0);
  }

  /** 开仓所需最低点卡余额 (SystemConfig, 默认 0=不限制) */
  async getOpenMinPointBalance(): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: 'open_min_point_balance' },
    });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return Number(process.env.OPEN_MIN_POINT_BALANCE || 0);
  }

  async setOpenMinPointBalance(amount: number) {
    const v = Math.max(0, Number(amount) || 0);
    await this.prisma.systemConfig.upsert({
      where: { key: 'open_min_point_balance' },
      create: {
        key: 'open_min_point_balance',
        value: String(v),
        remark: '开仓/跟单开仓所需最低点卡余额, 低于则禁止开仓',
      },
      update: { value: String(v) },
    });
    return { openMinPointBalance: v };
  }

  /**
   * 开仓点卡门槛检查。平仓不受限。
   * 返回是否足够; 不足时抛错 (assert=true) 或仅返回结果。
   */
  async checkOpenPointGate(userId: string, opts?: { assert?: boolean }) {
    const min = await this.getOpenMinPointBalance();
    const balance = await this.getPointBalance(userId);
    const ok = balance >= min;
    const result = {
      ok,
      pointBalance: balance,
      openMinPointBalance: min,
      message: ok
        ? null
        : `点卡不足, 无法开仓 (当前 ${balance}, 需 ≥ ${min})`,
    };
    if (opts?.assert && !ok) {
      throw new BadRequestException(result.message || '点卡不足, 无法开仓');
    }
    return result;
  }

  /** 开始交易前置检查 */
  async checklist(userId: string) {
    const keys = await this.keys.countComplete(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ips = await this.ipPool.egressIps();
    const proxy = await this.ipPool.resolveProxyForUser(userId);
    const approved = user?.status === 'ACTIVE';
    const pointGate = await this.checkOpenPointGate(userId);
    const followSetup = await this.getFollowSetupSummary(userId);
    return {
      approved,
      status: user?.status || 'PENDING',
      apiKey: keys > 0,
      apiKeyCount: keys,
      ipWhitelist: ips.ips.length > 0,
      ipCount: ips.ips.length,
      tradePassword: !!user?.tradePasswordHash,
      followEnabled: !!user?.followEnabled,
      followStartedAt: user?.followStartedAt || null,
      proxyAssigned: !!proxy,
      proxyEgress: proxy?.egressIp || null,
      middlewareBase: await this.mapi.resolveBaseUrl(),
      pointBalance: pointGate.pointBalance,
      openMinPointBalance: pointGate.openMinPointBalance,
      pointEnough: pointGate.ok,
      pointGateMessage: pointGate.message,
      canOpenFollow: pointGate.ok,
      followConfigReady: followSetup.ready,
      followConfigCount: followSetup.configuredCount,
      followConfigHint: followSetup.hint,
      canStart: approved && keys > 0 && followSetup.ready, // 须已配置至少一所：模板 + 声明本金
    };
  }

  /** 用户跟单配置摘要（不校验交易所余额） */
  async getFollowSetupSummary(userId: string) {
    const keys = await this.prisma.exchangeKey.findMany({
      where: { userId, active: true },
      select: { exchange: true },
    });
    const exchanges = Array.from(new Set(keys.map((k) => k.exchange)));
    if (exchanges.length === 0) {
      return { ready: false, configuredCount: 0, hint: '请先配置交易所 API Key' };
    }
    const configs = await this.prisma.userFollowConfig.findMany({
      where: { userId, exchange: { in: exchanges } },
      include: { template: { select: { id: true, active: true, maxPrincipal: true } } },
    });
    const ok = configs.filter(
      (c) =>
        c.template?.active &&
        Number(c.investAmount) > 0 &&
        Number(c.template.maxPrincipal) > 0,
    );
    const ready = ok.length > 0;
    return {
      ready,
      configuredCount: ok.length,
      hint: ready
        ? `已配置 ${ok.length}/${exchanges.length} 所跟单比例`
        : '请为至少一个已绑 Key 的交易所选择模板并填写投入总本金',
    };
  }

  /** 可选跟单模板（仅启用中；可按交易所过滤） */
  async listActiveFollowTemplates(exchange?: Exchange) {
    const items = await this.prisma.followTemplate.findMany({
      where: {
        active: true,
        ...(exchange ? { exchange } : {}),
      },
      orderBy: [{ exchange: 'asc' }, { name: 'asc' }],
    });
    return {
      items: items.map((t) => ({
        id: t.id,
        name: t.name,
        exchange: t.exchange,
        accountName: t.accountName,
        unitAmount: Number(t.unitAmount),
        maxPrincipal: Number(t.maxPrincipal),
        minInvestAmount: Number(t.minInvestAmount),
        remark: t.remark,
      })),
      total: items.length,
    };
  }

  /**
   * 用户跟单配置：按已绑 Key 的交易所列出（每所最多 1 模板）。
   * investAmount 为本地声明，仅用于开仓比例，不校验交易所余额。
   */
  async listUserFollowConfigs(userId: string) {
    const keys = await this.prisma.exchangeKey.findMany({
      where: { userId, active: true },
      select: { exchange: true, label: true },
      orderBy: { exchange: 'asc' },
    });
    const exchanges = Array.from(new Set(keys.map((k) => k.exchange)));
    const [configs, templates] = await Promise.all([
      this.prisma.userFollowConfig.findMany({
        where: { userId },
        include: {
          template: {
            select: {
              id: true,
              name: true,
              exchange: true,
              unitAmount: true,
              maxPrincipal: true,
              minInvestAmount: true,
              active: true,
              accountName: true,
            },
          },
        },
      }),
      exchanges.length
        ? this.prisma.followTemplate.findMany({
            where: { active: true, exchange: { in: exchanges } },
            orderBy: [{ exchange: 'asc' }, { name: 'asc' }],
          })
        : Promise.resolve([] as Awaited<ReturnType<typeof this.prisma.followTemplate.findMany>>),
    ]);
    const cfgMap = new Map(configs.map((c) => [c.exchange, c]));
    const items = exchanges.map((ex) => {
      const c = cfgMap.get(ex);
      const t = c?.template;
      const investAmount = c ? Number(c.investAmount) : null;
      const maxPrincipal = t ? Number(t.maxPrincipal) : null;
      const ratio =
        investAmount != null && maxPrincipal != null && maxPrincipal > 0
          ? investAmount / maxPrincipal
          : null;
      return {
        exchange: ex,
        hasKey: true,
        templateId: c?.templateId ?? null,
        investAmount,
        ratio,
        template: t
          ? {
              id: t.id,
              name: t.name,
              exchange: t.exchange,
              unitAmount: Number(t.unitAmount),
              maxPrincipal: Number(t.maxPrincipal),
              minInvestAmount: Number(t.minInvestAmount),
              active: t.active,
              accountName: t.accountName,
            }
          : null,
        templates: templates
          .filter((x) => x.exchange === ex)
          .map((x) => ({
            id: x.id,
            name: x.name,
            exchange: x.exchange,
            unitAmount: Number(x.unitAmount),
            maxPrincipal: Number(x.maxPrincipal),
            minInvestAmount: Number(x.minInvestAmount),
            accountName: x.accountName,
            remark: x.remark,
          })),
      };
    });
    const summary = await this.getFollowSetupSummary(userId);
    return { items, ...summary };
  }

  async upsertUserFollowConfig(
    userId: string,
    dto: {
      exchange: Exchange;
      templateId: string;
      investAmount: number;
    },
  ) {
    const investAmount = Number(dto.investAmount);
    if (!Number.isFinite(investAmount) || investAmount <= 0) {
      throw new BadRequestException('请填写有效的投入总本金');
    }
    const key = await this.prisma.exchangeKey.findFirst({
      where: { userId, exchange: dto.exchange, active: true },
    });
    if (!key) throw new BadRequestException('请先配置该交易所的 API Key');

    const template = await this.prisma.followTemplate.findUnique({ where: { id: dto.templateId } });
    if (!template || !template.active) throw new BadRequestException('模板不存在或已停用');
    if (template.exchange !== dto.exchange) {
      throw new BadRequestException('模板与交易所不匹配');
    }
    if (Number(template.maxPrincipal) <= 0) {
      throw new BadRequestException('模板比例基准本金无效，请联系管理员');
    }
    const minInvest = Number(template.minInvestAmount) || 0;
    if (minInvest > 0 && investAmount < minInvest) {
      throw new BadRequestException(`投入总本金不能少于最少投入总本金 ${minInvest}`);
    }

    const row = await this.prisma.userFollowConfig.upsert({
      where: { userId_exchange: { userId, exchange: dto.exchange } },
      create: {
        userId,
        exchange: dto.exchange,
        templateId: template.id,
        investAmount,
      },
      update: {
        templateId: template.id,
        investAmount,
      },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            unitAmount: true,
            maxPrincipal: true,
            minInvestAmount: true,
            accountName: true,
          },
        },
      },
    });
    const maxPrincipal = Number(row.template.maxPrincipal);
    return {
      exchange: row.exchange,
      templateId: row.templateId,
      investAmount: Number(row.investAmount),
      ratio: maxPrincipal > 0 ? Number(row.investAmount) / maxPrincipal : null,
      template: {
        id: row.template.id,
        name: row.template.name,
        unitAmount: Number(row.template.unitAmount),
        maxPrincipal,
        minInvestAmount: Number(row.template.minInvestAmount),
        accountName: row.template.accountName,
      },
    };
  }

  async deleteUserFollowConfig(userId: string, exchange: Exchange) {
    await this.prisma.userFollowConfig.deleteMany({ where: { userId, exchange } });
    return { ok: true };
  }

  /**
   * 用户点击「开始交易」= 开启自动跟单开关 (App 不下单)。
   * 须审核通过 + 已配置 Key；并受代理池容量限制（满仓拒绝并记回流失败日志）。
   */
  async startFollow(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('用户不存在');
    if (user.status !== 'ACTIVE') {
      throw new BadRequestException('账号尚未通过审核，无法开始交易');
    }
    const keyCount = await this.keys.countComplete(userId);
    if (keyCount === 0) {
      throw new BadRequestException('请先配置至少一个完整的交易所 API Key（OKX/Bitget 须含 Passphrase）');
    }
    const followSetup = await this.getFollowSetupSummary(userId);
    if (!followSetup.ready) {
      throw new BadRequestException(followSetup.hint || '请先选择跟单模板并填写投入总本金');
    }

    // 有空位才分配 IP；满仓抛错并写 FAIL_NO_CAPACITY 记录
    const alloc = await this.ipPool.ensureProxyOnStartFollow(userId);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        followEnabled: true,
        followStartedAt: new Date(),
        followStoppedAt: null,
      },
    });
    this.logger.log(
      `用户开启跟单: ${userId} proxy=${alloc.proxy.id} egress=${alloc.proxy.egressIp} resumed=${alloc.resumed}`,
    );
    return {
      followEnabled: updated.followEnabled,
      followStartedAt: updated.followStartedAt,
      proxyId: alloc.proxy.id,
      proxyEgress: alloc.proxy.egressIp,
    };
  }

  /** 停止跟单 */
  async stopFollow(userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { followEnabled: false, followStoppedAt: new Date() },
    });
    this.logger.log(`用户停止跟单: ${userId}`);
    return {
      followEnabled: updated.followEnabled,
      followStoppedAt: updated.followStoppedAt,
    };
  }

  /**
   * 管理端：跟单用户一览（按用户×交易所展开）。
   * readyOnly=true 时仅返回满足自动跟单条件的行：已开启 + ACTIVE + Key + 模板/本金。
   */
  async listAdminFollowers(opts?: {
    exchange?: Exchange;
    q?: string;
    userId?: string;
    readyOnly?: boolean;
  }) {
    const readyOnly = opts?.readyOnly !== false;
    const openMin = await this.getOpenMinPointBalance();
    const where: any = {
      isPlatform: false,
      followEnabled: true,
      status: 'ACTIVE',
    };
    if (opts?.userId?.trim()) {
      where.id = opts.userId.trim();
    } else if (opts?.q?.trim()) {
      const kw = opts.q.trim();
      const or: any[] = [
        { email: { contains: kw } },
        { nickname: { contains: kw } },
        { id: kw },
      ];
      if (/^\d+$/.test(kw)) or.push({ userNo: Number(kw) });
      where.OR = or;
    }
    if (readyOnly) {
      where.followConfigs = {
        some: {
          ...(opts?.exchange ? { exchange: opts.exchange } : {}),
          investAmount: { gt: 0 },
          template: { active: true, maxPrincipal: { gt: 0 } },
        },
      };
      where.exchangeKeys = {
        some: {
          active: true,
          ...(opts?.exchange ? { exchange: opts.exchange } : {}),
        },
      };
    }

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        nickname: true,
        userNo: true,
        status: true,
        followEnabled: true,
        followStartedAt: true,
        exchangeKeys: {
          where: { active: true },
          select: { exchange: true, label: true },
        },
        followConfigs: {
          include: {
            template: {
              select: {
                id: true,
                name: true,
                exchange: true,
                unitAmount: true,
                maxPrincipal: true,
                active: true,
                accountName: true,
                accountGid: true,
              },
            },
          },
        },
        pointCard: { select: { balance: true } },
      },
      orderBy: { followStartedAt: 'desc' },
    });

    const items: any[] = [];
    for (const u of users) {
      const keySet = new Set(u.exchangeKeys.map((k) => k.exchange));
      const pointBalance = Number(u.pointCard?.balance ?? 0);
      const configs = opts?.exchange
        ? u.followConfigs.filter((c) => c.exchange === opts.exchange)
        : u.followConfigs;

      const rowsSource =
        configs.length > 0
          ? configs
          : readyOnly
            ? []
            : (opts?.exchange ? [opts.exchange] : [...keySet]).map((ex) => ({
                exchange: ex as Exchange,
                templateId: null as string | null,
                investAmount: null as any,
                updatedAt: null as Date | null,
                template: null as any,
              }));

      for (const c of rowsSource) {
        const ex = c.exchange as Exchange;
        const t = c.template;
        const investAmount = c.investAmount != null ? Number(c.investAmount) : null;
        const maxPrincipal = t ? Number(t.maxPrincipal) : null;
        const unitAmount = t ? Number(t.unitAmount) : null;
        const hasKey = keySet.has(ex);
        const templateOk = !!(t && t.active && maxPrincipal != null && maxPrincipal > 0);
        const investOk = investAmount != null && investAmount > 0;
        const ready = hasKey && templateOk && investOk;
        if (readyOnly && !ready) continue;

        const openRatio =
          investOk && maxPrincipal != null && maxPrincipal > 0 ? investAmount! / maxPrincipal : null;
        const canOpen = ready && (openMin <= 0 || pointBalance >= openMin);
        const blockers: string[] = [];
        if (!hasKey) blockers.push('未绑定该所 Key');
        if (!t) blockers.push('未选模板');
        else if (!t.active) blockers.push('模板已停用');
        else if (!(maxPrincipal != null && maxPrincipal > 0)) blockers.push('模板基准本金无效');
        if (!investOk) blockers.push('未填投入本金');
        if (ready && !canOpen) blockers.push(`点卡不足开仓(需≥${openMin})`);

        items.push({
          userId: u.id,
          userNo: u.userNo,
          nickname: u.nickname,
          email: u.email,
          status: u.status,
          followEnabled: u.followEnabled,
          followStartedAt: u.followStartedAt,
          /** 跟单配置最近保存时间（含投入本金/模板变更） */
          investUpdatedAt: (c as any).updatedAt ?? null,
          exchange: ex,
          hasKey,
          templateId: t?.id ?? c.templateId ?? null,
          templateName: t?.name ?? null,
          templateAccountName: t?.accountName ?? null,
          templateAccountGid: t?.accountGid ?? null,
          investAmount,
          maxPrincipal,
          unitAmount,
          openRatio,
          pointBalance,
          openMinPointBalance: openMin,
          ready,
          canOpen,
          canFollowClose: ready,
          blockers,
        });
      }
    }

    return {
      items,
      total: items.length,
      openMinPointBalance: openMin,
      readyOnly,
    };
  }

  /**
   * 可跟单用户（圈人）: 审核通过 + 已开跟单 + 该所 Key + 模板/本金有效。
   * opts.accountGid: 信号中间件账户，须与模板 template.accountGid 一致（空模板 GID 不匹配）。
   */
  async listEligibleFollowers(
    exchange: Exchange,
    opts?: { forOpen?: boolean; accountGid?: string; skipPointGate?: boolean },
  ) {
    const signalAccountGid = opts?.accountGid?.trim() || '';
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        followEnabled: true,
        isPlatform: false,
        exchangeKeys: { some: { exchange, active: true } },
        followConfigs: {
          some: {
            exchange,
            investAmount: { gt: 0 },
            template: {
              active: true,
              maxPrincipal: { gt: 0 },
              ...(signalAccountGid
                ? { accountGid: signalAccountGid }
                : {}),
            },
          },
        },
      },
      select: {
        id: true,
        email: true,
        exchangeKeys: {
          where: { exchange, active: true },
          select: { exchange: true, label: true },
        },
        followConfigs: {
          where: {
            exchange,
            ...(signalAccountGid
              ? { template: { accountGid: signalAccountGid } }
              : {}),
          },
          take: 1,
          select: {
            investAmount: true,
            templateId: true,
            template: {
              select: {
                id: true,
                name: true,
                unitAmount: true,
                maxPrincipal: true,
                accountGid: true,
              },
            },
          },
        },
      },
    });

    let mapped = users
      .map((u) => {
        const cfg = u.followConfigs[0];
        const investAmount = cfg ? Number(cfg.investAmount) : 0;
        const maxPrincipal = cfg?.template ? Number(cfg.template.maxPrincipal) : 0;
        const unitAmount = cfg?.template ? Number(cfg.template.unitAmount) : 0;
        const templateAccountGid = cfg?.template?.accountGid?.trim() || '';
        const ratio = maxPrincipal > 0 ? investAmount / maxPrincipal : 0;
        return {
          id: u.id,
          email: u.email,
          exchangeKeys: u.exchangeKeys,
          templateId: cfg?.templateId ?? null,
          templateName: cfg?.template?.name ?? null,
          templateAccountGid,
          investAmount,
          maxPrincipal,
          unitAmount,
          /** 开仓数量比例 = 声明本金 / 模板基准本金 */
          openRatio: ratio,
        };
      })
      .filter((u) => {
        // 跟单下发必须带信号账户：模板未绑账户或与信号不一致的排除
        if (!signalAccountGid) return true;
        return !!u.templateAccountGid && u.templateAccountGid === signalAccountGid;
      });

    return mapped;
  }

  async followStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        followEnabled: true,
        followStartedAt: true,
        followStoppedAt: true,
      },
    });
    return user;
  }

  /**
   * 管理端：按「交易所 × 账户类型」查 QueryBalance（合约/现货/资金等）。
   * 单账户失败不影响其它；无 Key 返回空列表。
   */
  async listUserExchangeBalances(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isPlatform: false },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('用户不存在');

    const [keys, incomplete] = await Promise.all([
      this.keys.listCompleteKeys(userId),
      this.keys.listIncompleteKeys(userId),
    ]);

    const fetchedAt = new Date().toISOString();
    if (keys.length === 0 && incomplete.length === 0) {
      return {
        ok: true,
        userId,
        message: '未绑定启用中的交易所 Key',
        exchanges: [] as any[],
        totalUsdt: '0.00',
        totalUsdtNum: 0,
        fetchedAt,
      };
    }

    try {
      await this.resolveProxyIp(userId);
    } catch (e: any) {
      return {
        ok: false,
        userId,
        message: e?.message || '无可用代理，无法查询交易所资产',
        exchanges: [] as any[],
        totalUsdt: '0.00',
        totalUsdtNum: 0,
        fetchedAt,
      };
    }

    const exchanges: {
      exchange: Exchange;
      name: string;
      label: string | null;
      accounts: {
        accountType: string;
        label: string;
        ok: boolean;
        message?: string;
        assets: {
          asset: string;
          free: string;
          total: string;
          usdt: string;
          usdtNum: number;
        }[];
        usdt: string;
        usdtNum: number;
      }[];
      usdt: string;
      usdtNum: number;
    }[] = [];

    let grand = 0;

    // 凭证不完整（如 OKX 缺 Passphrase）绝不打中间件，只标记跳过
    for (const inc of incomplete) {
      exchanges.push({
        exchange: inc.exchange,
        name: apiName(inc.exchange),
        label: inc.label,
        accounts: [
          {
            accountType: '—',
            label: '已跳过',
            ok: false,
            message: `${inc.reason}，未查询中间件`,
            assets: [],
            usdt: '0.00',
            usdtNum: 0,
          },
        ],
        usdt: '0.00',
        usdtNum: 0,
      });
    }

    // 完整凭证的交易所并行查；某一所失败不影响其它所（例如欧意报错不会拦住币安）
    const completeRows = await Promise.all(
      keys.map(async (k) => {
        const typeDefs = adminBalanceAccountTypes(k.exchange);
        const accountRows = await Promise.all(
          typeDefs.map(async (def) => {
            try {
              const bal = await this.queryBalance(userId, k.exchange, def.type);
              const assets: {
                asset: string;
                free: string;
                total: string;
                usdt: string;
                usdtNum: number;
              }[] = [];
              let accSum = 0;
              for (const a of bal.assets || []) {
                const asset = String(a.asset || '').toUpperCase();
                if (!asset) continue;
                const amount = Number(a.total ?? a.free ?? 0);
                if (!Number.isFinite(amount) || amount === 0) continue;
                const px =
                  asset === 'USDT' || asset === 'USD' || asset === 'USDC'
                    ? 1
                    : this.market.getPrice(asset) ?? 0;
                const usdtNum = amount * px;
                accSum += usdtNum;
                assets.push({
                  asset,
                  free: String(a.free ?? '0'),
                  total: String(a.total ?? a.free ?? '0'),
                  usdt: this.fmtMoney(usdtNum),
                  usdtNum,
                });
              }
              assets.sort((a, b) => b.usdtNum - a.usdtNum);
              return {
                accountType: def.type,
                label: def.label,
                ok: true as const,
                assets,
                usdt: this.fmtMoney(accSum),
                usdtNum: accSum,
              };
            } catch (e: any) {
              return {
                accountType: def.type,
                label: def.label,
                ok: false as const,
                message: e?.message || '查询失败',
                assets: [] as {
                  asset: string;
                  free: string;
                  total: string;
                  usdt: string;
                  usdtNum: number;
                }[],
                usdt: '0.00',
                usdtNum: 0,
              };
            }
          }),
        );
        const exSum = accountRows.reduce((s, a) => s + a.usdtNum, 0);
        return {
          exchange: k.exchange,
          name: apiName(k.exchange),
          label: k.label,
          accounts: accountRows,
          usdt: this.fmtMoney(exSum),
          usdtNum: exSum,
        };
      }),
    );

    exchanges.push(...completeRows);
    grand = completeRows.reduce((s, e) => s + e.usdtNum, 0);

    return {
      ok: true,
      userId,
      message: null as string | null,
      exchanges,
      totalUsdt: this.fmtMoney(grand),
      totalUsdtNum: grand,
      fetchedAt,
    };
  }

  /** 汇总多交易所余额, 并用行情折算 USDT。opts.timeoutMs 限制单所耗时，避免首页卡住。 */
  async listBalances(userId: string, opts?: { timeoutMs?: number }) {
    const keys = await this.keys.listCompleteKeys(userId);
    const errors: { exchange: string; message: string }[] = [];
    const byAsset = new Map<
      string,
      { asset: string; amount: number; usdt: number; exchanges: string[] }
    >();
    const perExchangeMs = Math.max(
      1000,
      Number(opts?.timeoutMs ?? process.env.TRADE_BALANCE_TIMEOUT_MS ?? 8000),
    );

    const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
      new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label}超时 (${ms}ms)`)), ms);
        p.then(
          (v) => {
            clearTimeout(t);
            resolve(v);
          },
          (e) => {
            clearTimeout(t);
            reject(e);
          },
        );
      });

    await Promise.all(
      keys.map(async (k) => {
        try {
          const bal = await withTimeout(
            this.queryBalance(userId, k.exchange),
            perExchangeMs,
            `${k.exchange}余额`,
          );
          for (const a of bal.assets || []) {
            const asset = String(a.asset || '').toUpperCase();
            if (!asset) continue;
            const amount = Number(a.total ?? a.free ?? 0);
            if (!Number.isFinite(amount) || amount === 0) continue;
            const px = this.market.getPrice(asset) ?? 0;
            const usdt = amount * px;
            const prev = byAsset.get(asset);
            if (prev) {
              prev.amount += amount;
              prev.usdt += usdt;
              if (!prev.exchanges.includes(k.exchange)) prev.exchanges.push(k.exchange);
            } else {
              byAsset.set(asset, { asset, amount, usdt, exchanges: [k.exchange] });
            }
          }
        } catch (e: any) {
          errors.push({ exchange: k.exchange, message: e?.message || 'error' });
        }
      }),
    );

    const assets = [...byAsset.values()]
      .sort((a, b) => b.usdt - a.usdt)
      .map((a) => ({
        symbol: a.asset,
        name: a.asset,
        amount: this.fmtAmount(a.amount),
        usdt: this.fmtMoney(a.usdt),
        usdtNum: a.usdt,
        exchanges: a.exchanges,
        color: this.assetColor(a.asset),
      }));

    const totalUsdt = assets.reduce((s, a) => s + a.usdtNum, 0);
    return {
      totalAssets: this.fmtMoney(totalUsdt),
      totalAssetsNum: totalUsdt,
      assets,
      errors,
      apiKeyCount: keys.length,
      hasApiKey: keys.length > 0,
    };
  }

  /** 对外暴露公式 (管理端试算 / 单测) */
  calcRealizedPnl = calcRealizedPnl;

  /**
   * 本次新增成交量对应的边际平仓均价（避免用整单累计均价误算早先部分平）
   */
  private marginalCloseAvg(params: {
    totalFilled: number;
    totalAvg: number;
    prevRecorded: number;
    prevAvg: number;
    delta: number;
  }): number {
    const { totalFilled, totalAvg, prevRecorded, prevAvg, delta } = params;
    if (!(delta > 0)) return 0;
    if (prevRecorded > 1e-12 && prevAvg > 0 && totalFilled > prevRecorded + 1e-12) {
      const marginal = (totalFilled * totalAvg - prevRecorded * prevAvg) / delta;
      if (Number.isFinite(marginal) && marginal > 0) return marginal;
    }
    return totalAvg;
  }

  /**
   * 查单累计成交 → 增量切片入账。
   * 开仓：更新 filledAmt 后按剩余量汇总持仓；平仓：Δqty 扣开仓 consumedAmt（无均价也减仓）。
   */
  async applyFillFromQuery(
    log: {
      id: string;
      userId: string;
      exchange: Exchange;
      orderId: string | null;
      signalKey: string;
      orderGid?: string | null;
      symbol: string | null;
      accountType: string | null;
      coinName?: string | null;
      equalCoinName?: string | null;
      positionSide?: string | null;
      isOpen?: boolean | null;
      side?: string | null;
      requestBody?: string | null;
      orderAmt?: any;
      filledAmt?: any;
      avgPrice?: any;
      tradeFee?: any;
      recordedFilledAmt?: any;
      profitRecordedAmt?: any;
    },
    fill: FillSnapshot & { finalFill?: boolean },
  ): Promise<{
    booked: boolean;
    delta: number;
    complete: boolean;
    remainder: boolean;
    recorded: boolean;
    profit?: number;
    reason?: string;
  }> {
    const empty = {
      booked: false,
      delta: 0,
      complete: false,
      remainder: false,
      recorded: false,
    };
    if (!isQueryFillUsable(fill)) {
      return { ...empty, reason: 'query-unusable' };
    }

    let meta: any = {};
    try {
      meta = log.requestBody ? JSON.parse(log.requestBody) : {};
    } catch {
      meta = {};
    }
    const isOpen = log.isOpen != null ? log.isOpen : meta.isOpen != null ? !!meta.isOpen : null;
    const side = String(log.side || meta.orderSide || '').toLowerCase();
    const looksClose =
      isOpen === false || side === 'close' || (isOpen == null && side === 'sell');
    const coinName = log.coinName || meta.coinName || null;
    const equalCoinName = log.equalCoinName || meta.equalCoinName || null;
    const positionSide = String(log.positionSide || meta.positionSide || 'long').toLowerCase();

    const orderAmt = orderAmtOf(log);
    const watermark = fillWatermarkOf(log, looksClose);
    const totalFilled = Number(fill.filledAmt) || 0;
    const totalAvg = Number(fill.priceAvg) || 0;
    const totalFee = Number(fill.tradeFee) || 0;
    const prevAvg = Number(log.avgPrice ?? 0) || 0;
    const prevFee = Number(log.tradeFee ?? 0) || 0;
    const delta = fillDelta(totalFilled, watermark);

    let slicePx = 0;
    let sliceFee = 0;
    if (delta > FILL_EPS) {
      slicePx = sliceFillPrice({
        totalFilled,
        totalAvg,
        prevFilled: watermark,
        prevAvg,
        delta,
      });
      sliceFee = sliceFillFee(totalFee, prevFee, delta, totalFilled);

      const lastSlice = await this.prisma.followFillSlice.findFirst({
        where: { followLogId: log.id },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const seq = (lastSlice?.seq ?? 0) + 1;
      await this.prisma.followFillSlice.create({
        data: {
          followLogId: log.id,
          seq,
          qty: delta,
          price: slicePx,
          fee: sliceFee,
          cumulativeFilled: totalFilled,
          cumulativeAvg: totalAvg,
        },
      });

      const fillKind = looksClose
        ? fill.finalFill || fill.state === 'filled' || fill.state === 'cancelled'
          ? FollowFillKind.FULL
          : FollowFillKind.PARTIAL
        : fill.finalFill || fill.state === 'filled'
          ? FollowFillKind.FULL
          : FollowFillKind.PARTIAL;

      await this.prisma.signalFollowLog.update({
        where: { id: log.id },
        data: {
          filledAmt: totalFilled,
          avgPrice: totalAvg > 0 ? totalAvg : undefined,
          tradeFee: Number.isFinite(totalFee) ? totalFee : undefined,
          recordedFilledAmt: watermark + delta,
          fillKind,
          coinName: coinName || undefined,
          equalCoinName: equalCoinName || undefined,
          positionSide,
          isOpen: isOpen != null ? isOpen : undefined,
        },
      });

      if (looksClose) {
        await this.consumeCloseDelta({
          userId: log.userId,
          exchange: log.exchange,
          orderId: log.orderId,
          symbol: log.symbol,
          accountType: log.accountType || 'future',
          signalKey: log.signalKey,
          coinName,
          equalCoinName,
          positionSide,
          meta,
          delta,
          closeAvg: slicePx,
          feeDelta: sliceFee,
          closeLogId: log.id,
          prevRecorded: watermark,
        });
      }
    }

    const recordedFilled = watermark + delta;
    const complete =
      !!fill.finalFill ||
      isOrderFillComplete({ fill, orderAmt, recordedFilled });
    const remainder = hasLiveRemainder({ fill, orderAmt, recordedFilled });

    if (complete) {
      const filledAmt = Math.max(totalFilled, recordedFilled);
      await this.prisma.signalFollowLog.update({
        where: { id: log.id },
        data: {
          status: fill.state === 'cancelled' ? 'CANCELLED' : 'FILLED',
          fillKind:
            filledAmt > FILL_EPS
              ? fill.state === 'filled' ||
                (orderAmt > FILL_EPS && recordedFilled + FILL_COMPLETE_EPS >= orderAmt)
                ? FollowFillKind.FULL
                : FollowFillKind.PARTIAL
              : FollowFillKind.NONE,
          cancelledAt: fill.state === 'cancelled' ? new Date() : undefined,
          filledAmt: filledAmt > 0 ? filledAmt : undefined,
          avgPrice: totalAvg > 0 ? totalAvg : undefined,
          recordedFilledAmt: recordedFilled,
        },
      });
    }

    if (delta > FILL_EPS || (complete && recordedFilled > FILL_EPS)) {
      try {
        await this.syncUserPositionFromLots({
          userId: log.userId,
          exchange: log.exchange,
          coinName: coinName || '',
          equalCoinName,
          positionSide,
        });
      } catch (e: any) {
        this.logger.warn(
          `${looksClose ? '平' : '开'}仓同步持仓失败 log=${log.id}: ${e?.message || e}`,
        );
      }
    }

    return {
      booked: delta > FILL_EPS,
      delta,
      complete,
      remainder,
      recorded: delta > FILL_EPS && looksClose,
      reason: delta > FILL_EPS ? (looksClose ? 'close-slice' : 'open-slice') : 'no-delta',
    };
  }

  /** 平仓 Δqty FIFO 扣开仓剩余；有均价才记利润。无均价仍减仓。 */
  private async consumeCloseDelta(params: {
    userId: string;
    exchange: Exchange;
    orderId: string | null;
    symbol: string | null;
    accountType: string;
    signalKey: string;
    coinName: string | null;
    equalCoinName: string | null;
    positionSide: string;
    meta: any;
    delta: number;
    closeAvg: number;
    feeDelta: number;
    closeLogId: string;
    prevRecorded: number;
  }): Promise<{ matchedQty: number; profit: number }> {
    const {
      userId,
      exchange,
      orderId,
      symbol,
      accountType,
      signalKey,
      coinName,
      equalCoinName,
      positionSide,
      meta,
      delta,
      closeAvg,
      feeDelta,
      closeLogId,
      prevRecorded,
    } = params;
    if (!(delta > FILL_EPS)) return { matchedQty: 0, profit: 0 };

    const opens = await this.prisma.signalFollowLog.findMany({
      where: {
        userId,
        exchange,
        isOpen: true,
        profitConsumed: false,
        ...(coinName ? { coinName } : {}),
        ...(equalCoinName ? { equalCoinName } : {}),
        ...(positionSide ? { positionSide } : {}),
        OR: [
          { status: 'FILLED' },
          { status: 'CANCELLED', filledAmt: { gt: 0 } },
          { status: 'PLACED', filledAmt: { gt: 0 } },
          { status: 'CANCEL_FAILED', filledAmt: { gt: 0 } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    let remain = delta;
    let totalPnl = 0;
    let matchedQty = 0;
    let multiplier = 1;
    try {
      const spec = await this.resolveSymbolSpec(exchange, {
        apiCode: meta.apiCode,
        coinName: coinName || undefined,
        equalCoinName: equalCoinName || undefined,
        symbol: symbol || undefined,
        accountType,
      });
      multiplier = contractMultiplier({
        boardLotSize: spec.boardLotSize,
        minAmt: spec.minAmt,
        accountType,
      });
    } catch {
      multiplier = 1;
    }

    for (const open of opens) {
      if (remain <= FILL_EPS) break;
      const openFilled = Number(open.filledAmt ?? 0);
      const openConsumed = Number(open.consumedAmt ?? 0);
      const openAvg = Number(open.avgPrice ?? 0);
      const openFee = Number(open.tradeFee ?? 0);
      if (!(openFilled > 0)) continue;
      const available = Math.max(0, openFilled - openConsumed);
      if (available <= 0) {
        if (!open.profitConsumed) {
          await this.prisma.signalFollowLog.update({
            where: { id: open.id },
            data: { profitConsumed: true },
          });
        }
        continue;
      }
      const qty = Math.min(remain, available);
      if (closeAvg > 0 && openAvg > 0) {
        const openFeeShare = openFee * (qty / openFilled);
        const closeFeeShare = feeDelta * (qty / delta);
        const lot = calcRealizedPnl({
          positionSide,
          openAvg,
          closeAvg,
          qty,
          openFeeShare,
          closeFeeShare,
          multiplier,
        });
        totalPnl += lot.profit;
      }
      matchedQty += qty;
      remain -= qty;
      const newConsumed = openConsumed + qty;
      const fully = newConsumed + FILL_EPS >= openFilled;
      await this.prisma.signalFollowLog.update({
        where: { id: open.id },
        data: {
          consumedAmt: newConsumed,
          profitConsumed: fully,
        },
      });
    }

    const newRecorded = Math.round((prevRecorded + delta) * 1e10) / 1e10;
    await this.prisma.signalFollowLog.update({
      where: { id: closeLogId },
      data: { profitRecordedAmt: newRecorded },
    });

    if (!(matchedQty > FILL_EPS) || !(closeAvg > 0) || !orderId) {
      return { matchedQty, profit: 0 };
    }

    const profit = Math.round(totalPnl * 1e8) / 1e8;
    const rawKey = String(signalKey || '');
    const orderGid = rawKey.replace(/:(open|close)(:.*)?$/i, '') || rawKey;
    const profitSignalKey = `${orderGid}:close:${orderId}:${String(newRecorded).replace('.', '_')}`;
    try {
      const rec = await this.prisma.profitRecord.create({
        data: {
          userId,
          exchange,
          symbol: symbol || '—',
          profit,
          closedAt: new Date(),
          orderId,
          signalKey: profitSignalKey,
          source: 'FOLLOW',
        },
      });
      try {
        await this.commission.settleProfit(rec.id);
      } catch (e: any) {
        this.logger.warn(`利润 ${rec.id} 佣金结算失败(稍后可手动结算): ${e?.message || e}`);
      }
    } catch (e: any) {
      this.logger.debug(`利润切片跳过: ${e?.message || e}`);
    }
    this.logger.log(
      `平仓增量 user=${userId} ${positionSide} ${coinName || symbol} ` +
        `delta=${delta} matched=${matchedQty} closeAvg=${closeAvg} pnl=${profit}`,
    );
    return { matchedQty, profit };
  }

  /**
   * 跟单挂单成交后: 用 QueryOrder 的 FilledAmt/PriceAvg/TradeFee 入库成交信息;
   * 若为平仓, 与未消耗开仓单 FIFO 配对算出已实现盈亏 → ProfitRecord → 佣金结算。
   * 部分平仓按每次新增成交量即时配对（不等全平），避免后续加仓改变开仓均价后重算出错。
   *
   * 公式见 pnl.util.ts:
   *   多: (平仓均价−开仓均价)×数量×乘数 + 开仓手续费份额 + 平仓手续费份额
   *   空: (开仓均价−平仓均价)×数量×乘数 + 开仓手续费份额 + 平仓手续费份额
   *   手续费按文档「负数为支付」直接加减。
   */
  async recordFillProfit(log: {
    userId: string;
    exchange: Exchange;
    orderId: string | null;
    symbol: string | null;
    accountType: string | null;
    /** 中间件 orderGID；兼容旧参数名 signalKey */
    signalKey: string;
    /** 本次 QueryOrder 带回的成交字段 (由 sync 传入, 避免重复查单) */
    filledAmt?: number;
    priceAvg?: number;
    tradeFee?: number;
    /** 是否整单终态（全成/撤单后不再追加成交） */
    finalFill?: boolean;
  }): Promise<{ recorded: boolean; profit?: number; reason?: string }> {
    if (!log.orderId) return { recorded: false, reason: 'no-orderId' };
    const rawKey = String(log.signalKey || '');
    if (!rawKey) return { recorded: false, reason: 'no-orderGid' };
    const row =
      (await this.prisma.signalFollowLog.findFirst({
        where: { userId: log.userId, signalKey: rawKey },
      })) ||
      (await this.prisma.signalFollowLog.findFirst({
        where: { userId: log.userId, orderId: log.orderId },
        orderBy: { createdAt: 'desc' },
      }));
    if (!row) return { recorded: false, reason: 'log-not-found' };

    let filledAmt = Number(log.filledAmt);
    let priceAvg = Number(log.priceAvg);
    let tradeFee = Number(log.tradeFee);
    if (!Number.isFinite(filledAmt) || filledAmt < 0) {
      const q = await this.inspectOrderFill(log.userId, log.exchange, log.orderId, {
        symbol: log.symbol || row.symbol || undefined,
        accountType: log.accountType || row.accountType || 'future',
        coinName: row.coinName || undefined,
        equalCoinName: row.equalCoinName || undefined,
        clientOrderId: row.clientOrderId || undefined,
        isOpen: row.isOpen ?? false,
      });
      filledAmt = q.filledAmt;
      priceAvg = q.priceAvg;
      tradeFee = q.tradeFee;
    }
    const r = await this.applyFillFromQuery(row, {
      state: log.finalFill ? 'filled' : filledAmt > 0 ? 'partial' : 'open',
      filledAmt: Number.isFinite(filledAmt) ? filledAmt : 0,
      priceAvg: Number.isFinite(priceAvg) ? priceAvg : 0,
      tradeFee: Number.isFinite(tradeFee) ? tradeFee : 0,
      finalFill: !!log.finalFill,
    });
    return { recorded: r.recorded, profit: r.profit, reason: r.reason };
  }

  /** 管理端手动录入平仓利润 (联调/补录), 入库后自动结算佣金 */
  async recordProfitManual(dto: {
    userId: string;
    exchange: Exchange;
    symbol: string;
    profit: number;
    orderId?: string;
    signalKey?: string;
  }) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true } });
    if (!user) throw new BadRequestException('用户不存在');
    if (!Number.isFinite(dto.profit)) throw new BadRequestException('利润金额无效');

    const rec = await this.prisma.profitRecord.create({
      data: {
        userId: dto.userId,
        exchange: dto.exchange,
        symbol: dto.symbol || '—',
        profit: dto.profit,
        closedAt: new Date(),
        orderId: dto.orderId,
        signalKey: dto.signalKey,
        source: 'MANUAL',
      },
    });
    const settle = await this.commission.settleProfit(rec.id);
    return { id: rec.id, profit: dto.profit, ...settle };
  }

  /** 平仓收益记录 (DB) */
  async listProfits(
    userId: string,
    skip = 0,
    take = 50,
    opts?: { exchange?: string; coin?: string; from?: string; to?: string },
  ) {
    const where: Prisma.ProfitRecordWhereInput = { userId };
    const ex = String(opts?.exchange || '').trim().toUpperCase();
    if (ex && (Object.values(Exchange) as string[]).includes(ex)) {
      where.exchange = ex as Exchange;
    }
    const coin = String(opts?.coin || '').trim();
    if (coin) {
      where.symbol = { contains: coin };
    }
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(opts?.from || '').trim();
    const to = String(opts?.to || '').trim();
    if (from || to) {
      where.closedAt = {};
      if (dayRe.test(from)) where.closedAt.gte = new Date(`${from}T00:00:00`);
      if (dayRe.test(to)) {
        const end = new Date(`${to}T00:00:00`);
        end.setDate(end.getDate() + 1);
        where.closedAt.lt = end;
      }
    }

    const [rows, total, agg] = await Promise.all([
      this.prisma.profitRecord.findMany({
        where,
        orderBy: { closedAt: 'desc' },
        skip,
        take: Math.min(200, Math.max(1, take || 50)),
      }),
      this.prisma.profitRecord.count({ where }),
      this.prisma.profitRecord.aggregate({
        where,
        _sum: { profit: true },
      }),
    ]);

    const items = rows.map((r) => {
      const pnlNum = Number(r.profit);
      return {
        id: r.id,
        pair: r.symbol.includes('/') ? r.symbol : `${r.symbol}/USDT`,
        exchange: r.exchange,
        pnl: this.signedProfit(pnlNum),
        pnlNum,
        positive: pnlNum >= 0,
        amount: '—',
        openTime: '—',
        closeTime: this.fmtTime(r.closedAt),
        closedAt: r.closedAt,
      };
    });
    return {
      items,
      total,
      sum: Number(agg._sum.profit || 0),
    };
  }

  /**
   * 跟单/交易日志（App「交易日志」）
   * 用户端仅展示开仓成功 / 平仓成功（FILLED），失败与撤单等不返回。
   */
  async listFollowHistory(userId: string, skip = 0, take = 50) {
    const rows = await this.prisma.signalFollowLog.findMany({
      where: {
        userId,
        status: 'FILLED',
        isOpen: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Math.min(200, take || 50),
    });
    return rows.map((r) => {
      let req: any = {};
      try {
        req = r.requestBody ? JSON.parse(r.requestBody) : {};
      } catch {
        /* ignore */
      }
      const kind: 'open' | 'close' = r.isOpen === true ? 'open' : 'close';
      const kindLabel = kind === 'open' ? '开仓' : '平仓';
      const statusLabel = kind === 'open' ? '开仓成功' : '平仓成功';
      const signalAmt = req.signalAmount ?? req.amount;
      const followAmt = req.amount ?? r.filledAmt;
      const pairFromCoins =
        r.coinName || req.coinName || r.equalCoinName || req.equalCoinName
          ? `${r.coinName || req.coinName || ''}/${r.equalCoinName || req.equalCoinName || ''}`
          : null;
      return {
        id: r.id,
        pair: String(r.symbol || req.symbol || pairFromCoins || '—'),
        exchange: r.exchange,
        status: r.status,
        statusLabel,
        kind,
        kindLabel,
        isOpen: r.isOpen,
        coinName: r.coinName || req.coinName || null,
        equalCoinName: r.equalCoinName || req.equalCoinName || null,
        positionSide: r.positionSide || req.positionSide || null,
        pnl: statusLabel,
        pnlNum: 0,
        positive: true,
        amount: String(r.filledAmt ?? followAmt ?? '—'),
        signalAmount: signalAmt != null ? String(signalAmt) : null,
        filledAmt: r.filledAmt != null ? String(r.filledAmt) : null,
        avgPrice: r.avgPrice != null ? String(r.avgPrice) : null,
        openTime: this.fmtTime(r.createdAt),
        closeTime: '已成交',
        failReason: null,
        errorMsg: null,
        cancelledAt: r.cancelledAt,
        cancelReason: r.cancelReason,
        cancelMsg: null,
        closedAt: r.cancelledAt || r.createdAt,
        success: true,
        orderGid: r.orderGid || null,
        signalKey: r.signalKey,
        orderId: r.orderId,
      };
    });
  }

  async profitStats(userId: string) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

    const [todayAgg, weekAgg, totalAgg, commissionAgg] = await Promise.all([
      this.prisma.profitRecord.aggregate({
        where: { userId, closedAt: { gte: startOfToday } },
        _sum: { profit: true },
      }),
      this.prisma.profitRecord.aggregate({
        where: { userId, closedAt: { gte: weekAgo } },
        _sum: { profit: true },
      }),
      this.prisma.profitRecord.aggregate({
        where: { userId },
        _sum: { profit: true },
      }),
      this.prisma.commissionRecord.aggregate({
        where: { earnerId: userId },
        _sum: { amount: true },
      }),
    ]);

    const today = Number(todayAgg._sum.profit || 0);
    const week = Number(weekAgg._sum.profit || 0);
    const total = Number(totalAgg._sum.profit || 0);
    const commission = Number(commissionAgg._sum.amount || 0);

    return {
      today: this.signedMoney(today),
      week: this.signedMoney(week),
      totalIncome: this.signedMoney(total),
      earnings: this.signedMoney(total + commission),
      commission: this.fmtMoney(commission),
      todayNum: today,
      weekNum: week,
      totalNum: total,
      commissionNum: commission,
    };
  }

  /** 首页聚合：总资产=收益(跟单+佣金)+点卡余额，不查交易所 */
  async homeSummary(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        nickname: true,
        status: true,
        followEnabled: true,
        followStartedAt: true,
      },
    });
    const pointCard =
      (await this.prisma.pointCard.findUnique({ where: { userId } })) ??
      (await this.prisma.pointCard.create({ data: { userId } }));

    const [stats, openMin, apiKeyCount] = await Promise.all([
      this.profitStats(userId),
      this.getOpenMinPointBalance(),
      this.keys.countComplete(userId),
    ]);

    const pointBalance = Number(pointCard.balance);
    const claimableNum = Number(pointCard.commissionBalance);
    const pendingNum = Number(pointCard.commissionFrozen);
    const claimedNum = Math.max(
      0,
      (Number.isFinite(stats.commissionNum) ? stats.commissionNum : 0) -
        (Number.isFinite(claimableNum) ? claimableNum : 0) -
        (Number.isFinite(pendingNum) ? pendingNum : 0),
    );
    const totalAssetsNum =
      (Number.isFinite(pointBalance) ? pointBalance : 0) +
      (Number.isFinite(stats.totalNum) ? stats.totalNum : 0) +
      (Number.isFinite(stats.commissionNum) ? stats.commissionNum : 0);
    const pointEnough = pointBalance >= openMin;

    return {
      user: {
        name: user?.nickname || user?.email?.split('@')[0] || '用户',
        email: user?.email,
        role: 'USER',
        status: user?.status,
        followEnabled: !!user?.followEnabled,
        followStartedAt: user?.followStartedAt,
      },
      today: stats.today,
      week: stats.week,
      totalIncome: stats.totalIncome,
      totalAssets: this.fmtMoney(totalAssetsNum),
      pointCard: this.fmtMoney(pointBalance),
      pointBalance,
      openMinPointBalance: openMin,
      pointEnough,
      earnings: stats.earnings,
      commission: stats.commission,
      commissionClaimable: this.fmtMoney(claimableNum),
      commissionPending: this.fmtMoney(pendingNum),
      commissionClaimed: this.fmtMoney(claimedNum),
      // 持仓列表由 App 另调 /trade/positions，避免首页被交易所查询拖慢
      assets: [] as {
        symbol: string;
        name: string;
        amount: string;
        usdt: string;
        usdtNum: number;
        color: string;
      }[],
      balanceErrors: [] as { exchange: string; message: string }[],
      apiKeyCount,
      hasApiKey: apiKeyCount > 0,
    };
  }

  private fmtMoney(n: number): string {
    if (!Number.isFinite(n)) return '0.00';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** 已实现盈亏等小额利润：固定 8 位小数 */
  private fmtProfit(n: number): string {
    if (!Number.isFinite(n)) return '0.00000000';
    return n.toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
  }

  private signedProfit(n: number): string {
    const s = this.fmtProfit(Math.abs(n));
    if (n > 0) return `+${s}`;
    if (n < 0) return `-${s}`;
    return s;
  }

  private signedMoney(n: number): string {
    const s = this.fmtMoney(Math.abs(n));
    if (n > 0) return `+${s}`;
    if (n < 0) return `-${s}`;
    return s;
  }

  private fmtAmount(n: number): string {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
  }

  private fmtTime(d: Date | string): string {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt.getTime())) return '—';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
  }

  private assetColor(asset: string): string {
    const map: Record<string, string> = {
      BTC: '#F7931A',
      ETH: '#627EEA',
      USDT: '#26A17B',
      USDC: '#2775CA',
      BNB: '#F3BA2F',
      SOL: '#14F195',
      XRP: '#23292F',
      DOGE: '#C2A633',
    };
    return map[asset.toUpperCase()] || '#6B7280';
  }

  // ---------- normalize helpers (兼容多种中间件返回形状) ----------

  private asArray(data: any): any[] {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.list)) return data.list;
    if (Array.isArray(data?.records)) return data.records;
    if (Array.isArray(data?.orders)) return data.orders;
    if (Array.isArray(data?.positions)) return data.positions;
    if (Array.isArray(data?.assets)) return data.assets;
    return [];
  }

  /**
   * 管理端持仓列表：读本地 user_positions。
   * status=OPEN（默认）当前持仓；status=CLOSED 已平仓。
   * 时间筛选：OPEN 按开仓时间，CLOSED 按平仓时间。
   */
  /**
   * 管理端只读对比：中间件账户 mapi/Positions（账户列表持仓） vs 本地 user_positions OPEN。
   * match=both|local_only|live_only|all
   */
  async compareAdminPositions(opts: {
    accountGid: string;
    userId?: string;
    q?: string;
    exchange?: string;
    coinName?: string;
    match?: string;
  }) {
    const accountGid = String(opts.accountGid || '').trim();
    if (!accountGid) {
      throw new BadRequestException('请选择中间件主账户（账户列表 GID）');
    }

    let signalRows: ReturnType<TradeService['parseSignalPositions']> = [];
    let signalError: string | null = null;
    try {
      signalRows = await this.fetchSignalPositions(accountGid, {
        skipLog: true,
        bypassCache: true,
      });
    } catch (e: any) {
      signalError = e?.message || String(e);
      signalRows = [];
    }

    const where: Prisma.UserPositionWhereInput = {
      status: UserPositionStatus.OPEN,
      qty: { gt: 0 },
      accountGid,
    };
    if (opts.exchange) where.exchange = opts.exchange as Exchange;
    if (opts.userId?.trim()) where.userId = opts.userId.trim();
    if (opts.coinName?.trim()) {
      where.coinName = { contains: opts.coinName.trim().toUpperCase() };
    }
    if (opts.q?.trim() && !opts.userId?.trim()) {
      const q = opts.q.trim();
      const or: Prisma.UserWhereInput[] = [
        { email: { contains: q } },
        { nickname: { contains: q } },
      ];
      if (/^\d+$/.test(q)) or.push({ userNo: Number(q) });
      where.user = { OR: or };
    }

    const locals = await this.prisma.userPosition.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, nickname: true, userNo: true } },
      },
      take: 2000,
    });

    const posKey = (p: {
      exchange?: string | null;
      coinName: string;
      equalCoinName: string;
      positionSide: string;
    }) =>
      [
        String(p.exchange || '').toUpperCase(),
        String(p.coinName || '').toUpperCase(),
        String(p.equalCoinName || 'PC').toUpperCase() || 'PC',
        String(p.positionSide || 'long').toLowerCase().includes('short') ? 'short' : 'long',
      ].join('|');

    const signalByKey = new Map<string, (typeof signalRows)[0]>();
    for (const s of signalRows) {
      if (!(s.size > 0)) continue;
      if (opts.exchange && s.exchange && s.exchange !== opts.exchange) continue;
      if (
        opts.coinName?.trim() &&
        !s.coinName.includes(opts.coinName.trim().toUpperCase())
      ) {
        continue;
      }
      const k = posKey({
        exchange: s.exchange,
        coinName: s.coinName,
        equalCoinName: s.equalCoinName,
        positionSide: s.positionSide,
      });
      const prev = signalByKey.get(k);
      if (!prev || s.size > prev.size) signalByKey.set(k, s);
    }

    const ratioCache = new Map<string, number | null>();
    const getRatio = async (userId: string, exchange: Exchange) => {
      const ck = `${userId}|${exchange}|${accountGid}`;
      if (ratioCache.has(ck)) return ratioCache.get(ck)!;
      const r = await this.resolveOpenRatio(userId, exchange, accountGid);
      ratioCache.set(ck, r);
      return r;
    };

    type Row = {
      match: 'both' | 'local_only' | 'live_only';
      exchange: string;
      coinName: string;
      equalCoinName: string;
      side: string;
      signalSize: number | null;
      signalPrice: number | null;
      localQty: number | null;
      openRatio: number | null;
      expectedQty: number | null;
      diffQty: number | null;
      diffPct: number | null;
      openTime: string | null;
      localId: string | null;
      userId: string | null;
      user: {
        id: string;
        email: string;
        nickname: string | null;
        userNo: number | null;
      } | null;
      accountGid: string;
    };

    const items: Row[] = [];
    const matchedSignalKeys = new Set<string>();

    for (const loc of locals) {
      const coinName = String(loc.coinName || '').toUpperCase();
      const equalCoinName = String(loc.equalCoinName || 'PC').toUpperCase() || 'PC';
      const side = String(loc.positionSide || 'long').toLowerCase().includes('short')
        ? 'short'
        : 'long';
      const exchange = loc.exchange as Exchange;
      const k = posKey({ exchange, coinName, equalCoinName, positionSide: side });
      const sig = signalByKey.get(k);
      const localQty = Number(loc.qty);
      const openRatio = await getRatio(loc.userId, exchange);
      let signalSize: number | null = null;
      let signalPrice: number | null = null;
      let expectedQty: number | null = null;
      let diffQty: number | null = null;
      let diffPct: number | null = null;
      let match: Row['match'] = 'local_only';

      if (sig && sig.size > 0) {
        matchedSignalKeys.add(k);
        match = 'both';
        signalSize = sig.size;
        signalPrice = sig.price;
        if (openRatio != null && openRatio > 0) {
          expectedQty = sig.size * openRatio;
          diffQty = localQty - expectedQty;
          diffPct = expectedQty > 1e-12 ? diffQty / expectedQty : null;
        }
      }

      items.push({
        match,
        exchange,
        coinName,
        equalCoinName,
        side,
        signalSize,
        signalPrice,
        localQty,
        openRatio,
        expectedQty,
        diffQty,
        diffPct,
        openTime: loc.openedAt ? loc.openedAt.toISOString() : null,
        localId: loc.id,
        userId: loc.userId,
        user: loc.user
          ? {
              id: loc.user.id,
              email: loc.user.email,
              nickname: (loc.user as any).nickname ?? null,
              userNo: (loc.user as any).userNo ?? null,
            }
          : null,
        accountGid,
      });
    }

    for (const [k, sig] of signalByKey) {
      if (matchedSignalKeys.has(k)) continue;
      if (opts.userId?.trim()) {
        const ex = (sig.exchange || 'BINANCE') as Exchange;
        const openRatio = await getRatio(opts.userId.trim(), ex);
        const expectedQty = openRatio != null ? sig.size * openRatio : null;
        items.push({
          match: 'live_only',
          exchange: String(sig.exchange || ''),
          coinName: sig.coinName,
          equalCoinName: sig.equalCoinName,
          side: sig.positionSide,
          signalSize: sig.size,
          signalPrice: sig.price,
          localQty: null,
          openRatio,
          expectedQty,
          diffQty: expectedQty != null ? -expectedQty : null,
          diffPct: expectedQty != null ? -1 : null,
          openTime: null,
          localId: null,
          userId: opts.userId.trim(),
          user: null,
          accountGid,
        });
        continue;
      }
      if (opts.q?.trim()) continue;
      items.push({
        match: 'live_only',
        exchange: String(sig.exchange || ''),
        coinName: sig.coinName,
        equalCoinName: sig.equalCoinName,
        side: sig.positionSide,
        signalSize: sig.size,
        signalPrice: sig.price,
        localQty: null,
        openRatio: null,
        expectedQty: null,
        diffQty: null,
        diffPct: null,
        openTime: null,
        localId: null,
        userId: null,
        user: null,
        accountGid,
      });
    }

    const matchFilter = String(opts.match || 'all').toLowerCase();
    const filtered =
      matchFilter === 'both' || matchFilter === 'local_only' || matchFilter === 'live_only'
        ? items.filter((i) => i.match === matchFilter)
        : items;

    return {
      accountGid,
      signalError,
      summary: {
        both: items.filter((i) => i.match === 'both').length,
        localOnly: items.filter((i) => i.match === 'local_only').length,
        liveOnly: items.filter((i) => i.match === 'live_only').length,
        signalRows: signalByKey.size,
        localRows: locals.length,
      },
      items: filtered,
      total: filtered.length,
    };
  }

  /** 从 profit_records.signalKey 解析累计已入账平仓量 */
  private parseProfitRecordedFromSignalKey(signalKey: string | null | undefined): number | null {
    if (!signalKey) return null;
    const parts = String(signalKey).split(':');
    if (parts.length < 4) return null;
    const raw = parts[parts.length - 1].replace(/_/g, '.');
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  private positionSideKey(side: string | null | undefined): 'long' | 'short' {
    return String(side || 'long').toLowerCase().includes('short') ? 'short' : 'long';
  }

  private buildPosMatchKey(parts: {
    userId: string;
    exchange: string;
    coinName: string;
    equalCoinName: string;
    positionSide: string;
  }) {
    return [
      parts.userId,
      parts.exchange,
      String(parts.coinName || '').toUpperCase(),
      String(parts.equalCoinName || '').toUpperCase(),
      this.positionSideKey(parts.positionSide),
    ].join('|');
  }

  private matchMarketPeriod(
    period: string,
    accountType: string | null | undefined,
    equalCoinName: string | null | undefined,
  ): boolean {
    const p = String(period || '').toLowerCase();
    if (!p) return true;
    const at = String(accountType || '').toLowerCase();
    const eq = String(equalCoinName || '').toUpperCase();
    if (p === 'spot') return at === 'spot';
    if (p === 'perpetual') return eq === 'PC' && at !== 'spot';
    if (p === 'delivery') return eq !== 'PC' && at !== 'spot';
    return true;
  }

  /** 已平仓 tab：profit_records 逐笔 + 可选异常清除本地持仓 */
  private async listAdminClosedPositions(opts: {
    userId?: string;
    q?: string;
    exchange?: string;
    coinName?: string;
    period?: string;
    accountGid?: string;
    /** all=利润明细+异常清除；partial|full=仅对应利润；discard=仅异常清除 */
    closedKind?: string;
    /** 兼容旧参数：true→discard；false→利润明细；all→全部 */
    abnormal?: string | boolean;
    /** profit_records.id 或异常清除 user_positions.id */
    recordId?: string;
    from?: string;
    to?: string;
  }) {
    let kind = String(opts.closedKind || '').toLowerCase();
    if (!kind) {
      const ab = opts.abnormal;
      if (ab === true || ab === 'true' || ab === '1') kind = 'discard';
      else if (ab === false || ab === 'false' || ab === '0') kind = 'all';
      else kind = 'all';
    }

    const includeDiscard = kind === 'all' || kind === 'discard';
    const includeProfit = kind !== 'discard';

    const profitWhere: Prisma.ProfitRecordWhereInput = {};
    const recordId = String(opts.recordId || '').trim();
    if (recordId) profitWhere.id = recordId;
    if (opts.exchange) profitWhere.exchange = opts.exchange as Exchange;
    if (opts.coinName?.trim()) {
      profitWhere.symbol = { contains: opts.coinName.trim().toUpperCase() };
    }
    const fromMs = this.parseDayBoundMs(opts.from, false);
    const toMs = this.parseDayBoundMs(opts.to, true);
    if (fromMs != null || toMs != null) {
      const range: Prisma.DateTimeFilter = {};
      if (fromMs != null) range.gte = new Date(fromMs);
      if (toMs != null) range.lte = new Date(toMs);
      profitWhere.closedAt = range;
    }

    const userWhere: Prisma.UserWhereInput = {};
    if (opts.userId) {
      userWhere.id = opts.userId;
    } else if (opts.q?.trim()) {
      const kw = opts.q.trim();
      const or: Prisma.UserWhereInput[] = [
        { email: { contains: kw } },
        { nickname: { contains: kw } },
      ];
      if (/^\d+$/.test(kw)) or.push({ userNo: Number(kw) });
      userWhere.OR = or;
    }
    if (Object.keys(userWhere).length) profitWhere.user = userWhere;

    const [profits, discardRows] = await Promise.all([
      includeProfit
        ? this.prisma.profitRecord.findMany({
            where: profitWhere,
            orderBy: { closedAt: 'desc' },
            include: {
              user: { select: { id: true, email: true, nickname: true, userNo: true } },
            },
            take: 2000,
          })
        : Promise.resolve(
            [] as Array<
              Prisma.ProfitRecordGetPayload<{
                include: {
                  user: { select: { id: true; email: true; nickname: true; userNo: true } };
                };
              }>
            >,
          ),
      includeDiscard
        ? this.prisma.userPosition.findMany({
            where: {
              status: UserPositionStatus.CLOSED,
              closeKind: 'DISCARD_LOCAL',
              ...(recordId ? { id: recordId } : {}),
              ...(opts.exchange ? { exchange: opts.exchange as Exchange } : {}),
              ...(opts.accountGid?.trim() ? { accountGid: opts.accountGid.trim() } : {}),
              ...(opts.coinName?.trim()
                ? { coinName: { contains: opts.coinName.trim().toUpperCase() } }
                : {}),
              ...(fromMs != null || toMs != null
                ? {
                    closedAt: {
                      ...(fromMs != null ? { gte: new Date(fromMs) } : {}),
                      ...(toMs != null ? { lte: new Date(toMs) } : {}),
                    },
                  }
                : {}),
              ...(Object.keys(userWhere).length ? { user: userWhere } : {}),
            },
            orderBy: { closedAt: 'desc' },
            include: {
              user: { select: { id: true, email: true, nickname: true, userNo: true } },
            },
            take: 500,
          })
        : Promise.resolve(
            [] as Array<
              Prisma.UserPositionGetPayload<{
                include: {
                  user: { select: { id: true; email: true; nickname: true; userNo: true } };
                };
              }>
            >,
          ),
    ]);

    const orderIds = [
      ...new Set(profits.map((p) => p.orderId).filter(Boolean)),
    ] as string[];
    const userIds = [...new Set(profits.map((p) => p.userId))];

    type AdminCloseLogPick = {
      orderId: string | null;
      userId: string;
      exchange: Exchange;
      coinName: string | null;
      equalCoinName: string | null;
      positionSide: string | null;
      accountType: string | null;
      accountGid: string | null;
      accountName: string | null;
      filledAmt: Prisma.Decimal | null;
      avgPrice: Prisma.Decimal | null;
      isOpen: boolean | null;
      requestBody: string | null;
      createdAt: Date;
    };
    type AdminPosMetaPick = {
      userId: string;
      exchange: Exchange;
      coinName: string;
      equalCoinName: string;
      positionSide: string;
      accountType: string | null;
      accountGid: string | null;
      accountName: string | null;
      leverage: Prisma.Decimal | null;
      entryPrice: Prisma.Decimal | null;
      status: UserPositionStatus;
      closedAt: Date | null;
    };

    const [closeLogs, positions] = await Promise.all([
      orderIds.length
        ? this.prisma.signalFollowLog.findMany({
            where: { orderId: { in: orderIds }, isOpen: false },
            select: {
              orderId: true,
              userId: true,
              exchange: true,
              coinName: true,
              equalCoinName: true,
              positionSide: true,
              accountType: true,
              accountGid: true,
              accountName: true,
              filledAmt: true,
              avgPrice: true,
              isOpen: true,
              requestBody: true,
              createdAt: true,
            },
          })
        : Promise.resolve([] as AdminCloseLogPick[]),
      userIds.length
        ? this.prisma.userPosition.findMany({
            where: { userId: { in: userIds } },
            select: {
              userId: true,
              exchange: true,
              coinName: true,
              equalCoinName: true,
              positionSide: true,
              accountType: true,
              accountGid: true,
              accountName: true,
              leverage: true,
              entryPrice: true,
              status: true,
              closedAt: true,
            },
          })
        : Promise.resolve([] as AdminPosMetaPick[]),
    ]);

    const closeLogByOrderId = new Map<string, AdminCloseLogPick>();
    for (const l of closeLogs) {
      if (l.orderId) closeLogByOrderId.set(String(l.orderId), l);
    }
    const closedPosByKey = new Map<string, { closedAt: Date | null }>();
    const posMetaByKey = new Map<
      string,
      {
        accountType: string | null;
        accountGid: string | null;
        accountName: string | null;
        leverage: number | null;
        entryPrice: number | null;
      }
    >();
    for (const pos of positions) {
      const key = this.buildPosMatchKey({
        userId: pos.userId,
        exchange: pos.exchange,
        coinName: pos.coinName,
        equalCoinName: pos.equalCoinName,
        positionSide: pos.positionSide,
      });
      const ep = pos.entryPrice != null ? Number(pos.entryPrice) : NaN;
      posMetaByKey.set(key, {
        accountType: pos.accountType,
        accountGid: pos.accountGid,
        accountName: pos.accountName,
        leverage: pos.leverage != null ? Number(pos.leverage) : null,
        entryPrice: Number.isFinite(ep) && ep > 0 ? ep : null,
      });
      if (pos.status === UserPositionStatus.CLOSED) {
        const cur = closedPosByKey.get(key);
        const ca = pos.closedAt?.getTime() ?? 0;
        const prev = cur?.closedAt?.getTime() ?? 0;
        if (!cur || ca >= prev) closedPosByKey.set(key, { closedAt: pos.closedAt });
      }
    }

    const profitsByPosKey = new Map<string, typeof profits>();
    for (const p of profits) {
      const log = p.orderId ? closeLogByOrderId.get(String(p.orderId)) : undefined;
      const parsed = this.parseSymbolParts(p.symbol || '');
      const coin = String(log?.coinName || parsed.coin || '').toUpperCase();
      const eq = String(log?.equalCoinName || parsed.equalCoin || '').toUpperCase();
      const side = this.positionSideKey(log?.positionSide);
      const posKey = this.buildPosMatchKey({
        userId: p.userId,
        exchange: p.exchange,
        coinName: coin,
        equalCoinName: eq,
        positionSide: side,
      });
      const arr = profitsByPosKey.get(posKey) || [];
      arr.push(p);
      profitsByPosKey.set(posKey, arr);
    }
    for (const arr of profitsByPosKey.values()) {
      arr.sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
    }

    const fullProfitIdByPosKey = new Map<string, string>();
    for (const [posKey, arr] of profitsByPosKey) {
      const closedPos = closedPosByKey.get(posKey);
      if (!closedPos?.closedAt || !arr.length) continue;
      let best = arr[0];
      let bestDiff = Math.abs(arr[0].closedAt.getTime() - closedPos.closedAt.getTime());
      for (const p of arr) {
        const d = Math.abs(p.closedAt.getTime() - closedPos.closedAt.getTime());
        if (d < bestDiff) {
          bestDiff = d;
          best = p;
        }
      }
      if (bestDiff <= 120_000) fullProfitIdByPosKey.set(posKey, best.id);
    }

    const profitsByOrderId = new Map<string, typeof profits>();
    for (const p of profits) {
      if (!p.orderId) continue;
      const oid = String(p.orderId);
      const arr = profitsByOrderId.get(oid) || [];
      arr.push(p);
      profitsByOrderId.set(oid, arr);
    }
    const profitQtyById = new Map<string, number>();
    for (const arr of profitsByOrderId.values()) {
      arr.sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
      let prevRecorded = 0;
      for (const p of arr) {
        const recorded = this.parseProfitRecordedFromSignalKey(p.signalKey);
        if (recorded == null) continue;
        profitQtyById.set(p.id, Math.max(0, recorded - prevRecorded));
        prevRecorded = recorded;
      }
    }

    const period = String(opts.period || '').toLowerCase();
    const accountGidFilter = opts.accountGid?.trim() || '';
    const profitItems: Array<ReturnType<TradeService['mapUserPositionRow']> & {
      userId: string;
      user: (typeof profits)[0]['user'];
      recordKind: 'PROFIT';
    }> = [];

    for (const p of profits) {
      const log = p.orderId ? closeLogByOrderId.get(String(p.orderId)) : undefined;
      const parsed = this.parseSymbolParts(p.symbol || '');
      const coin = String(log?.coinName || parsed.coin || '').toUpperCase();
      const eq = String(log?.equalCoinName || parsed.equalCoin || 'USDT').toUpperCase();
      const side = this.positionSideKey(log?.positionSide);
      const posKey = this.buildPosMatchKey({
        userId: p.userId,
        exchange: p.exchange,
        coinName: coin,
        equalCoinName: eq,
        positionSide: side,
      });
      const meta = posMetaByKey.get(posKey);
      const accountType = log?.accountType ?? meta?.accountType ?? null;
      const accountGid = log?.accountGid ?? meta?.accountGid ?? null;
      const accountName = log?.accountName ?? meta?.accountName ?? null;

      if (period && !this.matchMarketPeriod(period, accountType, eq)) continue;
      if (accountGidFilter && String(accountGid || '') !== accountGidFilter) continue;

      const closeKind =
        fullProfitIdByPosKey.get(posKey) === p.id ? 'FULL' : 'PARTIAL';
      if (kind === 'partial' && closeKind !== 'PARTIAL') continue;
      if (kind === 'full' && closeKind !== 'FULL') continue;

      const closeQty = profitQtyById.get(p.id);
      const at = String(accountType || '').toLowerCase();
      const mode =
        at === 'spot' ? '现货' : eq === 'PC' || !eq ? '永续合约' : '交割合约';
      const symbol = eq ? `${coin}/${eq}` : coin;
      const closeAvg = log?.avgPrice != null ? Number(log.avgPrice) : null;
      const entryRaw = meta?.entryPrice != null ? Number(meta.entryPrice) : NaN;
      const entryPrice =
        Number.isFinite(entryRaw) && entryRaw > 0
          ? Number(
              formatDisplayPrice(entryRaw, this.symbols.peek(
                toApiCode(p.exchange, at === 'spot' ? 'spot' : 'future'),
                coin,
                eq || (at === 'spot' ? 'USDT' : 'PC'),
              )) || entryRaw,
            )
          : null;

      profitItems.push({
        id: p.id,
        recordKind: 'PROFIT',
        exchange: p.exchange,
        symbol,
        coinName: coin,
        equalCoinName: eq || null,
        pair: symbol,
        mode,
        accountType: accountType || (at === 'spot' ? 'spot' : 'future'),
        accountGid,
        accountName,
        side,
        amount: closeQty != null && closeQty > 0 ? String(Math.round(closeQty * 1e10) / 1e10) : '—',
        entryPrice,
        markPrice: null,
        leverage: meta?.leverage ?? null,
        liquidationPrice: '—',
        margin: '—',
        pnl: String(p.profit),
        realizedPnl: String(p.profit),
        openTime: '',
        closeTime: p.closedAt.toISOString(),
        holdDuration: '',
        status: UserPositionStatus.CLOSED,
        abnormal: false,
        closeFailCount: 0,
        lastCloseFailAt: null,
        lastCloseFailAmt: null,
        lastCloseFailMsg: null,
        lastCloseOkAt: null,
        lastCloseOkAmt: null,
        abnormalAt: null,
        closeRetryStopAt: null,
        closeRetryStopped: false,
        closeKind,
        discardedLocal: false,
        orderId: p.orderId,
        orderIds: p.orderId ? [p.orderId] : [],
        lastFollowSignal: log ? this.parseFollowSignalFromLog(log) : null,
        userId: p.userId,
        user: p.user,
        ...(closeAvg != null && Number.isFinite(closeAvg) && closeAvg > 0
          ? { closeAvgPrice: closeAvg }
          : {}),
      } as any);
    }

    let discardItems: Array<
      ReturnType<TradeService['mapUserPositionRow']> & {
        userId: string;
        user: { id: string; email: string; nickname: string | null; userNo: number | null };
        recordKind: 'POSITION';
      }
    > = [];
    if (includeDiscard && kind !== 'partial' && kind !== 'full') {
      discardItems = discardRows
        .filter((r) => {
          if (period && !this.matchMarketPeriod(period, r.accountType, r.equalCoinName)) {
            return false;
          }
          return true;
        })
        .map((r) => ({
          ...this.mapUserPositionRow(r),
          userId: r.userId,
          user: r.user,
          recordKind: 'POSITION',
        }));
      for (const item of discardItems) {
        item.realizedPnl = null;
        item.orderId = null;
        item.orderIds = [];
      }
    }

    const items = [...profitItems, ...discardItems].sort((a, b) => {
      const ta = Date.parse(String(a.closeTime || '')) || 0;
      const tb = Date.parse(String(b.closeTime || '')) || 0;
      return tb - ta;
    });

    // 利润行缺开仓均价时：用开仓查单均价加权补齐（平仓查单均价在 closeAvgPrice）
    await this.attachClosedExtras(items as any);

    return {
      items,
      errors: [] as { userId?: string; email?: string; exchange?: string; message: string }[],
      scannedUsers: new Set(items.map((i) => i.userId)).size,
      total: items.length,
      status: 'CLOSED',
    };
  }

  async listAdminPositions(opts: {
    userId?: string;
    q?: string;
    exchange?: string;
    coinName?: string;
    period?: string;
    accountGid?: string;
    /** OPEN | CLOSED，默认 OPEN */
    status?: string;
    /** OPEN 时：true=仅异常；false/缺省=仅正常；传 all 则不过滤。
     *  CLOSED 时（兼容）：true=仅异常清除；false/缺省=利润明细+异常清除；all=同上 */
    abnormal?: string | boolean;
    /** CLOSED 时：all | partial | full | discard */
    closedKind?: string;
    /** user_positions.id 或 profit_records.id（已平仓） */
    recordId?: string;
    /** 开仓/平仓时间起 YYYY-MM-DD */
    from?: string;
    /** 开仓/平仓时间止 YYYY-MM-DD */
    to?: string;
  }) {
    const closed =
      String(opts.status || 'OPEN').toUpperCase() === UserPositionStatus.CLOSED;
    if (closed) {
      return this.listAdminClosedPositions(opts);
    }
    const where: Prisma.UserPositionWhereInput = {
      status: UserPositionStatus.OPEN,
    };
    const recordId = String(opts.recordId || '').trim();
    if (recordId) {
      where.id = recordId;
    }
    const ab = opts.abnormal;
    where.qty = { gt: 0 };
    if (ab === true || ab === 'true' || ab === '1') where.abnormal = true;
    else if (ab === 'all') {
      /* both */
    } else where.abnormal = false;
    if (opts.exchange) where.exchange = opts.exchange as Exchange;
    if (opts.accountGid?.trim()) where.accountGid = opts.accountGid.trim();
    if (opts.coinName?.trim()) {
      where.coinName = { contains: opts.coinName.trim().toUpperCase() };
    }

    const period = String(opts.period || '').toLowerCase();
    if (period === 'spot') {
      where.accountType = 'spot';
    } else if (period === 'perpetual') {
      where.equalCoinName = 'PC';
      where.NOT = { accountType: 'spot' };
    } else if (period === 'delivery') {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { NOT: { equalCoinName: 'PC' } },
        { NOT: { accountType: 'spot' } },
      ];
    }

    const fromMs = this.parseDayBoundMs(opts.from, false);
    const toMs = this.parseDayBoundMs(opts.to, true);
    if (fromMs != null || toMs != null) {
      const range: Prisma.DateTimeNullableFilter = {};
      if (fromMs != null) range.gte = new Date(fromMs);
      if (toMs != null) range.lte = new Date(toMs);
      where.openedAt = range;
    }

    const userWhere: Prisma.UserWhereInput = {};
    if (opts.userId) {
      userWhere.id = opts.userId;
    } else if (opts.q?.trim()) {
      const kw = opts.q.trim();
      const or: Prisma.UserWhereInput[] = [
        { email: { contains: kw } },
        { nickname: { contains: kw } },
      ];
      if (/^\d+$/.test(kw)) or.push({ userNo: Number(kw) });
      userWhere.OR = or;
    }
    if (Object.keys(userWhere).length) {
      where.user = userWhere;
    }

    const rows = await this.prisma.userPosition.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, nickname: true, userNo: true } },
      },
      take: 2000,
    });

    this.kickoffPositionMarkPrices(rows);

    const items = rows.map((r) => ({
      ...this.mapUserPositionRow(r),
      userId: r.userId,
      user: r.user,
    }));

    return {
      items,
      errors: [] as { userId?: string; email?: string; exchange?: string; message: string }[],
      scannedUsers: new Set(rows.map((r) => r.userId)).size,
      total: items.length,
      status: 'OPEN',
    };
  }

  /**
   * 管理端/对账市价平仓。中间件无独立 ClosePosition，走 PlaceOrder(isOpen=false) + 内存标记价。
   * 对账没价不打单、不记失败，等后台盘口线程刷到再平。
   * 手动市价平：中间件正常回包但业务失败（successed=false / 失败文案）→ 立刻标异常持仓。
   * 成功后写平仓流水、配对盈亏/扣点分佣，并同步本地持仓。
   */
  async adminClosePosition(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName?: string;
    symbol?: string;
    positionSide: string;
    amount: number | string;
    accountType?: string;
    accountGid?: string;
    accountName?: string;
    leverage?: number | string;
    /** ADMIN_CLOSE | RECONCILE_ORPHAN | RECONCILE_EXCESS */
    source?: string;
    remark?: string;
  }) {
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('平仓数量须大于 0');
    }
    const coinName = String(params.coinName || '').trim().toUpperCase();
    if (!coinName) throw new BadRequestException('缺少币名');
    const side = String(params.positionSide || '').toLowerCase();
    if (!side.includes('long') && !side.includes('short')) {
      throw new BadRequestException('持仓方向无效（long/short）');
    }
    const positionSide = side.includes('short') ? 'short' : 'long';
    const equal = String(params.equalCoinName || 'PC').trim().toUpperCase() || 'PC';
    const symbol = String(params.symbol || `${coinName}/${equal}`).trim();
    const accountType = params.accountType || 'future';
    const source = String(params.source || 'ADMIN_CLOSE').trim() || 'ADMIN_CLOSE';
    const remark =
      String(params.remark || '').trim() ||
      (source.startsWith('RECONCILE') ? '仓位对账市价平仓' : '管理端手动市价平仓');
    const isManualClose = !source.startsWith('RECONCILE');

    // 展示用主账户：优先入参（持仓上的信号账户），否则从本地持仓/跟单模板补齐
    let displayGid = String(params.accountGid || '').trim();
    let displayName = String(params.accountName || '').trim();
    if (!displayGid || !displayName) {
      const pos = await this.prisma.userPosition.findFirst({
        where: {
          userId: params.userId,
          exchange: params.exchange,
          coinName,
          equalCoinName: equal,
          positionSide,
        },
        select: { accountGid: true, accountName: true },
      });
      displayGid = displayGid || String(pos?.accountGid || '').trim();
      displayName = displayName || String(pos?.accountName || '').trim();
    }
    if (!displayGid || !displayName) {
      const cfg = await this.prisma.userFollowConfig.findFirst({
        where: { userId: params.userId, exchange: params.exchange },
        include: { template: { select: { accountGid: true, accountName: true } } },
      });
      displayGid = displayGid || String(cfg?.template?.accountGid || '').trim();
      displayName = displayName || String(cfg?.template?.accountName || '').trim();
    }

    // 持仓上的 accountGid 是信号主账户，不能带入 PlaceOrder.account.gid
    const openPosId = await this.findOpenPositionId({
      userId: params.userId,
      exchange: params.exchange,
      coinName,
      equalCoinName: equal,
      positionSide,
    });

    let place: any;
    try {
      place = await this.placeOrder(params.userId, {
        exchange: params.exchange,
        symbol,
        side: 'close',
        orderType: 'market',
        accountType,
        amount,
        positionSide,
        coinName,
        equalCoinName: equal,
        leverage: params.leverage,
        isOpen: false,
        skipTradePassword: true,
      });
    } catch (e: any) {
      // Nest 包装时 e.message 常是「Bad Request Exception」，须用 formatTradeError 取交易所/中间件原因
      const failMsg = formatTradeError(e);
      if (source.startsWith('RECONCILE') && this.isWaitMarkPriceError(e)) {
        throw e;
      }
      if (openPosId) {
        // 手动：中间件正常回包但业务失败 → 立刻异常；对账仍累计次数
        const markNow =
          isManualClose && this.isPlaceOrderBusinessFailure(e);
        await this.recordPositionCloseFailure(openPosId, failMsg, amount, {
          markAbnormalNow: markNow,
        });
        // 管理端 toast：失败原因 + 已进异常仓
        if (markNow) {
          const reason =
            failMsg.replace(/^(平仓失败|开仓失败)[:：]\s*/i, '').trim() || failMsg;
          throw new BadRequestException(
            `平仓失败：${reason}。该持仓已进入异常持仓。`,
          );
        }
      } else {
        this.logger.warn(
          `${source} 平仓失败 user=${params.userId} ${params.exchange} ${coinName} ${positionSide} amt=${amount}: ${failMsg}`,
        );
      }
      throw e;
    }
    const data: any = place?.data ?? place;
    const orderId = extractPlaceOrderId(data);
    if (!orderId) {
      const noId = '平仓失败: 未返回订单号（successed 不为 true）';
      if (openPosId) {
        await this.recordPositionCloseFailure(openPosId, noId, amount, {
          markAbnormalNow: isManualClose,
        });
        if (isManualClose) {
          const reason = noId.replace(/^(平仓失败)[:：]\s*/i, '').trim() || noId;
          throw new BadRequestException(
            `平仓失败：${reason}。该持仓已进入异常持仓。`,
          );
        }
      }
      throw new BadRequestException(noId);
    }
    if (openPosId) {
      await this.recordPositionCloseSuccess(openPosId, amount);
    }

    const signalKey = `${source.toLowerCase()}:${orderId}:close`;
    const orderGid = orderId;

    const log = await this.prisma.signalFollowLog.create({
      data: {
        orderGid,
        signalKey,
        userId: params.userId,
        exchange: params.exchange,
        status: 'PLACED',
        success: true,
        orderId,
        symbol,
        side: 'close',
        orderType: 'market',
        accountType,
        accountGid: displayGid || undefined,
        accountName: displayName || undefined,
        coinName,
        equalCoinName: equal,
        positionSide,
        isOpen: false,
        orderAmt: amount,
        cancelMsg: remark,
        responseBody: JSON.stringify(data ?? place).slice(0, 8000),
        requestBody: JSON.stringify({
          source,
          coinName,
          equalCoinName: equal,
          positionSide,
          amount,
          orderId,
          remark,
        }),
      },
    });

    const q = await this.inspectOrderFill(params.userId, params.exchange, orderId, {
      symbol,
      accountType,
      coinName,
      equalCoinName: equal,
      isOpen: false,
    });
    const applied = await this.applyFillFromQuery(log, q);
    let profitResult: { recorded: boolean; profit?: number; reason?: string } = {
      recorded: applied.recorded,
      profit: applied.profit,
      reason: applied.reason,
    };

    return {
      ...place,
      orderId,
      localSynced: true,
      profit: profitResult,
    };
  }

  /**
   * 平仓失败累计：达阈值标为异常持仓。
   * POSITION_CLOSE_FAIL_ABNORMAL_COUNT（默认 60）
   * POSITION_ABNORMAL_STOP_HOURS（默认 24，异常后自动重试截止）
   */
  private closeFailAbnormalThreshold(): number {
    return Math.max(1, Number(process.env.POSITION_CLOSE_FAIL_ABNORMAL_COUNT || 60));
  }

  private abnormalRetryStopHours(): number {
    return Math.max(1, Number(process.env.POSITION_ABNORMAL_STOP_HOURS || 24));
  }

  async recordPositionCloseFailure(
    positionId: string,
    message: string,
    amount?: number,
    opts?: { markAbnormalNow?: boolean },
  ) {
    const id = String(positionId || '').trim();
    if (!id) return;
    const msg = String(message || '').slice(0, 2000);
    const row = await this.prisma.userPosition.findUnique({ where: { id } });
    if (!row || row.status !== UserPositionStatus.OPEN) return;
    const next = (row.closeFailCount || 0) + 1;
    const threshold = this.closeFailAbnormalThreshold();
    const now = new Date();
    const amt = Number(amount);
    const hasAmt = Number.isFinite(amt) && amt > 0;
    const markNow = !!opts?.markAbnormalNow;
    // 同一轮失败：覆盖最后数量+时间+原因。成功清掉。
    const data: Prisma.UserPositionUpdateInput = {
      closeFailCount: next,
      lastCloseFailAt: now,
      lastCloseFailMsg: msg || null,
      ...(hasAmt ? { lastCloseFailAmt: amt } : {}),
    };
    this.logger.warn(
      `平仓失败 user=${row.userId} ${row.coinName} ${row.positionSide}` +
        (hasAmt ? ` amt=${amt}` : '') +
        ` n=${next}` +
        (markNow ? ' (手动业务失败→立刻异常)' : '') +
        `: ${msg}`,
    );
    if (!row.abnormal && (markNow || next >= threshold)) {
      data.abnormal = true;
      data.abnormalAt = now;
      data.closeRetryStopAt = new Date(
        now.getTime() + this.abnormalRetryStopHours() * 3600_000,
      );
      this.logger.warn(
        `持仓标为异常 id=${id} user=${row.userId} ${row.coinName} ${row.positionSide} fail=${next}` +
          (markNow ? ' reason=manual-business-fail' : '') +
          ` stopAt=${(data.closeRetryStopAt as Date).toISOString()}`,
      );
    }
    await this.prisma.userPosition.update({ where: { id }, data });
  }

  /** 中间件 HTTP 通了，但 PlaceOrder 业务失败（successed=false / 失败文案在 orderID） */
  private isPlaceOrderBusinessFailure(err: unknown): boolean {
    if (err instanceof BadRequestException) return true;
    const msg = String((err as any)?.message || err || '');
    return /平仓失败|开仓失败|successed|未返回订单号|接口错误|ReduceOnly|position|持仓|不够|不足/i.test(
      msg,
    );
  }

  /** 平成功：另记成功数量+时间，不擦失败痕迹。只摘掉异常重试标记。 */
  async recordPositionCloseSuccess(positionId: string, amount?: number) {
    const id = String(positionId || '').trim();
    if (!id) return;
    const amt = Number(amount);
    const hasAmt = Number.isFinite(amt) && amt > 0;
    await this.prisma.userPosition.updateMany({
      where: { id, status: UserPositionStatus.OPEN },
      data: {
        lastCloseOkAt: new Date(),
        ...(hasAmt ? { lastCloseOkAmt: amt } : {}),
        abnormal: false,
        abnormalAt: null,
        closeRetryStopAt: null,
      },
    });
  }

  async clearPositionCloseFailures(positionId: string) {
    const id = String(positionId || '').trim();
    if (!id) return;
    await this.prisma.userPosition.updateMany({
      where: { id },
      data: {
        closeFailCount: 0,
        lastCloseFailAt: null,
        lastCloseFailAmt: null,
        lastCloseFailMsg: null,
        lastCloseOkAt: null,
        lastCloseOkAmt: null,
        abnormal: false,
        abnormalAt: null,
        closeRetryStopAt: null,
      },
    });
  }

  private async findOpenPositionId(params: {
    userId: string;
    exchange: Exchange;
    coinName: string;
    equalCoinName: string;
    positionSide: string;
  }): Promise<string | null> {
    const row = await this.prisma.userPosition.findFirst({
      where: {
        userId: params.userId,
        exchange: params.exchange,
        coinName: params.coinName,
        equalCoinName: params.equalCoinName,
        positionSide: params.positionSide,
        status: UserPositionStatus.OPEN,
        qty: { gt: 0 },
      },
      select: { id: true },
    });
    return row?.id || null;
  }

  /**
   * 运维：异常仓「删除」为死仓——本地 CLOSED + DISCARD_LOCAL，不向交易所下单。
   * 不再参与定时重试平仓；不计利润。保留 lastCloseFailMsg 供列表展示进入异常的原因。
   * 正常持仓不可删，须先标为异常。
   */
  async adminDiscardLocalPositions(ids: string[]) {
    const uniq = [
      ...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean)),
    ];
    if (uniq.length === 0) {
      throw new BadRequestException('请选择要删除的异常持仓');
    }
    const now = new Date();
    const result = await this.prisma.userPosition.updateMany({
      where: {
        id: { in: uniq },
        status: UserPositionStatus.OPEN,
        abnormal: true,
      },
      data: {
        status: UserPositionStatus.CLOSED,
        qty: 0,
        closedAt: now,
        closeKind: 'DISCARD_LOCAL',
        // 保留失败次数/原因/时间，便于已平仓「异常清除」核对死仓来源
        lastCloseOkAt: null,
        lastCloseOkAmt: null,
        abnormal: false,
        closeRetryStopAt: null,
      },
    });
    const skipped = uniq.length - result.count;
    this.logger.log(
      `删除异常死仓 ${result.count}/${uniq.length} 条（不计利润、停重试）` +
        (skipped ? `（跳过非异常 ${skipped}）` : ''),
    );
    return {
      ok: true as const,
      requested: uniq.length,
      discarded: result.count,
      skippedNonAbnormal: skipped,
    };
  }

  /** YYYY-MM-DD → 当天起/止毫秒 */
  private parseDayBoundMs(day?: string, endOfDay = false): number | null {
    const s = String(day || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    if (endOfDay) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private parseOpenTimeMs(v: any): number | null {
    if (v == null || v === '' || v === '—') return null;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v > 1e12 ? v : v > 1e9 ? v * 1000 : v;
    }
    const n = Date.parse(String(v));
    return Number.isFinite(n) ? n : null;
  }

  /** period: spot | perpetual | delivery */
  private matchPositionPeriod(p: any, period: string): boolean {
    if (!period) return true;
    const at = String(p.accountType || '').toLowerCase();
    const eq = String(p.equalCoinName || '').toUpperCase();
    const mode = String(p.mode || '');
    if (period === 'spot') {
      return at === 'spot' || mode.includes('现货');
    }
    if (period === 'perpetual') {
      return eq === 'PC' || mode.includes('永续') || (at !== 'spot' && !eq);
    }
    if (period === 'delivery') {
      return (
        (at === 'future' || at === 'futures' || mode.includes('交割')) &&
        eq !== 'PC' &&
        !!eq
      );
    }
    return true;
  }

  private normalizeBalance(exchange: Exchange, data: any) {
    // 文档 CoinAssetInfo: coinName / free / locked / interest / borrowed / net
    const list = this.asArray(data);
    if (list.length) {
      return {
        exchange,
        assets: list.map((a) => {
          const free = Number(a.free ?? a.available ?? a.availBal ?? 0);
          const locked = Number(a.locked ?? a.frozen ?? 0);
          const net = a.net != null ? Number(a.net) : free + locked;
          return {
            asset: a.coinName || a.asset || a.coin || a.currency || a.symbolName || a.symbol,
            free: String(free),
            total: String(a.total ?? a.balance ?? a.eq ?? net ?? free),
          };
        }),
        raw: data,
      };
    }
    return { exchange, assets: [], raw: data };
  }
}
