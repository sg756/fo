import { Module, forwardRef } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { MarketModule } from '../market/market.module';
import { AdminModule } from '../admin/admin.module';
import { IpPoolModule } from '../ippool/ippool.module';
import { MapiClient } from './mapi.client';
import { SymbolService } from './symbol.service';
import { TradeService } from './trade.service';
import { TradeAdminController, TradeController } from './trade.controller';
import { FollowerWorker } from './follower.worker';
import { QueryPositionWorker } from './query-position.worker';

@Module({
  imports: [MarketModule, AdminModule, forwardRef(() => IpPoolModule)],
  controllers: [TradeController, TradeAdminController],
  providers: [
    AuditService,
    MapiClient,
    SymbolService,
    TradeService,
    FollowerWorker,
    QueryPositionWorker,
  ],
  exports: [TradeService, MapiClient, SymbolService, FollowerWorker, QueryPositionWorker],
})
export class TradeModule {}
