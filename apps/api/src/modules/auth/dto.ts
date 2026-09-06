import { IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

export class RegisterDto {
  /** 登录账号（至少 6 位，不限邮箱格式）；兼容旧字段 email */
  @ValidateIf((o) => !o.email)
  @IsString()
  @MinLength(6, { message: '账号至少 6 位' })
  account?: string;

  @ValidateIf((o) => !o.account)
  @IsString()
  @MinLength(6, { message: '账号至少 6 位' })
  email?: string;

  @IsString()
  @MinLength(6, { message: '密码至少 6 位' })
  password: string;

  /** 二次确认密码 */
  @IsString()
  @MinLength(6, { message: '确认密码至少 6 位' })
  confirmPassword: string;

  @IsOptional()
  @IsString()
  nickname?: string;

  @IsOptional()
  @IsString()
  inviteCode?: string;
}

export class LoginDto {
  /** 登录账号：支持账号名、完整邮箱、或邮箱前缀 */
  @IsString()
  @MinLength(1)
  email: string;

  @IsString()
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(6)
  newPassword: string;

  @IsString()
  @MinLength(6)
  confirmPassword: string;
}
