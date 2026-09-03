import { Controller, Get, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { UserRole } from '../../common/auth-role';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private prisma: PrismaService) {}

  @Get('summary')
  async summary() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const num = (v: any) => Number(v || 0);

    const [
      pendingUsers,
      todayRegistrations,
      pendingWithdraws,
      pendingRecharges,
      activeUsers,
      totalUsers,
      disabledUsers,
      followEnabled,
      todayFollows,
      filledFollows,
      failedFollows,
      cancelFailed,
      pointAgg,
      rechargeTodayAgg,
      rechargeTotalAgg,
      withdrawSettledAgg,
      commissionAgg,
      commissionUserAgg,
      commissionPlatformAgg,
      profitTotalAgg,
      profitTodayAgg,
      unsettledAgg,
    ] = await Promise.all([
      this.prisma.user.count({ where: { status: 'PENDING', isPlatform: false } }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfToday }, isPlatform: false } }),
      this.prisma.withdrawRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.rechargeOrder.count({ where: { status: { in: ['PENDING', 'CONFIRMED'] } } }),
      this.prisma.user.count({ where: { status: 'ACTIVE', isPlatform: false } }),
      this.prisma.user.count({ where: { isPlatform: false } }),
      this.prisma.user.count({ where: { status: 'DISABLED', isPlatform: false } }),
      this.prisma.user.count({ where: { followEnabled: true, isPlatform: false } }),
      this.prisma.signalFollowLog.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.signalFollowLog.count({ where: { status: 'FILLED' } }),
      this.prisma.signalFollowLog.count({ where: { status: 'FAILED' } }),
      this.prisma.signalFollowLog.count({ where: { status: 'CANCEL_FAILED' } }),
      this.prisma.pointCard.aggregate({
        where: { user: { isPlatform: false } },
        _sum: { balance: true, frozen: true },
      }),
      this.prisma.rechargeOrder.aggregate({
        where: { status: 'CREDITED', createdAt: { gte: startOfToday } },
        _sum: { amount: true },
      }),
      this.prisma.rechargeOrder.aggregate({
        where: { status: 'CREDITED' },
        _sum: { amount: true },
      }),
      this.prisma.withdrawRequest.aggregate({
        where: { status: 'SETTLED' },
        _sum: { amount: true },
      }),
      this.prisma.commissionRecord.aggregate({ _sum: { amount: true } }),
      this.prisma.commissionRecord.aggregate({
        where: { level: { in: ['DIRECT', 'INDIRECT'] } },
        _sum: { amount: true },
      }),
      this.prisma.commissionRecord.aggregate({
        where: { level: 'PLATFORM' },
        _sum: { amount: true },
      }),
      this.prisma.profitRecord.aggregate({ _sum: { profit: true } }),
      this.prisma.profitRecord.aggregate({
        where: { closedAt: { gte: startOfToday } },
        _sum: { profit: true },
      }),
      this.prisma.profitRecord.aggregate({
        where: { settled: false, profit: { gt: 0 } },
        _sum: { profit: true },
        _count: { _all: true },
      }),
    ]);

    const filledRate =
      filledFollows + failedFollows === 0
        ? 0
        : Math.round((filledFollows / Math.max(1, filledFollows + failedFollows)) * 100);

    return {
      notifications: {
        pendingUsers,
        todayRegistrations,
        pendingWithdraws,
        pendingRecharges,
        unsettledProfits: unsettledAgg._count._all,
        cancelFailed,
      },
      users: {
        total: totalUsers,
        active: activeUsers,
        pending: pendingUsers,
        disabled: disabledUsers,
        todayNew: todayRegistrations,
      },
      follow: {
        enabled: followEnabled,
        todayFollows,
        filled: filledFollows,
        failed: failedFollows,
        cancelFailed,
        successRate: filledRate,
      },
      funds: {
        pointBalance: num(pointAgg._sum.balance),
        pointFrozen: num(pointAgg._sum.frozen),
        rechargeToday: num(rechargeTodayAgg._sum.amount),
        rechargeTotal: num(rechargeTotalAgg._sum.amount),
        withdrawSettled: num(withdrawSettledAgg._sum.amount),
      },
      profit: {
        total: num(profitTotalAgg._sum.profit),
        today: num(profitTodayAgg._sum.profit),
        commissionTotal: num(commissionAgg._sum.amount),
        /** 直推+间推（普通用户） */
        commissionUserTotal: num(commissionUserAgg._sum.amount),
        /** 平台档 */
        commissionPlatformTotal: num(commissionPlatformAgg._sum.amount),
        unsettledCount: unsettledAgg._count._all,
        unsettledAmount: num(unsettledAgg._sum.profit),
      },
      stats: { activeUsers },
    };
  }
}
