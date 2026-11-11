import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IpProxy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt } from '../../common/crypto.util';

const CFG_USERS_PER_PROXY = 'proxy_users_per_proxy';
const CFG_IDLE_NO_FILL_DAYS = 'proxy_idle_no_fill_days';
const CFG_IDLE_FOLLOW_OFF_DAYS = 'proxy_idle_follow_off_days';
/** 不健康代理探活。库里没有这项时默认开启。 */
export const CFG_PROXY_PROBE_ENABLED = 'proxy_probe_enabled';
const CFG_APP_DOWNLOAD_URL = 'app_download_url';
const CFG_APP_H5_URL = 'app_h5_url';
/** 带 proxyIP 的请求连续超时/断网达到此次数，标异常并迁走用户 */
const PROXY_TRANSPORT_FAIL_LIMIT = 5;

/** 解析中间件代理 value：支持 `ip` 或 `host:port`。无端口时 port=0（PlaceOrder 须原样传 value，勿拼端口）。 */
function parseMiddlewareProxy(value: string): { host: string; port: number; egressIp: string } {
  const v = value.trim();
  const m = /^(\[?[0-9a-fA-F:.]+\]?):(\d+)$/.exec(v);
  if (m) {
    const host = m[1].replace(/^\[|\]$/g, '');
    const port = Number(m[2]);
    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : 0,
      egressIp: host,
    };
  }
  return { host: v, port: 0, egressIp: v };
}

export type ProxyCapacity = {
  healthyProxies: number;
  usersPerProxy: number;
  capacity: number;
  occupied: number;
  remaining: number;
  full: boolean;
  nearFull: boolean;
  message: string | null;
};

@Injectable()
export class IpPoolService {
  private readonly logger = new Logger(IpPoolService.name);
  /** 同一代理连续传输失败次数。成功一次即清零。 */
  private proxyTransportFails = new Map<string, number>();
  private proxyTransportChain = new Map<string, Promise<void>>();
  private proxyTransportMigrating = new Set<string>();

  constructor(private prisma: PrismaService) {}

  async list() {
    const items = await this.prisma.ipProxy.findMany({
      orderBy: [{ active: 'desc' }, { healthy: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { assignments: true } } },
    });
    return items.map(({ _count, ...p }) => ({
      ...p,
      assignedCount: _count.assignments,
      /** 中间件列表已无 / 本地停用 */
      retired: !p.active,
    }));
  }

