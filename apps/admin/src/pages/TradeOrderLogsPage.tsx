import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { DraggableFloatPanel } from '../components/DraggableFloatPanel';
import { ListLoading } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { SearchSelect } from '../components/SearchSelect';
import { toast } from '../components/Toast';
import { CopyMonoCell } from '../components/CopyMonoCell';
import { normalizePaged, usePager } from '../hooks/usePager';
import { useCoinOptions, useUserOptions, useMiddlewareAccounts, MARKET_PERIOD_OPTIONS, marketPeriodLabel, accountGidLabel, accountGidTitle, USER_FILTER_PLACEHOLDER, USER_FILTER_EMPTY_HINT } from '../hooks/useSearchFilterOptions';

const STATUS_LABEL: Record<string, string> = {
  PENDING: '准备中',
  PLACED: '挂单中',
  FILLED: '已成交',
  CANCELLED: '已撤单',
  CANCEL_FAILED: '撤单失败',
  FAILED: '开仓/下单失败',
};

function failReasonOf(r: any): string {
  const msg = String(r.errorMsg || r.cancelMsg || '').trim();
  return msg || '—';
}

function statusLabelOf(r: any): string {
  if (r.status === 'FAILED') {
    if (r.isOpen === true) return '开仓失败';
    if (r.isOpen === false) return '平仓失败';
    return '下单失败';
  }
  return STATUS_LABEL[r.status] || r.status || (r.success ? 'OK' : 'FAIL');
}

/** 旧失败记录缺字段时，从 symbol / requestBody 补展示 */
function enrichLogRow(r: any) {
  let req: any = {};
  try {
    req = r.requestBody ? JSON.parse(r.requestBody) : {};
  } catch {
    /* ignore */
  }
  const symbol = String(r.symbol || req.symbol || '');
  const [symCoin, symEq] = symbol.includes('/') ? symbol.split('/') : [null, null];
  const signalAtRaw = req.signalAt ?? req.signal_at;
  let signalAtMs: number | null = null;
  if (signalAtRaw != null && signalAtRaw !== '') {
    const n = Number(signalAtRaw);
    if (Number.isFinite(n)) signalAtMs = n > 1e12 ? n : n > 1e9 ? n * 1000 : n;
  }
  return {
    ...r,
    accountGid: r.accountGid || req.accountGID || req.accountGid || null,
    accountName: r.accountName || req.accountName || null,
    coinName: r.coinName || req.coinName || symCoin || null,
    equalCoinName: r.equalCoinName || req.equalCoinName || symEq || null,
    accountType: r.accountType || req.accountType || null,
    signalPrice: req.price ?? req.signalPrice ?? null,
    signalAmount: req.signalAmount ?? null,
    followAmount: req.amount ?? null,
    signalAtMs,
    _req: req,
  };
}

