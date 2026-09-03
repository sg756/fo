import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { UserRole } from '../../common/auth-role';
import { AuditService } from '../../common/audit.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/audit-logs')
export class AuditController {
  constructor(
    private audit: AuditService,
    private prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Query('action') action?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    const { items: rows, total } = await this.audit.list({
      action,
      skip: Number(skip),
      take: Math.min(200, Number(take) || 50),
    });

    const actorIds = Array.from(new Set(rows.map((r) => r.actorId).filter(Boolean))) as string[];
    const actors = actorIds.length
      ? await this.prisma.admin.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a.email]));

    const userTargetIds = Array.from(
      new Set(rows.filter((r) => r.targetType === 'User' && r.targetId).map((r) => r.targetId!)),
    );
    const users = userTargetIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userTargetIds } },
          select: { id: true, nickname: true, email: true, userNo: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    return {
      items: rows.map((r) => {
        const u = r.targetType === 'User' && r.targetId ? userMap.get(r.targetId) : undefined;
        return {
          id: r.id,
          action: r.action,
          actorId: r.actorId,
          actorEmail: r.actorId ? actorMap.get(r.actorId) || null : null,
          targetType: r.targetType,
          targetId: r.targetId,
          targetNickname: u?.nickname ?? null,
          targetEmail: u?.email ?? null,
          targetUserNo: u?.userNo ?? null,
          detail: r.detail,
          ip: r.ip,
          createdAt: r.createdAt,
        };
      }),
      total,
    };
  }

  @Get('actions')
  async actions() {
    const groups = await this.prisma.auditLog.groupBy({
      by: ['action'],
      _count: { _all: true },
    });
    return groups
      .map((g) => ({ action: g.action, count: g._count._all }))
      .sort((a, b) => b.count - a.count);
  }
}
