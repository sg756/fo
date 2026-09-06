import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { UserRole } from '../../common/auth-role';
import { AuditService } from '../../common/audit.service';
import { ADMIN_MENU_KEYS, ADMIN_MENU_LABELS, normalizeMenus } from '../../common/admin-menus';

class UpsertRoleDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @MinLength(1) code: string;
  @IsString() @MinLength(1) name: string;
  @IsArray() @IsString({ each: true }) menus: string[];
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isSystem?: boolean;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/roles')
export class AdminRolesController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get('menu-catalog')
  menuCatalog() {
    return {
      items: ADMIN_MENU_KEYS.map((key) => ({ key, label: ADMIN_MENU_LABELS[key] })),
    };
  }

  @Get()
  async list() {
    const items = await this.prisma.adminRole.findMany({
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { admins: true } } },
    });
    return {
      items: items.map((r) => ({
        ...r,
        menus: normalizeMenus(r.menus),
        userCount: r._count.admins,
      })),
    };
  }

  @Post()
  async upsert(@Body() dto: UpsertRoleDto, @CurrentUser('sub') actorId: string) {
    await this.assertCanManageRoles(actorId);
    const code = dto.code.trim().toLowerCase();
    const menus = normalizeMenus(dto.menus);
    if (!menus.length) throw new BadRequestException('??????????');

    if (dto.id) {
      const old = await this.prisma.adminRole.findUnique({ where: { id: dto.id } });
      if (!old) throw new NotFoundException('?????');
      if (old.isSystem && code !== old.code) {
        throw new BadRequestException('???????????');
      }
      const updated = await this.prisma.adminRole.update({
        where: { id: dto.id },
        data: {
          name: dto.name.trim(),
          menus,
          description: dto.description,
          ...(old.isSystem ? {} : { code }),
        },
      });
      await this.audit.log({
        actorId,
        action: 'ADMIN_ROLE_UPDATE',
        targetType: 'AdminRole',
        targetId: updated.id,
        detail: { code: updated.code, menus },
      });
      return { ...updated, menus: normalizeMenus(updated.menus) };
    }

    const exists = await this.prisma.adminRole.findUnique({ where: { code } });
    if (exists) throw new BadRequestException('???????');
    const created = await this.prisma.adminRole.create({
      data: {
        code,
        name: dto.name.trim(),
        menus,
        description: dto.description,
        isSystem: false,
      },
    });
    await this.audit.log({
      actorId,
      action: 'ADMIN_ROLE_CREATE',
      targetType: 'AdminRole',
      targetId: created.id,
      detail: { code, menus },
    });
    return { ...created, menus: normalizeMenus(created.menus) };
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpsertRoleDto,
    @CurrentUser('sub') actorId: string,
  ) {
    return this.upsert({ ...dto, id }, actorId);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    await this.assertCanManageRoles(actorId);
    const role = await this.prisma.adminRole.findUnique({
      where: { id },
      include: { _count: { select: { admins: true } } },
    });
    if (!role) throw new NotFoundException('?????');
    if (role.isSystem) throw new BadRequestException('??????????');
    if (role._count.admins > 0) {
      throw new BadRequestException('??????????????????');
    }
    await this.prisma.adminRole.delete({ where: { id } });
    await this.audit.log({
      actorId,
      action: 'ADMIN_ROLE_DELETE',
      targetType: 'AdminRole',
      targetId: id,
    });
    return { ok: true };
  }

  private async assertCanManageRoles(actorId: string) {
    const me = await this.prisma.admin.findUnique({
      where: { id: actorId },
      include: { adminRole: true },
    });
    if (!me) throw new BadRequestException('???');
    const menus = normalizeMenus(me.adminRole?.menus);
    if (!me.adminRoleId || menus.includes('roles') || me.adminRole?.code === 'system') return;
    throw new BadRequestException('???????');
  }
}
