import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../deposit/wallet.service';
import { getPrimaryChain } from '../deposit/chain.config';
import { LoginDto, RegisterDto } from './dto';
import { allocUniqueInviteCode, isNumericInviteCode } from '../../common/invite-code';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private wallets: WalletService,
  ) {}

  /** 生成唯一 8 位纯数字邀请码 */
  async allocInviteCode(): Promise<string> {
    return allocUniqueInviteCode(this.prisma);
  }

  /** 若无码或非纯数字则补发/改成纯数字 */
  async ensureInviteCode(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { inviteCode: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    if (isNumericInviteCode(user.inviteCode)) return user.inviteCode.trim();
    const inviteCode = await this.allocInviteCode();
    await this.prisma.user.update({ where: { id: userId }, data: { inviteCode } });
    return inviteCode;
  }

  /** 按账号解析用户：账号名(nickname) / 完整邮箱 / 内部 email / 邮箱前缀 */
  private async resolveUserByAccount(accountRaw: string): Promise<User | null> {
    const account = accountRaw.trim();
    if (!account) return null;

    const byNickname = await this.prisma.user.findFirst({
      where: { nickname: account, isPlatform: false },
    });
    if (byNickname) return byNickname;

    const byEmail = await this.prisma.user.findUnique({ where: { email: account.toLowerCase() } });
    if (byEmail && !byEmail.isPlatform) return byEmail;

    const byInternal = await this.prisma.user.findUnique({
      where: { email: `${account.toLowerCase()}@account.local` },
    });
    if (byInternal && !byInternal.isPlatform) return byInternal;

    const byPrefix = await this.prisma.user.findFirst({
      where: { email: { startsWith: `${account.toLowerCase()}@` }, isPlatform: false },
    });
    return byPrefix;
  }

  /**
   * 级差分销挂树: 邀请人即直推上级; l1Id/l2Id 为冗余缓存
   * - parentId = 邀请人
   * - l1Id = 直推(邀请人) — 分润上一级
   * - l2Id = 间推(邀请人的上级) — 分润上两级
   */
  private resolveUpline(inviter: User): {
    parentId: string;
    l1Id: string | null;
    l2Id: string | null;
  } {
    return {
      parentId: inviter.id,
      l1Id: inviter.id,
      l2Id: inviter.parentId,
    };
  }

  async register(dto: RegisterDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('两次输入的密码不一致');
    }
    if (dto.password.length < 6) {
      throw new BadRequestException('密码至少 6 位');
    }

    const account = (dto.account || dto.email || '').trim();
    if (account.length < 6) {
      throw new BadRequestException('账号至少 6 位');
    }

    // 不限邮箱：普通账号存 nickname + 内部邮箱；若本身带 @ 则按邮箱存
    const isEmailLike = account.includes('@');
    const email = isEmailLike
      ? account.toLowerCase()
      : `${account.toLowerCase()}@account.local`;
    const nickname = (dto.nickname || (isEmailLike ? account.split('@')[0] : account)).trim();

    const existsEmail = await this.prisma.user.findUnique({ where: { email } });
    if (existsEmail) throw new BadRequestException('账号已被注册');
    const existsNick = await this.prisma.user.findFirst({ where: { nickname } });
    if (existsNick) throw new BadRequestException('账号已被注册');

    let upline = {
      parentId: null as string | null,
      l1Id: null as string | null,
      l2Id: null as string | null,
    };
    if (dto.inviteCode) {
      const code = dto.inviteCode.trim();
      const inviter = await this.prisma.user.findUnique({
        where: { inviteCode: /^\d+$/.test(code) ? code : code.toUpperCase() },
      });
      if (!inviter) throw new BadRequestException('邀请码无效');
      upline = this.resolveUpline(inviter);
    }

    // 注册即分配本人邀请码；状态 PENDING，需后台审核通过后才能登录
    const inviteCode = await this.allocInviteCode();
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        nickname,
        inviteCode,
        parentId: upline.parentId,
        l1Id: upline.l1Id,
        l2Id: upline.l2Id,
        status: 'PENDING',
        pointCard: { create: {} },
      },
    });

    // 注册成功即为用户创建平台托管充值钱包（用户不持有私钥，仅用于链上识别充值归属）
    const primaryChain = getPrimaryChain();
    try {
      const wallet = await this.wallets.ensureUserWallet(user.id, primaryChain);
      this.logger.log(
        `用户 ${user.id} 注册完成（待审核），账号=${nickname}，邀请码=${inviteCode}，已创建 ${primaryChain} 充值地址 ${wallet.address}`,
      );
      return {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        status: user.status,
        inviteCode: user.inviteCode,
        depositChain: primaryChain,
        depositAddress: wallet.address,
        message: '注册成功，请等待管理员审核通过后再登录',
      };
    } catch (e: any) {
      this.logger.error(`用户 ${user.id} 托管钱包创建失败，回滚注册: ${e?.message || e}`);
      await this.prisma
        .$transaction([
          this.prisma.wallet.deleteMany({ where: { userId: user.id } }),
          this.prisma.pointCard.deleteMany({ where: { userId: user.id } }),
          this.prisma.user.delete({ where: { id: user.id } }),
        ])
        .catch(() => undefined);
      throw new BadRequestException('注册失败：无法创建充值钱包，请稍后重试或联系管理员');
    }
  }

  async login(dto: LoginDto) {
    const user = await this.resolveUserByAccount(dto.email);
    if (!user) throw new UnauthorizedException('账号或密码错误');

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('账号或密码错误');

    if (user.isPlatform) throw new UnauthorizedException('账号或密码错误');
    if (user.status === 'PENDING') throw new ForbiddenException('账号待审核，请等待管理员通过后再登录');
    if (user.status === 'REJECTED') throw new ForbiddenException('账号审核未通过');
    if (user.status === 'DISABLED') {
      throw new ForbiddenException('你的账户已经被禁用，请联系管理员');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: 'USER',
      typ: 'user',
      status: user.status,
    });

    const profile = await this.me(user.id);
    return {
      accessToken: token,
      user: profile,
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { pointCard: true },
    });
    if (!user || user.isPlatform) throw new NotFoundException('用户不存在');
    if (user.status === 'DISABLED') {
      throw new ForbiddenException('你的账户已经被禁用，请联系管理员');
    }

    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      role: 'USER' as const,
      status: user.status,
      inviteCode: user.inviteCode,
      hasTradePassword: !!user.tradePasswordHash,
      followEnabled: user.followEnabled,
      followStartedAt: user.followStartedAt,
      withdrawAddress: user.withdrawAddress,
      withdrawChain: user.withdrawChain,
      hasWithdrawAddress: !!user.withdrawAddress,
      pointCard: user.pointCard,
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, confirmPassword: string) {
    if (newPassword !== confirmPassword) {
      throw new BadRequestException('两次输入的新密码不一致');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('新密码不能与当前密码相同');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('当前密码错误');

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    return { ok: true, message: '登录密码已更新' };
  }
}
