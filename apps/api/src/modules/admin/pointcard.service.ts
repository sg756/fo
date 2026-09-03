import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { getPrimaryChain, resolveDepositChain } from '../deposit/chain.config';

@Injectable()
export class PointCardService {
  constructor(private prisma: PrismaService) {}

  async listCards(params: {
    skip?: number;
    take?: number;
    q?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
  }) {
    const { skip = 0, take = 50, q, userNo, account, from, to } = params;
    const userFilter: Prisma.UserWhereInput = { isPlatform: false };
    const no = userNo?.trim();
    if (no) {
      if (/^\d+$/.test(no)) userFilter.userNo = Number(no);
      else userFilter.id = no;
    }
    const acc = (account || q)?.trim();
    if (acc) {
      userFilter.OR = [
        { email: { contains: acc } },
        { nickname: { contains: acc } },
      ];
    }

    const where: Prisma.PointCardWhereInput = { user: userFilter };
    if (from || to) {
      where.updatedAt = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) where.updatedAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(to.trim())) d.setHours(23, 59, 59, 999);
          where.updatedAt.lte = d;
        }
      }
    }

    const takeN = Math.min(take, 200);
    const [items, total] = await Promise.all([
      this.prisma.pointCard.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: takeN,
        include: {
          user: { select: { id: true, userNo: true, email: true, nickname: true, status: true } },
        },
      }),
      this.prisma.pointCard.count({ where }),
    ]);
    return { items, total };
  }

  async listTxs(params: {
    userId?: string;
    userNo?: string;
    account?: string;
    type?: any;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) {
    const { userId, userNo, account, type, from, to, skip = 0, take = 50 } = params;
    const where: Prisma.PointCardTxWhereInput = { user: { isPlatform: false } };
    if (userId) where.userId = userId;
    if (type) where.type = type as any;

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

    const userFilter: Prisma.UserWhereInput = { isPlatform: false };
    let hasUserExtra = false;
    const no = userNo?.trim();
    if (no) {
      hasUserExtra = true;
      if (/^\d+$/.test(no)) userFilter.userNo = Number(no);
      else userFilter.id = no;
    }
    const acc = account?.trim();
    if (acc) {
      hasUserExtra = true;
      userFilter.OR = [
        { email: { contains: acc } },
        { nickname: { contains: acc } },
      ];
    }
    if (hasUserExtra) where.user = userFilter;

    const [items, totalAgg, increaseAgg, decreaseAgg] = await Promise.all([
      this.prisma.pointCardTx.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(take, 200),
        include: {
          user: { select: { id: true, userNo: true, email: true, nickname: true } },
        },
      }),
      this.prisma.pointCardTx.aggregate({
        where,
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.pointCardTx.aggregate({
        where: { ...where, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      this.prisma.pointCardTx.aggregate({
        where: { ...where, amount: { lt: 0 } },
        _sum: { amount: true },
      }),
    ]);

    return {
      items,
      total: totalAgg._count,
      summary: {
        count: totalAgg._count,
        total: String(totalAgg._sum.amount ?? 0),
        increase: String(increaseAgg._sum.amount ?? 0),
        decrease: String(decreaseAgg._sum.amount ?? 0),
      },
    };
  }

  async adjust(userId: string, amount: number, remark: string) {
    if (!amount) throw new BadRequestException('调整金额不能为 0');
    if (!remark?.trim()) throw new BadRequestException('请填写调账备注');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.isPlatform) throw new NotFoundException('用户不存在');

    return this.prisma.$transaction(async (tx) => {
      const card =
        (await tx.pointCard.findUnique({ where: { userId } })) ??
        (await tx.pointCard.create({ data: { userId } }));
      const delta = new Prisma.Decimal(amount);
      const balanceAfter = new Prisma.Decimal(card.balance).add(delta);
      if (balanceAfter.lessThan(0)) throw new BadRequestException('余额不足, 无法扣减');
      await tx.pointCard.update({ where: { userId }, data: { balance: balanceAfter } });
      return tx.pointCardTx.create({
        data: {
          userId,
          type: 'ADJUST',
          amount: delta,
          balanceAfter,
          remark: remark.trim(),
        },
        include: { user: { select: { email: true, nickname: true } } },
      });
    });
  }

  async listRecharges(params: {
    status?: any;
    userId?: string;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) {
    const { status, userId, userNo, account, from, to, skip = 0, take = 50 } = params;
    const where: Prisma.RechargeOrderWhereInput = { user: { isPlatform: false } };
    if (status) where.status = status;
    if (userId) where.userId = userId;

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

    const userFilter: Prisma.UserWhereInput = { isPlatform: false };
    const no = userNo?.trim();
    if (no) {
      if (/^\d+$/.test(no)) userFilter.userNo = Number(no);
      else userFilter.id = no;
    }
    const acc = account?.trim();
    if (acc) {
      userFilter.OR = [
        { email: { contains: acc } },
        { nickname: { contains: acc } },
      ];
    }
    where.user = userFilter;

    const [items, totalAgg, creditedAgg] = await Promise.all([
      this.prisma.rechargeOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(take, 200),
        include: {
          user: { select: { id: true, userNo: true, email: true, nickname: true } },
          wallet: { select: { address: true, chain: true } },
        },
      }),
      this.prisma.rechargeOrder.aggregate({
        where,
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.rechargeOrder.aggregate({
        where: { ...where, status: 'CREDITED' },
        _count: true,
        _sum: { amount: true },
      }),
    ]);

    return {
      items,
      total: totalAgg._count,
      summary: {
        count: totalAgg._count,
        total: String(totalAgg._sum.amount ?? 0),
        creditedCount: creditedAgg._count,
        creditedTotal: String(creditedAgg._sum.amount ?? 0),
      },
    };
  }

  async creditRecharge(rechargeId: string) {
    const order = await this.prisma.rechargeOrder.findUnique({ where: { id: rechargeId } });
    if (!order) throw new NotFoundException('充值订单不存在');
    if (order.status === 'CREDITED') return order;

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.rechargeOrder.updateMany({
        where: { id: rechargeId, status: { in: ['PENDING', 'CONFIRMED', 'FAILED'] } },
        data: { status: 'CREDITED' },
      });
      if (claimed.count === 0) {
        return tx.rechargeOrder.findUnique({ where: { id: rechargeId } });
      }

      const fresh = await tx.rechargeOrder.findUnique({ where: { id: rechargeId } });
      const card =
        (await tx.pointCard.findUnique({ where: { userId: fresh!.userId } })) ??
        (await tx.pointCard.create({ data: { userId: fresh!.userId } }));
      const amount = new Prisma.Decimal(fresh!.amount);
      const balanceAfter = new Prisma.Decimal(card.balance).add(amount);
      await tx.pointCard.update({ where: { userId: fresh!.userId }, data: { balance: balanceAfter } });
      const ptx = await tx.pointCardTx.create({
        data: {
          userId: fresh!.userId,
          type: 'RECHARGE',
          amount,
          balanceAfter,
          refType: 'RechargeOrder',
          refId: fresh!.id,
          remark: `充值入账 ${fresh!.tokenSymbol}`,
        },
      });
      return tx.rechargeOrder.update({
        where: { id: fresh!.id },
        data: { pointTxId: ptx.id, status: 'CREDITED' },
      });
    });
  }

  /**
   * 手动充值：写入充值订单 + 点卡流水（类型 RECHARGE），与「调账 ADJUST」区分。
   * 用于链上漏扫、线下已收款等需记成充值的场景；金额必须为正。
   */
  async manualRecharge(params: {
    userId?: string;
    userNo?: string;
    account?: string;
    amount: number;
    remark: string;
    txHash?: string;
    chain?: string;
  }) {
    const amountNum = Number(params.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new BadRequestException('充值金额必须为正数');
    }
    if (!params.remark?.trim()) throw new BadRequestException('请填写备注');
    const allowedRemarks = ['线下收款', '漏扫补入', '链上延迟补入', '运营补发'];
    if (!allowedRemarks.includes(params.remark.trim())) {
      throw new BadRequestException('备注无效，请选择规定原因');
    }

    let userId = params.userId?.trim() || '';
    if (!userId) {
      const no = params.userNo?.trim();
      const acc = params.account?.trim();
      if (!no && !acc) throw new BadRequestException('请填写用户ID或账号');

      if (no) {
        const user = await this.prisma.user.findFirst({
          where: /^\d+$/.test(no)
            ? { userNo: Number(no), isPlatform: false }
            : { id: no, isPlatform: false },
          select: { id: true },
        });
        if (!user) throw new NotFoundException('用户不存在（用户ID）');
        userId = user.id;
      } else {
        const matches = await this.prisma.user.findMany({
          where: {
            isPlatform: false,
            OR: [{ nickname: { contains: acc! } }, { email: { contains: acc! } }],
          },
          select: { id: true, userNo: true, nickname: true, email: true },
          take: 6,
        });
        if (matches.length === 0) throw new NotFoundException('用户不存在（账号）');
        if (matches.length > 1) {
          const tip = matches
            .slice(0, 5)
            .map((u) => `#${u.userNo ?? '?'} ${u.nickname || u.email}`)
            .join('；');
          throw new BadRequestException(`账号匹配到多人，请改用用户ID：${tip}`);
        }
        userId = matches[0].id;
      }
    } else {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, isPlatform: false },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('用户不存在');
    }

    const chain = params.chain?.trim()
      ? resolveDepositChain(params.chain)
      : getPrimaryChain();

    let wallet = await this.prisma.wallet.findFirst({
      where: { userId, chain },
      orderBy: { createdAt: 'asc' },
    });
    if (!wallet) {
      wallet = await this.prisma.wallet.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!wallet) {
      throw new BadRequestException('该用户尚无充值钱包，无法记充值单');
    }

    const rawHash = params.txHash?.trim();
    const txHash = rawHash
      ? rawHash.startsWith('manual:')
        ? rawHash
        : `manual:${rawHash}`
      : `manual:${randomUUID()}`;

    const exists = await this.prisma.rechargeOrder.findUnique({ where: { txHash } });
    if (exists) throw new BadRequestException('该 txHash 已存在，请勿重复提交');

    const remark = params.remark.trim();
    const amount = new Prisma.Decimal(amountNum);

    return this.prisma.$transaction(async (tx) => {
      const card =
        (await tx.pointCard.findUnique({ where: { userId } })) ??
        (await tx.pointCard.create({ data: { userId } }));
      const balanceAfter = new Prisma.Decimal(card.balance).add(amount);
      await tx.pointCard.update({ where: { userId }, data: { balance: balanceAfter } });

      const order = await tx.rechargeOrder.create({
        data: {
          userId,
          walletId: wallet!.id,
          chain: wallet!.chain || chain,
          tokenSymbol: 'USDT',
          txHash,
          amount,
          confirmations: 0,
          status: 'CREDITED',
        },
      });

      const ptx = await tx.pointCardTx.create({
        data: {
          userId,
          type: 'RECHARGE',
          amount,
          balanceAfter,
          refType: 'RechargeOrder',
          refId: order.id,
          remark: `手动充值：${remark}`,
        },
      });

      return tx.rechargeOrder.update({
        where: { id: order.id },
        data: { pointTxId: ptx.id },
        include: {
          user: { select: { id: true, userNo: true, email: true, nickname: true } },
          wallet: { select: { address: true, chain: true } },
        },
      });
    });
  }
}
