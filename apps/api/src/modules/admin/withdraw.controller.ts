import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '../../common/auth-role';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { WithdrawService } from './withdraw.service';
import { ChainPayoutService } from './chain-payout.service';

class AuditDto {
  @IsOptional() @IsString() remark?: string;
}
class ReleaseDto {
  @IsString() txHash: string;
  @IsOptional() @IsString() remark?: string;
}
class MinWithdrawDto {
  @IsNumber() @Min(0) amount: number;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/withdraws')
export class WithdrawAdminController {
  constructor(
    private svc: WithdrawService,
    private chainPayout: ChainPayoutService,
  ) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('userNo') userNo?: string,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.list({
      status,
      userNo,
      account,
      from,
      to,
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Get('config')
  async config() {
    const minWithdrawAmount = await this.svc.getMinWithdrawAmount();
    return { minWithdrawAmount };
  }

  @Post('config/min-amount')
  setMinAmount(@Body() dto: MinWithdrawDto) {
    return this.svc.setMinWithdrawAmount(dto.amount);
  }

  @Get('release-logs')
  logs(@Query('skip') skip = '0', @Query('take') take = '50') {
    return this.svc.releaseLogs({ skip: Number(skip), take: Number(take) });
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() dto: AuditDto, @CurrentUser('sub') actorId: string) {
    return this.svc.approve(id, actorId, dto.remark);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: AuditDto, @CurrentUser('sub') actorId: string) {
    return this.svc.reject(id, actorId, dto.remark);
  }

  @Post(':id/release')
  release(@Param('id') id: string, @Body() dto: ReleaseDto, @CurrentUser('sub') actorId: string) {
    return this.svc.settle(id, actorId, dto.txHash, dto.remark);
  }

  /** 管理员确认线下已打款 → 已结算 */
  @Post(':id/settle')
  settle(@Param('id') id: string, @Body() dto: ReleaseDto, @CurrentUser('sub') actorId: string) {
    return this.svc.settle(id, actorId, dto.txHash, dto.remark);
  }

  /** 可选：热钱包自动打款并结算 */
  @Post(':id/payout')
  payout(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    return this.svc.payoutOnChain(id, actorId, (p) => this.chainPayout.sendUsdtFromHot(p));
  }
}
