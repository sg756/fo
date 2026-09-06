import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApi } from '../api';

type SignalRow = {
  orderGID: string;
  accountGID: string;
  accountName?: string | null;
  exchange: string;
  apiCode: string;
  coinName: string;
  equalCoinName: string;
  symbol: string;
  accountType: string;
  isOpen: boolean;
  orderSide: string;
  positionSide: string;
  price?: string | number;
  amount: string | number;
  signalAt: number | null;
  /** 本地：刚出现的信号高亮一段时间 */
  isNew?: boolean;
};

const POLL_MS = 2000;
const TICK_MS = 100;
const NEW_HIGHLIGHT_MS = 8000;
const MAX_ROWS = 200;
const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'];

function fingerprint(s: SignalRow) {
  return `${s.orderGID}|${s.price}|${s.amount}|${s.orderSide}|${s.signalAt}`;
}

function formatRemain(ms: number): string {
  if (ms <= 0) return '已过期';
  const total = Math.floor(ms);
  const sec = Math.floor(total / 1000);
  const remMs = total % 1000;
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}.${String(remMs).padStart(3, '0')}`;
  }
  return `${sec}.${String(remMs).padStart(3, '0')}s`;
}

function symbolBlob(s: SignalRow) {
  return `${s.symbol || ''} ${s.coinName || ''} ${s.equalCoinName || ''} ${s.apiCode || ''}`.toUpperCase();
}

const SPOT_QUOTES = new Set(['U', 'USDT', 'USDC', 'USD', 'BTC', 'ETH', 'EUR', 'FDUSD', 'DAI', 'TUSD']);

/** equalCoin：永续(PC) / USDT / 交割(CQ) 等 */
function equalCoinDisplay(equalCoinName?: string | null): string {
  const eq = String(equalCoinName || '').trim().toUpperCase();
  if (!eq) return '—';
  if (eq === 'PC') return `永续(${eq})`;
  if (SPOT_QUOTES.has(eq)) return eq;
  return `交割(${eq})`;
}

export function TradeSignalsPage() {
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [now, setNow] = useState(() => Date.now());
  const [polledAt, setPolledAt] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [exchangeFilter, setExchangeFilter] = useState('');
  const [symbolFilter, setSymbolFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [signalFilter, setSignalFilter] = useState(''); // open | close | long | short | ''
  const [err, setErr] = useState('');
  const [hint, setHint] = useState('');
  const [newCount, setNewCount] = useState(0);
  const [polling, setPolling] = useState(false);

  const knownFp = useRef<Map<string, string>>(new Map());
  const highlightTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlight = useRef(false);
  const pendingManual = useRef(false);
  const primed = useRef(false);

  const clearHighlight = useCallback((key: string) => {
    const t = highlightTimers.current.get(key);
    if (t) clearTimeout(t);
    highlightTimers.current.delete(key);
    setRows((prev) => prev.map((r) => (r.orderGID === key ? { ...r, isNew: false } : r)));
  }, []);

  const markNew = useCallback(
    (key: string) => {
      const prev = highlightTimers.current.get(key);
      if (prev) clearTimeout(prev);
      highlightTimers.current.set(
        key,
        setTimeout(() => clearHighlight(key), NEW_HIGHLIGHT_MS),
      );
    },
    [clearHighlight],
  );

  const mergeSignals = useCallback(
    (incoming: SignalRow[]) => {
      const nextFp = new Map<string, string>();
      let added = 0;

      setRows((prev) => {
        const prevMap = new Map(prev.map((r) => [r.orderGID, r]));
        const merged: SignalRow[] = [];

        for (const s of incoming) {
          const fp = fingerprint(s);
          nextFp.set(s.orderGID, fp);
          const old = prevMap.get(s.orderGID);
          const wasKnown = knownFp.current.has(s.orderGID);

          if (!wasKnown) {
            if (primed.current) {
              added++;
              markNew(s.orderGID);
              merged.push({ ...s, isNew: true });
            } else {
              merged.push({ ...s, isNew: false });
            }
          } else {
            merged.push({
              ...(old || s),
              ...s,
              isNew: old?.isNew,
            });
          }
        }

        merged.sort((a, b) => (b.signalAt || 0) - (a.signalAt || 0));
        return merged.slice(0, MAX_ROWS);
      });

      knownFp.current = nextFp;
      primed.current = true;
      if (added > 0) setNewCount(added);
    },
    [markNew],
  );

  const poll = useCallback(async (source: 'auto' | 'manual' | 'mount' = 'auto') => {
    if (source === 'manual') setPolling(true);
    if (inFlight.current) {
      // 自动轮询进行中时点「立即拉取」：立刻显示拉取中，当前请求结束后再补拉一次
      if (source === 'manual') pendingManual.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const r = await AdminApi.followerSignals();
      setPolledAt(r.polledAt);
      if (typeof r.signalTimeoutMs === 'number' && r.signalTimeoutMs >= 100) {
        setTimeoutMs(r.signalTimeoutMs);
      }
      if (!r.ok) {
        setErr(r.message || '拉取失败');
      } else {
        setErr('');
        setHint(r.message || '');
        mergeSignals(r.items || []);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      inFlight.current = false;
      if (pendingManual.current) {
        pendingManual.current = false;
        void poll('manual');
        return;
      }
      setPolling(false);
    }
  }, [mergeSignals]);

  useEffect(() => {
    void poll('mount');
  }, [poll]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void poll('auto'), POLL_MS);
    return () => clearInterval(id);
  }, [auto, poll]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      highlightTimers.current.forEach((t) => clearTimeout(t));
      highlightTimers.current.clear();
    };
  }, []);

  const accountOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      const gid = String(r.accountGID || '').trim();
      if (!gid || map.has(gid)) continue;
      map.set(gid, r.accountName?.trim() || gid);
    }
    return [...map.entries()]
      .map(([gid, name]) => ({ gid, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [rows]);

  const symbolOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const sym = String(r.symbol || '').trim();
      const coin = String(r.coinName || '').trim().toUpperCase();
      if (sym) set.add(sym);
      else if (coin) set.add(coin);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [rows]);

  const visibleRows = useMemo(() => {
    const symKw = symbolFilter.trim().toUpperCase();
    return rows.filter((r) => {
      if (exchangeFilter && r.exchange !== exchangeFilter) return false;
      if (accountFilter && r.accountGID !== accountFilter) return false;
      if (symKw) {
        const blob = symbolBlob(r);
        if (!blob.includes(symKw) && r.symbol !== symbolFilter && r.coinName?.toUpperCase() !== symKw) {
          return false;
        }
      }
      if (signalFilter === 'open' && !r.isOpen) return false;
      if (signalFilter === 'close' && r.isOpen) return false;
      if (signalFilter === 'long') {
        const side = String(r.positionSide || r.orderSide || '').toLowerCase();
        if (!(side.includes('long') || side === '多' || side === '1')) return false;
      }
      if (signalFilter === 'short') {
        const side = String(r.positionSide || r.orderSide || '').toLowerCase();
        if (!(side.includes('short') || side === '空' || side === '2')) return false;
      }
      return true;
    });
  }, [rows, exchangeFilter, accountFilter, symbolFilter, signalFilter]);

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {hint ? <p className="hint">{hint}</p> : null}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="hint">
            直拉展示（账号列表内；跟单按模板绑定账户，门槛不足记失败流水）
          </span>
          <span className="hint">
            {polledAt ? `最近拉取 ${new Date(polledAt).toLocaleTimeString()}` : '尚未拉取'}
            {polling ? ' · 拉取中' : ''}
            {newCount > 0 ? ` · 本批新增 ${newCount}` : ''}
            {' · '}显示 {visibleRows.length}/{rows.length}
          </span>
          <select
            value={exchangeFilter}
            onChange={(e) => setExchangeFilter(e.target.value)}
            style={{ marginLeft: 'auto' }}
          >
            <option value="">全部交易所</option>
            {EXCHANGES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            title="按中间件账号列表中的账户过滤"
          >
            <option value="">全部账户</option>
            {accountOptions.map((a) => (
              <option key={a.gid} value={a.gid}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            list="signal-symbol-options"
            placeholder="币对过滤"
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
            style={{ width: 140 }}
            title="按交易对 / 币名过滤"
          />
          <datalist id="signal-symbol-options">
            {symbolOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <select
            value={signalFilter}
            onChange={(e) => setSignalFilter(e.target.value)}
            title="按开平 / 多空过滤"
          >
            <option value="">全部信号</option>
            <option value="open">仅开仓</option>
            <option value="close">仅平仓</option>
            <option value="long">仅多</option>
            <option value="short">仅空</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            自动刷新
          </label>
          <button className="ghost" onClick={() => void poll('manual')} disabled={polling}>
            {polling ? '拉取中…' : '立即拉取'}
          </button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>时间</th>
              <th>剩余</th>
              <th>账户名</th>
              <th>交易所</th>
              <th>币名</th>
              <th>计价/周期</th>
              <th>账户类型</th>
              <th>方向</th>
              <th>开平</th>
              <th>价格</th>
              <th>数量</th>
              <th>订单ID</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((s) => {
              const remain =
                s.signalAt == null ? null : timeoutMs - (now - s.signalAt);
              const expired = remain != null && remain <= 0;
              return (
                <tr
                  key={s.orderGID}
                  style={
                    s.isNew
                      ? { background: 'rgba(46, 160, 67, 0.18)' }
                      : expired
                        ? { opacity: 0.55 }
                        : undefined
                  }
                >
                  <td>{s.isNew ? '新' : ''}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                    {s.signalAt ? new Date(s.signalAt).toLocaleString() : '—'}
                  </td>
                  <td
                    style={{
                      whiteSpace: 'nowrap',
                      fontFamily: 'monospace',
                      fontSize: 12,
                      color: expired ? 'var(--err, #c62828)' : undefined,
                    }}
                  >
                    {remain == null ? '—' : formatRemain(remain)}
                  </td>
                  <td title={s.accountGID || ''}>
                    {s.accountName || s.accountGID || '—'}
                  </td>
                  <td>
                    {s.exchange}
                    <span className="hint"> / {s.apiCode}</span>
                  </td>
                  <td title={s.symbol || ''}>{s.coinName || s.symbol?.split('/')[0] || '—'}</td>
                  <td title={s.equalCoinName || ''}>{equalCoinDisplay(s.equalCoinName)}</td>
                  <td>{s.accountType || '—'}</td>
                  <td>{s.positionSide}</td>
                  <td>{s.isOpen ? '开' : '平'}</td>
                  <td style={{ fontFamily: 'monospace' }}>{s.price ?? '—'}</td>
                  <td style={{ fontFamily: 'monospace' }}>{s.amount}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{s.orderGID}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visibleRows.length === 0 ? (
          <p className="hint list-empty">暂无信号</p>
        ) : null}
      </div>
    </div>
  );
}
