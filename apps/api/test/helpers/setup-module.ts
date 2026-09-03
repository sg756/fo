import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PostLogModule } from '../../src/modules/postlog/postlog.module';
import { ExchangeKeyModule } from '../../src/modules/exchange-key/exchange-key.module';
import { ExchangeKeyService } from '../../src/modules/exchange-key/exchange-key.service';
import { IpPoolModule } from '../../src/modules/ippool/ippool.module';
import { MarketModule } from '../../src/modules/market/market.module';
import { AdminModule } from '../../src/modules/admin/admin.module';
import { TradeModule } from '../../src/modules/trade/trade.module';
import { TradeService } from '../../src/modules/trade/trade.service';
import { FollowerWorker } from '../../src/modules/trade/follower.worker';
import { MapiClient } from '../../src/modules/trade/mapi.client';
import { SymbolService } from '../../src/modules/trade/symbol.service';
import { SymbolPairInfo } from '../../src/modules/trade/mapi.types';
import { mapiMock } from './mapi-mock';

const BTC_SYMBOL: SymbolPairInfo = {
  apiCode: 'bac',
  apiName: 'Binance',
  coinName: 'BTC',
  equalCoinName: 'PC',
  minAmt: 0.001,
  minSize: 0.001,
  pricePrecision: 2,
  priceStep: 0.01,
  settleCoin: 'USDT',
  boardLotSize: 0,
  symbol: 'BTC/PC',
};

export type TestContext = {
  module: TestingModule;
  trade: TradeService;
  worker: FollowerWorker;
  mapi: MapiClient;
};

export async function createTestContext(): Promise<TestContext> {
  mapiMock.reset();
  process.env.QUERY_POSITION_SYNC = 'false';

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: process.env.NODE_ENV === 'production' ? ['.env'] : ['.env.dev', '.env'],
      }),
      PrismaModule,
      PostLogModule,
      ExchangeKeyModule,
      IpPoolModule,
      MarketModule,
      AdminModule,
      TradeModule,
    ],
  })
    .overrideProvider(ExchangeKeyService)
    .useValue({
      getDecrypted: async () => ({
        apiKey: 'mock-api-key',
        apiSecret: 'mock-api-secret',
        passphrase: '',
      }),
      countComplete: async () => 1,
    })
    .overrideProvider(MapiClient)
    .useValue({
      post: (endpoint: string, body?: any, _opts?: any) => mapiMock.post(endpoint, body),
      get: (endpoint: string, _opts?: any) => mapiMock.get(endpoint, _opts),
      resolveBaseUrl: async () => 'http://127.0.0.1:1820',
      resolveServiceKey: async () => 'mock-key',
      envDefaultBase: () => 'http://127.0.0.1:1820',
    })
    .overrideProvider(SymbolService)
    .useValue({
      find: async () => BTC_SYMBOL,
      load: async () => ({ items: [BTC_SYMBOL], refreshed: true }),
      onModuleInit: () => undefined,
      onModuleDestroy: () => undefined,
    })
    .compile();

  const trade = module.get(TradeService);
  const worker = module.get(FollowerWorker);
  const mapi = module.get(MapiClient);

  return { module, trade, worker, mapi };
}

export async function destroyTestContext(ctx: TestContext) {
  await ctx.module.close();
}
