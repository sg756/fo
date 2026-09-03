import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [AdminModule],
  controllers: [AccountController],
})
export class AccountModule {}
