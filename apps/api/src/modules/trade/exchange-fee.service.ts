import { Injectable } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { defaultFeeForFill } from './trade-fee.util';

/** 只按各所公开默认档计算，不请求交易所费率接口。 */
@Injectable()
export class ExchangeFeeService {
  feeForFill(params: {
    exchange: Exchange;
    filledAmt: number;
    priceAvg: number;
    accountType?: string | null;
    equalCoinName?: string | null;
    orderType?: string | null;
    followMode?: string | null;
  }): number {
    return defaultFeeForFill(params);
  }
}
