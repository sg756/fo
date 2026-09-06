import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { ALL_ADMIN_MENUS, normalizeMenus } from '../../common/admin-menus';

@Injectable()
export class AdminAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  private async resolveByAccount(accountRaw: string) {
    const account = accountRaw.trim();
    if (!account) return null;
    const byNick = await this.prisma.admin.findFirst({ where: { nickname: account } });
    if (byNick) return byNick;
    const email = account.includes('@') ? account.toLowerCase() : null;
    if (email) {
      const byEmail = await this.prisma.admin.findUnique({ where: { email } });
      if (byEmail) return byEmail;
    }
    const byInternal = await this.prisma.admin.findUnique({
      where: { email: `${account.toLowerCase()}@admin.local` },
    });
    if (byInternal) return byInternal;
    return this.prisma.admin.findFirst({
      where: { email: { startsWith: `${account.toLowerCase()}@` } },
    });
  }

  async login(account: string, password: string) {
    const admin = await this.resolveByAccount(account);
    if (!admin) throw new UnauthorizedException('账号或密码错误');
    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) throw new UnauthorizedException('账号或密码错误');
    if (admin.status === 'DISABLED') {
      throw new ForbiddenException('你的账户已经被禁用，请联系管理员');
    }

    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const token = await this.jwt.signAsync({
      sub: admin.id,
      email: admin.email,
      role: 'ADMIN',
      typ: 'admin',
      status: admin.status,
    });

    return {
      accessToken: token,
      user: await this.me(admin.id),
    };
  }

  async me(adminId: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      include: { adminRole: true },
    });
    if (!admin) throw new NotFoundException('管理员不存在');
    if (admin.status === 'DISABLED') {
      throw new ForbiddenException('你的账户已经被禁用，请联系管理员');
    }

    let menus = [...ALL_ADMIN_MENUS];
    let adminRole: { id: string; code: string; name: string } | null = null;
    if (admin.adminRole) {
      menus = normalizeMenus(admin.adminRole.menus);
      adminRole = {
        id: admin.adminRole.id,
        code: admin.adminRole.code,
        name: admin.adminRole.name,
      };
    }

    return {
      id: admin.id,
      email: admin.email,
      nickname: admin.nickname,
      role: 'ADMIN' as const,
      status: admin.status,
      adminRoleId: admin.adminRoleId,
      adminRole,
      menus,
      totpEnabled: !!admin.totpEnabled && !!admin.encTotpSecret,
    };
  }
}
