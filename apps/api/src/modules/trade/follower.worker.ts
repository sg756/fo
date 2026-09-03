import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatTradeError, extractPlaceOrderId } from '../../common/trade-error';
import { TradeService } from './trade.service';
import { MapiClient } from './mapi.client';
import { fromApiCode, accountTypeFromEqualCoin } from './exchange-codes';
import { canAttemptRemainderCancel, isQueryFillUsable } from './order-fill.util';

const CFG_SIGNAL_TIMEOUT = 'signal_timeout_seconds'; // 旧：秒
const CFG_SIGNAL_TIMEOUT_MS = 'signal_timeout_ms'; // 新：毫秒
const CFG_POLL_MS = 'follower_poll_ms';
const CFG_ORDER_EXPIRE = 'order_expire_seconds';
const CFG_CHASE_ON_EXPIRE = 'chase_on_expire';
/** 管理端「关闭跟单」：勾选后自动跟单不再下任何新单（含开/平/追入） */
const CFG_FOLLOW_HALTED = 'follow_halted';

type NormalizedSignal = {
  orderGID: string; // 仓位/信号 GUID (幂等: orderGID + userId)
  accountGID: string; // LastOrderRecords 顶层账户 GID
  exchange: Exchange;
  apiCode: string; // 信号原生 apiCode (如 bac)
  coinName: string;
  equalCoinName: string;
  symbol: string; // COIN/EQUAL
  accountType: string; // spot / future
  isOpen: boolean; // open/buy=true, close/sell=false
  orderSide: string; // open/close/buy/sell
  positionSide: string; // long/short
  orderType: string; // market/limit
  price?: string | number;
  amount: string | number;
  /** 信号时间戳 ms */
  signalAt: number | null;
  raw: any;
};

/**
 * 实时采集 :1820 LastOrderRecords 信号 (默认每 500ms, 间隔后台可调)。
 * 拉包与 JSON.parse 在工作线程完成后再回到主线程过滤/下单。
 * 仅对「审核通过 + 已点开始交易 + 已配置对应交易所 Key」的用户跟单。
 * 信号时间戳超过配置超时(默认60s)则作废。
 * 挂单超过 order_expire_seconds 未成交则自动撤单并更新状态。
 * 平仓撤单后 / 定时对账：按信号账户 Positions 做独有强平 + 多的平（市价）。
 */
