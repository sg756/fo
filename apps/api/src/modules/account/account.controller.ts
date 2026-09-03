import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PointTxType, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { WithdrawService } from '../admin/withdraw.service';
import { WalletService } from '../deposit/wallet.service';
import { DepositService } from '../deposit/deposit.service';
import { DepositChain, depositNetworkOptions, resolveDepositChain } from '../deposit/chain.config';
import { allocUniqueInviteCode, isNumericInviteCode } from '../../common/invite-code';

class WithdrawDto {
  @IsNumber() @Min(0.0001) amount: number;
}

class WithdrawAddressDto {
  @IsString() address: string;
  @IsOptional() @IsString() chain?: string;
  @IsOptional() @IsString() label?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('account')
export class AccountController {
  constructor(
    private prisma: PrismaService,
    private withdraw: WithdrawService,
    private wallets: WalletService,
    private deposit: DepositService,
  ) {}

  @Get('point-card')
  async pointCard(@CurrentUser('sub') userId: string) {
    const card =
      (await this.prisma.pointCard.findUnique({ where: { userId } })) ??
      (await this.prisma.pointCard.create({ data: { userId } }));
    return {
      balance: card.balance,
      frozen: card.frozen,
      commissionBalance: card.commissionBalance,
      commissionFrozen: card.commissionFrozen,
      /** 可提现余额 = 可用佣金（点卡不可提） */
      withdrawable: card.commissionBalance,
    };
  }

  @Get('txs')
  txs(
    @CurrentUser('sub') userId: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const where: Prisma.PointCardTxWhereInput = { userId };
    const t = String(type || '')
      .trim()
      .toUpperCase()
      .replace(/-/g, '_');
    const allowed = Object.values(PointTxType) as string[];
    if (t && allowed.includes(t)) where.type = t as PointTxType;

    const fromDay = String(from || '').trim();
    const toDay = String(to || '').trim();
    const range: Prisma.DateTimeFilter = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDay)) {
      const d = new Date(`${fromDay}T00:00:00`);
      if (!Number.isNaN(d.getTime())) range.gte = d;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
      const d = new Date(`${toDay}T23:59:59.999`);
      if (!Number.isNaN(d.getTime())) range.lte = d;
    }
    if (range.gte || range.lte) where.createdAt = range;

