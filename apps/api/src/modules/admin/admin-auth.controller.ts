import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { UserRole } from '../../common/auth-role';
import { AdminAuthService } from './admin-auth.service';
import { AdminCaptchaService } from './admin-captcha.service';
import { AdminTotpService } from './admin-totp.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { AuditService } from '../../common/audit.service';

class AdminLoginDto {
  @IsString()
  @MinLength(1)
  email: string;

  @IsString()
  @MinLength(1)
  password: string;

  @IsString()
  @MinLength(1)
  captchaId: string;

  @IsString()
  @MinLength(1)
  captchaCode: string;
}

class TotpCodeDto {
  @IsString()
  @MinLength(6)
  code: string;
}

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private auth: AdminAuthService,
    private captcha: AdminCaptchaService,
    private totp: AdminTotpService,
    private audit: AuditService,
  ) {}

  /** 图形验证码（登录前获取，点击可刷新） */
  @Get('captcha')
  captchaImage() {
    return this.captcha.create();
  }

  @Post('login')
  login(@Body() dto: AdminLoginDto) {
    this.captcha.consume(dto.captchaId, dto.captchaCode);
    return this.auth.login(dto.email, dto.password);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('me')
  me(@CurrentUser('sub') adminId: string) {
    return this.auth.me(adminId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('totp/status')
  totpStatus(@CurrentUser('sub') adminId: string) {
    return this.totp.status(adminId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('totp/setup')
  totpSetup(@CurrentUser('sub') adminId: string) {
    return this.totp.setup(adminId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('totp/confirm')
  async totpConfirm(@CurrentUser('sub') adminId: string, @Body() dto: TotpCodeDto) {
    const res = await this.totp.confirm(adminId, dto.code);
    await this.audit.log({
      actorId: adminId,
      action: 'ADMIN_TOTP_BIND',
      targetType: 'Admin',
      targetId: adminId,
    });
    return res;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('totp/disable')
  async totpDisable(@CurrentUser('sub') adminId: string, @Body() dto: TotpCodeDto) {
    const res = await this.totp.disable(adminId, dto.code);
    await this.audit.log({
      actorId: adminId,
      action: 'ADMIN_TOTP_DISABLE',
      targetType: 'Admin',
      targetId: adminId,
    });
    return res;
  }
}
