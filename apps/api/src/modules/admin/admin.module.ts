import { Module } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { DashboardController } from './dashboard.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminCaptchaService } from './admin-captcha.service';
import { AdminTotpService } from './admin-totp.service';
import { AdminRolesController } from './admin-roles.controller';
import { AdminRoleService } from './admin-role.service';
import { AdminsAdminController, UsersAdminController } from './users-admin.controller';
import { CommissionController } from './commission.controller';
import { CommissionService } from './commission.service';
import { PointCardController } from './pointcard.controller';
import { PointCardService } from './pointcard.service';
import { WithdrawAdminController } from './withdraw.controller';
import { WithdrawService } from './withdraw.service';
import { WalletAdminController } from './wallet.controller';
import { AuditController } from './audit.controller';
import { ChainPayoutService } from './chain-payout.service';
import { CollectionService } from './collection.service';
import { jwtModuleAsync } from '../../common/jwt-register';

@Module({
  imports: [jwtModuleAsync],
  controllers: [
    DashboardController,
    AdminAuthController,
    UsersAdminController,
    AdminsAdminController,
    AdminRolesController,
    CommissionController,
    PointCardController,
    WithdrawAdminController,
    WalletAdminController,
    AuditController,
  ],
  providers: [
    AuditService,
    AdminAuthService,
    AdminCaptchaService,
    AdminTotpService,
    AdminRoleService,
    CommissionService,
    PointCardService,
    WithdrawService,
    ChainPayoutService,
    CollectionService,
  ],
  exports: [WithdrawService, AuditService, ChainPayoutService, CollectionService, CommissionService],
})
export class AdminModule {}
