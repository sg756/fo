/**
 * 开仓余额/保证金不足：只认中间件透传进 orderID 的英文句子。
 * 币安 USDC 永续实盘回包是「错误: Margin is insufficient.」，没有 -2019。
 * 其它所用各所下单失败文案里那一句，数字码不参与判断。
 * 只用于开仓失败。平仓、超时、张数、价格、只减仓不在这里。
 */

export const INSUFFICIENT_BALANCE_TEXT: Record<string, readonly string[]> = {
  /** 合约实盘已见 Margin is insufficient。现货是另一句。 */
  BINANCE: [
    'margin is insufficient',
    'account has insufficient balance for requested action',
  ],
  /** 币种会变：Insufficient USDT balance in account / Insufficient BTC margin in account */
  OKX: ['balance in account', 'margin in account'],
  /** 经典合约 balance not enough；经典现货 / 统一账户 Insufficient balance、Insufficient margin */
  BITGET: ['balance not enough', 'insufficient balance', 'insufficient margin'],
  BYBIT: [
    'wallet balance is insufficient',
    'available balance is insufficient',
    'insufficient available balance',
    'available margin is insufficient',
    'balance insufficient',
    'insufficient account balance',
    'unable to cover the position margin',
  ],
  /** 标签或文案。划转那条 FUTURES_BALANCE_NOT_ENOUGH 不在这里。 */
  GATE: [
    'balance_not_enough',
    'margin_balance_not_enough',
    'insufficient_available',
    'balance is not enough',
  ],
  /** USDT 合约原文 Insufficient margin available. 现货字符串错误码未核对，不写。 */
  HUOBI: ['insufficient margin available'],
  KUCOIN: [
    'balance insufficient',
    'balance not enough',
    'insufficient available margin',
    'account.available.amount',
  ],
  HYPERLIQUID: ['insufficient margin to place order'],
  HASHKEY: ['insufficient asset', 'insufficient balance to submit the order'],
  /** 与币安合约同一句。不认 Balance is insufficient。 */
  ASTER: ['margin is insufficient'],
  LIGHTER: ['not enough margin to create the order'],
};

/** 这些句子不是「没钱开仓」，即使带了 insufficient 也不挡。 */
const NOT_OPEN_BALANCE = [
  'reduce only',
  'reduceonly',
  'notional must',
  'position is not sufficient',
  'not enough open position',
  'not enough position',
  'insufficient liquidity',
  'insufficient position',
  'max open size',
  'greater than the max open',
  'exceed margin tier',
  'leverage',
  'withdraw',
];

function normalizeReason(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 开仓失败原文是否为余额或保证金不足。
 * 平仓一律否。未列入的交易所（如 Backpack）一律否。
 */
export function isInsufficientOpenBalance(
  exchange: string,
  text: string,
  isOpen = true,
): boolean {
  if (isOpen === false) return false;
  const normalized = normalizeReason(text);
  if (!normalized) return false;
  if (NOT_OPEN_BALANCE.some((phrase) => normalized.includes(phrase))) return false;

  const id = String(exchange || '').trim().toUpperCase();
  const phrases = INSUFFICIENT_BALANCE_TEXT[id];
  if (!phrases) return false;

  const hit = phrases.some((phrase) => normalized.includes(phrase));
  // 欧易币种不固定，必须同时有 insufficient，避免单独的 balance in account。
  if (id === 'OKX') return hit && normalized.includes('insufficient');
  return hit;
}
