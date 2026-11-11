import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { CFG_PROXY_PROBE_ENABLED } from '../ippool/ippool.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TradeService } from './trade.service';

const INTERVAL_MS = 5 * 60_000;

function middlewareProxyValue(host: string, port: number): string {
  const h = String(host || '').trim();
  const p = Number(port);
  return Number.isFinite(p) && p > 0 ? `${h}:${p}` : h;
}

/**
 * 独立探活：只扫不健康代理，用一个可跟单用户打 QueryPosition。
 * HTTP 在 probe 工作线程里发，不跟盘口、跟单信号排队。
 * 拿到回包只把该代理标为健康，不迁用户。超时或网络故障什么都不改。
 */
@Injectable()
export class ProxyProbeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProxyProbeWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private prisma: PrismaService,
    private trade: TradeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.logger.log('ProxyProbeWorker 已启动: 间隔=5分钟, 开关在代理配置');
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      if (!(await this.probeEnabled())) return;
      await this.probeUnhealthy();
    } catch (e: any) {
      this.logger.warn(`代理探测异常: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  /** 代理配置里的开关。还没保存过时默认开启。 */
  private async probeEnabled(): Promise<boolean> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_PROXY_PROBE_ENABLED },
    });
    if (!row) return true;
    const v = String(row.value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  private async probeUnhealthy() {
    const proxies = await this.prisma.ipProxy.findMany({
      where: { active: true, healthy: false },
      select: { id: true, host: true, port: true, egressIp: true },
      orderBy: { id: 'asc' },
    });
    if (proxies.length === 0) return;

    const sample = await this.pickFollowUser();
    if (!sample) {
      this.logger.warn(`代理探测: 没有可跟单用户，跳过 ${proxies.length} 条不健康代理`);
      return;
    }

    for (const proxy of proxies) {
      if (this.stopped) return;
      const proxyIP = middlewareProxyValue(proxy.host, proxy.port);
      if (!proxyIP) continue;
      const label = proxy.egressIp || proxy.host;
      let reached = false;
      try {
        reached = await this.trade.probeQueryPosition(sample.userId, sample.exchange, proxyIP);
      } catch (e: any) {
        this.logger.warn(`代理探测: ${label} 调用失败，保持不健康: ${e?.message || e}`);
        continue;
      }
      if (!reached) {
        this.logger.warn(`代理探测: ${label} 未拿到回包，保持不健康`);
        continue;
      }
      const updated = await this.prisma.ipProxy.updateMany({
        where: { id: proxy.id, healthy: false },
        data: { healthy: true, lastCheckAt: new Date() },
      });
      if (updated.count > 0) {
        this.logger.log(`代理探测: ${label} 已标为健康`);
      }
    }
  }

  /** 一个可跟单用户：已通过、已开跟单、该所 Key 启用、模板启用且两个本金大于 0。全局模板已应用时不看用户自选。 */
  private async pickFollowUser(): Promise<{ userId: string; exchange: Exchange } | null> {
    const scope = await this.trade.globalFollowScope();
    if (scope?.applied) {
      if (!scope.usable) return null;
      const user = await this.prisma.user.findFirst({
        where: {
          status: 'ACTIVE',
          followEnabled: true,
          isPlatform: false,
          exchangeKeys: {
            some: {
              active: true,
              ...(scope.allExchanges ? {} : { exchange: { in: scope.exchanges } }),
            },
          },
        },
        orderBy: { followStartedAt: 'desc' },
        select: {
          id: true,
          exchangeKeys: { where: { active: true }, select: { exchange: true } },
        },
      });
      const exchange = user?.exchangeKeys.find(
        (k) => scope.allExchanges || scope.exchanges.includes(k.exchange),
      )?.exchange;
      if (!user || !exchange) return null;
      return { userId: user.id, exchange };
    }
    const user = await this.prisma.user.findFirst({
      where: {
        status: 'ACTIVE',
        followEnabled: true,
        isPlatform: false,
        exchangeKeys: { some: { active: true } },
        followConfigs: {
          some: {
            template: { active: true, maxPrincipal: { gt: 0 }, minInvestAmount: { gt: 0 } },
          },
        },
      },
      orderBy: { followStartedAt: 'desc' },
      select: {
        id: true,
        exchangeKeys: { where: { active: true }, select: { exchange: true } },
        followConfigs: {
          where: {
            template: { active: true, maxPrincipal: { gt: 0 }, minInvestAmount: { gt: 0 } },
          },
          select: { exchange: true },
        },
      },
    });
    if (!user) return null;
    const keys = new Set(user.exchangeKeys.map((k) => k.exchange));
    const exchange = user.followConfigs.find((c) => keys.has(c.exchange))?.exchange;
    if (!exchange) return null;
    return { userId: user.id, exchange };
  }
}
