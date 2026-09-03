import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../common/auth-role';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { AuditService } from '../../common/audit.service';
import { PointCardService } from './pointcard.service';

class RejectDto {
  @IsOptional() @IsString() reason?: string;
}
class RebindDto {
  @IsString() parentInviteCode: string;
}
class UpdateUserDto {
  /** 账号显示名 / 登录用 nickname */
  @IsOptional() @IsString() @MinLength(2) nickname?: string;
  /** 重置登录密码（至少 6 位）；不传则不改 */
  @IsOptional() @IsString() @MinLength(6) password?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
  /** 填写则改绑直推上级（邀请码）；有下级时不允许 */
  @IsOptional() @IsString() parentInviteCode?: string;
  /** 仅允许后台强制关闭跟单；开启请用户在 App 走完整流程 */
  @IsOptional() @IsBoolean() followEnabled?: boolean;
  @IsOptional() @IsBoolean() clearTradePassword?: boolean;
  /** 点卡增减（正加负减）；与 remark 成对 */
  @ValidateIf((o) => o.pointAdjustAmount != null)
  @IsNumber()
  pointAdjustAmount?: number;
  @ValidateIf((o) => o.pointAdjustAmount != null && o.pointAdjustAmount !== 0)
  @IsString()
  pointAdjustRemark?: string;
}
class CreateAdminDto {
  @IsString() @MinLength(6) account: string;
  @IsString() @MinLength(6) password: string;
  @IsOptional() @IsString() nickname?: string;
  @IsOptional() @IsString() adminRoleId?: string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/users')
export class UsersAdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private pointCard: PointCardService,
  ) {}

  /** ???????????????? */
  @Get()
  async list(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('userNo') userNo?: string,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    const where: any = { isPlatform: false };
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

    const no = userNo?.trim();
    if (no) {
      if (/^\d+$/.test(no)) where.userNo = Number(no);
      else where.id = no;
    }

    const acc = account?.trim();
    if (acc) {
      where.OR = [
        { email: { contains: acc } },
        { nickname: { contains: acc } },
        { inviteCode: { contains: acc } },
      ];
    } else if (q?.trim()) {
      const s = q.trim();
      const or: any[] = [
        { email: { contains: s } },
        { nickname: { contains: s } },
        { inviteCode: { contains: s } },
        { id: s },
      ];
      if (/^\d+$/.test(s)) {
        or.push({ userNo: Number(s) });
      }
      where.OR = or;
    }

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: Number(skip),
        take: Math.min(Number(take) || 50, 200),
        select: {
          id: true,
          userNo: true,
          email: true,
          nickname: true,
          status: true,
          inviteCode: true,
          parentId: true,
          l1Id: true,
          l2Id: true,
          followEnabled: true,
          createdAt: true,
          lastLoginAt: true,
          parent: { select: { id: true, userNo: true, nickname: true, email: true, inviteCode: true } },
          pointCard: {
            select: {
              balance: true,
              frozen: true,
              commissionBalance: true,
              commissionFrozen: true,
            },
          },
          _count: { select: { children: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // ?????????l2 ? relation?
    const l2Ids = [...new Set(items.map((u) => u.l2Id).filter(Boolean))] as string[];
    const l2Map = new Map<
      string,
      { id: string; userNo: number | null; nickname: string | null; email: string; inviteCode: string }
    >();
    if (l2Ids.length) {
      const l2Users = await this.prisma.user.findMany({
        where: { id: { in: l2Ids } },
        select: { id: true, userNo: true, nickname: true, email: true, inviteCode: true },
      });
      for (const u of l2Users) l2Map.set(u.id, u);
    }

    return {
      items: items.map((u) => {
        const { _count, pointCard, ...rest } = u;
        return {
          ...rest,
          l1: u.parent,
          l2: u.l2Id ? l2Map.get(u.l2Id) || null : null,
          directCount: _count.children,
          pointBalance: pointCard ? Number(pointCard.balance) : 0,
          pointFrozen: pointCard ? Number(pointCard.frozen) : 0,
          commissionBalance: pointCard ? Number(pointCard.commissionBalance) : 0,
          commissionFrozen: pointCard ? Number(pointCard.commissionFrozen) : 0,
        };
      }),
      total,
    };
  }

  /**
   * ????? parentId ??
   * roots = ???????????????????????
   */
  @Get('distribution-tree')
  async distributionTree(@Query('q') q?: string) {
    const where: any = { isPlatform: false };
    if (q?.trim()) {
      const s = q.trim();
      const or: any[] = [
        { email: { contains: s } },
        { nickname: { contains: s } },
        { inviteCode: { contains: s.trim().toUpperCase() } },
        { id: s },
      ];
      if (/^\d+$/.test(s)) or.push({ userNo: Number(s) });
      where.OR = or;
    }

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 3000,
      select: {
        id: true,
        userNo: true,
        email: true,
        nickname: true,
        status: true,
        inviteCode: true,
        parentId: true,
        l1Id: true,
        l2Id: true,
        followEnabled: true,
        createdAt: true,
        _count: { select: { children: true } },
      },
    });

    type Flat = (typeof users)[number];
    type TreeNode = Flat & {
      children: TreeNode[];
      directCount: number;
      downlineCount: number;
    };

    const byId = new Map<string, TreeNode>();
    for (const u of users) {
      byId.set(u.id, {
        ...u,
        children: [],
        directCount: u._count.children,
        downlineCount: 0,
      });
    }

    const roots: TreeNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent && parent.id !== node.id) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    // ??????????
    const sortRec = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => {
        if (b.directCount !== a.directCount) return b.directCount - a.directCount;
        return a.email.localeCompare(b.email);
      });
      for (const n of nodes) sortRec(n.children);
    };
    sortRec(roots);

    const countDownline = (n: TreeNode): number => {
      let c = n.children.length;
      for (const ch of n.children) c += countDownline(ch);
      n.downlineCount = c;
      return c;
    };
    for (const r of roots) countDownline(r);

    const [commTotals, commByLevel] = await Promise.all([
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
    const rebateMap = new Map<
      string,
      { count: number; amount: number; direct: number; indirect: number }
    >();
    for (const t of commTotals) {
      rebateMap.set(t.earnerId, {
        count: t._count,
        amount: Number(t._sum.amount ?? 0),
        direct: 0,
        indirect: 0,
      });
    }
    for (const row of commByLevel) {
      const cur = rebateMap.get(row.earnerId);
      if (!cur) continue;
      const v = Number(row._sum.amount ?? 0);
      const lv = String(row.level);
      if (lv === 'DIRECT' || lv === 'L1') cur.direct += v;
      else if (lv === 'INDIRECT' || lv === 'L2') cur.indirect += v;
    }

    const strip = (n: TreeNode): any => {
      const rebate = rebateMap.get(n.id);
      return {
        id: n.id,
        userNo: n.userNo,
        email: n.email,
        nickname: n.nickname,
        status: n.status,
        inviteCode: n.inviteCode,
        parentId: n.parentId,
        l1Id: n.l1Id,
        l2Id: n.l2Id,
        followEnabled: n.followEnabled,
        createdAt: n.createdAt,
        directCount: n.directCount,
        downlineCount: n.downlineCount,
        rebateAmount: rebate ? Number(rebate.amount.toFixed(6)) : 0,
        rebateCount: rebate?.count ?? 0,
        rebateDirect: rebate ? Number(rebate.direct.toFixed(6)) : 0,
        rebateIndirect: rebate ? Number(rebate.indirect.toFixed(6)) : 0,
        children: n.children.map(strip),
      };
    };

    const summary = {
      total: users.length,
      roots: roots.length,
      noParent: users.filter((u) => !u.parentId).length,
    };

    return { summary, roots: roots.map(strip) };
  }

  /** ???????? distribution-tree ?????? :id ????? cuid ??? ID */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const byNo = /^\d+$/.test(id);
    const user = await this.prisma.user.findFirst({
      where: byNo ? { userNo: Number(id), isPlatform: false } : { id, isPlatform: false },
      select: {
        id: true,
        userNo: true,
        email: true,
        nickname: true,
        isPlatform: true,
        status: true,
        inviteCode: true,
        parentId: true,
        l1Id: true,
        l2Id: true,
        followEnabled: true,
        followStartedAt: true,
        followStoppedAt: true,
        withdrawAddress: true,
        withdrawChain: true,
        withdrawAddressLabel: true,
        withdrawAddressUpdatedAt: true,
        reviewedAt: true,
        rejectReason: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        parent: {
          select: { id: true, userNo: true, nickname: true, email: true, inviteCode: true, status: true },
        },
        pointCard: {
          select: {
            balance: true,
            frozen: true,
            commissionBalance: true,
            commissionFrozen: true,
            updatedAt: true,
          },
        },
        wallets: {
          select: { id: true, chain: true, address: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        exchangeKeys: {
          select: { id: true, exchange: true, label: true, active: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { children: true } },
      },
    });
    if (!user || user.isPlatform) throw new NotFoundException('?????');

    let l2: {
      id: string;
      userNo: number | null;
      nickname: string | null;
      email: string;
      inviteCode: string;
      status: string;
    } | null = null;
    if (user.l2Id) {
      l2 = await this.prisma.user.findUnique({
        where: { id: user.l2Id },
        select: { id: true, userNo: true, nickname: true, email: true, inviteCode: true, status: true },
      });
    }

    return {
      ...user,
      l1: user.parent,
      l2,
      directCount: user._count.children,
      pointCard: user.pointCard
        ? {
            balance: Number(user.pointCard.balance),
            frozen: Number(user.pointCard.frozen),
            commissionBalance: Number(user.pointCard.commissionBalance),
            commissionFrozen: Number(user.pointCard.commissionFrozen),
            updatedAt: user.pointCard.updatedAt,
          }
        : {
            balance: 0,
            frozen: 0,
            commissionBalance: 0,
            commissionFrozen: 0,
            updatedAt: null,
          },
    };
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.isPlatform) throw new NotFoundException('?????');
    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: 'ACTIVE', reviewedById: actorId, reviewedAt: new Date(), rejectReason: null },
    });
    await this.audit.log({ actorId, action: 'USER_APPROVE', targetType: 'User', targetId: id });
    return { id: updated.id, status: updated.status };
  }

  @Post(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.isPlatform) throw new NotFoundException('?????');
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedById: actorId,
        reviewedAt: new Date(),
        rejectReason: dto.reason,
        followEnabled: false,
        followStoppedAt: new Date(),
      },
    });
    await this.audit.log({
      actorId,
      action: 'USER_REJECT',
      targetType: 'User',
      targetId: id,
      detail: { reason: dto.reason },
    });
    return { id: updated.id, status: updated.status };
  }

  @Post(':id/disable')
  async disable(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.isPlatform) throw new NotFoundException('用户不存在');
    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: 'DISABLED', followEnabled: false, followStoppedAt: new Date() },
    });
    await this.audit.log({ actorId, action: 'USER_DISABLE', targetType: 'User', targetId: id });
    return { id: updated.id, status: updated.status };
  }

  /** 重新启用（DISABLED → ACTIVE） */
  @Post(':id/enable')
  async enable(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.isPlatform) throw new NotFoundException('用户不存在');
    if (user.status === 'ACTIVE') return { id: user.id, status: user.status };
    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: 'ACTIVE', rejectReason: null, reviewedById: actorId, reviewedAt: new Date() },
    });
    await this.audit.log({ actorId, action: 'USER_ENABLE', targetType: 'User', targetId: id });
    return { id: updated.id, status: updated.status };
  }

  /**
   * 后台代改用户：账号名、密码、状态、直推上级、强制关跟单、清交易密码、点卡调账。
   * 不可改：用户 ID、登录标识 email、邀请码、间推（由直推推导）、注册/登录时间、钱包与 Key。
   */
  @Post(':id/update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { children: true } } },
    });
    if (!user || user.isPlatform) throw new NotFoundException('用户不存在');

    const detail: Record<string, unknown> = {};
    const data: Record<string, unknown> = {};

    if (dto.nickname != null) {
      const nick = dto.nickname.trim();
      if (nick.length < 2) throw new BadRequestException('账号至少 2 位');
      const clash = await this.prisma.user.findFirst({
        where: { nickname: nick, NOT: { id }, isPlatform: false },
      });
      if (clash) throw new BadRequestException('账号名已被占用');
      data.nickname = nick;
      detail.nickname = nick;
    }

    if (dto.password != null && dto.password !== '') {
      if (dto.password.length < 6) throw new BadRequestException('密码至少 6 位');
      data.passwordHash = await bcrypt.hash(dto.password, 10);
      detail.passwordReset = true;
    }

    if (dto.status === 'DISABLED') {
      data.status = 'DISABLED';
      data.followEnabled = false;
      data.followStoppedAt = new Date();
      detail.status = 'DISABLED';
    } else if (dto.status === 'ACTIVE') {
      data.status = 'ACTIVE';
      data.rejectReason = null;
      data.reviewedById = actorId;
      data.reviewedAt = new Date();
      detail.status = 'ACTIVE';
    }

    if (dto.followEnabled === false) {
      data.followEnabled = false;
      data.followStoppedAt = new Date();
      detail.followEnabled = false;
    } else if (dto.followEnabled === true) {
      throw new BadRequestException('开启跟单请用户在 App 内操作（需代理与交易检查）');
    }

    if (dto.clearTradePassword) {
      data.tradePasswordHash = null;
      detail.clearTradePassword = true;
    }

    if (dto.parentInviteCode != null && dto.parentInviteCode.trim() !== '') {
      if (user._count.children > 0) {
        throw new BadRequestException('该用户已有下级，不能改绑直推上级');
      }
      const parentCode = dto.parentInviteCode.trim();
      const parent = await this.prisma.user.findUnique({
        where: { inviteCode: /^\d+$/.test(parentCode) ? parentCode : parentCode.toUpperCase() },
      });
      if (!parent) throw new BadRequestException('上级邀请码无效');
      if (parent.isPlatform) throw new BadRequestException('不能绑到平台账号');
      if (parent.id === id) throw new BadRequestException('不能绑到自己');

      let walk: string | null = parent.parentId;
      const seen = new Set<string>([parent.id]);
      while (walk) {
        if (walk === id) throw new BadRequestException('不能形成循环上下级');
        if (seen.has(walk)) break;
        seen.add(walk);
        const up = await this.prisma.user.findUnique({
          where: { id: walk },
          select: { parentId: true },
        });
        walk = up?.parentId ?? null;
      }

      data.parentId = parent.id;
      data.l1Id = parent.id;
      data.l2Id = parent.parentId;
      detail.rebind = { parentId: parent.id, l1Id: parent.id, l2Id: parent.parentId };
    }

    if (Object.keys(data).length) {
      await this.prisma.user.update({ where: { id }, data: data as any });
    }

    let pointTx: unknown = null;
    if (dto.pointAdjustAmount != null && dto.pointAdjustAmount !== 0) {
      pointTx = await this.pointCard.adjust(
        id,
        Number(dto.pointAdjustAmount),
        dto.pointAdjustRemark || '后台用户编辑调账',
      );
      detail.pointAdjust = {
        amount: Number(dto.pointAdjustAmount),
        remark: dto.pointAdjustRemark || '后台用户编辑调账',
      };
    }

    if (!Object.keys(detail).length) {
      throw new BadRequestException('未提交可修改项');
    }

    await this.audit.log({
      actorId,
      action: 'USER_UPDATE',
      targetType: 'User',
      targetId: id,
      detail,
    });

    return { ok: true, id, detail, pointTx };
  }

  @Post(':id/rebind')
  async rebind(
    @Param('id') id: string,
    @Body() dto: RebindDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { children: true } } },
    });
    if (!user) throw new NotFoundException('?????');
    if (user.isPlatform) throw new BadRequestException('????????');
    if (user._count.children > 0) {
      throw new BadRequestException('??????????????');
    }

    const parentCode = dto.parentInviteCode.trim();
    const parent = await this.prisma.user.findUnique({
      where: { inviteCode: /^\d+$/.test(parentCode) ? parentCode : parentCode.toUpperCase() },
    });
    if (!parent) throw new BadRequestException('?????');
    if (parent.isPlatform) throw new BadRequestException('?????????');
    if (parent.id === id) throw new BadRequestException('??????');

    // ????????????????
    let walk: string | null = parent.parentId;
    const seen = new Set<string>([parent.id]);
    while (walk) {
      if (walk === id) throw new BadRequestException('??????');
      if (seen.has(walk)) break;
      seen.add(walk);
      const up = await this.prisma.user.findUnique({
        where: { id: walk },
        select: { parentId: true },
      });
      walk = up?.parentId ?? null;
    }

    // ?????l1=?????l2=????
    const l1Id = parent.id;
    const l2Id = parent.parentId;

    const updated = await this.prisma.user.update({
      where: { id },
      data: { parentId: parent.id, l1Id, l2Id },
    });
    await this.audit.log({
      actorId,
      action: 'USER_REBIND',
      targetType: 'User',
      targetId: id,
      detail: { parentId: parent.id, l1Id, l2Id, note: 'level_diff_2_up' },
    });
    return { id: updated.id, parentId: updated.parentId, l1Id, l2Id };
  }
}

