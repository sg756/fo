import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IpPoolService } from '../ippool/ippool.service';
import { TradeService } from './trade.service';

const CFG_INTERVAL_MIN = 'query_position_interval_min';
const DEFAULT_INTERVAL_MIN = 5;
const MIN_INTERVAL_MIN = 2;
const GAP_MS = 5_000;
const COOLDOWN_MS = 2 * 60_000;

type AlignJob = {
  userId: string;
  exchange: Exchange;
  reason: 'cron' | 'manual';
};

function jobKey(userId: string, exchange: Exchange): string {
  return `${userId}|${exchange}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 独立队列：QueryPosition 对齐本地 OPEN 仓。
 * - 周期由跟单配置「对齐间隔(分钟)」控制，最少 2 分钟，默认 5
 * - 同一 proxyIP 串行，人与人间隔 5 秒；不同节点可并行
 * - 手动入队走同一条队列，不在 HTTP 请求里打中间件
 * - 同一用户×交易所冷却 2 分钟（定时/手动共用）
 */
@Injectable()
export class QueryPositionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueryPositionWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMin = DEFAULT_INTERVAL_MIN;
  private stopped = false;
  private queues = new Map<string, AlignJob[]>();
  private pumping = new Set<string>();
  private queued = new Set<string>();
  private lastHitAt = new Map<string, number>();
  private scanning = false;

  constructor(
    private prisma: PrismaService,
    private trade: TradeService,
    @Inject(forwardRef(() => IpPoolService)) private ipPool: IpPoolService,
  ) {}

  async onModuleInit() {
    if (!this.enabled()) {
      this.logger.warn('QueryPositionWorker 已禁用 (QUERY_POSITION_SYNC=false)');
      return;
    }
    this.intervalMin = await this.getIntervalMin();
    this.startTimer(this.intervalMin);
    // 启动后按交易所快照对齐一轮；不再用跟单流水回填覆盖本地仓
    setTimeout(() => void this.tickCron(), 20_000);
    this.logger.log(
      `QueryPositionWorker 已启动: 间隔=${this.intervalMin}分钟, 同代理间隔=${GAP_MS}ms, 冷却=${COOLDOWN_MS / 60000}分钟`,
    );
  }

  onModuleDestroy() {
    this.stopped = true;
    this.stopTimer();
  }

  private enabled(): boolean {
    return (process.env.QUERY_POSITION_SYNC || 'true').toLowerCase() !== 'false';
  }

  async publicConfig() {
    return {
      queryPositionIntervalMin: await this.getIntervalMin(),
      queryPositionGapSec: GAP_MS / 1000,
      queryPositionCooldownMin: COOLDOWN_MS / 60000,
      queryPositionEnabled: this.enabled(),
      queryPositionQueueSize: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
    };
  }

  async getIntervalMin(): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_INTERVAL_MIN },
    });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n)) return Math.max(MIN_INTERVAL_MIN, Math.floor(n));
    }
    const env = Number(process.env.QUERY_POSITION_INTERVAL_MIN || DEFAULT_INTERVAL_MIN);
    return Math.max(MIN_INTERVAL_MIN, Number.isFinite(env) ? Math.floor(env) : DEFAULT_INTERVAL_MIN);
  }

  async setIntervalMin(minutes: number) {
    const v = Math.max(MIN_INTERVAL_MIN, Math.floor(Number(minutes) || DEFAULT_INTERVAL_MIN));
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_INTERVAL_MIN },
      create: {
        key: CFG_INTERVAL_MIN,
        value: String(v),
        remark: 'QueryPosition 持仓对齐间隔(分钟)，最少 2',
      },
      update: { value: String(v) },
    });
    this.intervalMin = v;
    if (this.enabled()) this.startTimer(v);
    return { queryPositionIntervalMin: v };
  }

  private startTimer(minutes: number) {
    this.stopTimer();
    const ms = Math.max(MIN_INTERVAL_MIN, minutes) * 60_000;
    this.timer = setInterval(() => void this.tickCron(), ms);
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tickCron() {
    if (!this.enabled() || this.stopped) return;
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.enqueueTargets({ reason: 'cron' });
    } catch (e: any) {
      this.logger.warn(`QueryPosition 定时入队异常: ${e?.message || e}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * 入队（本地库扫描 + 代理分组）。不调用 QueryPosition。
   */
  async enqueueTargets(opts: {
    reason: 'cron' | 'manual';
    userId?: string;
    exchange?: Exchange;
  }): Promise<{
    ok: true;
    queued: number;
    alreadyQueued: number;
    cooldown: number;
    noOpen: number;
  }> {
    let targets = await this.trade.listOpenQueryPositionTargets(opts.userId);
    if (opts.exchange) {
      targets = targets.filter((t) => t.exchange === opts.exchange);
    }
    let queued = 0;
    let alreadyQueued = 0;
    let cooldown = 0;
    for (const t of targets) {
      const r = await this.enqueueOne(t.userId, t.exchange, opts.reason);
      if (r === 'queued') queued += 1;
      else if (r === 'already') alreadyQueued += 1;
      else if (r === 'cooldown') cooldown += 1;
    }
    return {
      ok: true,
      queued,
      alreadyQueued,
      cooldown,
      noOpen: targets.length === 0 ? 1 : 0,
    };
  }

  private async enqueueOne(
    userId: string,
    exchange: Exchange,
    reason: 'cron' | 'manual',
  ): Promise<'queued' | 'already' | 'cooldown'> {
    const key = jobKey(userId, exchange);
    if (this.queued.has(key)) return 'already';
    const last = this.lastHitAt.get(key) || 0;
    if (Date.now() - last < COOLDOWN_MS) return 'cooldown';
    const proxyIP = await this.proxyLane(userId);
    const q = this.queues.get(proxyIP) || [];
    q.push({ userId, exchange, reason });
    this.queues.set(proxyIP, q);
    this.queued.add(key);
    this.ensurePump(proxyIP);
    return 'queued';
  }

  private async proxyLane(userId: string): Promise<string> {
    try {
      const proxy = await this.ipPool.resolveProxyForUser(userId);
      if (!proxy) return '';
      const host = String(proxy.host || '').trim();
      const port = Number(proxy.port);
      return Number.isFinite(port) && port > 0 ? `${host}:${port}` : host;
    } catch {
      return '';
    }
  }

  private ensurePump(proxyIP: string) {
    if (this.stopped) return;
    if (this.pumping.has(proxyIP)) return;
    this.pumping.add(proxyIP);
    void this.pump(proxyIP);
  }

  private async pump(proxyIP: string) {
    try {
      while (!this.stopped) {
        const q = this.queues.get(proxyIP);
        const job = q?.shift();
        if (!job) break;
        const key = jobKey(job.userId, job.exchange);
        try {
          const res = await this.trade.syncLocalPositionsFromQueryPosition(
            job.userId,
            job.exchange,
          );
          const skipHit =
            res.skipped === 'pending-orders' || res.skipped === 'no-open';
          if (!skipHit) this.lastHitAt.set(key, Date.now());
        } catch (e: any) {
          this.logger.warn(
            `QueryPosition 执行异常 user=${job.userId} ${job.exchange}: ${e?.message || e}`,
          );
          this.lastHitAt.set(key, Date.now());
        } finally {
          this.queued.delete(key);
        }
        const more = (this.queues.get(proxyIP)?.length || 0) > 0;
        if (more) await sleep(GAP_MS);
      }
    } finally {
      this.pumping.delete(proxyIP);
      if (!this.stopped && (this.queues.get(proxyIP)?.length || 0) > 0) {
        this.ensurePump(proxyIP);
      }
    }
  }
}
