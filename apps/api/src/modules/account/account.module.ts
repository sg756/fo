import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AdminModule } from '../admin/admin.module';
import { PointAlertService } from './point-alert.service';
import { PointAlertWorker } from './point-alert.worker';
import { NoticeService } from './notice.service';

@Module({
  imports: [AdminModule],
  controllers: [AccountController],
  providers: [PointAlertService, PointAlertWorker, NoticeService],
})
export class AccountModule {}
