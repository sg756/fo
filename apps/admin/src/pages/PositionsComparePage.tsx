import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApi } from '../api';
import { ListLoading } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { SearchSelect } from '../components/SearchSelect';
import { usePager } from '../hooks/usePager';
import {
  useMiddlewareAccounts,
  useUserOptions,
  marketPeriodLabel,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'];

const MATCH_OPTS = [
  { value: 'all', label: '全部对齐' },
  { value: 'both', label: '两边都有' },
  { value: 'local_only', label: '我们有、账户没有' },
  { value: 'live_only', label: '账户有、我们没有' },
] as const;

function fmtNum(v: unknown, digits = 6) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const p = n * 100;
  const s = `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
  return s;
}

function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString();
}

function userLabel(u?: { userNo?: number | null; nickname?: string | null; email?: string } | null) {
  if (!u) return '—';
  const name = u.nickname || u.email || '—';
  return u.userNo != null ? `${name}（#${u.userNo}）` : name;
}

function matchBadge(m: string) {
  if (m === 'both') return <span className="badge ok">两边都有</span>;
  if (m === 'local_only') return <span className="badge warn">仅本地</span>;
  if (m === 'live_only') return <span className="badge danger">仅账户</span>;
  return <span className="badge">{m}</span>;
}

/** 账户列表持仓（中间件 Positions）vs 本地 user_positions 只读对比 */
export function PositionsComparePage() {
  const mwAccounts = useMiddlewareAccounts();
  const [accountGid, setAccountGid] = useState('');
  const [exchange, setExchange] = useState('');
  const [coinName, setCoinName] = useState('');
  const [match, setMatch] = useState('all');
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [applied, setApplied] = useState({
    accountGid: '',
    exchange: '',
    coinName: '',
    match: 'all',
    q: '',
    userId: '',
  });
  const [rows, setRows] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [signalError, setSignalError] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const pager = usePager(50);
  const userOpts = useUserOptions(userText, userId);

  useEffect(() => {
    if (!accountGid && mwAccounts.length) {
      setAccountGid(mwAccounts[0].gid);
    }
  }, [mwAccounts, accountGid]);

  const load = useCallback(async () => {
    if (!applied.accountGid) {
      setRows([]);
      setSummary(null);
      setSignalError('');
      pager.setTotal(0);
      return;
    }
    setLoading(true);
    setErr('');
    setSignalError('');
    try {
      const res = await AdminApi.positionsCompare({
        accountGid: applied.accountGid,
        match: applied.match !== 'all' ? applied.match : undefined,
        exchange: applied.exchange || undefined,
        coinName: applied.coinName || undefined,
        userId: applied.userId || undefined,
        q: !applied.userId && applied.q ? applied.q : undefined,
      });
      const items = Array.isArray(res.items) ? res.items : [];
      setRows(items);
      setSummary(res.summary || null);
      setSignalError(res.signalError || '');
      pager.setTotal(items.length);
      pager.goFirst();
    } catch (e: any) {
      setErr(e.message || '查询失败');
      setRows([]);
      setSummary(null);
      pager.setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  function search() {
    if (!accountGid) {
      setErr('请选择中间件主账户');
      return;
    }
    setApplied({
      accountGid,
      exchange,
      coinName: coinName.trim().toUpperCase(),
      match,
      q: userText.trim(),
      userId,
    });
  }

  function resetFilters() {
    setExchange('');
    setCoinName('');
    setMatch('all');
    setUserText('');
    setUserId('');
    setApplied({
      accountGid,
      exchange: '',
      coinName: '',
      match: 'all',
      q: '',
      userId: '',
    });
  }

  const pageRows = useMemo(
    () => rows.slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize),
    [rows, pager.page, pager.pageSize],
  );

  return (
    <div className="page-list">
      <p className="hint" style={{ marginTop: 0 }}>
        对比「账户列表」主账户实时持仓与本地跟单持仓。按币 / 周期 / 方向对齐；预期数量 =
        账户数量 × 开仓比例（投入本金 / 模板基准本金）。只读，不自动平仓。
      </p>
      {err ? <p className="err">{err}</p> : null}
      {signalError ? <p className="err">拉取账户持仓失败：{signalError}</p> : null}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>主账户</label>
          <select
            value={accountGid}
            onChange={(e) => setAccountGid(e.target.value)}
            style={{ maxWidth: 260 }}
            title="中间件 MultiAccountList"
          >
            <option value="">请选择</option>
            {mwAccounts.map((a) => (
              <option key={a.gid} value={a.gid}>
                {a.name ? `${a.name}` : a.gid}
              </option>
            ))}
          </select>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>对齐</label>
          <select value={match} onChange={(e) => setMatch(e.target.value)}>
            {MATCH_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select value={exchange} onChange={(e) => setExchange(e.target.value)}>
            <option value="">全部交易所</option>
            {EXCHANGES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <input
            value={coinName}
            onChange={(e) => setCoinName(e.target.value)}
            placeholder="币名"
            style={{ width: 100 }}
          />
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>用户</label>
          <SearchSelect
            text={userText}
            onTextChange={(t) => {
              setUserText(t);
              if (userId) setUserId('');
            }}
            value={userId}
            onSelect={(o) => setUserId(o?.value || '')}
            options={userOpts.options}
            loading={userOpts.loading}
            remote
            placeholder={USER_FILTER_PLACEHOLDER}
            width={200}
            emptyHint={USER_FILTER_EMPTY_HINT}
          />
          <button type="button" onClick={search} disabled={loading || !accountGid}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button type="button" className="ghost" onClick={resetFilters} disabled={loading}>
            重置
          </button>
          <button type="button" className="ghost" onClick={() => void load()} disabled={loading || !applied.accountGid}>
            刷新
          </button>
        </div>
      </div>

      {summary ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <span className="badge ok">两边都有 {summary.both ?? 0}</span>
          <span className="badge warn">仅本地 {summary.localOnly ?? 0}</span>
          <span className="badge danger">仅账户 {summary.liveOnly ?? 0}</span>
          <span className="badge">账户品种 {summary.signalRows ?? 0}</span>
          <span className="badge">本地行 {summary.localRows ?? 0}</span>
        </div>
      ) : null}

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="对比中…" />
        <div className="table-scroll">
          <table className="positions-compare-table">
            <thead>
              <tr>
                <th style={{ width: 88 }}>对齐</th>
                <th style={{ width: 140 }}>用户</th>
                <th style={{ width: 88 }}>交易所</th>
                <th style={{ width: 72 }}>币</th>
                <th style={{ width: 88 }}>类型</th>
                <th style={{ width: 56 }}>方向</th>
                <th style={{ width: 96 }}>账户数量</th>
                <th style={{ width: 96 }}>本地数量</th>
                <th style={{ width: 88 }}>开仓比例</th>
                <th style={{ width: 96 }}>应按数量</th>
                <th style={{ width: 88 }}>差额</th>
                <th style={{ width: 72 }}>偏差</th>
                <th style={{ width: 160 }}>本地开仓时间</th>
              </tr>
            </thead>
            <tbody>
              {!loading && pageRows.length === 0 ? (
                <tr>
                  <td colSpan={13} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted)' }}>
                    {applied.accountGid ? '无对比结果' : '请选择主账户后查询'}
                  </td>
                </tr>
              ) : (
                pageRows.map((r, i) => (
                  <tr key={r.localId || `${r.match}-${r.coinName}-${r.side}-${r.userId || i}`}>
                    <td>{matchBadge(r.match)}</td>
                    <td style={{ fontSize: 12 }} title={r.user?.email || undefined}>
                      {userLabel(r.user)}
                    </td>
                    <td>{r.exchange || '—'}</td>
                    <td className="nowrap">{r.coinName}</td>
                    <td>{marketPeriodLabel({ equalCoinName: r.equalCoinName })}</td>
                    <td>
                      <span
                        className="badge"
                        style={{ color: r.side === 'short' ? '#dc2626' : '#16a34a' }}
                      >
                        {r.side === 'short' ? '空' : '多'}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace' }}>{fmtNum(r.signalSize)}</td>
                    <td style={{ fontFamily: 'monospace' }}>{fmtNum(r.localQty)}</td>
                    <td style={{ fontFamily: 'monospace' }}>
                      {r.openRatio != null && Number.isFinite(r.openRatio)
                        ? `×${Number(r.openRatio).toFixed(4)}`
                        : '—'}
                    </td>
                    <td style={{ fontFamily: 'monospace' }}>{fmtNum(r.expectedQty)}</td>
                    <td
                      style={{
                        fontFamily: 'monospace',
                        color:
                          r.diffQty != null && Math.abs(Number(r.diffQty)) > 1e-8
                            ? '#b45309'
                            : undefined,
                      }}
                    >
                      {fmtNum(r.diffQty)}
                    </td>
                    <td style={{ fontFamily: 'monospace' }}>{fmtPct(r.diffPct)}</td>
                    <td style={{ fontSize: 12 }}>{fmtTime(r.openTime)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[20, 50, 100]}
          disabled={loading}
          onChange={(p, s) => pager.onPageChange(p, s)}
        />
      </div>
    </div>
  );
}
