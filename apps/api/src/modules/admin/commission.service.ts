import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CommissionService {
  constructor(private prisma: PrismaService) {}

  async getActiveRule() {
    let rule = await this.prisma.commissionRule.findFirst({ where: { active: true } });
    if (!rule) {
      rule = await this.prisma.commissionRule.create({
        data: {
          name: 'default',
          // 默认：每单抽 10%，抽成池内 直推25% / 间推50% / 平台25%
          extractRate: 0.1,
          l1Rate: 0.25,
          l2Rate: 0.5,
          platformRate: 0.25,
          active: true,
        },
      });
    }
    return rule;
  }

  listRules() {
    return this.prisma.commissionRule.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async upsertRule(data: {
    id?: string;
    name?: string;
    extractRate: number;
    l1Rate: number;
    l2Rate: number;
    platformRate: number;
    active?: boolean;
    updatedById?: string;
  }) {
    const extractRate = Number(data.extractRate);
    if (!Number.isFinite(extractRate) || extractRate < 0 || extractRate > 1) {
      throw new BadRequestException('每单抽成比例须在 0～100%');
    }
    if (data.l1Rate + data.l2Rate + data.platformRate > 1 + 1e-9) {
      throw new BadRequestException('抽成池内三级比例之和不能超过 100%');
    }
    const makeActive = data.active !== false;

    if (makeActive) {
      await this.prisma.commissionRule.updateMany({
        where: data.id ? { id: { not: data.id } } : undefined,
        data: { active: false },
      });
    }

    if (data.id) {
      return this.prisma.commissionRule.update({
        where: { id: data.id },
        data: {
          name: data.name,
          extractRate,
          l1Rate: data.l1Rate,
          l2Rate: data.l2Rate,
          platformRate: data.platformRate,
          active: makeActive,
          updatedById: data.updatedById,
        },
      });
    }

    return this.prisma.commissionRule.create({
      data: {
        name: data.name || 'rule',
        extractRate,
        l1Rate: data.l1Rate,
        l2Rate: data.l2Rate,
        platformRate: data.platformRate,
        active: makeActive,
        updatedById: data.updatedById,
      },
    });
  }

  /** 启用历史规则（同时停用其它） */
  async activateRule(id: string, updatedById?: string) {
    const rule = await this.prisma.commissionRule.findUnique({ where: { id } });
    if (!rule) throw new BadRequestException('规则不存在');
    await this.prisma.commissionRule.updateMany({ data: { active: false } });
    return this.prisma.commissionRule.update({
      where: { id },
      data: { active: true, updatedById },
    });
  }

  /** 删除停用中的规则（启用中的不允许删） */
  async deleteRule(id: string) {
    const rule = await this.prisma.commissionRule.findUnique({ where: { id } });
    if (!rule) throw new BadRequestException('规则不存在');
    if (rule.active) throw new BadRequestException('启用中的规则不能删除，请先启用其它规则');
    await this.prisma.commissionRule.delete({ where: { id } });
    return { ok: true, id };
  }

  async listRecords(params: {
    skip?: number;
    take?: number;
    earnerId?: string;
    /** 获得者（目标）：用户 ID / 账号 / 邮箱 */
    earner?: string;
    /** 来源用户：用户 ID / 账号 / 邮箱 */
    fromUser?: string;
    from?: string;
    to?: string;
  }) {
    const { skip = 0, take = 50, earnerId, earner, fromUser, from, to } = params;
    const where: Prisma.CommissionRecordWhereInput = {};
    if (earnerId) where.earnerId = earnerId;

    if (from || to) {
      where.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) where.createdAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(to.trim())) d.setHours(23, 59, 59, 999);
          where.createdAt.lte = d;
        }
      }
    }

    const buildUserFilter = (raw?: string): Prisma.UserWhereInput | undefined => {
      const s = raw?.trim();
      if (!s) return undefined;
      if (/^\d+$/.test(s)) return { userNo: Number(s) };
      return {
        OR: [
          { email: { contains: s } },
          { nickname: { contains: s } },
          { inviteCode: { contains: s } },
          { id: s },
        ],
      };
    };

    const earnerFilter = buildUserFilter(earner);
    if (earnerFilter) where.earner = earnerFilter;
    const fromFilter = buildUserFilter(fromUser);
    if (fromFilter) where.fromUser = fromFilter;

    const [items, total, agg, profitAgg, byLevel] = await Promise.all([
      this.prisma.commissionRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(take, 200),
        include: {
          earner: { select: { id: true, email: true, nickname: true, userNo: true } },
          fromUser: { select: { id: true, email: true, nickname: true, userNo: true } },
          profit: {
            select: {
              id: true,
              profit: true,
              symbol: true,
              exchange: true,
              orderId: true,
              signalKey: true,
              source: true,
              closedAt: true,
            },
          },
        },
      }),
      this.prisma.commissionRecord.count({ where }),
      this.prisma.commissionRecord.aggregate({
        where,
        _sum: { amount: true },
        _count: true,
      }),
      // 同一平仓会拆成多条佣金；利润按 profit 去重后 SUM，避免翻倍
      this.prisma.profitRecord.aggregate({
        where: { commissions: { some: where } },
        _sum: { profit: true },
      }),
      this.prisma.commissionRecord.groupBy({
        by: ['level'],
        where,
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const levelMap: Record<string, { count: number; amount: string }> = {};
    for (const row of byLevel) {
      levelMap[row.level] = {
        count: row._count,
        amount: String(row._sum.amount ?? 0),
      };
    }

    return {
      items,
      total,
      summary: {
        count: agg._count,
        amount: String(agg._sum.amount ?? 0),
        profitSum: String(profitAgg._sum.profit ?? 0),
        byLevel: levelMap,
      },
    };
  }

  /** 佣金记录溯源：关联 profit_records + 平仓/配对开仓挂单日志 */
  async getRecordSource(id: string) {
    const rec = await this.prisma.commissionRecord.findUnique({
      where: { id },
      include: {
        earner: { select: { id: true, email: true, nickname: true, userNo: true } },
        fromUser: { select: { id: true, email: true, nickname: true, userNo: true } },
        profit: true,
      },
    });
    if (!rec) throw new BadRequestException('佣金记录不存在');

    const closeLog = await this.resolveCloseFollowLog(rec.profit);
    const openLots = await this.resolveMatchedOpenLots(rec.profit, closeLog);

    return {
      commission: {
        id: rec.id,
        level: rec.level,
        rate: String(rec.rate),
        amount: String(rec.amount),
        createdAt: rec.createdAt,
        earner: rec.earner,
        fromUser: rec.fromUser,
      },
      profit: {
        id: rec.profit.id,
        userId: rec.profit.userId,
        exchange: rec.profit.exchange,
        symbol: rec.profit.symbol,
        profit: String(rec.profit.profit),
        closedAt: rec.profit.closedAt,
        orderId: rec.profit.orderId,
        signalKey: rec.profit.signalKey,
        source: rec.profit.source,
        settled: rec.profit.settled,
        createdAt: rec.profit.createdAt,
      },
      closeLog: closeLog ? this.formatFollowLogBrief(closeLog) : null,
      openLots: openLots.map((o) => this.formatFollowLogBrief(o)),
      traceHint: closeLog
        ? null
        : rec.profit.source === 'MANUAL'
          ? '该笔利润为手动录入，无跟单挂单日志'
          : '未找到对应平仓挂单日志（可能已被清理）',
    };
  }

  private async resolveCloseFollowLog(profit: {
    userId: string;
    orderId: string | null;
    signalKey: string | null;
    closedAt: Date;
  }) {
    if (profit.orderId) {
      const byOrder = await this.prisma.signalFollowLog.findFirst({
        where: { userId: profit.userId, orderId: profit.orderId, isOpen: false },
        orderBy: { createdAt: 'desc' },
      });
      if (byOrder) return byOrder;
    }
    const sk = String(profit.signalKey || '').trim();
    if (!sk) return null;
    const orderGid = sk.replace(/:(open|close)(:.*)?$/i, '') || sk;
    return this.prisma.signalFollowLog.findFirst({
      where: {
        userId: profit.userId,
        OR: [
          { signalKey: sk },
          { signalKey: `${orderGid}:close` },
          { orderGid, isOpen: false },
          { signalKey: orderGid, isOpen: false },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async resolveMatchedOpenLots(
    profit: { userId: string; exchange: string; closedAt: Date; symbol: string },
    closeLog: {
      coinName?: string | null;
      equalCoinName?: string | null;
      positionSide?: string | null;
    } | null,
  ) {
    let coinName = closeLog?.coinName || null;
    let equalCoinName = closeLog?.equalCoinName || null;
    if (!coinName && profit.symbol && profit.symbol !== '—') {
      const sym = String(profit.symbol);
      coinName = sym.includes('/') ? sym.split('/')[0] : sym;
      if (sym.includes('/')) equalCoinName = sym.split('/')[1] || equalCoinName;
    }

    const where: Prisma.SignalFollowLogWhereInput = {
      userId: profit.userId,
      exchange: profit.exchange as any,
      isOpen: true,
      consumedAmt: { gt: 0 },
      createdAt: { lte: profit.closedAt },
    };
    if (coinName) where.coinName = coinName;
    if (equalCoinName) where.equalCoinName = equalCoinName;
    if (closeLog?.positionSide) where.positionSide = closeLog.positionSide;

    return this.prisma.signalFollowLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
  }

  private formatFollowLogBrief(log: {
    id: string;
    status: string;
    orderId: string | null;
    orderGid?: string;
    signalKey?: string;
    coinName: string | null;
    equalCoinName: string | null;
    positionSide: string | null;
    isOpen: boolean | null;
    filledAmt: any;
    consumedAmt: any;
    avgPrice: any;
    tradeFee: any;
    profitConsumed: boolean;
    createdAt: Date;
    accountGid: string | null;
    accountName: string | null;
    fillKind?: string;
  }) {
    return {
      id: log.id,
      status: log.status,
      fillKind: log.fillKind || null,
      orderId: log.orderId,
      orderGid: log.orderGid || null,
      signalKey: log.signalKey || null,
      coinName: log.coinName,
      equalCoinName: log.equalCoinName,
      positionSide: log.positionSide,
      isOpen: log.isOpen,
      filledAmt: log.filledAmt != null ? String(log.filledAmt) : null,
      consumedAmt: log.consumedAmt != null ? String(log.consumedAmt) : null,
      avgPrice: log.avgPrice != null ? String(log.avgPrice) : null,
      tradeFee: log.tradeFee != null ? String(log.tradeFee) : null,
      profitConsumed: log.profitConsumed,
      createdAt: log.createdAt,
      accountGid: log.accountGid,
      accountName: log.accountName,
    };
  }

  /** 某收款人按日返利汇总（按 commission_records.createdAt） */
  async dailySummary(params: { earnerId: string; days?: number }) {
    const { earnerId, days = 90 } = params;
    if (!earnerId) throw new BadRequestException('缺少 earnerId');
    const d = Math.min(Math.max(Number(days) || 90, 1), 366);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (d - 1));

    const rows = await this.prisma.$queryRaw<
      Array<{ day: Date | string; level: string; cnt: bigint | number; sum: any }>
    >`
      SELECT DATE(createdAt) AS day, level, COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS sum
      FROM commission_records
      WHERE earnerId = ${earnerId} AND createdAt >= ${since}
      GROUP BY DATE(createdAt), level
      ORDER BY day DESC
    `;

    const byDay = new Map<
      string,
      {
        day: string;
        count: number;
        amount: number;
        direct: number;
        indirect: number;
        platform: number;
      }
    >();

    for (const r of rows) {
      const day =
        r.day instanceof Date
          ? r.day.toISOString().slice(0, 10)
          : String(r.day).slice(0, 10);
      let bucket = byDay.get(day);
      if (!bucket) {
        bucket = { day, count: 0, amount: 0, direct: 0, indirect: 0, platform: 0 };
        byDay.set(day, bucket);
      }
      const cnt = Number(r.cnt);
      const sum = Number(r.sum);
      bucket.count += cnt;
      bucket.amount += sum;
      if (r.level === 'DIRECT' || r.level === 'L1') bucket.direct += sum;
      else if (r.level === 'INDIRECT' || r.level === 'L2') bucket.indirect += sum;
      else if (r.level === 'PLATFORM') bucket.platform += sum;
    }

    const items = [...byDay.values()].map((x) => ({
      ...x,
      amount: Number(x.amount.toFixed(10)),
      direct: Number(x.direct.toFixed(10)),
      indirect: Number(x.indirect.toFixed(10)),
      platform: Number(x.platform.toFixed(10)),
    }));

    const total = items.reduce(
      (acc, x) => {
        acc.count += x.count;
        acc.amount += x.amount;
        return acc;
      },
      { count: 0, amount: 0 },
    );

    return {
      earnerId,
      days: d,
      items,
      total: { count: total.count, amount: Number(total.amount.toFixed(10)) },
    };
  }

  /** 各用户累计获得返利（供分销树挂载） */
  async earnerTotals() {
    const [totals, byLevel] = await Promise.all([
      this.prisma.commissionRecord.groupBy({
        by: ['earnerId'],
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.commissionRecord.groupBy({
        by: ['earnerId', 'level'],
        _sum: { amount: true },
      }),
    ]);

    const map = new Map<
      string,
      { count: number; amount: number; direct: number; indirect: number }
    >();
    for (const t of totals) {
      map.set(t.earnerId, {
        count: t._count,
        amount: Number(t._sum.amount ?? 0),
        direct: 0,
        indirect: 0,
      });
    }
    for (const row of byLevel) {
      const cur = map.get(row.earnerId);
      if (!cur) continue;
      const v = Number(row._sum.amount ?? 0);
      const lv = String(row.level);
      if (lv === 'DIRECT' || lv === 'L1') cur.direct += v;
      else if (lv === 'INDIRECT' || lv === 'L2') cur.indirect += v;
    }
    return map;
  }

  /** 点卡/佣金入账 (正数)。COMMISSION 入可提佣金余额，其它入跟单点卡。 */
  private async creditPoint(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: Prisma.Decimal,
    type: 'COMMISSION' | 'TRADE_PNL' | 'ADJUST' | 'RECHARGE' | 'WITHDRAW_REFUND',
    refType: string,
    refId: string,
    remark: string,
  ) {
    if (amount.lte(0)) return;
    const card =
      (await tx.pointCard.findUnique({ where: { userId } })) ??
      (await tx.pointCard.create({ data: { userId } }));

    if (type === 'COMMISSION') {
      const commissionBalance = new Prisma.Decimal(card.commissionBalance).add(amount);
      await tx.pointCard.update({ where: { userId }, data: { commissionBalance } });
      await tx.pointCardTx.create({
        data: {
          userId,
          type,
          amount,
          balanceAfter: commissionBalance,
          refType,
          refId,
          remark,
        },
      });
      return;
    }

    const balanceAfter = new Prisma.Decimal(card.balance).add(amount);
    await tx.pointCard.update({ where: { userId }, data: { balance: balanceAfter } });
    await tx.pointCardTx.create({
      data: {
        userId,
        type,
        amount,
        balanceAfter,
        refType,
        refId,
        remark,
      },
    });
  }

  /**
   * 点卡扣减 (amount 为正数表示扣多少; 流水记负数)。
   * 分润扣减允许余额为负: 盈利在交易所账户, 无法提前预知金额, 可能大于当前点卡。
   */
  private async debitPoint(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: Prisma.Decimal,
    type: 'SHARE_DEDUCT' | 'WITHDRAW' | 'ADJUST',
    refType: string,
    refId: string,
    remark: string,
    opts?: { allowNegative?: boolean },
  ) {
    if (amount.lte(0)) return;
    const card =
      (await tx.pointCard.findUnique({ where: { userId } })) ??
      (await tx.pointCard.create({ data: { userId } }));
    const balanceAfter = new Prisma.Decimal(card.balance).sub(amount);
    if (!opts?.allowNegative && balanceAfter.lt(0)) {
      throw new BadRequestException(
        `点卡余额不足, 无法扣除 ${amount.toString()} (当前 ${card.balance.toString()})`,
      );
    }
    await tx.pointCard.update({ where: { userId }, data: { balance: balanceAfter } });
    await tx.pointCardTx.create({
      data: {
        userId,
        type,
        amount: amount.neg(), // 流水: 负出
        balanceAfter,
        refType,
        refId,
        remark,
      },
    });
  }

  /** 平台佣金归集账户（users.isPlatform=true，不是管理员） */
  async getPlatformUserId(): Promise<string | null> {
    const platform = await this.prisma.user.findFirst({
      where: { isPlatform: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return platform?.id ?? null;
  }

  /**
   * 沿 parent 链取分润上级: 直推(上1级) / 间推(上2级)
   * 邀请关系可无限级, 分润只返两级 + 平台
   */
  private async resolveUplineChain(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ up1: string | null; up2: string | null }> {
    const me = await tx.user.findUnique({
      where: { id: userId },
      select: { parentId: true },
    });
    if (!me?.parentId || me.parentId === userId) return { up1: null, up2: null };

    const p1 = await tx.user.findUnique({
      where: { id: me.parentId },
      select: { id: true, parentId: true },
    });
    if (!p1) return { up1: null, up2: null };

    const up1 = p1.id;
    let up2: string | null = p1.parentId && p1.parentId !== userId && p1.parentId !== up1 ? p1.parentId : null;
    return { up1, up2 };
  }

  /**
   * 单条平仓利润结算 (幂等: settled=true 直接跳过)
   *
   * 说明: 实际盈利在用户交易所账户, 平台点卡不入账获利。
   * 新模型:
   * 1. 按 extractRate 从正利润抽出「抽成池」；点卡只扣抽成池，余下利润归用户
   * 2. 抽成池内按 直推 / 间推 / 平台 分配（比例相对抽成池）；缺档或未分配部分归平台
   */
  private async settleOneRecord(
    p: {
      id: string;
      userId: string;
      profit: Prisma.Decimal | any;
    },
    rule: { extractRate?: any; l1Rate: any; l2Rate: any; platformRate: any },
    platformUserId: string | null,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.profitRecord.findUnique({ where: { id: p.id } });
      if (!fresh || fresh.settled) return;

      const profit = new Prisma.Decimal(p.profit);
      if (profit.lte(0)) {
        await tx.profitRecord.update({ where: { id: p.id }, data: { settled: true } });
        return;
      }

      const extractRate = Math.min(1, Math.max(0, Number(rule.extractRate) || 0));
      const l1Rate = Number(rule.l1Rate) || 0; // 直推（相对抽成池）
      const l2Rate = Number(rule.l2Rate) || 0; // 间推
      const platformRate = Number(rule.platformRate) || 0;
      if (extractRate <= 0) {
        await tx.profitRecord.update({ where: { id: p.id }, data: { settled: true } });
        return;
      }

      const { up1, up2 } = await this.resolveUplineChain(tx, p.userId);

      // 1) 抽成池 = 利润 × 每单抽成%；点卡只扣池内金额
      const pool = profit.mul(extractRate);
      await this.debitPoint(
        tx,
        p.userId,
        pool,
        'SHARE_DEDUCT',
        'ProfitRecord',
        p.id,
        '分润扣减',
        { allowNegative: true },
      );

      // 2) 抽成池内级差分配: 直推 / 间推 / 平台
      type Share = {
        earnerId: string;
        level: 'DIRECT' | 'INDIRECT' | 'PLATFORM';
        rate: number;
        amount: Prisma.Decimal;
      };
      const shares: Share[] = [];
      let platformAmount = pool.mul(platformRate);
      let allocated = platformAmount;

      if (l1Rate > 0) {
        const amt = pool.mul(l1Rate);
        if (up1 && up1 !== p.userId) {
          shares.push({ earnerId: up1, level: 'DIRECT', rate: l1Rate, amount: amt });
          allocated = allocated.add(amt);
        } else {
          platformAmount = platformAmount.add(amt);
          allocated = allocated.add(amt);
        }
      }
      if (l2Rate > 0) {
        const amt = pool.mul(l2Rate);
        if (up2 && up2 !== p.userId && up2 !== up1) {
          shares.push({ earnerId: up2, level: 'INDIRECT', rate: l2Rate, amount: amt });
          allocated = allocated.add(amt);
        } else {
          platformAmount = platformAmount.add(amt);
          allocated = allocated.add(amt);
        }
      }
      // 抽成池内未分配部分归平台，保证扣额 = 佣金合计
      const leftover = pool.sub(allocated);
      if (leftover.gt(0)) {
        platformAmount = platformAmount.add(leftover);
      }

      if (platformAmount.gt(0) && platformUserId && platformUserId !== p.userId) {
        const platRate = Number(platformAmount.div(pool).toFixed(6));
        shares.push({
          earnerId: platformUserId,
          level: 'PLATFORM',
          rate: platRate,
          amount: platformAmount,
        });
      }

      const levelLabel: Record<string, string> = {
        DIRECT: '直推',
        INDIRECT: '间推',
        PLATFORM: '平台',
      };

      for (const s of shares) {
        if (s.amount.lte(0) || !s.earnerId) continue;
        const rec = await tx.commissionRecord.create({
          data: {
            earnerId: s.earnerId,
            fromUserId: p.userId,
            profitId: p.id,
            level: s.level,
            rate: s.rate,
            amount: s.amount,
          },
        });
        await this.creditPoint(
          tx,
          s.earnerId,
          s.amount,
          'COMMISSION',
          'CommissionRecord',
          rec.id,
          `佣金分成(${levelLabel[s.level] || s.level})`,
        );
      }

      await tx.profitRecord.update({ where: { id: p.id }, data: { settled: true } });
    });
  }

  /**
   * 结算未结算的平仓利润 -> 按比例扣用户点卡(可负) -> 三级佣金
   */
  async settle(platformUserId?: string) {
    const rule = await this.getActiveRule();
    const platform = platformUserId ?? (await this.getPlatformUserId());
    const profits = await this.prisma.profitRecord.findMany({
      where: { settled: false, profit: { gt: 0 } },
      take: 500,
    });

    let processed = 0;
    for (const p of profits) {
      await this.settleOneRecord(p as any, rule, platform);
      processed++;
    }

    return { processed };
  }

  /** 结算单条平仓利润 (利润入库后即时触发) */
  async settleProfit(profitId: string) {
    const p = await this.prisma.profitRecord.findUnique({ where: { id: profitId } });
    if (!p) throw new BadRequestException('利润记录不存在');
    if (p.settled) return { settled: true, skipped: true };
    if (Number(p.profit) <= 0) {
      await this.prisma.profitRecord.update({ where: { id: profitId }, data: { settled: true } });
      return { settled: true, commission: false, userNet: 0 };
    }
    const rule = await this.getActiveRule();
    const platform = await this.getPlatformUserId();
    await this.settleOneRecord(p, rule, platform);

    const extractRate = Math.min(1, Math.max(0, Number(rule.extractRate) || 0));
    const profit = Number(p.profit);
    return {
      settled: true,
      commission: extractRate > 0,
      profit,
      extractRate,
      deductRate: extractRate,
      deductAmount: profit * extractRate,
      // 盈利留在交易所账户, 点卡只扣抽成池、不增加
      note: 'profit_stays_on_exchange',
    };
  }

  /** 解析日界 [start, end) 本地日历日 */
  private dayRange(dateStr?: string): { day: string; start: Date; end: Date } {
    const base = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
    if (Number.isNaN(base.getTime())) throw new BadRequestException('日期格式无效, 请用 YYYY-MM-DD');
    const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    return { day, start, end };
  }

  private num(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** 用户筛选：纯数字=用户ID(userNo)，否则按 id / 昵称 / 邮箱 / 邀请码 */
  private userFilterFromQuery(raw?: string): Prisma.UserWhereInput | undefined {
    const s = String(raw || '').trim();
    if (!s) return undefined;
    if (/^\d+$/.test(s)) return { userNo: Number(s) };
    return {
      OR: [
        { id: s },
        { email: { contains: s } },
        { nickname: { contains: s } },
        { inviteCode: { contains: s } },
      ],
    };
  }

  /**
   * 单日对账: 利润(已结算且>0) ↔ SHARE_DEDUCT ↔ 佣金入账
   * 理想关系: |扣点卡| ≈ Σ佣金 (同一 profitId)
   */
  async reconcileDay(dateStr?: string, userRaw?: string) {
    const { day, start, end } = this.dayRange(dateStr);
    const eps = 1e-6;
    const userFilter = this.userFilterFromQuery(userRaw);

    const profits = await this.prisma.profitRecord.findMany({
      where: {
        closedAt: { gte: start, lt: end },
        ...(userFilter ? { user: userFilter } : {}),
      },
      include: {
        user: { select: { email: true, nickname: true, userNo: true } },
        commissions: { select: { id: true, amount: true, level: true, earnerId: true } },
      },
      orderBy: { closedAt: 'asc' },
      take: 2000,
    });

    const profitIds = profits.map((p) => p.id);

    // 扣点卡按 profitId 关联(可跨日结算); 另取当日产生的 SHARE_DEDUCT 查跨日/孤儿
    const [deductByRefs, deductCreatedDay] = await Promise.all([
      profitIds.length
        ? this.prisma.pointCardTx.findMany({
            where: {
              type: 'SHARE_DEDUCT',
              refType: 'ProfitRecord',
              refId: { in: profitIds },
            },
            include: { user: { select: { email: true, nickname: true, userNo: true } } },
            take: 5000,
          })
        : Promise.resolve([]),
      this.prisma.pointCardTx.findMany({
        where: {
          type: 'SHARE_DEDUCT',
          createdAt: { gte: start, lt: end },
          ...(userFilter ? { user: userFilter } : {}),
        },
        include: { user: { select: { email: true, nickname: true, userNo: true } } },
        take: 2000,
      }),
    ]);

    const deductByProfit = new Map<
      string,
      { amount: number; txId: string; userEmail?: string; userNickname?: string | null }
    >();
    for (const tx of deductByRefs) {
      if (!tx.refId) continue;
      const abs = Math.abs(this.num(tx.amount));
      const prev = deductByProfit.get(tx.refId);
      deductByProfit.set(tx.refId, {
        amount: (prev?.amount || 0) + abs,
        txId: tx.id,
        userEmail: tx.user?.email,
        userNickname: tx.user?.nickname,
      });
    }

    const profitIdSet = new Set(profitIds);

    type Issue = {
      kind: string;
      profitId?: string;
      userEmail?: string;
      userNickname?: string | null;
      userNo?: number | null;
      profit?: number;
      deduct?: number;
      commission?: number;
      detail: string;
    };
    const issues: Issue[] = [];
    const rows: any[] = [];

    let profitPositiveSum = 0;
    let profitPositiveCount = 0;
    let settledPositiveCount = 0;
    let matchedOk = 0;

    for (const p of profits) {
      const profit = this.num(p.profit);
      const commissionSumRow = p.commissions.reduce((s, c) => s + this.num(c.amount), 0);
      const deduct = deductByProfit.get(p.id)?.amount ?? 0;
      const userEmail = p.user?.email;
      const userNickname = p.user?.nickname;
      const userNo = p.user?.userNo ?? null;

      if (profit > 0) {
        profitPositiveSum += profit;
        profitPositiveCount++;
        if (p.settled) settledPositiveCount++;
      }

      let status: 'ok' | 'skip' | 'mismatch' | 'unsettled' | 'missing_deduct' | 'missing_commission' = 'ok';
      if (profit <= 0) {
        status = 'skip'; // 亏损/持平不分润
      } else if (!p.settled) {
        status = 'unsettled';
        issues.push({
          kind: 'UNSETTLED',
          profitId: p.id,
          userEmail,
          userNickname,
          userNo,
          profit,
          deduct,
          commission: commissionSumRow,
          detail: '正利润未结算',
        });
      } else if (deduct <= eps && commissionSumRow <= eps) {
        // 比例全 0 或无可分配: 允许
        status = 'ok';
        matchedOk++;
      } else if (deduct <= eps) {
        status = 'missing_deduct';
        issues.push({
          kind: 'MISSING_DEDUCT',
          profitId: p.id,
          userEmail,
          userNickname,
          userNo,
          profit,
          deduct,
          commission: commissionSumRow,
          detail: '已结算但无 SHARE_DEDUCT 扣点卡流水',
        });
      } else if (commissionSumRow <= eps) {
        status = 'missing_commission';
        issues.push({
          kind: 'MISSING_COMMISSION',
          profitId: p.id,
          userEmail,
          userNickname,
          userNo,
          profit,
          deduct,
          commission: commissionSumRow,
          detail: '已扣点卡但无佣金记录',
        });
      } else if (Math.abs(deduct - commissionSumRow) > Math.max(eps, deduct * 1e-8)) {
        status = 'mismatch';
        issues.push({
          kind: 'AMOUNT_MISMATCH',
          profitId: p.id,
          userEmail,
          userNickname,
          userNo,
          profit,
          deduct,
          commission: commissionSumRow,
          detail: `扣点卡 ${deduct} ≠ 佣金合计 ${commissionSumRow} (差 ${deduct - commissionSumRow})`,
        });
      } else {
        matchedOk++;
      }

      rows.push({
        profitId: p.id,
        userEmail,
        userNickname,
        userNo,
        symbol: p.symbol,
        profit,
        settled: p.settled,
        source: p.source,
        closedAt: p.closedAt,
        deduct,
        commission: commissionSumRow,
        commissionCount: p.commissions.length,
        status,
      });
    }

    // 当日产生的扣点卡, 其利润不在本日 closedAt → 跨日结算提示(非硬错误)
    for (const tx of deductCreatedDay) {
      if (tx.refType === 'ProfitRecord' && tx.refId && !profitIdSet.has(tx.refId)) {
        issues.push({
          kind: 'CROSS_DAY_DEDUCT',
          profitId: tx.refId,
          userEmail: tx.user?.email,
          userNickname: tx.user?.nickname,
          userNo: tx.user?.userNo ?? null,
          deduct: Math.abs(this.num(tx.amount)),
          detail: '本日产生 SHARE_DEDUCT, 但对应利润 closedAt 不在本日(跨日结算)',
        });
      } else if (!tx.refId || tx.refType !== 'ProfitRecord') {
        issues.push({
          kind: 'ORPHAN_DEDUCT',
          userEmail: tx.user?.email,
          userNickname: tx.user?.nickname,
          userNo: tx.user?.userNo ?? null,
          deduct: Math.abs(this.num(tx.amount)),
          detail: 'SHARE_DEDUCT 缺少 ProfitRecord 引用',
        });
      }
    }

    // 本日利润关联的扣/佣合计
    const deductDaySum = rows.reduce((s, r) => s + (r.deduct || 0), 0);
    const commissionDaySum = rows.reduce((s, r) => s + (r.commission || 0), 0);

    return {
      day,
      summary: {
        profitRecords: profits.length,
        profitPositiveCount,
        profitPositiveSum: Math.round(profitPositiveSum * 1e8) / 1e8,
        settledPositiveCount,
        unsettledPositive: profitPositiveCount - settledPositiveCount,
        deductTxCount: deductByRefs.length,
        deductSum: Math.round(deductDaySum * 1e8) / 1e8,
        commissionRecordCount: profits.reduce((n, p) => n + p.commissions.length, 0),
        commissionSum: Math.round(commissionDaySum * 1e8) / 1e8,
        matchedOk,
        issueCount: issues.length,
        hardIssueCount: issues.filter(
          (i) => i.kind !== 'CROSS_DAY_DEDUCT',
        ).length,
        /** 本日利润关联: 扣点卡合计 vs 佣金合计 */
        deductVsCommissionDiff: Math.round((deductDaySum - commissionDaySum) * 1e8) / 1e8,
        balanced:
          issues.filter((i) => i.kind !== 'CROSS_DAY_DEDUCT').length === 0 &&
          Math.abs(deductDaySum - commissionDaySum) <= 1e-4,
      },
      issues,
      rows,
    };
  }

  /**
   * 区间对账摘要（不含明细行）。
   * - from+to：闭区间；跨度最多 62 天
   * - 否则按 days：近 N 日（默认 30，最大 62）
   */
  async reconcileRecent(opts?: { days?: number; from?: string; to?: string; user?: string }) {
    const maxSpan = 62;
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const pad = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    let fromStr = String(opts?.from || '').trim();
    let toStr = String(opts?.to || '').trim();

    if (dayRe.test(fromStr) && dayRe.test(toStr)) {
      if (fromStr > toStr) {
        const tmp = fromStr;
        fromStr = toStr;
        toStr = tmp;
      }
      const fromD = new Date(`${fromStr}T00:00:00`);
      const toD = new Date(`${toStr}T00:00:00`);
      const span =
        Math.floor((toD.getTime() - fromD.getTime()) / 86400000) + 1;
      if (span > maxSpan) {
        throw new BadRequestException(`日期跨度最多 ${maxSpan} 天`);
      }
    } else {
      const n = Math.min(
        maxSpan,
        Math.max(1, Math.floor(Number(opts?.days) || 7)),
      );
      const toD = new Date();
      toD.setHours(0, 0, 0, 0);
      const fromD = new Date(toD);
      fromD.setDate(fromD.getDate() - (n - 1));
      fromStr = pad(fromD);
      toStr = pad(toD);
    }

    const items: any[] = [];
    const cursor = new Date(`${toStr}T00:00:00`);
    const start = new Date(`${fromStr}T00:00:00`);
    // 从近到远
    while (cursor.getTime() >= start.getTime()) {
      const day = pad(cursor);
      const r = await this.reconcileDay(day, opts?.user);
      items.push({ day: r.day, ...r.summary });
      cursor.setDate(cursor.getDate() - 1);
    }
    return { from: fromStr, to: toStr, days: items.length, items };
  }
}
