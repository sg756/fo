import { Global, Module, forwardRef } from '@nestjs/common';
import { IpPoolService } from './ippool.service';
import { IpPoolController, IpWhitelistController } from './ippool.controller';
import { TradeModule } from '../trade/trade.module';

@Global()
@Module({
  imports: [forwardRef(() => TradeModule)],
  controllers: [IpPoolController, IpWhitelistController],
  providers: [IpPoolService],
  exports: [IpPoolService],
})
export class IpPoolModule {}