/** ??????admins ?????????? */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/admins')
export class AdminsAdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get()
  async list(@Query('q') q?: string) {
    const where: any = {};
    if (q?.trim()) {
      const s = q.trim();
      where.OR = [{ email: { contains: s } }, { nickname: { contains: s } }];
    }
    const items = await this.prisma.admin.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        nickname: true,
        status: true,
        createdAt: true,
        adminRoleId: true,
        adminRole: { select: { id: true, code: true, name: true } },
      },
    });
    return {
      items: items.map((a) => ({ ...a, role: 'ADMIN' })),
      total: items.length,
    };
  }

  @Post()
  async create(@Body() dto: CreateAdminDto, @CurrentUser('sub') actorId: string) {
    const account = dto.account.trim();
    if (account.length < 6) throw new BadRequestException('???? 6 ?');
    const isEmailLike = account.includes('@');
    const email = isEmailLike ? account.toLowerCase() : `${account.toLowerCase()}@admin.local`;
    const nickname = (dto.nickname || (isEmailLike ? account.split('@')[0] : account)).trim();

    const exists = await this.prisma.admin.findFirst({
      where: { OR: [{ email }, { nickname }] },
    });
    if (exists) throw new BadRequestException('??????');

    let adminRoleId = dto.adminRoleId;
    if (adminRoleId) {
      const role = await this.prisma.adminRole.findUnique({ where: { id: adminRoleId } });
      if (!role) throw new BadRequestException('?????');
    } else {
      const system = await this.prisma.adminRole.findUnique({ where: { code: 'system' } });
      adminRoleId = system?.id;
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const admin = await this.prisma.admin.create({
      data: {
        email,
        nickname,
        passwordHash,
        status: 'ACTIVE',
        adminRoleId: adminRoleId || undefined,
      },
      select: {
        id: true,
        email: true,
        nickname: true,
        status: true,
        createdAt: true,
        adminRoleId: true,
        adminRole: { select: { id: true, code: true, name: true } },
      },
    });
    await this.audit.log({
      actorId,
      action: 'ADMIN_CREATE',
      targetType: 'Admin',
      targetId: admin.id,
      detail: { email: admin.email, adminRoleId },
    });
    return { ...admin, role: 'ADMIN' };
  }

  @Post(':id/role')
  async setAdminRole(
    @Param('id') id: string,
    @Body() body: { adminRoleId: string },
    @CurrentUser('sub') actorId: string,
  ) {
    if (!body.adminRoleId) throw new BadRequestException('?????');
    const role = await this.prisma.adminRole.findUnique({ where: { id: body.adminRoleId } });
    if (!role) throw new NotFoundException('?????');
    const admin = await this.prisma.admin.findUnique({ where: { id } });
    if (!admin) throw new NotFoundException('??????');
    const updated = await this.prisma.admin.update({
      where: { id },
      data: { adminRoleId: body.adminRoleId },
      select: {
        id: true,
        adminRoleId: true,
        adminRole: { select: { id: true, code: true, name: true } },
      },
    });
    await this.audit.log({
      actorId,
      action: 'ADMIN_SET_ROLE',
      targetType: 'Admin',
      targetId: id,
      detail: { adminRoleId: body.adminRoleId },
    });
    return updated;
  }

  @Post(':id/disable')
  async disable(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    if (id === actorId) throw new BadRequestException('??????');
    const admin = await this.prisma.admin.findUnique({ where: { id } });
    if (!admin) throw new NotFoundException('??????');
    const updated = await this.prisma.admin.update({
      where: { id },
      data: { status: 'DISABLED' },
      select: { id: true, status: true },
    });
    await this.audit.log({ actorId, action: 'ADMIN_DISABLE', targetType: 'Admin', targetId: id });
    return updated;
  }
}
