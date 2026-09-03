import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditService } from '../../common/audit.service';
import { WalletService } from './wallet.service';
import { DepositService } from './deposit.service';
import { DepositScannerService } from './deposit.scanner';
import { DepositAdminController } from './deposit-admin.controller';

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [DepositAdminController],
  providers: [AuditService, WalletService, DepositService, DepositScannerService],
  exports: [WalletService, DepositService, DepositScannerService],
})
export class DepositModule {}
