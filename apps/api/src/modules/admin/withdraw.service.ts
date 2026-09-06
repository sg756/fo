import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isAddress, getAddress } from 'ethers';
import { PrismaService } from '../../prisma/prisma.service';

const CFG_WITHDRAW_MIN = 'withdraw_min_amount';

@Injectable()
export class WithdrawService {
  constructor(private prisma: PrismaService) {}

  /** 最低提现金额；0 或未配置 = 不限制（仅要求 >0） */
  async getMinWithdrawAmount(): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: CFG_WITHDRAW_MIN } });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return Number(process.env.WITHDRAW_MIN_AMOUNT || 0);
  }

  async setMinWithdrawAmount(amount: number) {
    const v = Math.max(0, Number(amount) || 0);
    await this.prisma.systemConfig.upsert({
      where: { key: CFG_WITHDRAW_MIN },
      create: {
        key: CFG_WITHDRAW_MIN,
        value: String(v),
        remark: '最低提现金额(USDT)；0=不限制，仅要求大于0',
      },
      update: { value: String(v) },
    });
    return { minWithdrawAmount: v };
  }

  async getWithdrawAddress(userId: string) {
    const [u, minWithdrawAmount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          withdrawAddress: true,
          withdrawChain: true,
          withdrawAddressLabel: true,
          withdrawAddressUpdatedAt: true,
        },
      }),
      this.getMinWithdrawAmount(),
    ]);
    return {
      address: u?.withdrawAddress || null,
      chain: u?.withdrawChain || 'ARB',
      label: u?.withdrawAddressLabel || null,
      updatedAt: u?.withdrawAddressUpdatedAt || null,
      configured: !!u?.withdrawAddress,
      minWithdrawAmount,
    };
  }

  async setWithdrawAddress(
    userId: string,
    params: { address: string; chain?: string; label?: string },
  ) {
    const raw = params.address?.trim();
    if (!raw) throw new BadRequestException('请填写提现地址');
    if (!isAddress(raw)) {
      throw new BadRequestException('提现地址格式无效，请仔细核对钱包/交易所充值地址');
    }
    const address = getAddress(raw);
    const chain = (params.chain || 'ARB').toUpperCase();
    // 与充值一致：当前仅开放 Arbitrum
    if (chain !== 'ARB') throw new BadRequestException('当前仅支持 Arbitrum 提现网络');

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        withdrawAddress: address,
        withdrawChain: chain,
        withdrawAddressLabel: params.label?.trim() || null,
        withdrawAddressUpdatedAt: new Date(),
      },
    });
    return this.getWithdrawAddress(userId);
  }

  /**
   * 用户发起提现（仅可提佣金）:
   * - 必须已保存提现地址
   * - 冻结佣金余额, 审核通过前不可再用
   */
  async create(userId: string, amount: number, fee = 0) {
    if (amount <= 0) throw new BadRequestException('提现金额必须大于 0');
    const minAmt = await this.getMinWithdrawAmount();
    if (minAmt > 0 && amount < minAmt) {
      throw new BadRequestException(`最低提现金额为 ${minAmt} USDT`);
    }

    const addr = await this.getWithdrawAddress(userId);
    if (!addr.configured || !addr.address) {
      throw new BadRequestException('请先设置提现收款地址（钱包或交易所地址）');
    }

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.pointCard.findUnique({ where: { userId } });
      if (!card) throw new BadRequestException('点卡账户不存在');
      const total = new Prisma.Decimal(amount).add(fee);
      if (new Prisma.Decimal(card.commissionBalance).lessThan(total)) {
        throw new BadRequestException('可提佣金不足（仅佣金可提现，点卡不可提）');
      }
      const commissionBalance = new Prisma.Decimal(card.commissionBalance).sub(total);
      const commissionFrozen = new Prisma.Decimal(card.commissionFrozen).add(total);
      await tx.pointCard.update({
        where: { userId },
        data: { commissionBalance, commissionFrozen },
      });
      await tx.pointCardTx.create({
        data: {
          userId,
          type: 'WITHDRAW',
          amount: total.mul(-1),
          balanceAfter: commissionBalance,
          refType: 'WithdrawRequest',
          remark: '提现申请锁定佣金',
        },
      });
      return tx.withdrawRequest.create({
        data: {
          userId,
          amount,
          fee,
          toAddress: addr.address!,
          chain: addr.chain || 'ARB',
          status: 'PENDING',
        },
      });
    });
  }

  async list(params: {
    status?: any;
    userNo?: string;
    account?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) {
    const { status, userNo, account, from, to, skip = 0, take = 50 } = params;
    const where: any = {};
    if (status) where.status = status;

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

    const userFilter: any = {};
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
    if (Object.keys(userFilter).length) where.user = userFilter;

    const takeN = Math.min(take, 200);
    const [items, total] = await Promise.all([
      this.prisma.withdrawRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: takeN,
        include: {
          user: {
            select: {
              id: true,
              userNo: true,
              email: true,
              nickname: true,
              withdrawAddress: true,
              withdrawChain: true,
              withdrawAddressLabel: true,
            },
          },
        },
      }),
      this.prisma.withdrawRequest.count({ where }),
    ]);
    return { items, total };
  }

  releaseLogs(params: { skip?: number; take?: number }) {
    const { skip = 0, take = 50 } = params;
    return this.prisma.withdrawAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { withdraw: { select: { userId: true, amount: true, toAddress: true, status: true } } },
    });
  }

  async approve(id: string, actorId: string, remark?: string) {
    const w = await this.prisma.withdrawRequest.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('提现单不存在');
    if (w.status !== 'PENDING') throw new BadRequestException('当前状态不可审核');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.withdrawRequest.update({
        where: { id },
        data: { status: 'APPROVED', auditById: actorId, auditedAt: new Date(), auditRemark: remark },
      });
      await tx.withdrawAuditLog.create({
        data: { withdrawId: id, actorId, action: 'APPROVE', remark },
      });
      return updated;
    });
  }

  async reject(id: string, actorId: string, remark?: string) {
    const w = await this.prisma.withdrawRequest.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('提现单不存在');
    if (w.status !== 'PENDING' && w.status !== 'APPROVED') {
      throw new BadRequestException('当前状态不可驳回');
    }
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.pointCard.findUnique({ where: { userId: w.userId } });
      const total = new Prisma.Decimal(w.amount).add(w.fee);
      const commissionBalance = new Prisma.Decimal(card!.commissionBalance).add(total);
      const commissionFrozen = new Prisma.Decimal(card!.commissionFrozen).sub(total);
      await tx.pointCard.update({
        where: { userId: w.userId },
        data: { commissionBalance, commissionFrozen },
      });
      await tx.pointCardTx.create({
        data: {
          userId: w.userId,
          type: 'WITHDRAW_REFUND',
          amount: total,
          balanceAfter: commissionBalance,
          refType: 'WithdrawRequest',
          refId: id,
          remark: '提现驳回解锁退回佣金',
        },
      });
      const updated = await tx.withdrawRequest.update({
        where: { id },
        data: { status: 'REJECTED', auditById: actorId, auditedAt: new Date(), auditRemark: remark },
      });
      await tx.withdrawAuditLog.create({
        data: { withdrawId: id, actorId, action: 'REJECT', remark },
      });
      return updated;
    });
  }

  /**
   * 管理员线下打款完成后确认 → 已结算
   * 扣除冻结佣金, 状态 SETTLED
   */
  async settle(id: string, actorId: string, txHash: string, remark?: string) {
    const w = await this.prisma.withdrawRequest.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('提现单不存在');
    if (w.status !== 'APPROVED') throw new BadRequestException('需先审核通过后再确认打款结算');
    if (!txHash?.trim()) throw new BadRequestException('请填写打款交易哈希(txHash)以便留档');

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.pointCard.findUnique({ where: { userId: w.userId } });
      const total = new Prisma.Decimal(w.amount).add(w.fee);
      const commissionFrozen = new Prisma.Decimal(card!.commissionFrozen).sub(total);
      await tx.pointCard.update({
        where: { userId: w.userId },
        data: { commissionFrozen },
      });
      const updated = await tx.withdrawRequest.update({
        where: { id },
        data: {
          status: 'SETTLED',
          releaseTxHash: txHash.trim(),
          releasedAt: new Date(),
        },
      });
      await tx.withdrawAuditLog.create({
        data: {
          withdrawId: id,
          actorId,
          action: 'RELEASE',
          remark: remark || `已结算扣除佣金 txHash=${txHash.trim()}`,
        },
      });
      return updated;
    });
  }

  /** @deprecated 兼容旧 release 接口 → settle */
  async release(id: string, actorId: string, txHash: string, remark?: string) {
    return this.settle(id, actorId, txHash, remark);
  }

  async payoutOnChain(
    id: string,
    actorId: string,
    sendFn: (p: { chain: string; toAddress: string; amount: number }) => Promise<{ txHash: string }>,
  ) {
    const w = await this.prisma.withdrawRequest.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('提现单不存在');
    if (w.status !== 'APPROVED') throw new BadRequestException('需先审核通过再打款');

    try {
      const { txHash } = await sendFn({
        chain: w.chain,
        toAddress: w.toAddress,
        amount: Number(w.amount),
      });
      const settled = await this.settle(id, actorId, txHash, '链上自动打款已结算');
      return { ...settled, txHash, releaseTxHash: txHash };
    } catch (e: any) {
      await this.prisma.withdrawRequest.update({
        where: { id },
        data: { auditRemark: e?.message || '打款失败' },
      });
      await this.prisma.withdrawAuditLog.create({
        data: {
          withdrawId: id,
          actorId,
          action: 'RELEASE',
          remark: `PAYOUT_FAILED: ${e?.message || e}`,
        },
      });
      throw new BadRequestException(e?.message || '链上打款失败');
    }
  }
}
