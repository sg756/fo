import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from './wallet.service';
import {
  DEPOSIT_CHAINS,
  DepositChain,
} from './chain.config';

export type IngestTransferInput = {
  chain: DepositChain;
  txHash: string;
  logIndex: number;
  toAddress: string;
  amountRaw: bigint; // 链上原始整数金额
  blockNumber: number;
  currentBlock: number;
};

@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);

  constructor(
    private prisma: PrismaService,
    private wallets: WalletService,
  ) {}

  /** 幂等键: 同一笔 Transfer 日志只入一次 */
  static transferUid(txHash: string, logIndex: number): string {
    return `${txHash.toLowerCase()}:${logIndex}`;
  }

  /**
   * 摄入一笔链上 Transfer:
   * - 找不到收款钱包 → 忽略
   * - txHash 已存在 → 只更新确认数, 不重复加点
   * - 新建 PENDING/CONFIRMED, 确认数够则 CREDITED
   */
  async ingestTransfer(input: IngestTransferInput) {
    const cfg = DEPOSIT_CHAINS[input.chain];
    const wallet = await this.wallets.findByAddress(input.toAddress);
    if (!wallet) return { skipped: true, reason: 'unknown_address' as const };

    const uid = DepositService.transferUid(input.txHash, input.logIndex);
    const human = Number(input.amountRaw) / 10 ** cfg.decimals;
    if (human <= 0) return { skipped: true, reason: 'zero_amount' as const };

    const confirmations = Math.max(0, input.currentBlock - input.blockNumber + 1);
    const enough = confirmations >= cfg.confirmations;

    const existing = await this.prisma.rechargeOrder.findUnique({ where: { txHash: uid } });
    if (existing) {
      if (existing.status === 'CREDITED') {
        return { skipped: true, reason: 'already_credited' as const, orderId: existing.id };
      }
      // 含历史「低于最小金额」标 FAILED 的单：确认够后可重新入账
      await this.prisma.rechargeOrder.update({
        where: { id: existing.id },
        data: {
          confirmations,
          status: enough ? 'CONFIRMED' : 'PENDING',
        },
      });
      if (enough) {
        await this.creditIfNeeded(existing.id);
        return { skipped: false, credited: true, orderId: existing.id };
      }
      return { skipped: false, credited: false, orderId: existing.id };
    }

    const order = await this.prisma.rechargeOrder.create({
      data: {
        userId: wallet.userId,
        walletId: wallet.id,
        chain: input.chain,
        tokenSymbol: 'USDT',
        txHash: uid,
        amount: new Prisma.Decimal(human.toFixed(cfg.decimals)),
        confirmations,
        status: enough ? 'CONFIRMED' : 'PENDING',
      },
    });
    this.logger.log(`新充值单 ${order.id} user=${wallet.userId} ${human} USDT ${uid}`);

    if (enough) {
      await this.creditIfNeeded(order.id);
      return { skipped: false, credited: true, orderId: order.id };
    }
    return { skipped: false, credited: false, orderId: order.id };
  }

  /**
   * 幂等入账: 仅当状态不是 CREDITED 时更新成功并加点。
   * 并发安全: updateMany + count 判断。
   */
  async creditIfNeeded(rechargeId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.rechargeOrder.findUnique({ where: { id: rechargeId } });
      if (!order) throw new NotFoundException('充值订单不存在');
      if (order.status === 'CREDITED') return order;

      const claimed = await tx.rechargeOrder.updateMany({
        where: { id: rechargeId, status: { in: ['PENDING', 'CONFIRMED', 'FAILED'] } },
        data: { status: 'CREDITED' },
      });
      if (claimed.count === 0) {
        // 并发下已被其他事务入账
        return tx.rechargeOrder.findUnique({ where: { id: rechargeId } });
      }

      const card =
        (await tx.pointCard.findUnique({ where: { userId: order.userId } })) ??
        (await tx.pointCard.create({ data: { userId: order.userId } }));
      const amount = new Prisma.Decimal(order.amount);
      const balanceAfter = new Prisma.Decimal(card.balance).add(amount);
      await tx.pointCard.update({ where: { userId: order.userId }, data: { balance: balanceAfter } });
      const ptx = await tx.pointCardTx.create({
        data: {
          userId: order.userId,
          type: 'RECHARGE',
          amount,
          balanceAfter,
          refType: 'RechargeOrder',
          refId: order.id,
          remark: `充值入账 ${order.tokenSymbol} ${order.chain}`,
        },
      });
      return tx.rechargeOrder.update({
        where: { id: order.id },
        data: { pointTxId: ptx.id, status: 'CREDITED' },
      });
    });
  }

  /** 推进未入账订单的确认数, 达标则入账 */
  async refreshPendingConfirmations(chain: DepositChain, currentBlock: number) {
    const cfg = DEPOSIT_CHAINS[chain];
    const pending = await this.prisma.rechargeOrder.findMany({
      where: { chain, status: { in: ['PENDING', 'CONFIRMED'] } },
      take: 200,
    });
    for (const o of pending) {
      // txHash 形如 0xabc:12, 确认数由扫描时写入; 这里用「扫描时记录的 confirmations + 新块差」不精确
      // 简化: 若已是 CONFIRMED 或 confirmations 已够则入账; 否则由 scanner 再次 ingest 更新
      if (o.confirmations >= cfg.confirmations || o.status === 'CONFIRMED') {
        await this.creditIfNeeded(o.id);
      }
    }
  }

  listUserRecharges(userId: string, skip = 0, take = 50) {
    return this.prisma.rechargeOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        chain: true,
        tokenSymbol: true,
        txHash: true,
        amount: true,
        confirmations: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
