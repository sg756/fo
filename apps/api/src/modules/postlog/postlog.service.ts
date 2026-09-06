import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Exchange, PostDirection, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const CFG_POST_LOG_ENABLED = 'post_log_enabled';
const POST_LOG_RETENTION_DAYS = Number(process.env.POST_LOG_RETENTION_DAYS || 7);

/** 超过此字节数不写原始 body，只记摘要。下单/查单通常远小于此值 */
const POST_LOG_BODY_OMIT_MAX = Number(process.env.POST_LOG_BODY_OMIT_MAX || 65_536);
/** 数组或字典键数达到此值视为大包，不再 JSON.stringify 原文 */
const POST_LOG_COLLECTION_OMIT = Number(process.env.POST_LOG_COLLECTION_OMIT || 500);

function endpointPath(endpoint: string): string {
  return String(endpoint || '')
    .replace(/^\//, '')
    .split('?')[0];
}

/** 跟单信号轮询（LastOrderRecords）频率高、无审计价值，不写 post_logs */
function isFollowSignalPollLog(endpoint: string, feature?: string): boolean {
  if (endpointPath(endpoint) === 'mapi/LastOrderRecords') return true;
  return String(feature || '').trim() === '跟单信号';
}

/** 大包列表类：不写 post_logs */
function isSkippedLargeListLog(endpoint: string, feature?: string): boolean {
  if (isFollowSignalPollLog(endpoint, feature)) return true;
  const p = endpointPath(endpoint);
  return p === 'mapi/CryptoSymbolList' || p === 'mapi/GetDepth' || p.startsWith('mapi/GetDepth');
}

function isAlwaysOmitEndpoint(endpoint: string): boolean {
  const p = endpointPath(endpoint);
  return p === 'mapi/CryptoSymbolList' || p === 'mapi/GetDepth' || p.startsWith('mapi/GetDepth');
}

function collectionSize(v: any): number | undefined {
  if (Array.isArray(v)) return v.length;
  if (!v || typeof v !== 'object') return undefined;
  if (Array.isArray(v.data)) return v.data.length;
  if (v.data && typeof v.data === 'object' && !Array.isArray(v.data)) {
    return Object.keys(v.data).length;
  }
  return Object.keys(v).length;
}

function omitBodySummary(v: any, reason: string, bytes?: number): string {
  return JSON.stringify({
    _omitted: true,
    reason,
    bytes: bytes ?? undefined,
    type: Array.isArray(v) ? 'array' : typeof v,
    count: collectionSize(v),
  });
}

/** 小包原文；大数组/大字典/超长 JSON 只记摘要，不落几 MB body */
function toLogBody(v: any, forceOmit = false): string | null {
  if (v == null) return null;
  const n = collectionSize(v);
  if (forceOmit || (n != null && n >= POST_LOG_COLLECTION_OMIT)) {
    return omitBodySummary(
      v,
      forceOmit ? 'large endpoint body omitted' : 'large collection omitted',
    );
  }
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length <= POST_LOG_BODY_OMIT_MAX) return s;
    return omitBodySummary(v, 'body too large', s.length);
  } catch {
    return JSON.stringify({ _omitted: true, reason: 'unserializable' });
  }
}

