import { useCallback, useEffect, useState } from 'react';
import { toast } from '../components/Toast';

/** 归集相关「刷新余额」共用冷却，避免连点打 RPC */
export const CHAIN_BALANCE_REFRESH_KEY = 'admin.chainBalanceRefreshAt';
export const CHAIN_BALANCE_REFRESH_MS = 30_000;

/** 进页自动拉余额被服务端限流时不弹 toast（切菜单不打扰） */
export function isOnChainRateLimitError(e: unknown) {
  const msg = String((e as any)?.message || e || '');
  return /链上查询过于频繁/.test(msg);
}

export function useRefreshCooldown(
  storageKey = CHAIN_BALANCE_REFRESH_KEY,
  intervalMs = CHAIN_BALANCE_REFRESH_MS,
) {
  const remainingSec = useCallback(() => {
    try {
      const at = Number(sessionStorage.getItem(storageKey) || 0);
      if (!at) return 0;
      return Math.max(0, Math.ceil((at + intervalMs - Date.now()) / 1000));
    } catch {
      return 0;
    }
  }, [storageKey, intervalMs]);

  const [left, setLeft] = useState(0);

  useEffect(() => {
    setLeft(remainingSec());
    const t = window.setInterval(() => setLeft(remainingSec()), 500);
    return () => window.clearInterval(t);
  }, [remainingSec]);

  const tryStart = useCallback(() => {
    const s = remainingSec();
    if (s > 0) {
      toast(`刷新过于频繁，请 ${s} 秒后再试`, 'err');
      setLeft(s);
      return false;
    }
    try {
      sessionStorage.setItem(storageKey, String(Date.now()));
    } catch {
      /* ignore */
    }
    setLeft(Math.ceil(intervalMs / 1000));
    return true;
  }, [remainingSec, storageKey, intervalMs]);

  return { cooling: left > 0, left, tryStart };
}