function fmtSignalTime(r: ReturnType<typeof enrichLogRow>) {
  const ms = r.signalAtMs ?? (r.createdAt ? Date.parse(String(r.createdAt)) : NaN);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

function openCloseLabel(r: any): string {
  if (r.isOpen === true) return '开';
  if (r.isOpen === false) return '平';
  const side = String(r.side || '').toLowerCase();
  if (side === 'open' || side === 'buy') return '开';
  if (side === 'close' || side === 'sell') return '平';
  return '—';
}

const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'];

function statusAccent(status: string): string | undefined {
  if (status === 'CANCEL_FAILED' || status === 'FAILED') return '#dc2626';
  if (status === 'CANCELLED') return '#d97706';
  if (status === 'FILLED') return '#16a34a';
  if (status === 'PLACED') return undefined;
  return undefined;
}

const LOG_STATUSES = new Set(Object.keys(STATUS_LABEL));

function statusFromUrl(raw: string | null | undefined) {
  const s = String(raw || '').trim();
  return LOG_STATUSES.has(s) ? s : '';
}

/** 挂单日志：成功 / 失败 / 撤销等流水 */
export function TradeOrderLogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlStatus = statusFromUrl(searchParams.get('status'));
  const [logs, setLogs] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [status, setStatus] = useState(urlStatus);
  const [exchange, setExchange] = useState('');
  const [period, setPeriod] = useState('');
  const [accountGid, setAccountGid] = useState('');
  const [coinText, setCoinText] = useState('');
  const [coinValue, setCoinValue] = useState('');
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [recordId, setRecordId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [abnormalKind, setAbnormalKind] = useState('');
  const [fillKind, setFillKind] = useState('');
  const [applied, setApplied] = useState({
    status: urlStatus,
    exchange: '',
    period: '',
    accountGid: '',
    coinName: '',
    q: '',
    userId: '',
    recordId: '',
    orderId: '',
    abnormalKind: '',
    fillKind: '',
  });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [fromAt, setFromAt] = useState('');
  const [toAt, setToAt] = useState('');
  const [purging, setPurging] = useState<'all' | 'range' | 'ids' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [signalDetail, setSignalDetail] = useState<ReturnType<typeof enrichLogRow> | null>(null);
  const pager = usePager(20);
  const coinOpts = useCoinOptions();
  const userOpts = useUserOptions(userText, userId);
  const mwAccounts = useMiddlewareAccounts();

  const pageIds = useMemo(() => logs.map((r) => r.id).filter(Boolean), [logs]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const loadStats = useCallback(async () => {
    const s = await AdminApi.followLogStats();
    setStats(s);
  }, []);

  const loadLogs = useCallback(
    async (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setLoading(true);
      setErr('');
      try {
        const l = await AdminApi.followLogs({
          status: applied.status || undefined,
          exchange: applied.exchange || undefined,
          period: applied.period || undefined,
          accountGid: applied.accountGid || undefined,
          coinName: applied.coinName || undefined,
          userId: applied.userId || undefined,
          recordId: applied.recordId || undefined,
          orderId: applied.orderId || undefined,
          q: !applied.userId && applied.q ? applied.q : undefined,
          abnormalKind: applied.abnormalKind || undefined,
          fillKind: applied.fillKind || undefined,
          skip: (p - 1) * size,
          take: size,
        });
        const { items, total } = normalizePaged(l);
        setLogs(items);
        setSelected(new Set());
        pager.setTotal(total);
        await loadStats();
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    },
    [applied, pager.page, pager.pageSize, loadStats],
  );

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    const s = statusFromUrl(searchParams.get('status'));
    setStatus(s);
    setApplied((prev) => (prev.status === s ? prev : { ...prev, status: s }));
    pager.goFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('status')]);

  function writeStatusParam(next: string) {
    const p = new URLSearchParams(searchParams);
    if (next) p.set('status', next);
    else p.delete('status');
    setSearchParams(p, { replace: true });
  }

  function search() {
    writeStatusParam(status);
    setApplied({
      status,
      exchange,
      period,
      accountGid,
      coinName: (coinValue || coinText).trim().toUpperCase(),
      q: userText.trim(),
      userId,
      recordId: recordId.trim(),
      orderId: orderId.trim(),
      abnormalKind,
      fillKind,
    });
    pager.goFirst();
  }

  function resetFilters() {
    writeStatusParam('');
    setStatus('');
    setExchange('');
    setPeriod('');
    setAccountGid('');
    setCoinText('');
    setCoinValue('');
    setUserText('');
    setUserId('');
    setRecordId('');
    setOrderId('');
    setAbnormalKind('');
    setFillKind('');
    setApplied({
      status: '',
      exchange: '',
      period: '',
      accountGid: '',
      coinName: '',
      q: '',
      userId: '',
      recordId: '',
      orderId: '',
      abnormalKind: '',
      fillKind: '',
    });
    pager.goFirst();
  }

  async function retryAllCancelFailed() {
    if (!(await confirmDialog('批量重试全部撤单失败（最多 50 笔）？'))) return;
    setBusy('重试失败');
    setMsg('');
    setErr('');
    try {
      const res = await AdminApi.retryCancelFailed({ take: 50 });
      setMsg(
        `重试完成：共 ${res.total} · 已撤 ${res.cancelled} · 已成交 ${res.filled} · 仍失败 ${res.failed}`,
      );
      await loadLogs();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  const cancelFailed = stats?.cancelFailed ?? stats?.byStatus?.CANCEL_FAILED ?? 0;
  const systemAbnormal = stats?.systemAbnormal ?? 0;
  const businessAbnormal = stats?.businessAbnormal ?? 0;

  async function purgeAll() {
    if (!(await confirmDialog('确认清空全部挂单日志？此操作不可恢复。'))) return;
    setPurging('all');
    setErr('');
    setMsg('');
    try {
      const res = await AdminApi.purgeFollowLogs({ mode: 'all' });
      toast(`已清理 ${res.deleted ?? 0} 条`, 'ok');
      pager.goFirst();
      await loadLogs({ page: 1 });
    } catch (e: any) {
      toast(e.message || '清理失败', 'err');
    } finally {
      setPurging(null);
    }
  }

  async function purgeRange() {
    if (!fromAt && !toAt) {
      toast('请填写开始或结束时间', 'err');
      return;
    }
    const label = [fromAt || '…', toAt || '…'].join(' ~ ');
    if (!(await confirmDialog(`确认清理时间范围内的挂单日志？\n${label}\n此操作不可恢复。`))) {
      return;
    }
    setPurging('range');
    setErr('');
    setMsg('');
    try {
      const res = await AdminApi.purgeFollowLogs({
        mode: 'range',
        from: fromAt || undefined,
        to: toAt || undefined,
      });
      toast(`已清理 ${res.deleted ?? 0} 条`, 'ok');
      pager.goFirst();
      await loadLogs({ page: 1 });
    } catch (e: any) {
      toast(e.message || '清理失败', 'err');
    } finally {
      setPurging(null);
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllPage() {
    setSelected((prev) => {
      if (pageIds.length === 0) return prev;
      if (pageIds.every((id) => prev.has(id))) return new Set();
      return new Set(pageIds);
    });
  }

  async function purgeByIds(ids: string[], label: string) {
    if (!ids.length) {
      toast('请先勾选要删除的日志', 'err');
      return;
    }
    if (!(await confirmDialog(`${label} ${ids.length} 条？此操作不可恢复。`))) return;
    setPurging('ids');
    try {
      const res = await AdminApi.purgeFollowLogs({ mode: 'ids', ids });
      toast(`已删除 ${res.deleted ?? 0} 条`, 'ok');
      await loadLogs();
    } catch (e: any) {
      toast(e.message || '删除失败', 'err');
    } finally {
      setPurging(null);
    }
  }

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select value={exchange} onChange={(e) => setExchange(e.target.value)}>
            <option value="">全部交易所</option>
            {EXCHANGES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="PENDING">准备中</option>
            <option value="PLACED">挂单中</option>
            <option value="FILLED">已成交</option>
            <option value="CANCELLED">已撤单</option>
            <option value="CANCEL_FAILED">撤单失败</option>
            <option value="FAILED">开仓/下单失败</option>
          </select>
          <select value={abnormalKind} onChange={(e) => setAbnormalKind(e.target.value)}>
            <option value="">不限异常</option>
            <option value="ANY">仅异常（业务+系统）</option>
            <option value="BUSINESS">业务异常</option>
            <option value="SYSTEM">系统异常</option>
            <option value="NONE">无异常</option>
          </select>
          <select value={fillKind} onChange={(e) => setFillKind(e.target.value)}>
            <option value="">全部成交形态</option>
            <option value="NONE">无成交</option>
            <option value="PARTIAL">部分成交</option>
            <option value="FULL">完全成交</option>
          </select>
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {MARKET_PERIOD_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={accountGid}
            onChange={(e) => setAccountGid(e.target.value)}
            style={{ maxWidth: 220 }}
            title="中间件主账户 GID"
          >
            <option value="">全部主账户</option>
            {mwAccounts.map((a) => (
              <option key={a.gid} value={a.gid}>
                {a.name ? `${a.name}` : a.gid}
              </option>
            ))}
          </select>
          <SearchSelect
            text={coinText}
            onTextChange={setCoinText}
            value={coinValue}
            onSelect={(o) => setCoinValue(o?.value || '')}
            options={coinOpts}
            placeholder="币名（输入筛选）"
            width={140}
            emptyHint="无匹配币名"
          />
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
          <input
            type="text"
            value={recordId}
            onChange={(e) => setRecordId(e.target.value)}
            placeholder="流水编号"
            title="signal_follow_logs.id"
            style={{ width: 168 }}
            className="mono"
          />
          <input
            type="text"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="交易所订单号"
            style={{ width: 148 }}
            className="mono"
          />
          <button onClick={search} disabled={loading || !!purging}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button className="ghost" onClick={resetFilters} disabled={loading || !!purging}>
            重置
          </button>
          <button
            className="ghost"
            onClick={() => loadLogs()}
            disabled={loading || !!busy || !!purging}
          >
            刷新
          </button>
          {cancelFailed > 0 ? (
            <button onClick={retryAllCancelFailed} disabled={!!busy || !!purging}>
              {busy === '重试失败' ? '重试中…' : `批量重试撤单失败（${cancelFailed}）`}
            </button>
          ) : null}
          {systemAbnormal > 0 || businessAbnormal > 0 ? (
            <span className="hint">
              系统异常 {systemAbnormal} · 业务异常 {businessAbnormal}
            </span>
          ) : null}
        </div>

        <div
          className="row"
          style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 }}
        >
          <span className="hint">清理</span>
          <input
            type="datetime-local"
            value={fromAt}
            onChange={(e) => setFromAt(e.target.value)}
            title="开始时间"
          />
          <span className="hint">至</span>
          <input
            type="datetime-local"
            value={toAt}
            onChange={(e) => setToAt(e.target.value)}
            title="结束时间"
          />
          <button
            className="ghost btn-with-spinner"
            disabled={!!purging || loading}
            onClick={() => void purgeRange()}
          >
            {purging === 'range' ? <span className="btn-spinner" aria-hidden /> : null}
            清理时间范围
          </button>
          <button
            className="ghost btn-with-spinner"
            style={{ color: 'var(--danger, #c0392b)' }}
            disabled={!!purging || loading}
            onClick={() => void purgeAll()}
          >
            {purging === 'all' ? <span className="btn-spinner" aria-hidden /> : null}
            清理全部
          </button>
          <button
            className="ghost btn-with-spinner"
            style={{ color: 'var(--danger, #c0392b)' }}
            disabled={!!purging || loading || selected.size === 0}
            onClick={() => void purgeByIds([...selected], '删除所选')}
          >
            {purging === 'ids' ? <span className="btn-spinner" aria-hidden /> : null}
            删除所选{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
          <button
            className="ghost btn-with-spinner"
            style={{ color: 'var(--danger, #c0392b)' }}
            disabled={!!purging || loading || pageIds.length === 0}
            onClick={() => void purgeByIds(pageIds, '全选删除本页')}
          >
            全选删除
          </button>
        </div>
      </div>

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="查询中…" />
        <div className="table-scroll">
          <table className="order-logs-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    disabled={pageIds.length === 0 || !!purging}
                    onChange={toggleAllPage}
                    title="全选本页"
                  />
                </th>
                <th>流水编号</th>
                <th>时间</th>
                <th>用户</th>
                <th>主账户</th>
                <th>交易所</th>
                <th>币名</th>
                <th>开平</th>
                <th>类型</th>
                <th>状态</th>
                <th>成交形态</th>
                <th>异常</th>
                <th>成交量</th>
                <th>成交价格</th>
                <th>订单号</th>
                <th>撤单原因</th>
                <th>撤单时间</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((raw) => {
                const r = enrichLogRow(raw);
                const failed = r.status === 'FAILED' || r.status === 'CANCEL_FAILED';
                const reason = failReasonOf(r);
                const active = signalDetail?.id === r.id;
                return (
                <tr
                  key={r.id}
                  className={`row-clickable${active ? ' active' : ''}`}
                  title="点击查看跟单信号"
                  onClick={() => setSignalDetail(r)}
                >
                  <td
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      disabled={!!purging}
                      onChange={() => toggleOne(r.id)}
                    />
                  </td>
                  <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                    <CopyMonoCell value={r.id} label="流水编号" />
                  </td>
                  <td className="nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="nowrap">
                    {r.user?.nickname || r.user?.email || '—'}
                    {r.user?.userNo != null ? (
                      <span className="hint"> #{r.user.userNo}</span>
                    ) : null}
                  </td>
                  <td title={accountGidTitle(r)} style={{ fontSize: 12 }} className="nowrap">
                    {accountGidLabel(r, mwAccounts)}
                    {r.accountGid ? (
                      <span className="hint" style={{ marginLeft: 4, fontFamily: 'monospace', fontSize: 11 }}>
                        {String(r.accountGid).length > 10
                          ? `${String(r.accountGid).slice(0, 8)}…`
                          : r.accountGid}
                      </span>
                    ) : null}
                  </td>
                  <td className="nowrap">{r.exchange}</td>
                  <td className="nowrap">{r.coinName || '—'}</td>
                  <td className="nowrap">
                    {(() => {
                      const oc = openCloseLabel(r);
                      return (
                        <span
                          className="badge"
                          style={{
                            color:
                              oc === '开' ? '#16a34a' : oc === '平' ? '#dc2626' : undefined,
                          }}
                        >
                          {oc}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="nowrap">{marketPeriodLabel(r)}</td>
                  <td className="nowrap">
                    <span className="badge" style={{ color: statusAccent(r.status) }}>
                      {statusLabelOf(r)}
                    </span>
                  </td>
                  <td className="nowrap">
                    {r.fillKind === 'PARTIAL'
                      ? '部分成'
                      : r.fillKind === 'FULL'
                        ? '全成'
                        : '—'}
                  </td>
                  <td
                    className="nowrap"
                    title={r.abnormalMsg || undefined}
                    style={{
                      color:
                        r.abnormalKind === 'SYSTEM'
                          ? '#dc2626'
                          : r.abnormalKind === 'BUSINESS'
                            ? '#d97706'
                            : undefined,
                      fontWeight:
                        r.abnormalKind === 'SYSTEM' || r.abnormalKind === 'BUSINESS'
                          ? 600
                          : undefined,
                    }}
                  >
                    {r.abnormalKind === 'SYSTEM'
                      ? '系统'
                      : r.abnormalKind === 'BUSINESS'
                        ? '业务'
                        : '—'}
                  </td>
                  <td className="mono nowrap">
                    {r.filledAmt != null && r.filledAmt !== '' ? String(r.filledAmt) : '—'}
                  </td>
                  <td className="mono nowrap">
                    {r.avgPrice != null && r.avgPrice !== '' ? String(r.avgPrice) : '—'}
                  </td>
                  <td className="mono nowrap">{r.orderId || '—'}</td>
                  <td className="nowrap">{r.cancelReason || '—'}</td>
                  <td className="nowrap">
                    {r.cancelledAt ? new Date(r.cancelledAt).toLocaleString() : '—'}
                  </td>
                  <td
                    className="reason-cell"
                    title={reason !== '—' ? reason : undefined}
                    style={{
                      color: failed ? '#dc2626' : undefined,
                      fontWeight: failed && reason !== '—' ? 600 : undefined,
                    }}
                  >
                    <span className="reason-text">{reason}</span>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
          {logs.length === 0 && !loading ? (
            <p className="hint list-empty list-empty-in-scroll">暂无日志</p>
          ) : null}
        </div>
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          disabled={loading}
          onChange={(p, s) => {
            pager.onPageChange(p, s);
            loadLogs({ page: p, pageSize: s });
          }}
        />
      </div>

      <DraggableFloatPanel
        open={!!signalDetail}
        title="跟单信号"
        onClose={() => setSignalDetail(null)}
        initialX={Math.max(40, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 800) / 2 - 180))}
        initialY={120}
      >
        {signalDetail ? (
          <div className="float-kv">
            <span className="k">币</span>
            <span className="v">
              {signalDetail.coinName || '—'}
              {signalDetail.equalCoinName ? `/${signalDetail.equalCoinName}` : ''}
            </span>
            <span className="k">价格</span>
            <span className="v">
              {signalDetail.signalPrice != null && signalDetail.signalPrice !== ''
                ? String(signalDetail.signalPrice)
                : '—'}
            </span>
            <span className="k">数量</span>
            <span className="v">
              {signalDetail.signalAmount != null && signalDetail.signalAmount !== ''
                ? String(signalDetail.signalAmount)
                : signalDetail.followAmount != null && signalDetail.followAmount !== ''
                  ? String(signalDetail.followAmount)
                  : '—'}
            </span>
            <span className="k">开平</span>
            <span
              className={`v ${
                openCloseLabel(signalDetail) === '开'
                  ? 'side-open'
                  : openCloseLabel(signalDetail) === '平'
                    ? 'side-close'
                    : ''
              }`}
            >
              {openCloseLabel(signalDetail)}
            </span>
            <span className="k">时间</span>
            <span className="v">{fmtSignalTime(signalDetail)}</span>
            <span className="k">流水编号</span>
            <span className="v">
              <CopyMonoCell value={signalDetail.id} label="流水编号" />
            </span>
          </div>
        ) : null}
      </DraggableFloatPanel>
    </div>
  );
}
