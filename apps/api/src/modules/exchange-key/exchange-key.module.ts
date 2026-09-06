import { Global, Module } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { ExchangeKeyService } from './exchange-key.service';
import { ExchangeKeyAdminController, ExchangeKeyController } from './exchange-key.controller';

@Global()
@Module({
  controllers: [ExchangeKeyController, ExchangeKeyAdminController],
  providers: [ExchangeKeyService, AuditService],
  exports: [ExchangeKeyService],
})
export class ExchangeKeyModule {}
