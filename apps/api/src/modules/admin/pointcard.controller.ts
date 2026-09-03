import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '../../common/auth-role';
import { IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { PointCardService } from './pointcard.service';
import { AuditService } from '../../common/audit.service';

class AdjustDto {
  @IsString() userId: string;
  @IsNumber() amount: number;
  @IsString() @MinLength(1) remark: string;
}

class ManualRechargeDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() userNo?: string;
  @IsOptional() @IsString() account?: string;
  @IsNumber() amount: number;
  @IsString() @MinLength(1) remark: string;
  @IsOptional() @IsString() txHash?: string;
  @IsOptional() @IsString() chain?: string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/pointcard')
export class PointCardController {
  constructor(
    private svc: PointCardService,
    private audit: AuditService,
  ) {}

  @Get('cards')
  cards(
    @Query('q') q?: string,
    @Query('userNo') userNo?: string,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.listCards({
      q,
      userNo,
      account,
      from,
      to,
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Get('txs')
  txs(
    @Query('userId') userId?: string,
    @Query('userNo') userNo?: string,
    @Query('account') account?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.listTxs({
      userId,
      userNo,
      account,
      type,
      from,
      to,
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Post('adjust')
  async adjust(@Body() dto: AdjustDto, @CurrentUser('sub') actorId: string) {
    if (!dto.remark?.trim()) throw new BadRequestException('请填写调账备注');
    const res = await this.svc.adjust(dto.userId, dto.amount, dto.remark.trim());
    await this.audit.log({
      actorId,
      action: 'POINT_ADJUST',
      targetType: 'User',
      targetId: dto.userId,
      detail: { amount: dto.amount, remark: dto.remark },
    });
    return res;
  }

  @Get('recharges')
  recharges(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('userNo') userNo?: string,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.listRecharges({
      status,
      userId,
      userNo,
      account,
      from,
      to,
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Post('recharges/manual')
  async manualRecharge(@Body() dto: ManualRechargeDto, @CurrentUser('sub') actorId: string) {
    if (!dto.remark?.trim()) throw new BadRequestException('请填写备注');
    if (!dto.userId?.trim() && !dto.userNo?.trim() && !dto.account?.trim()) {
      throw new BadRequestException('请填写用户ID或账号');
    }
    const res = await this.svc.manualRecharge({
      userId: dto.userId,
      userNo: dto.userNo,
      account: dto.account,
      amount: dto.amount,
      remark: dto.remark.trim(),
      txHash: dto.txHash,
      chain: dto.chain,
    });
    await this.audit.log({
      actorId,
      action: 'RECHARGE_MANUAL',
      targetType: 'RechargeOrder',
      targetId: res.id,
      detail: {
        userId: res.userId,
        amount: String(res.amount),
        remark: dto.remark.trim(),
        txHash: res.txHash,
      },
    });
    return res;
  }

  @Post('recharges/:id/credit')
  async credit(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.svc.creditRecharge(id);
    await this.audit.log({
      actorId,
      action: 'RECHARGE_CREDIT',
      targetType: 'RechargeOrder',
      targetId: id,
    });
    return res;
  }
}
