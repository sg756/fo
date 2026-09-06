/**
 * EVM 充值链配置
 * 一期默认只启用主链 ARB（低手续费）；完整链表保留便于扩展。
 *
 * 环境变量:
 * - DEPOSIT_PRIMARY_CHAIN=ARB|BASE|ETH  （注册默认建哪条）
 * - DEPOSIT_ENABLED_CHAINS=ARB          （逗号分隔；空则仅主链）
 *   以后加网示例: DEPOSIT_ENABLED_CHAINS=ARB,BASE
 * - DEPOSIT_SCAN_MS=90000               （正常扫块间隔，默认 90s）
 * - DEPOSIT_BAN_BACKOFF_MS              （可选：无响应头时 RPC 兜底）
 * - DEPOSIT_BAN_BACKOFF_MAX_MS=1800000  （退避上限，默认 30min）
 */

export type DepositChain = 'ETH' | 'ARB' | 'BASE';

export type ChainConfig = {
  chain: DepositChain;
  name: string;
  /** USDT 合约地址 */
  usdt: string;
  /** USDT 精度 */
  decimals: number;
  /** 默认公共 RPC (生产请换成自己的) */
  defaultRpc: string;
  /** 入账所需确认数 */
  confirmations: number;
  envRpcKey: string;
};

export const DEPOSIT_CHAINS: Record<DepositChain, ChainConfig> = {
  ARB: {
    chain: 'ARB',
    name: 'Arbitrum One',
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    decimals: 6,
    defaultRpc: 'https://arb1.arbitrum.io/rpc',
    confirmations: 12,
    envRpcKey: 'CHAIN_ARB_RPC',
  },
  BASE: {
    chain: 'BASE',
    name: 'Base',
    usdt: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    decimals: 6,
    defaultRpc: 'https://mainnet.base.org',
    confirmations: 12,
    envRpcKey: 'CHAIN_BASE_RPC',
  },
  ETH: {
    chain: 'ETH',
    name: 'Ethereum',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    defaultRpc: 'https://ethereum.publicnode.com',
    confirmations: 12,
    envRpcKey: 'CHAIN_ETH_RPC',
  },
};

/** ERC20 Transfer(address,address,uint256) */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export function getRpcUrl(cfg: ChainConfig): string {
  return process.env[cfg.envRpcKey] || cfg.defaultRpc;
}

/** 已废弃：平台不再设最低充值门槛；交易所侧最小提币额由用户自行注意 */
export function getMinDepositAmount(): number {
  return 0;
}

export function isScanEnabled(): boolean {
  return (process.env.DEPOSIT_SCAN_ENABLED || 'true').toLowerCase() !== 'false';
}

export function getPrimaryChain(): DepositChain {
  const v = (process.env.DEPOSIT_PRIMARY_CHAIN || 'ARB').toUpperCase();
  if (v === 'ETH' || v === 'ARB' || v === 'BASE') return v;
  return 'ARB';
}

/** 当前对外开放的充值/扫描链（默认仅主链，便于以后加网） */
export function getEnabledDepositChains(): DepositChain[] {
  const raw = (process.env.DEPOSIT_ENABLED_CHAINS || '').trim();
  const primary = getPrimaryChain();
  if (!raw) return [primary];
  const list = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is DepositChain => s === 'ETH' || s === 'ARB' || s === 'BASE');
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : [primary];
}

export function isDepositChainEnabled(chain: string): boolean {
  const c = chain.toUpperCase();
  return getEnabledDepositChains().some((x) => x === c);
}

/** 解析用户请求的链：未启用则回落到主链 */
export function resolveDepositChain(chain?: string): DepositChain {
  const primary = getPrimaryChain();
  if (!chain?.trim()) return primary;
  const c = chain.trim().toUpperCase();
  if ((c === 'ETH' || c === 'ARB' || c === 'BASE') && isDepositChainEnabled(c)) return c;
  return primary;
}

export function depositNetworkOptions() {
  return getEnabledDepositChains().map((chain) => ({
    chain,
    name: DEPOSIT_CHAINS[chain].name,
    label: `USDT · ${DEPOSIT_CHAINS[chain].name}`,
    token: 'USDT' as const,
  }));
}
