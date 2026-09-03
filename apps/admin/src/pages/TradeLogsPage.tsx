import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { ListLoading } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { SearchSelect } from '../components/SearchSelect';
import { toast } from '../components/Toast';
import { usePager, normalizePaged } from '../hooks/usePager';
import { useCoinOptions, useUserOptions, useMiddlewareAccounts, MARKET_PERIOD_OPTIONS, marketPeriodLabel, accountGidLabel, accountGidTitle, USER_FILTER_PLACEHOLDER, USER_FILTER_EMPTY_HINT } from '../hooks/useSearchFilterOptions';

const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'];

function canAdminCancel(r: any) {
  // 撤单失败仍视为在途挂单，可重试撤单
  return !!r.orderId && (r.status === 'PLACED' || r.status === 'CANCEL_FAILED');
}

function statusLabel(r: any) {
  if (r.status === 'CANCEL_FAILED') return '撤单失败';
  if (r.status === 'PLACED') return '挂单中';
  return r.status || '—';
}

function parseJsonSafe(raw: unknown): any {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function openCloseLabel(r: any): string {
  if (r.isOpen === true) return '开';
  if (r.isOpen === false) return '平';
  const req = parseJsonSafe(r.requestBody);
  if (req.isOpen === true) return '开';
  if (req.isOpen === false) return '平';
  const side = String(r.side || req.orderSide || '').toLowerCase();
  if (side === 'open' || side === 'buy') return '开';
  if (side === 'close' || side === 'sell') return '平';
  return '—';
}

/** 挂单价：下单回包价优先，其次请求里的委托/信号价 */
function orderPriceOf(r: any): string {
  const req = parseJsonSafe(r.requestBody);
  const resp = parseJsonSafe(r.responseBody);
  const data = resp?.data && typeof resp.data === 'object' ? resp.data : resp;
  const raw =
    data?.price ??
    data?.Price ??
    req?.price ??
    req?.signalPrice ??
    r.avgPrice;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return String(raw);
  return '—';
}

/** 挂单列表：挂单中 + 撤单失败（撤单失败=曾挂单成功，订单可能仍在交易所） */
export function TradeLogsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [exchange, setExchange] = useState('');
  const [period, setPeriod] = useState('');
  const [accountGid, setAccountGid] = useState('');
  const [coinText, setCoinText] = useState('');
  const [coinValue, setCoinValue] = useState('');
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [applied, setApplied] = useState({
    exchange: '',
    period: '',
    accountGid: '',
    coinName: '',
    q: '',
    userId: '',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const pager = usePager(20);
  const coinOpts = useCoinOptions();
  const userOpts = useUserOptions(userText, userId);
  const mwAccounts = useMiddlewareAccounts();

  const load = useCallback(
    async (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setLoading(true);
      try {
        const res = await AdminApi.followLogs({
          status: 'PLACED,CANCEL_FAILED',
          exchange: applied.exchange || undefined,
          period: applied.period || undefined,
          accountGid: applied.accountGid || undefined,
          coinName: applied.coinName || undefined,
          userId: applied.userId || undefined,
          q: !applied.userId && applied.q ? applied.q : undefined,
          skip: (p - 1) * size,
          take: size,
        });
        const { items, total } = normalizePaged(res);
        setRows(items);
        pager.setTotal(total);
        setSelected(new Set());
      } catch (e: any) {
        toast(e.message || '加载失败', 'err');
      } finally {
        setLoading(false);
      }
    },
    [applied, pager.page, pager.pageSize],
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  function search() {
    setApplied({
      exchange,
      period,
      accountGid,
      coinName: (coinValue || coinText).trim().toUpperCase(),
      q: userText.trim(),
      userId,
    });
    pager.goFirst();
  }

  function resetFilters() {
    setExchange('');
    setPeriod('');
    setAccountGid('');
    setCoinText('');
    setCoinValue('');
    setUserText('');
    setUserId('');
    setApplied({ exchange: '', period: '', accountGid: '', coinName: '', q: '', userId: '' });
    pager.goFirst();
  }

  const selectableIds = useMemo(() => rows.filter(canAdminCancel).map((r) => r.id), [rows]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === selectableIds.length) return new Set();
      return new Set(selectableIds);
    });
  }

  async function cancelIds(ids: string[], label: string) {
    if (!ids.length) return;
    if (!(await confirmDialog(`${label} ${ids.length} 笔？`))) return;
    setBusy(label);
    try {
      const res = await AdminApi.cancelOrders(ids);
      const firstFail =
        res.failed > 0 && Array.isArray(res.items)
          ? res.items.find((it: any) => it.result === 'failed')
          : null;
      const reason = firstFail?.message ? ` · ${String(firstFail.message).slice(0, 160)}` : '';
      toast(
        `${label}：共 ${res.total} · 已撤 ${res.cancelled} · 已成交 ${res.filled} · 失败 ${res.failed}${reason}`,
        res.failed > 0 ? 'err' : 'ok',
      );
      await load();
    } catch (e: any) {
      toast(e.message || '操作失败', 'err');
    } finally {
      setBusy('');
    }
  }

  async function syncExchangeOpenOrders() {
    const uid = userId || applied.userId;
    if (!uid) {
      toast('请先在筛选里选择用户，再同步交易所挂单', 'err');
      return;
    }
    const ex = (exchange || applied.exchange || 'BINANCE').toUpperCase();
    setBusy('同步交易所挂单');
    try {
      const res = await AdminApi.syncExchangeOpenOrders({
        userId: uid,
        exchange: ex,
      });
      toast(
        `已同步 ${res.exchangeOpen} 笔交易所挂单：新增 ${res.created} · 更新 ${res.updated}` +
          (res.closed ? ` · 清理本地 ${res.closed}` : ''),
        'ok',
      );
      if (!applied.userId) {
        setApplied((prev) => ({ ...prev, userId: uid, exchange: ex === 'BINANCE' ? ex : prev.exchange }));
      }
      await load();
    } catch (e: any) {
      toast(e.message || '同步失败', 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page-list">
      <div className="card">
        <div className="row" style={{ marginBottom: 0, alignItems: 'center' }}>
          <h3 style={{ margin: 0, marginRight: 4, whiteSpace: 'nowrap' }}>运营动作</h3>
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() =>
              AdminApi.runOnce()
                .then(() => toast('已跑一轮跟单', 'ok'))
                .catch((e) => toast(e.message || '失败', 'err'))
            }
          >
            手动跑一轮
          </button>
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() =>
              AdminApi.syncFills()
                .then(() => {
                  toast('成交检测完成', 'ok');
                  load();
                })
                .catch((e) => toast(e.message || '失败', 'err'))
            }
          >
            成交检测
          </button>
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() =>
              AdminApi.cancelExpired()
                .then((r: any) => {
                  toast(
                    `过期撤单完成${r ? `：成功 ${r.cancelled ?? 0} / 失败 ${r.failed ?? 0}` : ''}`,
                    'ok',
                  );
                  load();
                })
                .catch((e) => toast(e.message || '失败', 'err'))
            }
          >
            过期撤单
          </button>
          <button
            className="ghost"
            disabled={!!busy}
            title="先在筛选里选择用户；把币安当前挂单写入本地挂单列表"
            onClick={() => void syncExchangeOpenOrders()}
          >
            {busy === '同步交易所挂单' ? '同步中…' : '同步交易所挂单'}
          </button>
        </div>
      </div>

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
          <button onClick={search} disabled={loading}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button className="ghost" onClick={resetFilters} disabled={loading}>
            重置
          </button>
          <button
            disabled={!!busy || selected.size === 0}
            onClick={() => cancelIds([...selected], '勾选立即撤单')}
          >
            {busy === '勾选立即撤单' ? '撤单中…' : `立即撤单（已选 ${selected.size}）`}
          </button>
          <button className="ghost" onClick={() => load()} disabled={!!busy || loading}>
            刷新
          </button>
        </div>
      </div>

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="查询中…" />
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={selectableIds.length > 0 && selected.size === selectableIds.length}
                  onChange={toggleAll}
                  disabled={!selectableIds.length}
                />
              </th>
              <th>时间</th>
              <th>用户</th>
              <th>主账户</th>
              <th>交易所</th>
              <th>币名</th>
              <th>开/平</th>
              <th>挂单价</th>
              <th>类型</th>
              <th>状态</th>
              <th>订单号</th>
              <th>说明</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ok = canAdminCancel(r);
              const cancelFailed = r.status === 'CANCEL_FAILED';
              return (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      disabled={!ok}
                      onChange={() => toggleOne(r.id)}
                    />
                  </td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    {r.user?.nickname || r.user?.email || '—'}
                    {r.user?.userNo != null ? (
                      <span className="hint"> #{r.user.userNo}</span>
                    ) : null}
                  </td>
                  <td title={accountGidTitle(r)} style={{ fontSize: 12 }}>
                    {accountGidLabel(r, mwAccounts)}
                    {r.accountGid ? (
                      <div className="hint" style={{ margin: 0, fontFamily: 'monospace', fontSize: 11 }}>
                        {String(r.accountGid).length > 16
                          ? `${String(r.accountGid).slice(0, 10)}…`
                          : r.accountGid}
                      </div>
                    ) : null}
                  </td>
                  <td>{r.exchange}</td>
                  <td>{r.coinName || '—'}</td>
                  <td>
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
                  <td className="mono nowrap">{orderPriceOf(r)}</td>
                  <td>{marketPeriodLabel(r)}</td>
                  <td>
                    <span
                      className="badge"
                      style={{ color: cancelFailed ? '#dc2626' : undefined }}
                    >
                      {statusLabel(r)}
                    </span>
                  </td>
                  <td>{r.orderId || '—'}</td>
                  <td
                    title={r.cancelMsg || r.errorMsg || undefined}
                    style={{
                      maxWidth: 220,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 12,
                      color: cancelFailed ? '#dc2626' : undefined,
                    }}
                  >
                    {r.cancelMsg || r.errorMsg || '—'}
                  </td>
                  <td>
                    {ok ? (
                      <button
                        className="ghost"
                        disabled={!!busy}
                        onClick={() =>
                          cancelIds([r.id], cancelFailed ? '重试撤单' : '立即撤单')
                        }
                      >
                        {cancelFailed ? '重试撤单' : '立即撤单'}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !loading ? (
          <p className="hint list-empty">当前无挂单 / 撤单失败单</p>
        ) : null}
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          disabled={loading}
          onChange={(p, s) => {
            pager.onPageChange(p, s);
            load({ page: p, pageSize: s });
          }}
        />
      </div>
    </div>
  );
}
