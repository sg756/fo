import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtUser } from './decorators';
import { UserRole } from './auth-role';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') || 'dev-secret',
    });
  }

  async validate(payload: JwtUser & { typ?: string }): Promise<JwtUser> {
    if (payload.role === UserRole.ADMIN || payload.typ === 'admin') {
      const admin = await this.prisma.admin.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, status: true },
      });
      if (!admin) throw new UnauthorizedException('登录已失效，请重新登录');
      if (admin.status === 'DISABLED') {
        throw new UnauthorizedException('你的账户已经被禁用，请联系管理员');
      }
      return {
        sub: admin.id,
        email: admin.email,
        role: UserRole.ADMIN,
        status: admin.status,
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, status: true, isPlatform: true },
    });
    if (!user || user.isPlatform) throw new UnauthorizedException('登录已失效，请重新登录');
    if (user.status === 'DISABLED') {
      throw new UnauthorizedException('你的账户已经被禁用，请联系管理员');
    }
    if (user.status === 'PENDING') throw new UnauthorizedException('账号待审核');
    if (user.status === 'REJECTED') throw new UnauthorizedException('账号审核未通过');
    return {
      sub: user.id,
      email: user.email,
      role: UserRole.USER,
      status: user.status,
    };
  }
}
