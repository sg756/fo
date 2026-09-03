import { useEffect, useState } from 'react';
import { AdminApi } from '../api';
import type { SearchSelectOption } from '../components/SearchSelect';

/** 用户筛选框文案（内部仍支持邮箱检索，界面不提示邮箱） */
export const USER_FILTER_PLACEHOLDER = '用户ID或昵称';
export const USER_FILTER_EMPTY_HINT = '输入用户ID或昵称';

/** 市场类型（原信号 equalCoin / accountType） */
export const MARKET_PERIOD_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'spot', label: '现货' },
  { value: 'perpetual', label: '永续合约' },
  { value: 'delivery', label: '交割合约' },
] as const;

const SPOT_QUOTES = new Set([
  'U',
  'USDT',
  'USDC',
  'USD',
  'BTC',
  'ETH',
  'EUR',
  'FDUSD',
  'DAI',
  'TUSD',
]);

/** 列表展示：现货 / 永续合约 / 交割合约 */
export function marketPeriodLabel(row: {
  accountType?: string | null;
  equalCoinName?: string | null;
}): string {
  const at = String(row.accountType || '').toLowerCase();
  const eq = String(row.equalCoinName || '').toUpperCase();
  if (at === 'spot' || SPOT_QUOTES.has(eq)) return '现货';
  if (eq === 'PC') return '永续合约';
  if (at === 'future' || at === 'futures' || at === 'swap' || at === 'perp') {
    return eq ? `交割合约(${eq})` : '交割合约';
  }
  return row.accountType || '—';
}

export function useCoinOptions() {
  const [options, setOptions] = useState<SearchSelectOption[]>([]);
  useEffect(() => {
    AdminApi.middlewareSymbols()
      .then((r) => {
        const seen = new Set<string>();
        const opts: SearchSelectOption[] = [];
        for (const s of r.items || []) {
          const coin = String(s.coinName || '')
            .trim()
            .toUpperCase();
          if (!coin || seen.has(coin)) continue;
          seen.add(coin);
          opts.push({ value: coin, label: coin });
        }
        opts.sort((a, b) => a.label.localeCompare(b.label));
        setOptions(opts);
      })
      .catch(() => undefined);
  }, []);
  return options;
}

export function useUserOptions(text: string, selectedId: string) {
  const [options, setOptions] = useState<SearchSelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const kw = text.trim();
    if (!kw || selectedId) {
      if (!kw) setOptions([]);
      return;
    }
    const t = window.setTimeout(() => {
      setLoading(true);
      AdminApi.users({ q: kw, take: 20 })
        .then((r) => {
          setOptions(
            (r.items || []).map((u: any) => ({
              value: u.id,
              label: u.nickname || u.email || u.id,
              sub: [
                u.userNo != null ? `#${u.userNo}` : null,
                u.pointCard?.balance != null ? `余额 ${u.pointCard.balance}` : null,
                u.email,
              ]
                .filter(Boolean)
                .join(' · '),
            })),
          );
        })
        .catch(() => setOptions([]))
        .finally(() => setLoading(false));
    }, 280);
    return () => window.clearTimeout(t);
  }, [text, selectedId]);
  return { options, loading };
}

export type MiddlewareAccount = { gid: string; name: string };

/** 中间件 MultiAccountList */
export function useMiddlewareAccounts() {
  const [accounts, setAccounts] = useState<MiddlewareAccount[]>([]);
  useEffect(() => {
    AdminApi.middlewareAccounts()
      .then((r) => {
        const list = (r.items || [])
          .map((a: any) => ({
            gid: String(a.value ?? a.gid ?? '').trim(),
            name: String(a.name || '').trim(),
          }))
          .filter((a: MiddlewareAccount) => !!a.gid);
        setAccounts(list);
      })
      .catch(() => setAccounts([]));
  }, []);
  return accounts;
}

/** 挂单归属主账户展示 */
export function accountGidLabel(
  row: { accountGid?: string | null; accountName?: string | null },
  accounts?: MiddlewareAccount[],
): string {
  const gid = String(row.accountGid || '').trim();
  if (!gid) return '—';
  const name =
    row.accountName ||
    accounts?.find((a) => a.gid === gid)?.name ||
    '';
  if (name && name !== gid) return `${name}`;
  return gid.length > 12 ? `${gid.slice(0, 8)}…` : gid;
}

export function accountGidTitle(row: {
  accountGid?: string | null;
  accountName?: string | null;
}): string {
  const gid = String(row.accountGid || '').trim();
  if (!gid) return '';
  return row.accountName ? `${row.accountName}\n${gid}` : gid;
}