/** 按中间件接口名推断触发功能 */
export function inferPostFeature(endpoint: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const path = String(endpoint || '')
    .split('?')[0]
    .replace(/^\//, '');
  const map: Record<string, string> = {
    'mapi/PlaceOrder': '下单',
    'mapi/CancelOrder': '撤单',
    'mapi/QueryOrder': '查单',
    'mapi/QueryBalance': '查资产',
    'mapi/QueryAssets': '查资产',
    'mapi/QueryPosition': '用户持仓对齐',
    'mapi/Positions': '信号持仓',
    'mapi/LastOrderRecords': '跟单信号',
    'mapi/PublicHttpProxyList': '代理列表',
    'mapi/MultiAccountList': '主账户列表',
    'mapi/CryptoSymbolList': '交易对规范',
    'mapi/Test': '连通性测试',
  };
  if (map[path]) return map[path];
  if (path.startsWith('mapi/GetDepth')) return '盘口深度';
  if (path.startsWith('mapi/')) return path.replace(/^mapi\//, '');
  return path || '未知';
}

@Injectable()
export class PostLogService implements OnModuleInit {
  private readonly logger = new Logger(PostLogService.name);
  private purging = false;
  private enabledCache: { at: number; on: boolean } | null = null;

  constructor(private prisma: PrismaService) {}

  /** 默认关闭：无配置或非 true/1 都不写库 */
  async isEnabled(): Promise<boolean> {
    if (this.enabledCache && Date.now() - this.enabledCache.at < 2_000) {
      return this.enabledCache.on;
    }
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CFG_POST_LOG_ENABLED },
    });
    const on = row?.value === 'true' || row?.value === '1';
    this.enabledCache = { at: Date.now(), on };
    return on;
  }

  async getConfig() {
    const enabled = await this.isEnabled();
    return { enabled };
  }

  async setEnabled(on: boolean) {
    const v = on ? 'true' : 'false';
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_POST_LOG_ENABLED },
      create: {
        key: CFG_POST_LOG_ENABLED,
        value: v,
        remark: '中间件 GET/POST 日志：true=写入 post_logs，默认关闭',
      },
      update: { value: v },
    });
    this.enabledCache = { at: Date.now(), on };
    this.logger.log(`中间件日志已${on ? '开启' : '关闭'}（post_log_enabled=${v}）`);
    return { enabled: on };
  }

  async onModuleInit() {
    setTimeout(() => {
      void this.purgeSignalPollLogs('startup').then(() => this.purgeExpired('startup'));
    }, 15_000);
  }

  /** 每天凌晨 3:20 清理跟单信号轮询日志 + 过期中间件日志 */
  @Cron('20 3 * * *')
  async cronPurge() {
    await this.purgeSignalPollLogs('cron');
    await this.purgeExpired('cron');
  }

  /**
   * 删除超过保留天数的中间件日志（默认 7 天）。
   * 分批删除，避免锁表过久。
   */
  async purgeExpired(reason = 'manual') {
    if (this.purging) {
      this.logger.warn(`PostLog 清理跳过（已在进行） reason=${reason}`);
      return { skipped: true as const };
    }
    this.purging = true;
    const days = Math.max(1, POST_LOG_RETENTION_DAYS);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const batch = 5000;
    let deletedOld = 0;
    try {
      for (;;) {
        const ids = await this.prisma.postLog.findMany({
          where: { createdAt: { lt: cutoff } },
          select: { id: true },
          take: batch,
        });
        if (ids.length === 0) break;
        const r = await this.prisma.postLog.deleteMany({
          where: { id: { in: ids.map((x) => x.id) } },
        });
        deletedOld += r.count;
        if (ids.length < batch) break;
      }

      this.logger.log(
        `PostLog 清理完成 reason=${reason} keepDays=${days} deleted=${deletedOld}`,
      );
      return { days, deletedOld };
    } catch (e: any) {
      this.logger.warn(`PostLog 清理失败 reason=${reason}: ${e?.message || e}`);
      return { error: e?.message || String(e) };
    } finally {
      this.purging = false;
    }
  }

  /** 清理跟单信号轮询日志（LastOrderRecords），高频写入无审计价值 */
  async purgeSignalPollLogs(reason = 'manual') {
    const batch = 5000;
    let deleted = 0;
    try {
      for (;;) {
        const ids = await this.prisma.postLog.findMany({
          where: {
            OR: [
              { feature: '跟单信号' },
              { endpoint: { startsWith: 'mapi/LastOrderRecords' } },
            ],
          },
          select: { id: true },
          take: batch,
        });
        if (ids.length === 0) break;
        const r = await this.prisma.postLog.deleteMany({
          where: { id: { in: ids.map((x) => x.id) } },
        });
        deleted += r.count;
        if (ids.length < batch) break;
      }
      this.logger.log(`PostLog 跟单信号轮询日志已清理 reason=${reason} deleted=${deleted}`);
      return { deleted };
    } catch (e: any) {
      this.logger.warn(`清理跟单信号日志失败: ${e?.message || e}`);
      return { error: e?.message || String(e) };
    }
  }

  /** 分批删除，避免一次 deleteMany 锁太久 */
  private async deleteByWhere(where: Prisma.PostLogWhereInput, reason: string) {
    if (this.purging) {
      throw new BadRequestException('正在清理中，请稍后再试');
    }
    this.purging = true;
    const batch = 5000;
    let deleted = 0;
    try {
      for (;;) {
        const ids = await this.prisma.postLog.findMany({
          where,
          select: { id: true },
          take: batch,
        });
        if (ids.length === 0) break;
        const r = await this.prisma.postLog.deleteMany({
          where: { id: { in: ids.map((x) => x.id) } },
        });
        deleted += r.count;
        if (ids.length < batch) break;
      }
      this.logger.log(`PostLog 手动清理完成 reason=${reason} deleted=${deleted}`);
      return { ok: true as const, deleted };
    } catch (e: any) {
      this.logger.warn(`PostLog 手动清理失败 reason=${reason}: ${e?.message || e}`);
      throw new BadRequestException(e?.message || '清理失败');
    } finally {
      this.purging = false;
    }
  }

  /** 清空全部中间件日志 */
  async purgeAll(reason = 'admin') {
    return this.deleteByWhere({}, reason);
  }

  /** 按时间范围清理（含边界）；from/to 可只填一侧 */
  async purgeByRange(opts: { from?: string; to?: string; reason?: string }) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (opts.from?.trim()) {
      const from = new Date(opts.from.trim());
      if (Number.isNaN(from.getTime())) throw new BadRequestException('开始时间无效');
      createdAt.gte = from;
    }
    if (opts.to?.trim()) {
      const to = new Date(opts.to.trim());
      if (Number.isNaN(to.getTime())) throw new BadRequestException('结束时间无效');
      createdAt.lte = to;
    }
    if (createdAt.gte && createdAt.lte && createdAt.gte > createdAt.lte) {
      throw new BadRequestException('开始时间不能晚于结束时间');
    }
    return this.deleteByWhere({ createdAt }, opts.reason || 'admin-range');
  }

  async record(params: {
    userId?: string;
    direction?: PostDirection;
    exchange?: Exchange;
    feature?: string;
    endpoint: string;
    /** 完整请求路径（含 query），缺省则用 endpoint */
    path?: string | null;
    method?: string;
    proxyIp?: string;
    requestBody?: any;
    responseBody?: any;
    statusCode?: number;
    latencyMs?: number;
    success?: boolean;
  }) {
    const fullPath = String(params.path || params.endpoint || '')
      .trim()
      .replace(/^\//, '');
    const endpointOnly = fullPath.split('?')[0] || fullPath;
    if (!(await this.isEnabled())) {
      return null;
    }
    if (isSkippedLargeListLog(endpointOnly, params.feature)) {
      return null;
    }
    const responseBody = toLogBody(
      params.responseBody,
      isAlwaysOmitEndpoint(endpointOnly),
    );

    return this.prisma.postLog.create({
      data: {
        userId: params.userId,
        direction: params.direction ?? 'OUTBOUND',
        exchange: params.exchange,
        feature: inferPostFeature(endpointOnly, params.feature),
        endpoint: endpointOnly,
        path: fullPath || null,
        method: params.method ?? 'POST',
        proxyIp: params.proxyIp,
        requestBody: toLogBody(params.requestBody),
        responseBody,
        statusCode: params.statusCode,
        latencyMs: params.latencyMs,
        success: params.success ?? false,
      },
    });
  }

  async list(params: {
    userId?: string;
    exchange?: Exchange;
    success?: boolean;
    feature?: string;
    endpoint?: string;
    q?: string;
    /** 是否搜报文正文（默认否，TEXT 全表扫很慢） */
    searchBody?: boolean;
    skip?: number;
    take?: number;
  }) {
    const {
      userId,
      exchange,
      success,
      feature,
      endpoint,
      q,
      searchBody = false,
      skip = 0,
      take = 50,
    } = params;
    const where: any = {};
    if (userId) where.userId = userId;
    if (exchange) where.exchange = exchange;
    if (success !== undefined) where.success = success;
    // 下拉选功能：精确匹配（可用索引），避免 contains 全表扫
    if (feature?.trim()) where.feature = feature.trim();
    if (endpoint?.trim()) where.endpoint = { contains: endpoint.trim() };
    if (q?.trim()) {
      const kw = q.trim();
      const or: any[] = [
        { feature: { contains: kw } },
        { endpoint: { contains: kw } },
        { path: { contains: kw } },
        { proxyIp: { contains: kw } },
      ];
      // 报文模糊搜仅显式开启：requestBody/responseBody 为 TEXT，日志量大时极慢
      if (searchBody) {
        or.push({ requestBody: { contains: kw } }, { responseBody: { contains: kw } });
      }
      where.OR = or;
    }
    const [rows, total] = await Promise.all([
      this.prisma.postLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(Math.max(take, 1), 200),
        select: {
          id: true,
          userId: true,
          direction: true,
          exchange: true,
          feature: true,
          endpoint: true,
          path: true,
          method: true,
          proxyIp: true,
          statusCode: true,
          latencyMs: true,
          success: true,
          createdAt: true,
          user: { select: { id: true, userNo: true, nickname: true, email: true } },
        },
      }),
      this.prisma.postLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        ...r,
        userLabel: r.user
          ? `${r.user.nickname || r.user.email || r.user.id}${
              r.user.userNo != null ? `（#${r.user.userNo}）` : ''
            }`
          : null,
      })),
      total,
    };
  }

  async getById(id: string) {
    const r = await this.prisma.postLog.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, userNo: true, nickname: true, email: true } },
      },
    });
    if (!r) return null;
    return {
      ...r,
      userLabel: r.user
        ? `${r.user.nickname || r.user.email || r.user.id}${
            r.user.userNo != null ? `（#${r.user.userNo}）` : ''
          }`
        : null,
    };
  }

  async features() {
    const groups = await this.prisma.postLog.groupBy({
      by: ['feature'],
      _count: { _all: true },
    });
    return groups
      .filter((g) => g.feature)
      .map((g) => ({ feature: g.feature as string, count: g._count._all }))
      .sort((a, b) => b.count - a.count);
  }
}
