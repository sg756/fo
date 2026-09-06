import { Controller, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '../../common/auth-role';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { AuditService } from '../../common/audit.service';
import { DepositService } from './deposit.service';
import { DepositScannerService } from './deposit.scanner';
import { DepositChain } from './chain.config';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/deposit')
export class DepositAdminController {
  constructor(
    private deposit: DepositService,
    private scanner: DepositScannerService,
    private audit: AuditService,
  ) {}

  /** 手动触发扫块 */
  @Post('scan')
  scan(@Query('chain') chain?: DepositChain) {
    return this.scanner.scanNow(chain);
  }

  /** 手动对某笔充值入账 (幂等) */
  @Post('orders/:id/credit')
  async credit(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const order = await this.deposit.creditIfNeeded(id);
    await this.audit.log({
      actorId,
      action: 'DEPOSIT_CREDIT',
      targetType: 'RechargeOrder',
      targetId: id,
    });
    return order;
  }
}