@Injectable()
export class FollowerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FollowerWorker.name);
  private running = false;
  private cancelRunning = false;
  private reconcileRunning = false;
  /** 同一 orderId 查单/撤余串行，避免并发双记增量 */
  private fillChains = new Map<string, Promise<void>>();
  private abnormalReconcileRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cancelTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private abnormalReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private pollMs = 500;

  constructor(
    private prisma: PrismaService,
    private trade: TradeService,
    private mapi: MapiClient,
  ) {}

  async onModuleInit() {
    if (!this.enabled()) {
      this.logger.warn('FollowerWorker 已禁用 (FOLLOWER_ENABLED=false)');
      return;
    }
    this.pollMs = await this.getPollMs();
    this.startTimer(this.pollMs);
    this.startCancelTimer();
    this.startReconcileTimer();
    this.startAbnormalReconcileTimer();
    this.logger.log(
      `FollowerWorker 已启动: 轮询=${this.pollMs}ms, 信号超时=${await this.getSignalTimeoutMs()}ms, ` +
        `挂单过期=${await this.getOrderExpireSec()}s, 仓位对账=${this.getReconcileMs()}ms, ` +
        `异常仓重试=${this.getAbnormalReconcileMs()}ms`,
    );
  }

  onModuleDestroy() {
    this.stopTimer();
    if (this.cancelTimer) {
      clearInterval(this.cancelTimer);
      this.cancelTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.abnormalReconcileTimer) {
      clearInterval(this.abnormalReconcileTimer);
      this.abnormalReconcileTimer = null;
    }
  }

  private enabled(): boolean {
    return (process.env.FOLLOWER_ENABLED || 'true').toLowerCase() !== 'false';
  }

  private startTimer(ms: number) {
    this.stopTimer();
    this.pollMs = Math.max(100, ms); // 下限 100ms 防打爆
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 挂单成交检测 + 过期撤单巡检 (默认 8s) */
  private startCancelTimer() {
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    const ms = Math.max(500, Number(process.env.ORDER_WATCH_MS || process.env.ORDER_EXPIRE_CHECK_MS || 8000));
    this.cancelTimer = setInterval(() => void this.tickOrderWatch(), ms);
  }

  /** 仓位对账兜底周期，默认 60s；可用 POSITION_RECONCILE_MS 覆盖 */
  private getReconcileMs(): number {
    return Math.max(10_000, Number(process.env.POSITION_RECONCILE_MS || 60_000));
  }

  private startReconcileTimer() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    const ms = this.getReconcileMs();
    this.reconcileTimer = setInterval(() => void this.tickPositionReconcile(), ms);
  }

  private async tickPositionReconcile() {
    if (!this.enabled()) return;
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      await this.trade.reconcileAllOpenPositions('cron');
    } catch (e: any) {
      this.logger.warn(`定时仓位对账异常: ${e?.message || e}`);
    } finally {
      this.reconcileRunning = false;
    }
  }

  /** 异常持仓重试周期，默认 5 分钟 */
  private getAbnormalReconcileMs(): number {
    return Math.max(60_000, Number(process.env.POSITION_ABNORMAL_RETRY_MS || 5 * 60_000));
  }

  private startAbnormalReconcileTimer() {
    if (this.abnormalReconcileTimer) clearInterval(this.abnormalReconcileTimer);
    const ms = this.getAbnormalReconcileMs();
    this.abnormalReconcileTimer = setInterval(
      () => void this.tickAbnormalPositionReconcile(),
      ms,
    );
  }

  private async tickAbnormalPositionReconcile() {
    if (!this.enabled()) return;
    if (this.abnormalReconcileRunning) return;
    this.abnormalReconcileRunning = true;
    try {
      await this.trade.reconcileAbnormalOpenPositions('abnormal-cron');
    } catch (e: any) {
      this.logger.warn(`异常持仓定时重试异常: ${e?.message || e}`);
    } finally {
      this.abnormalReconcileRunning = false;
    }
  }

  /** 平仓单撤单后触发对该用户+币+方向对账 */
  private maybeReconcileAfterCloseCancel(
    row: {
      userId: string;
      exchange: Exchange;
      coinName?: string | null;
      equalCoinName?: string | null;
      positionSide?: string | null;
      accountGid?: string | null;
      isOpen?: boolean | null;
      requestBody?: string | null;
    },
    reason: string,
  ) {
    let meta: any = {};
    try {
      meta = row.requestBody ? JSON.parse(row.requestBody) : {};
    } catch {
      meta = {};
    }
    const isOpen = row.isOpen != null ? row.isOpen : meta.isOpen != null ? !!meta.isOpen : undefined;
    // 仅平仓单；开仓撤单不对账
    if (isOpen === true) return;
    const coinName = row.coinName || meta.coinName;
    if (!coinName) return;
    this.trade.scheduleReconcileAfterCloseCancel({
      userId: row.userId,
      exchange: row.exchange,
      coinName,
      equalCoinName: row.equalCoinName || meta.equalCoinName,
      positionSide: row.positionSide || meta.positionSide,
      accountGid: row.accountGid || meta.accountGid || meta.accountGID,
      reason,
    });
  }

  /**
   * 我方「挂单过期」撤单且未成交：若管理端开启 chaseOnExpire，按原方向市价再挂一笔。
   * 不含交易所/中间件侧已撤（那些不追）。
   * @returns true=已尝试追单；false=未开启或不满足
   */
  private async maybeChaseAfterExpire(row: {
    id: string;
    userId: string;
    exchange: Exchange;
    signalKey?: string | null;
    orderGid?: string | null;
    orderId?: string | null;
    symbol?: string | null;
    side?: string | null;
    accountType?: string | null;
    accountGid?: string | null;
    accountName?: string | null;
    coinName?: string | null;
    equalCoinName?: string | null;
    positionSide?: string | null;
    isOpen?: boolean | null;
    filledAmt?: any;
    requestBody?: string | null;
    user?: { email?: string | null };
  }): Promise<boolean> {
    if (await this.getFollowHalted()) return false;
    if (!(await this.getChaseOnExpire())) return false;

    let meta: any = {};
    try {
      meta = row.requestBody ? JSON.parse(row.requestBody) : {};
    } catch {
      meta = {};
    }

    const ordered = Number(meta.amount ?? meta.followAmount ?? 0);
    const filled = Number(row.filledAmt ?? meta.filledAmt ?? 0);
    const amount = Number.isFinite(ordered)
      ? Math.max(0, ordered - (Number.isFinite(filled) && filled > 0 ? filled : 0))
      : 0;
    if (!Number.isFinite(amount) || amount <= 0) {
      this.logger.warn(
        `市价追入跳过：无有效数量 user=${row.user?.email || row.userId} log=${row.id}`,
      );
      return false;
    }

    const coinName = String(row.coinName || meta.coinName || '')
      .trim()
      .toUpperCase();
    const equalCoinName = String(row.equalCoinName || meta.equalCoinName || 'PC')
      .trim()
      .toUpperCase() || 'PC';
    if (!coinName) {
      this.logger.warn(`市价追入跳过：无币名 user=${row.user?.email || row.userId} log=${row.id}`);
      return false;
    }

    const isOpen =
      row.isOpen != null ? !!row.isOpen : meta.isOpen != null ? !!meta.isOpen : true;
    const positionSide = String(row.positionSide || meta.positionSide || 'long')
      .toLowerCase()
      .includes('short')
      ? 'short'
      : 'long';
    const orderSide =
      String(row.side || meta.orderSide || '').toLowerCase() || (isOpen ? 'open' : 'close');
    const symbol = String(row.symbol || meta.symbol || `${coinName}/${equalCoinName}`);
    const accountType = row.accountType || meta.accountType || 'future';
    const baseKey = String(row.signalKey || row.orderGid || row.orderId || row.id);
    const signalKey = `chase:${baseKey}`.slice(0, 180);
    const orderGid = String(row.orderGid || `chase-${row.orderId || row.id}`);
    const clientOrderId = `ch_${signalKey}`.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);

    try {
      await this.prisma.signalFollowLog.create({
        data: {
          orderGid,
          signalKey,
          userId: row.userId,
          exchange: row.exchange,
          status: 'PENDING',
          success: false,
          symbol,
          side: orderSide,
          orderType: 'market',
          accountType,
          accountGid: row.accountGid || meta.accountGid || meta.accountGID || undefined,
          accountName: row.accountName || meta.accountName || undefined,
          coinName,
          equalCoinName,
          positionSide,
          isOpen,
          requestBody: JSON.stringify({
            source: 'chase_on_expire',
            fromLogId: row.id,
            fromOrderId: row.orderId,
            amount,
            coinName,
            equalCoinName,
            symbol,
            orderSide,
            positionSide,
            isOpen,
            chasedAt: new Date().toISOString(),
          }),
        },
      });
    } catch (e: any) {
      // 已追过（幂等键冲突）则视为已处理
      if (String(e?.code || '') === 'P2002') {
        this.logger.log(`市价追入已存在跳过 signalKey=${signalKey}`);
        return true;
      }
      this.logger.warn(`市价追入建流水失败: ${e?.message || e}`);
      return false;
    }

    try {
      const result = await this.trade.placeOrder(row.userId, {
        exchange: row.exchange,
        symbol,
        side: orderSide,
        orderType: 'market',
        accountType,
        amount,
        positionSide,
        coinName,
        equalCoinName,
        isOpen,
        clientOrderId,
        skipTradePassword: true,
      });
      const orderId = extractPlaceOrderId(result?.data ?? result);
      await this.prisma.signalFollowLog.update({
        where: { signalKey_userId: { signalKey, userId: row.userId } },
        data: {
          success: true,
          status: 'PLACED',
          orderId: orderId || undefined,
          clientOrderId,
          responseBody: JSON.stringify(result?.data ?? result).slice(0, 8000),
          // 市价追入不再二次过期撤单
          expiresAt: null,
        },
      });
      this.logger.log(
        `市价追入已挂 user=${row.user?.email || row.userId} ${coinName} ${positionSide} ` +
          `${isOpen ? '开' : '平'} amt=${amount} orderId=${orderId || '—'}`,
      );
      return true;
    } catch (e: any) {
      const reason = formatTradeError(e);
      await this.prisma.signalFollowLog.update({
        where: { signalKey_userId: { signalKey, userId: row.userId } },
        data: {
          success: false,
          status: 'FAILED',
          errorMsg: reason.slice(0, 2000),
          responseBody:
            e?.responseBody != null
              ? JSON.stringify(e.responseBody).slice(0, 8000)
              : undefined,
        },
      });
      this.logger.warn(
        `市价追入失败 user=${row.user?.email || row.userId} ${coinName}: ${reason}`,
      );
      // 已尝试追单；平仓失败仍可走对账兜底
      if (!isOpen) {
        this.maybeReconcileAfterCloseCancel(row, 'EXPIRED_CHASE_FAIL');
      }
      return true;
    }
  }

  async getConfig() {
    const signalTimeoutMs = await this.getSignalTimeoutMs();
    return {
      pollMs: await this.getPollMs(),
      signalTimeoutMs,
      /** @deprecated 兼容旧前端，等于 ms/1000 */
      signalTimeoutSec: signalTimeoutMs / 1000,
      orderExpireSec: await this.getOrderExpireSec(),
      chaseOnExpire: await this.getChaseOnExpire(),
      followHalted: await this.getFollowHalted(),
      placeOrderTimeoutMs: Number(process.env.TRADE_REQUEST_TIMEOUT_MS || 15000),
      enabled: this.enabled(),
      openMinPointBalance: await this.trade.getOpenMinPointBalance(),
    };
  }

  /**
   * 后台「跟单信号」预览：直拉 LastOrderRecords，只按中间件账号列表过滤；
   * 不落库、不按金额门槛过滤、不触发下单。
   */
  async previewSignals() {
    const signalTimeoutMs = await this.getSignalTimeoutMs();
    const { allowedGids, nameByGid, listOk, listError } = await this.loadAccountWhitelist();
    if (!listOk) {
      return {
        ok: false,
        message: listError || '无法获取中间件账号列表，已停止展示信号',
        signalTimeoutMs,
        polledAt: new Date().toISOString(),
        accountCount: 0,
        items: [] as any[],
      };
    }

    let raw: any;
    try {
      const res = await this.mapi.get('mapi/LastOrderRecords', { skipLog: true });
      raw = res.data;
    } catch (e: any) {
      return {
        ok: false,
        message: e?.message || '拉取 LastOrderRecords 失败',
        signalTimeoutMs,
        polledAt: new Date().toISOString(),
        accountCount: allowedGids.size,
        items: [] as any[],
      };
    }

    if (allowedGids.size === 0) {
      return {
        ok: true,
        message: '中间件账号列表为空，无信号可展示',
        signalTimeoutMs,
        polledAt: new Date().toISOString(),
        accountCount: 0,
        items: [] as any[],
      };
    }

    const items = this.normalizeSignals(raw)
      .filter((s) => s.accountGID && allowedGids.has(s.accountGID))
      .map((s) => ({
        ...s,
        accountName: nameByGid.get(s.accountGID) || null,
      }))
      .sort((a, b) => (b.signalAt || 0) - (a.signalAt || 0));

    return {
      ok: true,
      message: null as string | null,
      signalTimeoutMs,
      polledAt: new Date().toISOString(),
      accountCount: allowedGids.size,
      items,
    };
  }

  /** 中间件账号白名单 */
  private async loadAccountWhitelist(): Promise<{
    allowedGids: Set<string>;
    nameByGid: Map<string, string>;
    listOk: boolean;
    listError?: string;
  }> {
    const nameByGid = new Map<string, string>();
    const allowedGids = new Set<string>();
    try {
      const { items: accounts } = await this.trade.multiAccountList({ skipLog: true });
      for (const a of accounts || []) {
        const gid = String((a as any).value ?? (a as any).gid ?? '').trim();
        if (!gid) continue;
        allowedGids.add(gid);
        const name = String((a as any).name ?? '').trim();
        if (name) nameByGid.set(gid, name);
      }
      return { allowedGids, nameByGid, listOk: true };
    } catch (e: any) {
      return {
        allowedGids,
        nameByGid,
        listOk: false,
        listError: e?.message || 'MultiAccountList 失败',
      };
    }
  }

  /** 热更新轮询间隔 / 超时后重启定时器 */
  async reloadSchedule() {
    const ms = await this.getPollMs();
    if (this.enabled()) this.startTimer(ms);
    return this.getConfig();
  }

  private async getPollMs(): Promise<number> {
    const fromDb = await this.prisma.systemConfig.findUnique({ where: { key: CFG_POLL_MS } });
    if (fromDb) {
      const n = Number(fromDb.value);
      if (Number.isFinite(n) && n >= 100) return n;
    }
    return Number(process.env.FOLLOWER_POLL_MS || 500);
  }

  /**
   * 信号超时毫秒：优先 signal_timeout_ms，其次旧秒配置 ×1000，再 env，默认 60000。
   */
  async getSignalTimeoutMs(): Promise<number> {
    const msRow = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_SIGNAL_TIMEOUT_MS },
    });
    if (msRow) {
      const n = Number(msRow.value);
      if (Number.isFinite(n) && n >= 100) return Math.floor(n);
    }
    const secRow = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_SIGNAL_TIMEOUT },
    });
    if (secRow) {
      const n = Number(secRow.value);
      if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
    }
    const envMs = Number(process.env.SIGNAL_TIMEOUT_MS);
    if (Number.isFinite(envMs) && envMs >= 100) return Math.floor(envMs);
    return Math.floor(Number(process.env.SIGNAL_TIMEOUT_SECONDS || 60) * 1000);
  }

  /** @deprecated 用 getSignalTimeoutMs */
  async getSignalTimeoutSec(): Promise<number> {
    return (await this.getSignalTimeoutMs()) / 1000;
  }

  async setSignalTimeoutMs(ms: number) {
    const v = Math.max(100, Math.floor(ms));
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_SIGNAL_TIMEOUT_MS },
      create: {
        key: CFG_SIGNAL_TIMEOUT_MS,
        value: String(v),
        remark: '跟单信号超时毫秒, 超过则作废',
      },
      update: { value: String(v) },
    });
    return { signalTimeoutMs: v, signalTimeoutSec: v / 1000 };
  }

  /** @deprecated 兼容旧接口：按秒写入，内部转毫秒 */
  async setSignalTimeoutSec(seconds: number) {
    return this.setSignalTimeoutMs(Math.max(0.1, Number(seconds)) * 1000);
  }

  async setPollMs(ms: number) {
    const v = Math.max(100, Math.floor(ms));
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_POLL_MS },
      create: {
        key: CFG_POLL_MS,
        value: String(v),
        remark: '跟单信号轮询间隔(毫秒)',
      },
      update: { value: String(v) },
    });
    this.startTimer(v);
    return { pollMs: v };
  }

  /** 挂单有效秒数: 到期未成交自动撤单, 默认 60 */
  async getOrderExpireSec(): Promise<number> {
    const fromDb = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_ORDER_EXPIRE },
    });
    if (fromDb) {
      const n = Number(fromDb.value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return Number(process.env.ORDER_EXPIRE_SECONDS || 60);
  }

  async setOrderExpireSec(seconds: number) {
    const sec = Math.max(1, Math.floor(seconds));
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_ORDER_EXPIRE },
      create: {
        key: CFG_ORDER_EXPIRE,
        value: String(sec),
        remark: '跟单挂单有效秒数, 到期未成交自动撤单',
      },
      update: { value: String(sec) },
    });
    return { orderExpireSec: sec };
  }

  /** 限价过期撤单未成交后是否市价追入（管理端开关，默认关） */
  async getChaseOnExpire(): Promise<boolean> {
    const fromDb = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_CHASE_ON_EXPIRE },
    });
    if (fromDb) {
      const v = String(fromDb.value || '').trim().toLowerCase();
      return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    }
    return (process.env.CHASE_ON_EXPIRE || 'false').toLowerCase() === 'true';
  }

  async setChaseOnExpire(enabled: boolean) {
    const on = !!enabled;
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_CHASE_ON_EXPIRE },
      create: {
        key: CFG_CHASE_ON_EXPIRE,
        value: on ? 'true' : 'false',
        remark: '仅系统挂单过期自动撤且未成交时市价追入；手动/运营撤不追',
      },
      update: { value: on ? 'true' : 'false' },
    });
    return { chaseOnExpire: on };
  }

  /** 管理端关闭跟单：勾选后自动跟单不再下新单（默认关=照常跟） */
  async getFollowHalted(): Promise<boolean> {
    const fromDb = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_FOLLOW_HALTED },
    });
    if (fromDb) {
      const v = String(fromDb.value || '').trim().toLowerCase();
      return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    }
    return (process.env.FOLLOW_HALTED || 'false').toLowerCase() === 'true';
  }

  async setFollowHalted(halted: boolean) {
    const on = !!halted;
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_FOLLOW_HALTED },
      create: {
        key: CFG_FOLLOW_HALTED,
        value: on ? 'true' : 'false',
        remark: '关闭跟单：勾选后自动跟单不再开任何新单（含开仓/平仓信号与过期追入）',
      },
      update: { value: on ? 'true' : 'false' },
    });
    this.logger.warn(`跟单已${on ? '关闭' : '恢复'}（follow_halted=${on}）`);
    return { followHalted: on };
  }

  private async tick() {
    if (!this.enabled()) return;
    if (this.running) return; // 上一轮未完成则跳过, 避免堆积
    this.running = true;
    try {
      await this.pollAndFollow();
    } catch (e: any) {
      this.logger.warn(`跟单轮询异常: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  private async tickOrderWatch() {
    if (!this.enabled()) return;
    if (this.cancelRunning) return;
    this.cancelRunning = true;
    try {
      // 先检测成交, 再处理过期撤单 (避免误撤已成交流单)
      await this.syncPlacedOrderFills();
      await this.trade.retrySystemAbnormalCancels({ minIntervalMs: 10_000 });
      await this.cancelExpiredOrders();
    } catch (e: any) {
      this.logger.warn(`挂单巡检异常: ${e?.message || e}`);
    } finally {
      this.cancelRunning = false;
    }
  }

  /** 管理端手动触发一轮 */
  async runOnce() {
    await this.pollAndFollow();
    await this.syncPlacedOrderFills();
    await this.trade.retrySystemAbnormalCancels({ minIntervalMs: 0 });
    await this.cancelExpiredOrders();
    const signalTimeoutMs = await this.getSignalTimeoutMs();
    return {
      ok: true,
      pollMs: this.pollMs,
      signalTimeoutMs,
      signalTimeoutSec: signalTimeoutMs / 1000,
      orderExpireSec: await this.getOrderExpireSec(),
    };
  }

  /**
   * 实时检测 PLACED 挂单是否已成交/已撤
   * 成交后 status→FILLED, 持仓由本地 user_positions 维护
   */
  private enqueueFillJob<T>(orderId: string, task: () => Promise<T>): Promise<T> {
    const key = String(orderId);
    const prev = this.fillChains.get(key) || Promise.resolve();
    const next = prev.then(() => task(), () => task()).finally(() => {
      if (this.fillChains.get(key) === (next as Promise<void>)) this.fillChains.delete(key);
    });
    this.fillChains.set(key, next as Promise<void>);
    return next;
  }

  /**
   * 实时检测 PLACED / CANCEL_FAILED：查单增量入账，部成即撤剩余。
   * 同一 orderId 串行。99/空串不记账不撤单。
   */
  async syncPlacedOrderFills() {
    const rows = await this.prisma.signalFollowLog.findMany({
      where: {
        status: { in: ['PLACED', 'CANCEL_FAILED'] },
        orderId: { not: null },
      },
      take: 80,
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true } } },
    });
    if (rows.length === 0) return { filled: 0, cancelled: 0, open: 0 };

    const results = await Promise.all(
      rows.map((row) =>
        this.enqueueFillJob(row.orderId!, () => this.processPlacedOrderFill(row)),
      ),
    );
    let filled = 0;
    let cancelled = 0;
    let open = 0;
    for (const r of results) {
      if (r === 'filled') filled++;
      else if (r === 'cancelled') cancelled++;
      else open++;
    }
    if (filled || cancelled) {
      this.logger.log(`成交检测本轮: 成交=${filled}, 外部撤单=${cancelled}, 仍挂单=${open}`);
    }
    return { filled, cancelled, open };
  }

  private async processPlacedOrderFill(row: {
    id: string;
    userId: string;
    exchange: Exchange;
    orderId: string | null;
    signalKey: string;
    orderGid: string;
    symbol: string | null;
    accountType: string | null;
    coinName: string | null;
    equalCoinName: string | null;
    positionSide: string | null;
    isOpen: boolean | null;
    side: string | null;
    requestBody: string | null;
    clientOrderId: string | null;
    createdAt: Date;
    remainderCancelStartedAt: Date | null;
    lastCancelAttemptAt: Date | null;
    cancelAttemptCount: number;
    user: { email: string };
  }): Promise<'filled' | 'cancelled' | 'open'> {
    let meta: any = {};
    try {
      meta = row.requestBody ? JSON.parse(row.requestBody) : {};
    } catch {
      meta = {};
    }
    const isOpen = row.isOpen != null ? row.isOpen : meta.isOpen != null ? !!meta.isOpen : undefined;
    const coinName = row.coinName || meta.coinName;
    const equalCoinName = row.equalCoinName || meta.equalCoinName;
    const inspectOpts = {
      symbol: row.symbol || undefined,
      accountType: row.accountType || 'future',
      coinName: coinName || undefined,
      equalCoinName: equalCoinName || undefined,
      clientOrderId: row.clientOrderId || undefined,
      positionSide: row.positionSide || meta.positionSide || undefined,
      placedAt: row.createdAt,
      isOpen,
    };

    const queryOnce = async () =>
      this.trade.inspectOrderFill(row.userId, row.exchange, row.orderId!, inspectOpts);

    const apply = async (fill: Awaited<ReturnType<TradeService['inspectOrderFill']>>) => {
      const fresh = await this.prisma.signalFollowLog.findUnique({ where: { id: row.id } });
      if (!fresh) return { booked: false, complete: false, remainder: false, delta: 0, recorded: false };
      return this.trade.applyFillFromQuery(fresh, fill);
    };

    let fill = await queryOnce();
    if (!isQueryFillUsable(fill)) return 'open';

    let applied = await apply(fill);
    if (applied.complete) {
      return fill.state === 'cancelled' ? 'cancelled' : 'filled';
    }
    if (!applied.remainder) return 'open';

    const now = Date.now();
    const attempt = canAttemptRemainderCancel({
      now,
      startedAt: row.remainderCancelStartedAt,
      lastAttemptAt: row.lastCancelAttemptAt,
    });
    if (attempt.giveUp) {
      await this.prisma.signalFollowLog.update({
        where: { id: row.id },
        data: {
          abnormalKind: 'BUSINESS',
          abnormalAt: new Date(),
          abnormalMsg: '部成撤余超过10分钟仍未完成，停止自动撤单，继续查单',
        },
      });
      this.logger.warn(
        `部成撤余放弃 user=${row.user.email} orderId=${row.orderId}`,
      );
      return 'open';
    }
    if (!attempt.allowed) return 'open';

    await this.prisma.signalFollowLog.update({
      where: { id: row.id },
      data: {
        remainderCancelStartedAt: row.remainderCancelStartedAt || new Date(),
        lastCancelAttemptAt: new Date(),
        cancelAttemptCount: { increment: 1 },
      },
    });

    try {
      await this.trade.cancelOrder(row.userId, {
        exchange: row.exchange,
        orderId: row.orderId!,
        symbol: row.symbol || undefined,
        accountType: row.accountType || 'future',
        coinName: coinName || undefined,
        equalCoinName: equalCoinName || undefined,
        clientOrderId: row.clientOrderId || undefined,
        isOpen,
        positionSide: row.positionSide || meta.positionSide,
        cancelReason: 'REMAINDER',
        skipTradePassword: true,
      });
    } catch (e: any) {
      this.logger.debug(
        `部成撤余 user=${row.user.email} orderId=${row.orderId}: ${e?.message || e}`,
      );
    }

    fill = await queryOnce();
    if (!isQueryFillUsable(fill)) return 'open';
    applied = await apply(fill);
    if (applied.complete) {
      return fill.state === 'cancelled' ? 'cancelled' : 'filled';
    }
    return 'open';
  }

  /** 到期未成交的挂单 → CancelOrder → 写入撤单记录 (成功 CANCELLED / 失败 CANCEL_FAILED) */
  async cancelExpiredOrders() {
    const now = new Date();
    const rows = await this.prisma.signalFollowLog.findMany({
      where: {
        status: { in: ['PLACED', 'CANCEL_FAILED'] },
        expiresAt: { lte: now },
        orderId: { not: null },
      },
      take: 50,
      orderBy: { expiresAt: 'asc' },
      include: { user: { select: { email: true, id: true } } },
    });
    if (rows.length === 0) return { cancelled: 0, failed: 0 };

    let cancelled = 0;
    let failed = 0;
    for (const row of rows) {
      let meta: any = {};
      try {
        meta = row.requestBody ? JSON.parse(row.requestBody) : {};
      } catch {
        meta = {};
      }
      try {
        const res = await this.trade.cancelOrder(row.userId, {
          exchange: row.exchange,
          orderId: row.orderId!,
          symbol: row.symbol || undefined,
          accountType: row.accountType || 'future',
          coinName: row.coinName || meta.coinName,
          equalCoinName: row.equalCoinName || meta.equalCoinName,
          clientOrderId: row.clientOrderId || undefined,
          isOpen: row.isOpen ?? meta.isOpen,
          positionSide: row.positionSide || meta.positionSide,
          cancelReason: 'EXPIRED',
          skipTradePassword: true,
        });
        if (res.ok || res.filled) {
          cancelled++;
          const exchangeGone = !!(res as any).exchangeGone;
          this.logger.log(
            `过期撤单${res.filled ? '(已成交)' : exchangeGone ? '(交易所已无单·本地关闭)' : '成功'} user=${row.user.email} orderId=${row.orderId}`,
          );
          // 未成交：勾选市价追入则追；否则平仓单走对账（交易所已无单则本地已关，不再追/对账）
          if (res.ok && !res.filled && !exchangeGone) {
            const chased = await this.maybeChaseAfterExpire(row);
            if (!chased) {
              this.maybeReconcileAfterCloseCancel(row, 'EXPIRED');
            }
          }
        } else {
          failed++;
        }
      } catch (e: any) {
        failed++;
        this.logger.warn(
          `过期撤单失败 user=${row.user.email} orderId=${row.orderId}: ${e?.message || e}`,
        );
      }
    }
    if (cancelled || failed) {
      this.logger.log(`过期撤单本轮: 成功/已处理=${cancelled}, 失败=${failed}`);
    }
    return { cancelled, failed };
  }

  /**
   * 运营立即撤单（单笔/勾选）
   * 仅处理 PLACED / CANCEL_FAILED 且有 orderId 的记录
   */
  async adminCancelByIds(ids: string[]) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (unique.length === 0) {
      return { total: 0, cancelled: 0, filled: 0, failed: 0, skipped: 0, items: [] as any[] };
    }
    const rows = await this.prisma.signalFollowLog.findMany({
      where: {
        id: { in: unique },
        status: { in: ['PLACED', 'CANCEL_FAILED'] },
        orderId: { not: null },
      },
      take: Math.min(200, unique.length),
      include: { user: { select: { email: true, id: true } } },
    });
    return this.runAdminCancels(rows, '立即撤单');
  }

  /**
   * 运营批量重试 CANCEL_FAILED（不依赖 expiresAt）
   * ids 可选；不传则处理全部失败单
   */
  async retryCancelFailed(opts?: { ids?: string[]; take?: number }) {
    const take = Math.min(200, Math.max(1, opts?.take || 50));
    const where: any = {
      status: 'CANCEL_FAILED',
      orderId: { not: null },
    };
    if (opts?.ids?.length) where.id = { in: opts.ids };

    const rows = await this.prisma.signalFollowLog.findMany({
      where,
      take,
      orderBy: { updatedAt: 'asc' },
      include: { user: { select: { email: true, id: true } } },
    });
    return this.runAdminCancels(rows, '重试撤单失败');
  }

  private async runAdminCancels(
    rows: Array<{
      id: string;
      userId: string;
      exchange: any;
      orderId: string | null;
      symbol: string | null;
      accountType: string | null;
      coinName: string | null;
      equalCoinName: string | null;
      clientOrderId: string | null;
      isOpen: boolean | null;
      positionSide?: string | null;
      requestBody: string | null;
      user: { email: string; id: string };
    }>,
    label: string,
  ) {
    if (rows.length === 0) {
      return { total: 0, cancelled: 0, filled: 0, failed: 0, skipped: 0, items: [] as any[] };
    }

    let cancelled = 0;
    let filled = 0;
    let failed = 0;
    const items: {
      id: string;
      orderId: string | null;
      email?: string;
      result: 'cancelled' | 'filled' | 'failed';
      message?: string;
    }[] = [];

    for (const row of rows) {
      let meta: any = {};
      try {
        meta = row.requestBody ? JSON.parse(row.requestBody) : {};
      } catch {
        meta = {};
      }
      try {
        const res = await this.trade.cancelOrder(row.userId, {
          exchange: row.exchange,
          orderId: row.orderId!,
          symbol: row.symbol || undefined,
          accountType: row.accountType || 'future',
          coinName: row.coinName || meta.coinName,
          equalCoinName: row.equalCoinName || meta.equalCoinName,
          clientOrderId: row.clientOrderId || undefined,
          isOpen: row.isOpen ?? meta.isOpen,
          positionSide: row.positionSide || meta.positionSide,
          cancelReason: 'ADMIN',
          skipTradePassword: true,
        });
        if (res.filled) {
          filled++;
          items.push({
            id: row.id,
            orderId: row.orderId,
            email: row.user.email,
            result: 'filled',
            message: res.message,
          });
        } else if (res.ok) {
          cancelled++;
          items.push({
            id: row.id,
            orderId: row.orderId,
            email: row.user.email,
            result: 'cancelled',
          });
        } else {
          failed++;
          items.push({
            id: row.id,
            orderId: row.orderId,
            email: row.user.email,
            result: 'failed',
            message: res.message,
          });
        }
      } catch (e: any) {
        failed++;
        items.push({
          id: row.id,
          orderId: row.orderId,
          email: row.user.email,
          result: 'failed',
          message: e?.message || String(e),
        });
        this.logger.warn(
          `运营${label}失败 user=${row.user.email} orderId=${row.orderId}: ${e?.message || e}`,
        );
      }
    }

    this.logger.log(
      `运营${label}: total=${rows.length} cancelled=${cancelled} filled=${filled} failed=${failed}`,
    );
    return { total: rows.length, cancelled, filled, failed, skipped: 0, items };
  }

  private async pollAndFollow() {
    if (await this.getFollowHalted()) {
      if ((process.env.FOLLOWER_LOG_EMPTY || 'false').toLowerCase() === 'true') {
        this.logger.debug('跟单已关闭(follow_halted)，跳过下发');
      }
      return;
    }

    let raw: any;
    try {
      const res = await this.mapi.get('mapi/LastOrderRecords', { skipLog: true });
      raw = res.data;
    } catch (e: any) {
      if ((process.env.FOLLOWER_LOG_EMPTY || 'false').toLowerCase() === 'true') {
        this.logger.debug(`拉信号失败: ${e?.message}`);
      }
      return;
    }

    const { allowedGids, nameByGid, listOk } = await this.loadAccountWhitelist();
    if (!listOk || allowedGids.size === 0) {
      if ((process.env.FOLLOWER_LOG_EMPTY || 'false').toLowerCase() === 'true') {
        this.logger.debug('中间件账号列表不可用或为空，跳过跟单下发');
      }
      return;
    }

    const timeoutMs = await this.getSignalTimeoutMs();
    const now = Date.now();
    // 账号列表内任一账户的信号均可跟；是否下单由模板 accountGid + 开单条件决定
    const all = this.normalizeSignals(raw).filter(
      (s) => s.accountGID && allowedGids.has(s.accountGID),
    );

    let expired = 0;
    const fresh = all.filter((s) => {
      if (s.signalAt == null) {
        expired++;
        return false;
      }
      if (now - s.signalAt > timeoutMs) {
        expired++;
        return false;
      }
      return true;
    });

    if (expired > 0 && (process.env.FOLLOWER_LOG_EXPIRED || 'false').toLowerCase() === 'true') {
      this.logger.debug(`丢弃超时信号 ${expired} 条 (超时阈值 ${timeoutMs}ms)`);
    }

    if (fresh.length === 0) return;

    const maxBatch = Number(process.env.FOLLOWER_MAX_SIGNALS || 20);
    const batch = fresh.slice(0, maxBatch);

    let followed = 0;
    for (const signal of batch) {
      const n = await this.dispatchSignal(signal, {
        nameByGid,
      });
      followed += n;
    }
    if (followed > 0) {
      this.logger.log(
        `本轮跟单下发 ${followed} 笔 (白名单账户信号 ${batch.length}, 超时丢弃 ${expired})`,
      );
    }
  }

  /**
   * 中间件时间字段为 UTC(0)。无时区字符串按 UTC 解析；带 Z/偏移或 Unix 时间戳原样处理。
   * 前端 toLocaleString 会再转成本地时区展示。
   */
  private parseSignalTime(o: any): number | null {
    const candidates = [
      o.timestamp,
      o.time,
      o.ts,
      o.createTime,
      o.createdAt,
      o.orderTime,
      o.tradeTime,
      o.ctime,
      o.updateTime,
    ];
    for (const c of candidates) {
      if (c == null || c === '') continue;
      if (typeof c === 'number') {
        // 秒级时间戳
        if (c > 1e9 && c < 1e12) return c * 1000;
        if (c >= 1e12) return c;
        continue;
      }
      const s = String(c).trim();
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (n > 1e9 && n < 1e12) return n * 1000;
        if (n >= 1e12) return n;
      }
      const utcMs = this.parseUtcDateString(s);
      if (utcMs != null) return utcMs;
    }
    return null;
  }

  /** 无时区的日期时间按 UTC 解析；已含 Z / ±偏移则交给 Date */
  private parseUtcDateString(s: string): number | null {
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    const m = s.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/,
    );
    if (m) {
      const frac = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
      return Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] || 0),
        frac,
      );
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  /**
   * 解析 mapi/LastOrderRecords。
   * 文档格式为嵌套字典:
   *   data = { "<账户GID>": { "<key>": { orderTime, orderGID, price, quantity, orderSide } } }
   * key 形如 `bac_IOTA_PC_long`: apiCode_币名_计价币(合约周期)_持仓方向(long/short)
   * orderSide: 合约 open/close, 现货 buy/sell
   */
  private normalizeSignals(data: any): NormalizedSignal[] {
    // 剥离信封 (MapiClient 已剥, 但兼容直接传原始体)
    const root =
      data && typeof data === 'object' && 'data' in data && !Array.isArray(data.data)
        ? data.data
        : data;
    if (!root || typeof root !== 'object') return [];

    const out: NormalizedSignal[] = [];
    for (const accountGID of Object.keys(root)) {
      const positions = root[accountGID];
      if (!positions || typeof positions !== 'object') continue;

      for (const key of Object.keys(positions)) {
        const o = positions[key] || {};
        const parts = key.split('_');
        if (parts.length < 4) continue;
        const apiCode = parts[0];
        const positionSide = parts[parts.length - 1].toLowerCase(); // long/short
        const equalCoinName = parts[parts.length - 2].toUpperCase(); // PC / U ...
        const coinName = parts.slice(1, parts.length - 2).join('_').toUpperCase();

        const exchange = fromApiCode(apiCode);
        if (!exchange || !coinName) continue;

        const orderGID = String(o.orderGID || o.orderGid || '');
        if (!orderGID) continue;

        const amount = o.quantity ?? o.amount ?? o.qty ?? o.size;
        if (amount == null || amount === '' || Number(amount) === 0) continue;

        const orderSide = String(o.orderSide || '').toLowerCase(); // open/close/buy/sell
        const isOpen = orderSide === 'open' || orderSide === 'buy';
        const accountType = accountTypeFromEqualCoin(equalCoinName);
        // LastOrderRecords 通常不带委托类型；未说明时跟单默认限价
        const rawType = String(
          o.orderType ?? o.OrderType ?? o.type ?? '',
        ).toLowerCase();
        const orderType = /market|市价|^1$/.test(rawType)
          ? 'market'
          : /limit|限价|^0$/.test(rawType)
            ? 'limit'
            : 'limit';

        out.push({
          orderGID,
          accountGID,
          exchange,
          apiCode,
          coinName,
          equalCoinName,
          symbol: `${coinName}/${equalCoinName}`,
          accountType,
          isOpen,
          orderSide,
          positionSide,
          orderType,
          price: o.price,
          amount,
          signalAt: this.parseSignalTime(o),
          raw: o,
        });
      }
    }
    return out;
  }

  /**
   * 幂等键：防轮询重复下单。
   * 中间件开/平可能共用 orderGID，且主账户可对同一仓位多次平仓，
   * 因此带上 open|close + signalAt（及数量）区分不同信号。
   */
  private followSignalKey(signal: {
    orderGID: string;
    isOpen: boolean;
    signalAt?: number | null;
    amount?: string | number;
  }): string {
    const side = signal.isOpen ? 'open' : 'close';
    const at =
      signal.signalAt != null && Number.isFinite(Number(signal.signalAt))
        ? String(Math.floor(Number(signal.signalAt)))
        : 'na';
    const amtNum = Number(signal.amount);
    const amt = Number.isFinite(amtNum) ? String(amtNum) : '';
    return amt
      ? `${signal.orderGID}:${side}:${at}:${amt}`
      : `${signal.orderGID}:${side}:${at}`;
  }

  private async writeFollowFailed(params: {
    signal: NormalizedSignal;
    userId: string;
    accountGid: string | null;
    accountName: string | null;
    errorMsg: string;
    extra?: Record<string, unknown>;
    abnormalKind?: 'NONE' | 'BUSINESS' | 'SYSTEM';
  }) {
    const { signal, userId, accountGid, accountName, errorMsg, extra } = params;
    const signalKey = this.followSignalKey(signal);
    const ab = params.abnormalKind || 'NONE';
    try {
      await this.prisma.signalFollowLog.create({
        data: {
          orderGid: signal.orderGID,
          signalKey,
          userId,
          exchange: signal.exchange,
          status: 'FAILED',
          success: false,
          symbol: signal.symbol,
          side: signal.orderSide,
          orderType: signal.orderType,
          accountType: signal.accountType,
          accountGid: accountGid || undefined,
          accountName: accountName || undefined,
          coinName: signal.coinName,
          equalCoinName: signal.equalCoinName,
          positionSide: signal.positionSide,
          isOpen: signal.isOpen,
          errorMsg: errorMsg.slice(0, 2000),
          ...(ab !== 'NONE'
            ? {
                abnormalKind: ab as any,
                abnormalAt: new Date(),
                abnormalMsg: errorMsg.slice(0, 2000),
              }
            : {}),
          requestBody: JSON.stringify({
            apiCode: signal.apiCode,
            coinName: signal.coinName,
            equalCoinName: signal.equalCoinName,
            symbol: signal.symbol,
            orderSide: signal.orderSide,
            positionSide: signal.positionSide,
            isOpen: signal.isOpen,
            price: signal.price,
            amount: signal.amount,
            signalAt: signal.signalAt,
            accountGID: accountGid,
            accountName,
            orderGID: signal.orderGID,
            signalKey,
            ...(extra || {}),
          }),
        },
      });
    } catch {
      /* 幂等冲突忽略 */
    }
  }

  private async dispatchSignal(
    signal: NormalizedSignal,
    ctx?: { nameByGid?: Map<string, string> },
  ): Promise<number> {
    // 下单前再检一次超时 (排队等待期间可能已过期)
    const timeoutMs = await this.getSignalTimeoutMs();
    if (signal.signalAt != null) {
      if (Date.now() - signal.signalAt > timeoutMs) return 0;
    }

    const accountGid = signal.accountGID || null;
    if (!accountGid) return 0;
    const accountName = ctx?.nameByGid?.get(accountGid) || null;

    // 圈人：已开跟单 + 模板绑定该信号账户；点卡/单笔最小等在循环里检并记 FAILED
    const followers = await this.trade.listEligibleFollowers(signal.exchange, {
      accountGid,
      skipPointGate: true,
    });
    if (followers.length === 0) return 0;

    const openMin = signal.isOpen ? await this.trade.getOpenMinPointBalance() : 0;
    let pointBal = new Map<string, number>();
    if (signal.isOpen && openMin > 0) {
      const cards = await this.prisma.pointCard.findMany({
        where: { userId: { in: followers.map((u) => u.id) } },
        select: { userId: true, balance: true },
      });
      pointBal = new Map(cards.map((c) => [c.userId, Number(c.balance)]));
    }

    let count = 0;
    for (const u of followers) {
      // 每个用户下单前再检超时
      if (signal.signalAt != null) {
        if (Date.now() - signal.signalAt > timeoutMs) break;
      }

      const signalKey = this.followSignalKey(signal);
      const existed = await this.prisma.signalFollowLog.findUnique({
        where: { signalKey_userId: { signalKey, userId: u.id } },
      });
      if (existed) continue;

      // 开仓/平仓前：先撤同币同向未完结开仓挂单（系统异常硬闸，不 PlaceOrder）
      const clear = await this.trade.clearSameDirectionOpenOrders({
        userId: u.id,
        exchange: signal.exchange,
        coinName: signal.coinName,
        equalCoinName: signal.equalCoinName,
        positionSide: signal.positionSide,
        cancelReason: 'SIGNAL',
      });
      if (!clear.ok) {
        const gateMsg = clear.systemError
          ? `同向旧开仓挂单撤单系统异常, 本信号不挂单: ${clear.message || ''}`
          : `同向旧开仓挂单未撤净, 本信号不挂单: ${clear.message || ''}`;
        await this.writeFollowFailed({
          signal,
          userId: u.id,
          accountGid,
          accountName,
          errorMsg: gateMsg.slice(0, 2000),
          abnormalKind: clear.systemError ? 'SYSTEM' : 'BUSINESS',
          extra: {
            clearSameDir: clear,
          },
        });
        this.logger.warn(
          `先撤再开拦截 user=${u.email} ${signal.coinName} ${signal.isOpen ? '开' : '平'}: ${gateMsg}`,
        );
        continue;
      }

      // 平仓：无本地持仓则跳过，不写失败流水（撤旧挂单后重新读仓）
      let localCloseQty = 0;
      if (!signal.isOpen) {
        localCloseQty = await this.trade.getOpenLocalQty({
          userId: u.id,
          exchange: signal.exchange,
          coinName: signal.coinName,
          equalCoinName: signal.equalCoinName,
          positionSide: signal.positionSide,
        });
        if (!(localCloseQty > 1e-12)) {
          continue;
        }
      }

      // 开仓点卡门槛：不足记 FAILED
      if (signal.isOpen && openMin > 0) {
        const bal = pointBal.get(u.id) ?? 0;
        if (bal < openMin) {
          await this.writeFollowFailed({
            signal,
            userId: u.id,
            accountGid,
            accountName,
            errorMsg: `点卡不足, 无法开仓 (当前 ${bal}, 需 ≥ ${openMin})`,
            extra: { pointBalance: bal, openMinPointBalance: openMin },
          });
          continue;
        }
      }

      // 开仓/平仓数量按用户声明本金与模板基准本金等比例缩放（不校验交易所余额）
      const ratio = Number((u as any).openRatio);
      const unitAmount = Number((u as any).unitAmount) || 0;
      const signalAmt = Number(signal.amount);
      if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(signalAmt) || signalAmt === 0) {
        await this.writeFollowFailed({
          signal,
          userId: u.id,
          accountGid,
          accountName,
          errorMsg: `跟单数量无效 ratio=${ratio} signalAmt=${signalAmt}`,
          extra: {
            ratio,
            signalAmount: signalAmt,
            investAmount: (u as any).investAmount,
            maxPrincipal: (u as any).maxPrincipal,
            templateId: (u as any).templateId,
          },
        });
        continue;
      }
      let followAmount = Number((signalAmt * ratio).toPrecision(12));
      if (!Number.isFinite(followAmount) || followAmount === 0) {
        await this.writeFollowFailed({
          signal,
          userId: u.id,
          accountGid,
          accountName,
          errorMsg: `跟单数量计算结果无效 followAmount=${followAmount}`,
          extra: {
            ratio,
            signalAmount: signalAmt,
            investAmount: (u as any).investAmount,
            maxPrincipal: (u as any).maxPrincipal,
            templateId: (u as any).templateId,
          },
        });
        continue;
      }

      // 平仓兜底：不超过本地持仓；达到 90% 则全平，避免交易所残留碎仓
      let closeFullBoost = false;
      let closeClamped = false;
      const sizedFromSignal = followAmount;
      if (!signal.isOpen && localCloseQty > 0) {
        const resolved = this.trade.resolveCloseAmount(followAmount, localCloseQty, 0.9);
        followAmount = resolved.amount;
        closeFullBoost = resolved.fullClose;
        closeClamped = resolved.clamped;
        if (closeFullBoost || closeClamped) {
          this.logger.log(
            `平仓数量兜底 user=${u.email} ${signal.coinName} 信号量=${sizedFromSignal} ` +
              `本地仓=${localCloseQty} → 下单=${followAmount}` +
              (closeFullBoost ? ' (≥90%抬全平)' : ''),
          );
        }
      }

      followAmount = await this.trade.snapPlaceQty({
        exchange: signal.exchange,
        coinName: signal.coinName,
        equalCoinName: signal.equalCoinName,
        accountType: signal.accountType,
        symbol: signal.symbol,
        apiCode: signal.apiCode,
        amount: followAmount,
      });

      const sizingMeta = {
        signalAmount: signalAmt,
        amount: followAmount,
        sizedFromSignal,
        localCloseQty: !signal.isOpen ? localCloseQty : undefined,
        closeFullBoost: closeFullBoost || undefined,
        closeClamped: closeClamped || undefined,
        ratio,
        investAmount: (u as any).investAmount,
        maxPrincipal: (u as any).maxPrincipal,
        unitAmount,
        templateId: (u as any).templateId,
      };

      if (
        await this.trade.isBelowMinPlaceQty({
          exchange: signal.exchange,
          coinName: signal.coinName,
          equalCoinName: signal.equalCoinName,
          accountType: signal.accountType,
          symbol: signal.symbol,
          apiCode: signal.apiCode,
          amount: followAmount,
        })
      ) {
        await this.writeFollowFailed({
          signal,
          userId: u.id,
          accountGid,
          accountName,
          errorMsg: 'below-min-contract',
          extra: sizingMeta,
        });
        continue;
      }

      // 开仓：名义金额低于模板单笔最小则记 FAILED（平仓仍按比例跟）
      if (signal.isOpen && unitAmount > 0) {
        const px = Number(signal.price);
        const notional =
          Number.isFinite(px) && px > 0 ? Math.abs(followAmount * px) : Math.abs(followAmount);
        if (notional < unitAmount) {
          await this.writeFollowFailed({
            signal,
            userId: u.id,
            accountGid,
            accountName,
            errorMsg: `低于单笔最小金额 unit=${unitAmount} notional=${notional}`,
            extra: sizingMeta,
          });
          continue;
        }
      }

      try {
        await this.prisma.signalFollowLog.create({
          data: {
            orderGid: signal.orderGID,
            signalKey,
            userId: u.id,
            exchange: signal.exchange,
            status: 'PENDING',
            success: false,
            symbol: signal.symbol,
            side: signal.orderSide,
            orderType: signal.orderType,
            accountType: signal.accountType,
            accountGid: accountGid || undefined,
            accountName: accountName || undefined,
            coinName: signal.coinName,
            equalCoinName: signal.equalCoinName,
            positionSide: signal.positionSide,
            isOpen: signal.isOpen,
            requestBody: JSON.stringify({
              apiCode: signal.apiCode,
              coinName: signal.coinName,
              equalCoinName: signal.equalCoinName,
              symbol: signal.symbol,
              orderSide: signal.orderSide,
              positionSide: signal.positionSide,
              isOpen: signal.isOpen,
              price: signal.price,
              signalAt: signal.signalAt,
              accountGID: accountGid,
              accountName,
              orderGID: signal.orderGID,
              signalKey,
              ...sizingMeta,
            }),
          },
        });
      } catch {
        continue;
      }

      const clientOrderId = `fo_${signalKey}`.slice(0, 32);
      const expireSec = await this.getOrderExpireSec();

      try {
        // 文档 leverage 非必填；信号未带杠杆时不传，由 placeOrder 默认 1
        const rawLev =
          Number((signal.raw as any)?.leverage ?? (signal.raw as any)?.leverageType) || 0;
        // 信号未带杠杆时 placeOrder 默认 1；展示保证金在仓位 leverage 为空时按合约 5 倍兜底
        const placeLev = rawLev > 0 ? rawLev : undefined;
        const result = await this.trade.placeOrder(u.id, {
          exchange: signal.exchange,
          symbol: signal.symbol,
          side: signal.orderSide,
          orderType: signal.orderType,
          accountType: signal.accountType,
          price: signal.price,
          amount: followAmount,
          positionSide: signal.positionSide,
          ...(placeLev ? { leverage: placeLev } : {}),
          apiCode: signal.apiCode,
          coinName: signal.coinName,
          equalCoinName: signal.equalCoinName,
          isOpen: signal.isOpen,
          clientOrderId,
          skipTradePassword: true,
        });
        const orderId = extractPlaceOrderId(result?.data ?? result);
        const placedAt = new Date();
        await this.prisma.signalFollowLog.update({
          where: { signalKey_userId: { signalKey, userId: u.id } },
          data: {
            success: true,
            status: 'PLACED',
            orderId: orderId || undefined,
            clientOrderId,
            symbol: signal.symbol,
            side: signal.orderSide,
            orderType: signal.orderType,
            accountType: signal.accountType,
            accountGid: accountGid || undefined,
            accountName: accountName || undefined,
            coinName: signal.coinName,
            equalCoinName: signal.equalCoinName,
            positionSide: signal.positionSide,
            isOpen: signal.isOpen,
            orderAmt: followAmount,
            expiresAt: new Date(placedAt.getTime() + expireSec * 1000),
            responseBody: JSON.stringify(result?.data ?? result),
            requestBody: JSON.stringify({
              apiCode: signal.apiCode,
              coinName: signal.coinName,
              equalCoinName: signal.equalCoinName,
              symbol: signal.symbol,
              orderSide: signal.orderSide,
              positionSide: signal.positionSide,
              isOpen: signal.isOpen,
              price: signal.price,
              signalAt: signal.signalAt,
              accountGID: accountGid,
              accountName,
              orderGID: signal.orderGID,
              signalKey,
              ...(placeLev ? { leverage: placeLev } : {}),
              ...sizingMeta,
            }),
          },
        });
        if (!orderId) {
          this.logger.warn(
            `跟单成功但未解析到 orderId, 过期无法自动撤单 orderGid=${signal.orderGID} user=${u.email}`,
          );
        }
        count++;
      } catch (e: any) {
        const reason = formatTradeError(e);
        // 优先中间件/传输层源 body；不要用 Nest getResponse() 的 503 包装顶替
        const rawBody =
          e?.responseBody != null
            ? e.responseBody
            : e?.cause?.responseBody != null
              ? e.cause.responseBody
              : null;
        const respBody =
          rawBody != null
            ? JSON.stringify(rawBody).slice(0, 8000)
            : undefined;
        await this.prisma.signalFollowLog.update({
          where: { signalKey_userId: { signalKey, userId: u.id } },
          data: {
            success: false,
            status: 'FAILED',
            errorMsg: reason.slice(0, 2000),
            responseBody: respBody,
            symbol: signal.symbol,
            side: signal.orderSide,
            orderType: signal.orderType,
            accountType: signal.accountType,
            accountGid: accountGid || undefined,
            accountName: accountName || undefined,
            coinName: signal.coinName,
            equalCoinName: signal.equalCoinName,
            positionSide: signal.positionSide,
            isOpen: signal.isOpen,
          },
        });
        if (!/至少需一张|委托数量不足|below-min-contract/i.test(reason)) {
          this.logger.warn(`跟单失败 user=${u.email} orderGid=${signal.orderGID}: ${reason}`);
        }
      }
    }
    return count;
  }
}
