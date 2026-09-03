import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { AccountModule } from './modules/account/account.module';
import { PostLogModule } from './modules/postlog/postlog.module';
import { ExchangeKeyModule } from './modules/exchange-key/exchange-key.module';
import { IpPoolModule } from './modules/ippool/ippool.module';
import { DepositModule } from './modules/deposit/deposit.module';
import { TradeModule } from './modules/trade/trade.module';
import { MarketModule } from './modules/market/market.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 本地：.env.dev ；服务器：.env（configure 生成；不做互相回退）
      envFilePath:
        process.env.NODE_ENV === 'production' ? ['.env'] : ['.env.dev'],
    }),
    PrismaModule,
    DepositModule,
    MarketModule,
    TradeModule,
    PostLogModule,
    ExchangeKeyModule,
    IpPoolModule,
    AuthModule,
    AdminModule,
    AccountModule,
  ],
})
export class AppModule {}
