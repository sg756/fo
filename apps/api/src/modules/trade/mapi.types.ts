/**
 * :1820 中间件文档 (devdocs) 定义的结构模型。
 * 字段命名与文档保持一致 (首字母小写), 仅保留与跟单/下单相关的字段。
 */

/** 交易对规范 (mapi/CryptoSymbolList 返回项) */
export interface SymbolPairInfo {
  apiCode: string; // 交易所代码, 如 ba / bac / ok
  apiName: string; // 交易所名称
  coinName: string; // 币名, 如 BTC
  equalCoinName: string; // 计价币名; 合约中表示合约周期(如 PC=永续)
  minAmt: number; // 数量步进+最小量；买入量须为其整数倍。合约上此值=面额
  minSize: number; // 张的可拆单位（如 0.1 张）。不是价格、不是币
  pricePrecision: number; // 价格最多几位小数（展示）。不管委托价是否合法
  priceStep: number; // 价格 tick；委托价必须是它的整数倍
  settleCoin: string; // 结算币名称
  boardLotSize: number; // 每手数量(币)；0 表示使用 minAmt
  marketDataDisabled?: number;
  marginSupport?: boolean;
  superMarginSupport?: boolean;
  pledgeSupport?: boolean;
  symbolLevel?: number;
  vol24H?: number;
  changeRate24H?: number;
  tokenAddress?: string | null;
  createTime?: number;
  // 便于内部匹配 (CryptoSymbolList 原生返回)
  symbolKey?: string; // 如 TAO_U_BA
  symbol?: string; // 如 TAO/U
}

/** 账户 API 配置 (下单/查单/撤单/查资产的 account 字段) */
export interface ApiAccountInfo {
  gid: string; // 账户标识
  apiCode: string; // 交易所代码
  apiName: string; // 交易所名称
  accountName: string; // 账户名称
  apiKey: string;
  apiSecret: string;
  passphrase: string; // 附加口令 (无则空串)
  extendedAttr: string;
  extendedAttr2: string;
  innerExtendedAttr: string;
  createTime: string; // ISO 时间
}

/** 订单实体 (QueryOrder / CancelOrder 的 order 字段) */
export interface OrderRecordInfo {
  gid: string; // 记录标识
  apiBillID: string; // 交易所返回的订单号
  clientBillID: string; // 本地自定义订单号
  ruleOrPositionGID: string; // 策略/仓位标识
  apiCode: string;
  apiName: string;
  accountGID: string;
  accountName: string;
  coinsName: string; // 标的名称
  equalCoinName: string; // 结算币/合约类型
  leverageType: number; // 杠杆倍数, 仅合约有效
  ruleType: number; // 0=现货 1=合约
  positionSide: number; // 0未知 1多头 2空头
  recordType: number; // 0买入 1卖出 2开仓 3平仓 4资金费 5利息
  tradeAmt: number; // 委托数量
  avgPrice: number; // 成交均价
  filledAmt: number; // 成交数量
  tradePrice: number; // 委托价格
  profitsAmt: number; // 盈亏
  profitsPercent: number;
  tradeFee: number;
  status: number; // 0待确定 1部分完成 2全部完成 3撤消
  tradeRemark: string;
  instrumentID: string; // 交易所原生币对名, 如 BTC-USDT（非 ETH/PC）
  isConfirmed: number;
  settleCoin: string;
  updateTime: number;
  createTime: number;
  createTimeMillSeconds: number;
  // status: 0待确定 1部分完成 2全部完成 3撤消订单（CancelOrder 请求须为 3）
}

/** PlaceOrder 请求体 */
export interface PlaceOrderRequest {
  proxyIP: string;
  symbol: SymbolPairInfo;
  account: ApiAccountInfo;
  isOpen: boolean; // 是否开仓
  accountType: string; // spot / margin / super-margin / future
  leverage: number; // 合约杠杆倍数
  coinAmt: number; // 下单币数量
  price: number; // 下单价格
  tradeType: number; // 0=买入 1=卖出
  orderType: number; // 0=限价单 1=市价单
  limitDepthOption: number; // 0 (2=做市单)
  baseQuoteLastPrice: number; // 基于 USD(S) 的价格
}

/** PlaceOrder 响应 data */
export interface PlaceOrderResult {
  instrumentID: string;
  coinAmt: number;
  price: number;
  size: number;
  successed: boolean;
  orderID: string; // successed=false 时存放失败原因
}

/** QueryOrder 响应 data */
export interface QueryOrderResult {
  status: string; // -1已撤销 0未成交 1部分成交 2完全成交 99无状态 ""错误
  filledAmt: number;
  priceAvg: number;
  tradeFee: number;
  errorMsg: string;
}

/**
 * mapi/QueryPosition 回包 data（整户快照，入参与 QueryBalance 相同，不带 symbol）。
 * 文档示例不一定有保证金字段；margin 为 0 / 缺省时不要覆盖本地计算保证金。
 */
export interface QueryPositionItem {
  symbol?: string;
  coinName?: string;
  equalCoinName?: string;
  openPrice?: number | string;
  positionAmt?: number | string;
  liquidationPrice?: number | string;
  risk?: number | string;
  holdType?: number | string;
  holdTypeName?: string;
  positionSide?: string;
  accountType?: string;
  /** 部分实现会回 isolatedMargin / initialMargin / margin */
  margin?: number | string;
  isolatedMargin?: number | string;
  initialMargin?: number | string;
  positionInitialMargin?: number | string;
  leverage?: number | string;
}

export interface QueryPositionResult {
  positions?: QueryPositionItem[];
  errorMsg?: string;
}

/** CancelOrder 响应 data */
export interface CancelOrderResult {
  successed: boolean;
  errorMsg: string;
}

/** 账户资产 */
export interface CoinAssetInfo {
  apiCode: string;
  apiName: string;
  accountGID: string;
  accountName: string;
  accountType: string;
  coinName: string;
  symbolName: string;
  free: number;
  locked: number;
  interest: number;
  borrowed: number;
  net: number;
  disabled?: boolean;
  updateTime?: number;
}

/** 文档订单状态码 → 内部成交状态 */
export function mapDocStatus(
  status: string | number,
): 'open' | 'partial' | 'filled' | 'cancelled' | 'unknown' {
  const s = String(status).trim();
  switch (s) {
    case '2':
      return 'filled';
    case '1':
      return 'partial';
    case '0':
      return 'open';
    case '-1':
      return 'cancelled';
    case '99':
    case '':
    default:
      return 'unknown';
  }
}
