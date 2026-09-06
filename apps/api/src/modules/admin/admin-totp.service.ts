import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { authenticator } from 'otplib';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt, decrypt } from '../../common/crypto.util';

type PendingSetup = { secret: string; expiresAt: number };

/**
 * 管理端 Google Authenticator（TOTP）
 * 绑定前 secret 暂存在内存；确认后加密写入 Admin.encTotpSecret
 */
@Injectable()
export class AdminTotpService {
  private readonly pending = new Map<string, PendingSetup>();
  private readonly issuer = process.env.TOTP_ISSUER || 'FlowOrder Admin';

  constructor(private prisma: PrismaService) {}

  async status(adminId: string) {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('管理员不存在');
    return {
      enabled: !!admin.totpEnabled && !!admin.encTotpSecret,
      boundAt: admin.totpBoundAt,
    };
  }

  /** 开始绑定：返回 secret + otpauth URL（需用 Authenticator 扫码后 confirm） */
  async setup(adminId: string) {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('管理员不存在');
    if (admin.totpEnabled && admin.encTotpSecret) {
      throw new BadRequestException('已绑定 Google 验证器，如需更换请先关闭后再绑定');
    }

    const secret = authenticator.generateSecret();
    const label = admin.email || admin.nickname || adminId;
    const otpauthUrl = authenticator.keyuri(label, this.issuer, secret);
    this.pending.set(adminId, { secret, expiresAt: Date.now() + 10 * 60 * 1000 });

    return {
      secret,
      otpauthUrl,
      issuer: this.issuer,
      account: label,
      expiresInSec: 600,
    };
  }

  /** 用验证码确认绑定 */
  async confirm(adminId: string, code: string) {
    const pending = this.pending.get(adminId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(adminId);
      throw new BadRequestException('绑定已过期，请重新获取二维码');
    }
    const token = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(token)) {
      throw new BadRequestException('请输入 6 位验证码');
    }
    if (!authenticator.check(token, pending.secret)) {
      throw new BadRequestException('验证码错误');
    }

    await this.prisma.admin.update({
      where: { id: adminId },
      data: {
        encTotpSecret: encrypt(pending.secret),
        totpEnabled: true,
        totpBoundAt: new Date(),
      },
    });
    this.pending.delete(adminId);
    return { ok: true, enabled: true };
  }

  /** 关闭绑定（需当前验证码） */
  async disable(adminId: string, code: string) {
    await this.assertValidCode(adminId, code);
    await this.prisma.admin.update({
      where: { id: adminId },
      data: {
        totpEnabled: false,
        encTotpSecret: null,
        totpBoundAt: null,
      },
    });
    this.pending.delete(adminId);
    return { ok: true, enabled: false };
  }

  /** 校验已绑定管理员的验证码；未绑定则抛错 */
  async assertValidCode(adminId: string, code: string) {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('管理员不存在');
    if (!admin.totpEnabled || !admin.encTotpSecret) {
      throw new BadRequestException('请先绑定 Google 验证器后再进行此操作');
    }
    const token = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(token)) {
      throw new BadRequestException('请输入 6 位 Google 验证码');
    }
    let secret: string;
    try {
      secret = decrypt(admin.encTotpSecret);
    } catch {
      throw new UnauthorizedException('验证器配置异常，请重新绑定');
    }
    if (!authenticator.check(token, secret)) {
      throw new BadRequestException('Google 验证码错误');
    }
    return true;
  }
}
