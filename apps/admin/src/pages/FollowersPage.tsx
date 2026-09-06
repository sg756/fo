import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminApi } from '../api';
import { ListLoading } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { SearchSelect } from '../components/SearchSelect';
import { usePager } from '../hooks/usePager';
import {
  useUserOptions,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'];

function readyOnlyFromUrl(raw: string | null | undefined) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no') return false;
  if (s === '1' || s === 'true' || s === 'yes') return true;
  return true;
}

function fmtRatio(r: number | null | undefined) {
  if (r == null || !Number.isFinite(r)) return '—';
  return `×${r.toFixed(4)}`;
}

function fmtAmt(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—';
  return String(v);
}

/** 满足 / 接近自动跟单条件的用户 */
export function FollowersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlReadyOnly = readyOnlyFromUrl(searchParams.get('readyOnly'));
  const [rows, setRows] = useState<any[]>([]);
  const [openMin, setOpenMin] = useState(0);
  const [exchange, setExchange] = useState('');
  const [readyOnly, setReadyOnly] = useState(urlReadyOnly);
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [applied, setApplied] = useState({
    exchange: '',
    readyOnly: urlReadyOnly,
    q: '',
    userId: '',
  });
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const pager = usePager(20);
  const userOpts = useUserOptions(userText, userId);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await AdminApi.followers({
        exchange: applied.exchange || undefined,
        readyOnly: applied.readyOnly,
        q: !applied.userId && applied.q ? applied.q : undefined,
        userId: applied.userId || undefined,
      });
      const items = Array.isArray(res.items) ? res.items : [];
      setRows(items);
      setOpenMin(res.openMinPointBalance ?? 0);
      pager.setTotal(items.length);
      pager.goFirst();
    } catch (e: any) {
      setErr(e.message);
      setRows([]);
      pager.setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const next = readyOnlyFromUrl(searchParams.get('readyOnly'));
    setReadyOnly(next);
    setApplied((prev) => (prev.readyOnly === next ? prev : { ...prev, readyOnly: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('readyOnly')]);

  function writeReadyOnlyParam(next: boolean) {
    const p = new URLSearchParams(searchParams);
    if (next) p.delete('readyOnly');
    else p.set('readyOnly', '0');
    setSearchParams(p, { replace: true });
  }

  function search() {
    writeReadyOnlyParam(readyOnly);
    setApplied({
      exchange,
      readyOnly,
      q: userText.trim(),
      userId,
    });
  }

  function resetFilters() {
    writeReadyOnlyParam(true);
    setExchange('');
    setReadyOnly(true);
    setUserText('');
    setUserId('');
    setApplied({ exchange: '', readyOnly: true, q: '', userId: '' });
  }

  const pageRows = rows.slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize);

  return (
    <div className="page-list">
      <p className="hint">
        展示已开启跟单且满足条件的用户（按交易所一行）。默认仅看「可自动跟单」：审核通过、已开始交易、已绑
        Key、已选模板并填写投入本金。开仓另需点卡 ≥ {openMin || 0}。
      </p>
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>用户</label>
          <SearchSelect
            text={userText}
            onTextChange={setUserText}
            value={userId}
            onSelect={(o) => setUserId(o?.value || '')}
            options={userOpts.options}
            loading={userOpts.loading}
            remote
            placeholder={USER_FILTER_PLACEHOLDER}
            width={200}
            emptyHint={USER_FILTER_EMPTY_HINT}
          />
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>交易所</label>
          <select value={exchange} onChange={(e) => setExchange(e.target.value)}>
            <option value="">全部交易所</option>
            {EXCHANGES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={readyOnly}
              onChange={(e) => setReadyOnly(e.target.checked)}
            />
            仅可自动跟单
          </label>
          <button onClick={search} disabled={loading}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button className="ghost" onClick={resetFilters} disabled={loading}>
            重置
          </button>
          <button className="ghost" onClick={() => load()} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="查询中…" />
        <div className="table-scroll">
          <table className="followers-list-table">
            <thead>
              <tr>
                <th style={{ width: 72 }}>用户ID</th>
                <th style={{ width: 100 }}>账号</th>
                <th style={{ width: 180 }}>邮箱</th>
                <th style={{ width: 88 }}>交易所</th>
                <th style={{ width: 140 }}>所选模板</th>
                <th style={{ width: 96 }}>投入本金</th>
                <th style={{ width: 96 }}>基准本金</th>
                <th style={{ width: 88 }}>开仓比例</th>
                <th style={{ width: 88 }}>点卡</th>
                <th style={{ width: 110 }}>开仓</th>
                <th style={{ width: 160 }}>状态</th>
                <th style={{ width: 160 }}>开启时间</th>
                <th style={{ width: 160 }} title="用户最近保存投入本金/模板的时间">
                  数据更新时间
                </th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={`${r.userId}-${r.exchange}`}>
                  <td style={{ fontFamily: 'monospace' }}>
                    {r.userNo != null ? `#${r.userNo}` : '—'}
                  </td>
                  <td>{r.nickname || '—'}</td>
                  <td>{r.email || '—'}</td>
                  <td>{r.exchange}</td>
                  <td>
                    {r.templateName || '—'}
                    {r.templateAccountName ? (
                      <div className="hint" style={{ margin: 0, fontSize: 11 }}>
                        {r.templateAccountName}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ fontFamily: 'monospace' }}>{fmtAmt(r.investAmount)}</td>
                  <td style={{ fontFamily: 'monospace' }}>{fmtAmt(r.maxPrincipal)}</td>
                  <td style={{ fontFamily: 'monospace' }}>{fmtRatio(r.openRatio)}</td>
                  <td style={{ fontFamily: 'monospace' }}>{fmtAmt(r.pointBalance)}</td>
                  <td>
                    <span className={`badge ${r.canOpen ? 'ok' : 'danger'}`}>
                      {r.canOpen ? '可开仓' : '仅平仓/不可'}
                    </span>
                  </td>
                  <td>
                    {r.ready ? (
                      <span className="badge ok">可跟单</span>
                    ) : (
                      <span className="badge danger" title={(r.blockers || []).join('；')}>
                        {(r.blockers || []).join('；') || '未就绪'}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.followStartedAt ? new Date(r.followStartedAt).toLocaleString() : '—'}
                  </td>
                  <td>
                    {r.investUpdatedAt ? new Date(r.investUpdatedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && !loading ? (
          <p className="hint list-empty">暂无符合条件的跟单用户</p>
        ) : null}
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          disabled={loading}
          onChange={(p, s) => pager.onPageChange(p, s)}
        />
      </div>
    </div>
  );
}