  /**
   * 按中间件 PublicHttpProxyList 同步本地代理池。
   * name = 公网 IP（App 白名单展示/复制）；ip/value = 代理连接地址（host 或 host:port）。
   * 中间件不提供健康字段。刷新成功：列表里有的留下（不改 healthy），没有的删除。
   * 空列表视为异常回包，不删本地数据。
   * 要删的代理先退出候选：人只换绑到本次仍在列表里、且健康未满的代理，按顺序填满再换下一台。
   * 没有健康空位则停跟单并记已移除，等之后重新绑到新的健康地址。
   */
  async syncFromMiddleware(items: { ip?: string; name?: string }[]) {
    const seen = new Set<string>();
    for (const raw of items || []) {
      const publicIp = String(raw.name || '')
        .trim()
        .replace(/^\[|\]$/g, '');
      const proxyAddr = String(raw.ip || '').trim();
      if (!publicIp && !proxyAddr) continue;

      const parsed = parseMiddlewareProxy(proxyAddr || publicIp);
      // 白名单用公网 IP：优先 name；没有则退回连接地址里的 host
      const egressIp = publicIp || parsed.egressIp;
      if (!egressIp) continue;
      seen.add(egressIp);

      const existing = await this.prisma.ipProxy.findFirst({
        where: { egressIp },
      });
      const data = {
        name: egressIp,
        host: parsed.host,
        port: parsed.port,
        active: true,
      };
      if (existing) {
        await this.prisma.ipProxy.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await this.prisma.ipProxy.create({
          data: {
            ...data,
            healthy: true,
            egressIp,
            proxyType: 'HTTP',
          },
        });
      }
    }

    if (seen.size === 0) {
      this.logger.warn('中间件代理列表为空，未删除本地代理');
      return this.list();
    }

    const stale = await this.prisma.ipProxy.findMany({
      where: { egressIp: { notIn: [...seen] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (stale.length === 0) {
      await this.rebindUnassignedFollowers();
      return this.list();
    }

    const staleIds = stale.map((p) => p.id);
    // 先标不健康，避免把人改绑到另一台也要删的代理上
    await this.prisma.ipProxy.updateMany({
      where: { id: { in: staleIds } },
      data: { healthy: false, lastCheckAt: new Date() },
    });

    const empty: typeof stale = [];
    const occupied: typeof stale = [];
    for (const p of stale) {
      const n = await this.prisma.ipAssignment.count({ where: { proxyId: p.id } });
      if (n === 0) empty.push(p);
      else occupied.push(p);
    }

    for (const p of empty) {
      await this.prisma.ipAssignment.deleteMany({ where: { proxyId: p.id } });
      await this.prisma.ipProxy.delete({ where: { id: p.id } });
      this.logger.log(`已删除中间件列表中不存在的代理 ${p.egressIp}`);
    }

    for (const p of occupied) {
      const bound = await this.prisma.ipAssignment.count({ where: { proxyId: p.id } });
      if (bound > 0) {
        const ev = await this.evacuate(p.id, undefined, staleIds);
        this.logger.log(
          `中间件已无代理 ${p.egressIp}，疏散绑定 moved=${ev.movedUsers} paused=${ev.pausedUsers}`,
        );
      }
      await this.prisma.ipAssignment.deleteMany({ where: { proxyId: p.id } });
      await this.prisma.ipProxy.delete({ where: { id: p.id } });
      this.logger.log(`已删除中间件列表中不存在的代理 ${p.egressIp}`);
    }

    await this.rebindUnassignedFollowers();
    return this.list();
  }

  /**
   * 补绑：
   * 1) 跟单开启但 IpAssignment 丢失（旧同步把绑定清掉后仍在开单）
   * 2) 疏散无空位进「已移除」的用户
   * 有健康空位才写绑定并计入人数；没有空位则跳过。
   */
  async rebindUnassignedFollowers() {
    const { usersPerProxy } = await this.getPoolConfig();
    const seenUser = new Set<string>();
    let reboundOrphans = 0;
    let reboundPaused = 0;

    const orphans = await this.prisma.user.findMany({
      where: {
        isPlatform: false,
        status: 'ACTIVE',
        followEnabled: true,
        ipAssignment: null,
      },
      orderBy: [{ followStartedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    for (const u of orphans) {
      if (seenUser.has(u.id)) continue;
      seenUser.add(u.id);
      const target = this.pickFirstWithRoom(await this.healthyWithCounts(), usersPerProxy);
      if (!target) break;
      await this.prisma.ipAssignment.create({
        data: { userId: u.id, proxyId: target.id, reason: 'orphan_rebind' },
      });
      await this.writeReflowLog({
        userId: u.id,
        result: 'SUCCESS',
        proxyId: target.id,
        egressIp: target.egressIp,
        wasReclaim: false,
        message: '跟单中无绑定记录，已补绑到健康代理',
      });
      reboundOrphans++;
    }

    const pending = await this.prisma.proxyReclaimRecord.findMany({
      where: { status: 'REMOVED', reason: 'evacuate_no_slot' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { userId: true },
    });
    for (const rec of pending) {
      if (seenUser.has(rec.userId)) continue;
      seenUser.add(rec.userId);

      const user = await this.prisma.user.findUnique({
        where: { id: rec.userId },
        select: { id: true, status: true, isPlatform: true },
      });
      if (!user || user.isPlatform || user.status !== 'ACTIVE') continue;

      const existing = await this.prisma.ipAssignment.findUnique({
        where: { userId: rec.userId },
      });
      if (existing) continue;

      const target = this.pickFirstWithRoom(await this.healthyWithCounts(), usersPerProxy);
      if (!target) break;

      await this.prisma.ipAssignment.create({
        data: { userId: rec.userId, proxyId: target.id, reason: 'sync_rebind' },
      });
      await this.prisma.user.update({
        where: { id: rec.userId },
        data: { followEnabled: true, followStoppedAt: null },
      });
      await this.markReflowed(rec.userId);
      await this.writeReflowLog({
        userId: rec.userId,
        result: 'SUCCESS',
        proxyId: target.id,
        egressIp: target.egressIp,
        wasReclaim: true,
        message: '刷新到健康代理空位，已重新绑定并恢复跟单',
      });
      reboundPaused++;
    }

    const rebound = reboundOrphans + reboundPaused;
    if (rebound > 0) {
      this.logger.log(
        `补绑未分配用户：跟单中丢失绑定 ${reboundOrphans}，已移除回流 ${reboundPaused}`,
      );
    }
    return { rebound, reboundOrphans, reboundPaused };
  }

  async egressIps() {
    const items = await this.prisma.ipProxy.findMany({
      where: { active: true },
      select: { egressIp: true },
    });
    const ips = Array.from(new Set(items.map((i) => i.egressIp)));
    return {
      ips,
      comma: ips.join(','),
      space: ips.join(' '),
      newline: ips.join('\n'),
    };
  }

  create(data: {
    name: string;
    host: string;
    port: number;
    egressIp: string;
    proxyType?: string;
    region?: string;
    username?: string;
    password?: string;
    weight?: number;
  }) {
    return this.prisma.ipProxy.create({
      data: {
        name: data.name,
        host: data.host,
        port: data.port,
        egressIp: data.egressIp,
        proxyType: data.proxyType || 'HTTP',
        region: data.region,
        username: data.username,
        encPassword: data.password ? encrypt(data.password) : null,
        weight: data.weight ?? 1,
      },
    });
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      host: string;
      port: number;
      egressIp: string;
      region: string;
      weight: number;
      active: boolean;
      healthy: boolean;
    }>,
  ) {
    const exists = await this.prisma.ipProxy.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('代理不存在');
    return this.prisma.ipProxy.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.prisma.ipAssignment.deleteMany({ where: { proxyId: id } });
    await this.prisma.ipProxy.delete({ where: { id } });
    return { ok: true };
  }

  // ---------- 配置 ----------

  private async getIntConfig(key: string, fallback: number, min = 1): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key } });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= min) return Math.floor(n);
    }
    return fallback;
  }

  private async getProbeEnabled(): Promise<boolean> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_PROXY_PROBE_ENABLED },
    });
    if (!row) return true;
    const v = String(row.value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  async getPoolConfig() {
    const [usersPerProxy, idleNoFillDays, idleFollowOffDays, probeEnabled] = await Promise.all([
      this.getIntConfig(CFG_USERS_PER_PROXY, 10, 1),
      this.getIntConfig(CFG_IDLE_NO_FILL_DAYS, 14, 1),
      this.getIntConfig(CFG_IDLE_FOLLOW_OFF_DAYS, 14, 1),
      this.getProbeEnabled(),
    ]);
    return { usersPerProxy, idleNoFillDays, idleFollowOffDays, probeEnabled };
  }

  async setPoolConfig( partial: {
    usersPerProxy?: number;
    idleNoFillDays?: number;
    idleFollowOffDays?: number;
    probeEnabled?: boolean;
  }) {
    const upsert = async (key: string, value: number, remark: string) => {
      const v = Math.max(1, Math.floor(value));
      await this.prisma.systemConfig.upsert({
        where: { key },
        create: { key, value: String(v), remark },
        update: { value: String(v) },
      });
      return v;
    };
    const out = await this.getPoolConfig();
    if (partial.usersPerProxy != null) {
      out.usersPerProxy = await upsert(
        CFG_USERS_PER_PROXY,
        partial.usersPerProxy,
        '每台代理最多绑定用户数',
      );
    }
    if (partial.idleNoFillDays != null) {
      out.idleNoFillDays = await upsert(
        CFG_IDLE_NO_FILL_DAYS,
        partial.idleNoFillDays,
        '跟单开启中无成功下单多少天可回收',
      );
    }
    if (partial.idleFollowOffDays != null) {
      out.idleFollowOffDays = await upsert(
        CFG_IDLE_FOLLOW_OFF_DAYS,
        partial.idleFollowOffDays,
        '关闭跟单后仍占代理多少天可回收',
      );
    }
    if (partial.probeEnabled != null) {
      const on = !!partial.probeEnabled;
      await this.prisma.systemConfig.upsert({
        where: { key: CFG_PROXY_PROBE_ENABLED },
        create: {
          key: CFG_PROXY_PROBE_ENABLED,
          value: on ? 'true' : 'false',
          remark: '不健康代理探活：开启后每 5 分钟查持仓，查通则标健康，不迁用户',
        },
        update: { value: on ? 'true' : 'false' },
      });
      out.probeEnabled = on;
    }
    return out;
  }

  async getAppDownloadUrl() {
    const [apk, h5] = await Promise.all([
      this.prisma.systemConfig.findUnique({ where: { key: CFG_APP_DOWNLOAD_URL } }),
      this.prisma.systemConfig.findUnique({ where: { key: CFG_APP_H5_URL } }),
    ]);
    return {
      url: String(apk?.value || '').trim(),
      h5Url: String(h5?.value || '').trim(),
    };
  }

  private normalizeHttpUrl(raw: string, label: string): string {
    const url = String(raw || '').trim();
    if (!url) return '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException(`${label}须是完整的 http 或 https 链接`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(`${label}须是完整的 http 或 https 链接`);
    }
    if (url.length > 500) throw new BadRequestException(`${label}过长`);
    return url;
  }

  async setAppDownloadUrl(rawApk: string, rawH5?: string) {
    const url = this.normalizeHttpUrl(rawApk, 'APK 下载地址');
    const h5Url = this.normalizeHttpUrl(rawH5 ?? '', 'Apple 地址');
    await this.prisma.$transaction([
      this.prisma.systemConfig.upsert({
        where: { key: CFG_APP_DOWNLOAD_URL },
        create: { key: CFG_APP_DOWNLOAD_URL, value: url, remark: '客户端 APK 下载地址' },
        update: { value: url },
      }),
      this.prisma.systemConfig.upsert({
        where: { key: CFG_APP_H5_URL },
        create: { key: CFG_APP_H5_URL, value: h5Url, remark: '客户端 Apple 下载/商店地址' },
        update: { value: h5Url, remark: '客户端 Apple 下载/商店地址' },
      }),
    ]);
    return { url, h5Url };
  }

  // ---------- 容量 ----------

  async getCapacity(): Promise<ProxyCapacity> {
    const { usersPerProxy } = await this.getPoolConfig();
    const healthyProxies = await this.prisma.ipProxy.count({
      where: { active: true, healthy: true },
    });
    const occupied = await this.prisma.ipAssignment.count();
    const capacity = healthyProxies * usersPerProxy;
    const remaining = Math.max(0, capacity - occupied);
    const full = healthyProxies === 0 || occupied >= capacity;
    const nearFull = !full && capacity > 0 && occupied / capacity >= 0.9;
    let message: string | null = null;
    if (healthyProxies === 0) message = '无健康代理，请在中间件配置出口 IP';
    else if (full) message = `代理已满（${occupied}/${capacity}），请在中间件添加出口 IP`;
    else if (nearFull) message = `代理将满（${occupied}/${capacity}），建议提前加 IP`;
    return {
      healthyProxies,
      usersPerProxy,
      capacity,
      occupied,
      remaining,
      full,
      nearFull,
      message,
    };
  }

  /** 健康代理及各自当前绑定人数（按创建时间升序，便于顺序填满） */
  private async healthyWithCounts() {
    const proxies = await this.prisma.ipProxy.findMany({
      where: { active: true, healthy: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { assignments: true } } },
    });
    return proxies.map((p) => ({
      ...p,
      assignedCount: p._count.assignments,
    }));
  }

  /** 顺序填满：第一台未满的健康代理 */
  private pickFirstWithRoom<T extends { assignedCount: number }>(
    proxies: T[],
    usersPerProxy: number,
  ): T | null {
    return proxies.find((p) => p.assignedCount < usersPerProxy) ?? null;
  }

  /**
   * 解析用户对应的代理。
   * 有健康绑定则用绑定；跟单中却无绑定则补绑进未满健康代理（写入 IpAssignment，列表人数才会对上）。
   * 非跟单用户仍只预览落点，不写库。
   */
  async resolveProxyForUser(userId: string): Promise<IpProxy | null> {
    const override = await this.prisma.ipAssignment.findUnique({
      where: { userId },
      include: { proxy: true },
    });
    if (override && override.proxy.active && override.proxy.healthy) {
      return override.proxy;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { followEnabled: true },
    });
    if (user?.followEnabled) {
      const alloc = await this.allocateProxyForUser(userId, 'orphan_rebind');
      if (!('error' in alloc)) return alloc.proxy;
      return null;
    }

    const { usersPerProxy } = await this.getPoolConfig();
    const healthy = await this.healthyWithCounts();
    const picked = this.pickFirstWithRoom(healthy, usersPerProxy);
    return picked ?? healthy[0] ?? null;
  }

  async preview(userId: string) {
    const existing = await this.prisma.ipAssignment.findUnique({
      where: { userId },
      include: { proxy: true },
    });
    const cap = await this.getCapacity();
    if (existing?.proxy?.active && existing.proxy.healthy) {
      return {
        userId,
        proxyId: existing.proxy.id,
        name: existing.proxy.name,
        egressIp: existing.proxy.egressIp,
        mode: 'bound',
        capacity: cap,
      };
    }
    const { usersPerProxy } = await this.getPoolConfig();
    const healthy = await this.healthyWithCounts();
    const picked = this.pickFirstWithRoom(healthy, usersPerProxy);
    return picked
      ? {
          userId,
          proxyId: picked.id,
          name: picked.name,
          egressIp: picked.egressIp,
          mode: 'next_slot',
          assignedCount: picked.assignedCount,
          usersPerProxy,
          capacity: cap,
        }
      : { userId, proxyId: null, message: '无可用空位', capacity: cap };
  }

  /**
   * 为用户分配一台未满的健康代理（开启跟单时调用）。
   * 策略：按创建顺序填满，超过每台上限换下一台。
   */
  async allocateProxyForUser(
    userId: string,
    reason = 'start_follow',
  ): Promise<{ proxy: IpProxy } | { error: 'NO_PROXY' | 'FULL'; capacity: ProxyCapacity }> {
    const existing = await this.prisma.ipAssignment.findUnique({
      where: { userId },
      include: { proxy: true },
    });
    if (existing?.proxy?.active && existing.proxy.healthy) {
      return { proxy: existing.proxy };
    }

    const { usersPerProxy } = await this.getPoolConfig();
    const healthy = await this.healthyWithCounts();
    if (healthy.length === 0) {
      return { error: 'NO_PROXY', capacity: await this.getCapacity() };
    }

    const picked = this.pickFirstWithRoom(healthy, usersPerProxy);
    if (!picked) {
      return { error: 'FULL', capacity: await this.getCapacity() };
    }

    await this.prisma.ipAssignment.upsert({
      where: { userId },
      create: { userId, proxyId: picked.id, reason },
      update: { proxyId: picked.id, reason },
    });
    return { proxy: picked };
  }

  async assign(userId: string, proxyId: string, reason?: string) {
    const proxy = await this.prisma.ipProxy.findUnique({ where: { id: proxyId } });
    if (!proxy) throw new BadRequestException('代理不存在');
    const { usersPerProxy } = await this.getPoolConfig();
    const count = await this.prisma.ipAssignment.count({ where: { proxyId } });
    const self = await this.prisma.ipAssignment.findUnique({ where: { userId } });
    const alreadyHere = self?.proxyId === proxyId;
    if (!alreadyHere && count >= usersPerProxy) {
      throw new BadRequestException(`该代理已满（每台最多 ${usersPerProxy} 人）`);
    }
    return this.prisma.ipAssignment.upsert({
      where: { userId },
      create: { userId, proxyId, reason },
      update: { proxyId, reason },
    });
  }

  async clearAssignment(userId: string) {
    await this.prisma.ipAssignment.deleteMany({ where: { userId } });
    return { ok: true };
  }

  /**
   * 开启跟单 / 回流：有坑才分配；失败写回流日志。
   */
  async ensureProxyOnStartFollow(userId: string): Promise<{
    ok: true;
    proxy: IpProxy;
    resumed: boolean;
  }> {
    const existing = await this.prisma.ipAssignment.findUnique({
      where: { userId },
      include: { proxy: true },
    });
    const wasReclaim =
      (await this.prisma.proxyReclaimRecord.count({
        where: { userId, status: 'REMOVED' },
      })) > 0;

    if (existing?.proxy?.active && existing.proxy.healthy) {
      await this.markReflowed(userId);
      await this.writeReflowLog({
        userId,
        result: 'SUCCESS',
        proxyId: existing.proxy.id,
        egressIp: existing.proxy.egressIp,
        wasReclaim,
        message: '已有绑定，恢复跟单',
      });
      return { ok: true, proxy: existing.proxy, resumed: true };
    }

    const alloc = await this.allocateProxyForUser(userId, wasReclaim ? 'reflow' : 'start_follow');
    if ('error' in alloc) {
      const cap = alloc.capacity;
      await this.writeReflowLog({
        userId,
        result: alloc.error === 'NO_PROXY' ? 'FAIL_NO_PROXY' : 'FAIL_NO_CAPACITY',
        occupied: cap.occupied,
        capacity: cap.capacity,
        healthyProxies: cap.healthyProxies,
        wasReclaim,
        message:
          alloc.error === 'NO_PROXY'
            ? '无健康代理'
            : `代理已满（${cap.occupied}/${cap.capacity}）`,
      });
      if (alloc.error === 'NO_PROXY') {
        throw new BadRequestException('暂无可用下单通道，请稍后再试或联系管理员');
      }
      throw new BadRequestException('当前跟单通道已满，请稍后再试');
    }

    await this.markReflowed(userId);
    await this.writeReflowLog({
      userId,
      result: 'SUCCESS',
      proxyId: alloc.proxy.id,
      egressIp: alloc.proxy.egressIp,
      wasReclaim,
      message: wasReclaim ? '回流成功，已重新分配代理' : '已分配代理并开启跟单',
    });
    return { ok: true, proxy: alloc.proxy, resumed: false };
  }

  private async writeReflowLog(data: {
    userId: string;
    result: string;
    proxyId?: string;
    egressIp?: string;
    occupied?: number;
    capacity?: number;
    healthyProxies?: number;
    wasReclaim?: boolean;
    message?: string;
  }) {
    const cap = await this.getCapacity();
    await this.prisma.proxyReflowLog.create({
      data: {
        userId: data.userId,
        result: data.result,
        proxyId: data.proxyId,
        egressIp: data.egressIp,
        occupied: data.occupied ?? cap.occupied,
        capacity: data.capacity ?? cap.capacity,
        healthyProxies: data.healthyProxies ?? cap.healthyProxies,
        wasReclaim: !!data.wasReclaim,
        message: data.message,
      },
    });
  }

  private async markReflowed(userId: string) {
    await this.prisma.proxyReclaimRecord.updateMany({
      where: { userId, status: 'REMOVED' },
      data: { status: 'REFLOWED', reflowedAt: new Date() },
    });
  }

  private async addReclaimRecord(params: {
    userId: string;
    prevProxyId?: string | null;
    prevEgress?: string | null;
    reason: string;
  }) {
    await this.prisma.proxyReclaimRecord.create({
      data: {
        userId: params.userId,
        prevProxyId: params.prevProxyId || undefined,
        prevEgress: params.prevEgress || undefined,
        reason: params.reason,
        status: 'REMOVED',
      },
    });
  }

  /**
   * 带 proxyIP 的中间件请求：成功清零；超时或网络故障连续 5 次则标异常并迁用户。
   * 交易所业务失败（有 HTTP 回包）不算。
   */
  noteProxyTransport(proxyAddress: string, ok: boolean): Promise<void> {
    const key = String(proxyAddress || '').trim();
    if (!key) return Promise.resolve();
    const prev = this.proxyTransportChain.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.applyProxyTransport(key, ok))
      .catch((e) => {
        this.logger.warn(`代理传输计数失败 ${key}: ${e?.message || e}`);
      });
    this.proxyTransportChain.set(key, run);
    return run;
  }

  private async findProxyByAddress(proxyAddress: string) {
    const parsed = parseMiddlewareProxy(proxyAddress);
    if (!parsed.host) return null;
    return this.prisma.ipProxy.findFirst({
      where: { host: parsed.host, port: parsed.port, active: true },
    });
  }

  private async applyProxyTransport(proxyAddress: string, ok: boolean) {
    const proxy = await this.findProxyByAddress(proxyAddress);
    if (!proxy) return;
    if (ok) {
      if (this.proxyTransportFails.get(proxy.id)) this.proxyTransportFails.set(proxy.id, 0);
      return;
    }
    if (!proxy.healthy || this.proxyTransportMigrating.has(proxy.id)) return;
    const n = (this.proxyTransportFails.get(proxy.id) || 0) + 1;
    this.proxyTransportFails.set(proxy.id, n);
    this.logger.warn(
      `代理 ${proxy.host} 请求超时或网络故障，连续 ${n}/${PROXY_TRANSPORT_FAIL_LIMIT} 次`,
    );
    if (n < PROXY_TRANSPORT_FAIL_LIMIT) return;
    this.proxyTransportFails.set(proxy.id, 0);
    await this.markUnhealthyFromTransport(proxy.id);
  }

  /** 传输故障达到阈值：只标不健康，人迁到仍有空位的代理。列表里还在，不标失效。 */
  private async markUnhealthyFromTransport(proxyId: string) {
    if (this.proxyTransportMigrating.has(proxyId)) return;
    this.proxyTransportMigrating.add(proxyId);
    try {
      const proxy = await this.prisma.ipProxy.findUnique({ where: { id: proxyId } });
      if (!proxy || !proxy.active || !proxy.healthy) return;
      const res = await this.relocateAssignees(proxyId, {
        deactivate: false,
        assignReason: `proxy_transport:${proxyId}`,
        pauseReason: 'proxy_transport',
      });
      this.logger.warn(
        `代理 ${proxy.egressIp || proxy.host} 连续传输失败已标异常，迁 ${res.movedUsers} 人，无空位停跟单 ${res.pausedUsers} 人`,
      );
    } finally {
      this.proxyTransportMigrating.delete(proxyId);
    }
  }

  /** 确认代理已恢复后手动标回健康，并清掉连续失败计数。不把已迁走的用户拉回来。 */
  async restoreHealth(proxyId: string) {
    const proxy = await this.prisma.ipProxy.findUnique({ where: { id: proxyId } });
    if (!proxy) throw new NotFoundException('代理不存在');
    this.proxyTransportFails.delete(proxyId);
    const updated = await this.prisma.ipProxy.update({
      where: { id: proxyId },
      data: { healthy: true, lastCheckAt: new Date() },
    });
    this.logger.log(`代理 ${proxy.egressIp || proxy.host} 已手动恢复健康`);
    return updated;
  }

  /**
   * 把绑定用户迁到仍有空位的健康代理。
   * 同步/清理会把源代理标成不健康；手动疏散 keepHealthy，健康代理保持健康。
   * count：只迁这么多人（按绑定时间从早到晚）。不传则迁走全部。
   * excludeProxyIds：这些代理即将删除，不能当换绑目标。
   */
  async evacuate(
    proxyId: string,
    toProxyId?: string,
    excludeProxyIds?: string[],
    manual?: { count?: number; keepHealthy?: boolean; strictTarget?: boolean },
  ) {
    return this.relocateAssignees(proxyId, {
      toProxyId,
      excludeProxyIds,
      count: manual?.count,
      keepHealthy: manual?.keepHealthy,
      strictTarget: manual?.strictTarget,
      deactivate: false,
      assignReason: `evacuate:${proxyId}`,
      pauseReason: 'evacuate_no_slot',
    });
  }

  private async relocateAssignees(
    proxyId: string,
    opts: {
      toProxyId?: string;
      excludeProxyIds?: string[];
      count?: number;
      keepHealthy?: boolean;
      /** 指定了目标时，只迁到这一台，空位不够则拒绝，不改落到其他代理 */
      strictTarget?: boolean;
      deactivate: boolean;
      assignReason: string;
      pauseReason: string;
    },
  ) {
    const proxy = await this.prisma.ipProxy.findUnique({ where: { id: proxyId } });
    if (!proxy) throw new NotFoundException('代理不存在');

    const { usersPerProxy } = await this.getPoolConfig();
    const assignees = await this.prisma.ipAssignment.findMany({
      where: { proxyId },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    let userIds = assignees.map((a) => a.userId);

    if (opts.count != null) {
      const count = opts.count;
      if (!Number.isInteger(count) || count < 1) {
        throw new BadRequestException('疏散个数至少为 1');
      }
      if (count > usersPerProxy) {
        throw new BadRequestException(`疏散个数不能超过每台阈值 ${usersPerProxy}`);
      }
      if (count > userIds.length) {
        throw new BadRequestException(`当前只绑定了 ${userIds.length} 人`);
      }
      userIds = userIds.slice(0, count);
    }

    if (!opts.keepHealthy) {
      await this.prisma.ipProxy.update({
        where: { id: proxyId },
        data: { healthy: false, lastCheckAt: new Date() },
      });
    }

    let targetFixed = opts.toProxyId
      ? await this.prisma.ipProxy.findUnique({ where: { id: opts.toProxyId } })
      : null;
    if (opts.toProxyId && !targetFixed) throw new BadRequestException('目标代理不存在');
    if (targetFixed && (targetFixed.id === proxyId || !targetFixed.active || !targetFixed.healthy)) {
      throw new BadRequestException('目标代理不可用');
    }
    if (opts.strictTarget && targetFixed && opts.count != null) {
      const occupied = await this.prisma.ipAssignment.count({
        where: { proxyId: targetFixed.id },
      });
      const room = usersPerProxy - occupied;
      if (opts.count > room) {
        throw new BadRequestException(room > 0 ? `目标代理还能再绑 ${room} 人` : '目标代理已满');
      }
    }

    const excluded = new Set(opts.excludeProxyIds || []);
    excluded.add(proxyId);

    let moved = 0;
    let paused = 0;

    const stillOnSource = async (userId: string) => {
      const row = await this.prisma.ipAssignment.findUnique({ where: { userId } });
      return !!row && row.proxyId === proxyId;
    };

    for (const userId of userIds) {
      const rest = (await this.healthyWithCounts()).filter(
        (p) => p.id !== proxyId && !excluded.has(p.id),
      );
      const withRoom = rest.filter((p) => p.assignedCount < usersPerProxy);

      let target: IpProxy | null = targetFixed;
      if (target && target.id === proxyId) target = null;
      if (target) {
        const live = withRoom.find((p) => p.id === target!.id);
        if (!live) target = null;
      }
      if (!target && !opts.strictTarget) {
        target = this.pickFirstWithRoom(withRoom, usersPerProxy);
      }
      if (target && target.id === proxyId) target = null;

      if (target) {
        await this.prisma.ipAssignment.upsert({
          where: { userId },
          create: { userId, proxyId: target.id, reason: opts.assignReason },
          update: { proxyId: target.id, reason: opts.assignReason },
        });
        if (await stillOnSource(userId)) {
          throw new BadRequestException('疏散后用户仍绑在原代理上');
        }
        moved++;
      } else if (opts.strictTarget) {
        break;
      } else {
        const prev = await this.prisma.ipAssignment.findUnique({
          where: { userId },
          include: { proxy: true },
        });
        await this.prisma.ipAssignment.deleteMany({ where: { userId } });
        await this.prisma.user.update({
          where: { id: userId },
          data: { followEnabled: false, followStoppedAt: new Date() },
        });
        await this.addReclaimRecord({
          userId,
          prevProxyId: prev?.proxyId || proxyId,
          prevEgress: prev?.proxy?.egressIp || proxy.egressIp,
          reason: opts.pauseReason,
        });
        paused++;
      }
    }

    if (opts.deactivate) {
      await this.prisma.ipProxy.update({
        where: { id: proxyId },
        data: { active: false, healthy: false },
      });
    }

    const remaining = userIds.length
      ? await this.prisma.ipAssignment.count({
          where: { proxyId, userId: { in: userIds } },
        })
      : 0;
    if (userIds.length > 0 && moved + paused === 0) {
      throw new BadRequestException('没有可迁入的空位，这台绑定没有变化');
    }
    if (remaining > 0 && !opts.strictTarget) {
      throw new BadRequestException(`还有 ${remaining} 人留在原代理上`);
    }

    return {
      proxyId,
      evacuatedTo: targetFixed?.id ?? 'sequential_fill',
      movedUsers: moved,
      pausedUsers: paused,
      remaining,
    };
  }

  /**
   * 运维：清理所有失效代理（active=false）。
   * 其上绑定用户先按 evacuate 迁到启用健康代理（或无空位停跟单），再删除旧代理行。
   */
  async cleanupInactiveProxies() {
    const inactive = await this.prisma.ipProxy.findMany({
      where: { active: false },
      orderBy: { createdAt: 'asc' },
    });
    const inactiveIds = inactive.map((p) => p.id);
    if (inactiveIds.length > 0) {
      await this.prisma.ipProxy.updateMany({
        where: { id: { in: inactiveIds } },
        data: { healthy: false, lastCheckAt: new Date() },
      });
    }

    let movedUsers = 0;
    let pausedUsers = 0;
    let deletedProxies = 0;
    const details: Array<{
      proxyId: string;
      egressIp: string;
      bound: number;
      moved: number;
      paused: number;
      deleted: boolean;
    }> = [];

    for (const p of inactive) {
      const bound = await this.prisma.ipAssignment.count({ where: { proxyId: p.id } });
      let moved = 0;
      let paused = 0;
      if (bound > 0) {
        const ev = await this.evacuate(p.id, undefined, inactiveIds);
        moved = ev.movedUsers;
        paused = ev.pausedUsers;
        movedUsers += moved;
        pausedUsers += paused;
      }
      // 疏散后不应再有绑定；兜底清掉再删行
      await this.prisma.ipAssignment.deleteMany({ where: { proxyId: p.id } });
      await this.prisma.ipProxy.delete({ where: { id: p.id } });
      deletedProxies++;
      details.push({
        proxyId: p.id,
        egressIp: p.egressIp,
        bound,
        moved,
        paused,
        deleted: true,
      });
      this.logger.log(
        `清理失效代理 ${p.egressIp}: bound=${bound} moved=${moved} paused=${paused}`,
      );
    }

    return {
      inactiveFound: inactive.length,
      deletedProxies,
      movedUsers,
      pausedUsers,
      details,
    };
  }

  // ---------- 闲置回收 ----------

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cronReclaimIdle() {
    try {
      const res = await this.reclaimIdle();
      if (res.reclaimed > 0) {
        this.logger.log(`闲置代理回收: ${res.reclaimed} 人`);
      }
    } catch (e: any) {
      this.logger.warn(`闲置回收失败: ${e?.message || e}`);
    }
  }

  async reclaimIdle() {
    const { idleNoFillDays, idleFollowOffDays } = await this.getPoolConfig();
    const now = Date.now();
    const noFillBefore = new Date(now - idleNoFillDays * 86400000);
    const followOffBefore = new Date(now - idleFollowOffDays * 86400000);

    let reclaimed = 0;
    const details: { userId: string; reason: string }[] = [];

    // 1) 开启跟单但长久无成功下单
    const following = await this.prisma.user.findMany({
      where: {
        isPlatform: false,
        followEnabled: true,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        followStartedAt: true,
        ipAssignment: { include: { proxy: true } },
      },
    });

    for (const u of following) {
      const lastFill = await this.prisma.signalFollowLog.findFirst({
        where: { userId: u.id, status: 'FILLED' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const anchor = lastFill?.createdAt || u.followStartedAt;
      if (!anchor || anchor > noFillBefore) continue;
      // 无 assignment 也回收跟单开关（不占坑但占跟单名额语义）
      await this.reclaimUser(u.id, u.ipAssignment, 'idle_no_fill');
      reclaimed++;
      details.push({ userId: u.id, reason: 'idle_no_fill' });
    }

    // 2) 关闭跟单超过 N 天仍占 IpAssignment
    const staleAssign = await this.prisma.ipAssignment.findMany({
      include: {
        proxy: true,
        user: { select: { id: true, followEnabled: true, followStoppedAt: true } },
      },
    });
    for (const a of staleAssign) {
      if (a.user.followEnabled) continue;
      const stopped = a.user.followStoppedAt || a.updatedAt;
      if (stopped > followOffBefore) continue;
      if (details.some((d) => d.userId === a.userId)) continue;
      await this.reclaimUser(a.userId, a, 'follow_off_stale');
      reclaimed++;
      details.push({ userId: a.userId, reason: 'follow_off_stale' });
    }

    return { reclaimed, details, idleNoFillDays, idleFollowOffDays };
  }

  private async reclaimUser(
    userId: string,
    assignment: { proxyId?: string; proxy?: { egressIp?: string } | null } | null,
    reason: string,
  ) {
    await this.prisma.ipAssignment.deleteMany({ where: { userId } });
    await this.prisma.user.update({
      where: { id: userId },
      data: { followEnabled: false, followStoppedAt: new Date() },
    });
    await this.addReclaimRecord({
      userId,
      prevProxyId: assignment?.proxyId,
      prevEgress: assignment?.proxy?.egressIp,
      reason,
    });
  }

  async listReclaims(params?: {
    status?: string;
    userId?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) {
    const where: any = {};
    if (params?.status) where.status = params.status;

    if (params?.from || params?.to) {
      where.createdAt = {};
      if (params.from) {
        const d = new Date(params.from);
        if (!Number.isNaN(d.getTime())) where.createdAt.gte = d;
      }
      if (params.to) {
        const d = new Date(params.to);
        if (!Number.isNaN(d.getTime())) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(params.to).trim())) d.setHours(23, 59, 59, 999);
          where.createdAt.lte = d;
        }
      }
    }

    const userWhere: any = {};
    const uid = params?.userId?.trim();
    if (uid) userWhere.id = uid;

    const no = params?.userNo?.trim();
    if (no) {
      if (/^\d+$/.test(no)) userWhere.userNo = Number(no);
      else if (!uid) userWhere.id = no;
    }

    const acc = params?.account?.trim();
    if (acc) {
      userWhere.OR = [
        { email: { contains: acc } },
        { nickname: { contains: acc } },
        { inviteCode: { contains: acc } },
      ];
    }

    if (Object.keys(userWhere).length > 0) {
      where.user = userWhere;
    }

    const skip = params?.skip ?? 0;
    const take = Math.min(params?.take ?? 50, 200);
    const [items, total] = await Promise.all([
      this.prisma.proxyReclaimRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { id: true, userNo: true, email: true, nickname: true, followEnabled: true } },
        },
      }),
      this.prisma.proxyReclaimRecord.count({ where }),
    ]);
    return { items, total };
  }

  async listReflowLogs(params?: { result?: string; skip?: number; take?: number }) {
    const where: any = {};
    if (params?.result) where.result = params.result;
    const skip = params?.skip ?? 0;
    const take = Math.min(params?.take ?? 50, 200);
    const [items, total] = await Promise.all([
      this.prisma.proxyReflowLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { id: true, userNo: true, email: true, nickname: true } },
        },
      }),
      this.prisma.proxyReflowLog.count({ where }),
    ]);
    return { items, total };
  }
}