    return this.prisma.pointCardTx.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: Number(skip) || 0,
      take: Math.min(200, Math.max(1, Number(take) || 50)),
    });
  }

  /** 当前开放的充值网络（默认仅主链；DEPOSIT_ENABLED_CHAINS 可扩展） */
  @Get('deposit-networks')
  depositNetworks() {
    return {
      networks: depositNetworkOptions(),
      /** 平台不再设最低充值；保留字段兼容旧 App */
      minAmount: 0,
    };
  }

  /** 充值地址: 平台托管, 仅用于识别该用户的链上充值并入账点卡 */
  @Get('deposit-address')
  async depositAddress(
    @CurrentUser('sub') userId: string,
    @Query('chain') chain?: string,
  ) {
    const useChain = resolveDepositChain(chain);
    const wallet = await this.wallets.ensureUserWallet(userId, useChain);
    return {
      chain: wallet.chain,
      address: wallet.address,
      token: 'USDT',
      networkName: depositNetworkOptions().find((n) => n.chain === useChain)?.name,
      minAmount: 0,
    };
  }

  @Get('recharges')
  recharges(
    @CurrentUser('sub') userId: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.deposit.listUserRecharges(userId, Number(skip), Number(take));
  }

  /** 用户提现收款地址 */
  @Get('withdraw-address')
  withdrawAddress(@CurrentUser('sub') userId: string) {
    return this.withdraw.getWithdrawAddress(userId);
  }

  @Post('withdraw-address')
  setWithdrawAddress(@CurrentUser('sub') userId: string, @Body() dto: WithdrawAddressDto) {
    return this.withdraw.setWithdrawAddress(userId, dto);
  }

  /** 提现申请: 使用已保存地址, 并锁定点卡金额 */
  @Post('withdraw')
  createWithdraw(@CurrentUser('sub') userId: string, @Body() dto: WithdrawDto) {
    return this.withdraw.create(userId, dto.amount);
  }

  @Get('withdraws')
  myWithdraws(@CurrentUser('sub') userId: string) {
    return this.prisma.withdrawRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('invite')
  async invite(@CurrentUser('sub') userId: string) {
    let me = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!me) return { inviteCode: null, inviteLink: null, members: [] };
    // 无码或非纯数字 → 补发 8 位数字码
    if (!isNumericInviteCode(me.inviteCode)) {
      const inviteCode = await allocUniqueInviteCode(this.prisma);
      me = await this.prisma.user.update({
        where: { id: userId },
        data: { inviteCode },
      });
    }
    const downlineWhere: Prisma.UserWhereInput = { parentId: userId, status: UserStatus.ACTIVE };
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [members, memberCount, todayAgg, totalAgg] = await Promise.all([
      this.prisma.user.findMany({
        where: downlineWhere,
        select: { id: true, email: true, nickname: true, userNo: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.user.count({ where: downlineWhere }),
      this.prisma.commissionRecord.aggregate({
        where: { earnerId: userId, createdAt: { gte: startOfToday } },
        _sum: { amount: true },
      }),
      this.prisma.commissionRecord.aggregate({
        where: { earnerId: userId },
        _sum: { amount: true },
      }),
    ]);

    return {
      inviteCode: me.inviteCode,
      inviteLink: `https://app.floworder.local/register?code=${me.inviteCode}`,
      todayCommission: Number(todayAgg._sum.amount || 0),
      totalCommission: Number(totalAgg._sum.amount || 0),
      memberCount,
      members: await this.withDownlineCommission(userId, members),
    };
  }

  /** 已审核直推下级分页（仅 ACTIVE） */
  @Get('invite/members')
  async inviteMembers(
    @CurrentUser('sub') userId: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    const downlineWhere: Prisma.UserWhereInput = { parentId: userId, status: UserStatus.ACTIVE };
    const skipN = Math.max(Number(skip) || 0, 0);
    const takeN = Math.min(Math.max(Number(take) || 50, 1), 100);
    const [members, total] = await Promise.all([
      this.prisma.user.findMany({
        where: downlineWhere,
        select: { id: true, email: true, nickname: true, userNo: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip: skipN,
        take: takeN,
      }),
      this.prisma.user.count({ where: downlineWhere }),
    ]);
    return {
      total,
      items: await this.withDownlineCommission(userId, members),
    };
  }

  /** 每人金额 = 该直推为你贡献的累计佣金（其本人平仓产生的直推分成合计，不含间推） */
  private async withDownlineCommission<T extends { id: string }>(
    userId: string,
    members: T[],
  ): Promise<(T & { commission: number })[]> {
    const memberIds = members.map((m) => m.id);
    if (!memberIds.length) return members.map((m) => ({ ...m, commission: 0 }));
    const contribRows = await this.prisma.commissionRecord.groupBy({
      by: ['fromUserId'],
      where: { earnerId: userId, fromUserId: { in: memberIds } },
      _sum: { amount: true },
    });
    const contribMap = new Map(contribRows.map((r) => [r.fromUserId, Number(r._sum.amount || 0)]));
    return members.map((m) => ({ ...m, commission: contribMap.get(m.id) || 0 }));
  }

  @Get('commissions')
  async commissions(
    @CurrentUser('sub') userId: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
  ) {
    const where: Prisma.CommissionRecordWhereInput = { earnerId: userId };

    const fromDay = String(from || '').trim();
    const toDay = String(to || '').trim();
    const range: Prisma.DateTimeFilter = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDay)) {
      const d = new Date(`${fromDay}T00:00:00`);
      if (!Number.isNaN(d.getTime())) range.gte = d;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
      const d = new Date(`${toDay}T23:59:59.999`);
      if (!Number.isNaN(d.getTime())) range.lte = d;
    }
    if (range.gte || range.lte) where.createdAt = range;

    // 三级分销：App 佣金只来自直推（下级）和间推（下两级），筛选不能查到树外用户
    const downline: Prisma.UserWhereInput = {
      OR: [{ parentId: userId }, { l2Id: userId }, { parent: { parentId: userId } }],
    };

    const keyword = String(q || '').trim();
    if (keyword) {
      const ident: Prisma.UserWhereInput[] = [
        { nickname: { contains: keyword } },
        { id: keyword },
      ];
      if (/^\d+$/.test(keyword)) ident.push({ userNo: Number(keyword) });
      where.fromUser = { AND: [downline, { OR: ident }] };
    }

    const takeN = Math.min(Math.max(Number(take) || 50, 1), 200);
    const skipN = Math.max(Number(skip) || 0, 0);

    const [items, total, agg] = await Promise.all([
      this.prisma.commissionRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipN,
        take: takeN,
        include: {
          fromUser: { select: { id: true, userNo: true, nickname: true, email: true } },
        },
      }),
      this.prisma.commissionRecord.count({ where }),
      this.prisma.commissionRecord.aggregate({
        where,
        _sum: { amount: true },
      }),
    ]);

    return {
      items,
      total,
      sum: Number(agg._sum.amount || 0),
    };
  }
}
