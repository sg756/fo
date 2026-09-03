import { Controller, Get, Query } from '@nestjs/common';
import { MarketService } from './market.service';

/** 行情只读接口 — App 从本服务取, 不直连公网交易所 */
@Controller('market')
export class MarketController {
  constructor(private market: MarketService) {}

  @Get('tickers')
  tickers(@Query('tab') tab?: string, @Query('q') q?: string) {
    return this.market.list(tab, q);
  }

  @Get('refresh')
  async refresh() {
    await this.market.refresh();
    return this.market.list();
  }
}
