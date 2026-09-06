import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApi } from '../api';
import { DateField } from '../components/DateField';
import { DraggableFloatPanel } from '../components/DraggableFloatPanel';
import { ListLoading } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { SearchSelect } from '../components/SearchSelect';
import { confirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import { CopyMonoCell } from '../components/CopyMonoCell';
import { usePager } from '../hooks/usePager';
import {
  useCoinOptions,
  useUserOptions,
  useMiddlewareAccounts,
  MARKET_PERIOD_OPTIONS,
  marketPeriodLabel,
  accountGidLabel,
  accountGidTitle,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'];

type PosTab = 'OPEN' | 'ABNORMAL' | 'CLOSED';

function sideLabel(side: string) {
  return String(side).toLowerCase() === 'short' ? '空' : '多';
}

function fmtTime(v: any) {
  if (v == null || v === '') return '—';
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) return String(v);
  const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : n;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(v);
  }
}

function pnlColor(pnl: any): string | undefined {
  const n = Number(pnl);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? '#16a34a' : '#dc2626';
}

function openCloseLabel(sig: { isOpen?: boolean | null } | null | undefined): string {
  if (!sig) return '—';
  if (sig.isOpen === true) return '开';
  if (sig.isOpen === false) return '平';
  return '—';
}

function fmtSignalTime(sig: { signalAtMs?: number | null; createdAt?: string | null } | null) {
  if (!sig) return '—';
  const ms =
    sig.signalAtMs != null && Number.isFinite(Number(sig.signalAtMs))
      ? Number(sig.signalAtMs)
      : sig.createdAt
        ? Date.parse(String(sig.createdAt))
        : NaN;
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

function closedKindBadge(r: {
  closeKind?: string | null;
  discardedLocal?: boolean;
  lastCloseFailMsg?: string | null;
}): { text: string; bg: string; title?: string } {
  if (r.discardedLocal || r.closeKind === 'DISCARD_LOCAL') {
    return {
      text: '死仓删除',
      bg: '#b45309',
      title: r.lastCloseFailMsg
        ? `异常死仓，不计利润。原因：${r.lastCloseFailMsg}`
        : '异常仓删除为死仓，不计利润、不参与重试',
    };
  }
  if (r.closeKind === 'PARTIAL') {
    return { text: '部分平仓', bg: '#2563eb', title: '本次平仓后仍有剩余持仓' };
  }
  if (r.closeKind === 'FULL') {
    return { text: '全平', bg: '#15803d', title: '本次平仓后整仓清零' };
  }
  return { text: '正常平仓', bg: '#15803d' };
}

/** 持仓列表：当前持仓 / 异常持仓 / 已平仓；异常仓可删除为死仓，正常仓不可 */
export function PositionsPage() {
  const [tab, setTab] = useState<PosTab>('OPEN');
  const [rows, setRows] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [exchange, setExchange] = useState('');
  const [period, setPeriod] = useState('');
  const [accountGid, setAccountGid] = useState('');
  const [coinText, setCoinText] = useState('');
  const [coinValue, setCoinValue] = useState('');
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recordId, setRecordId] = useState('');
  const [applied, setApplied] = useState({
    status: 'OPEN' as 'OPEN' | 'CLOSED',
    abnormal: false as boolean | 'all',
    exchange: '',
    period: '',
    accountGid: '',
    coinName: '',
    q: '',
    userId: '',
    from: '',
    to: '',
    recordId: '',
  });
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [closingKey, setClosingKey] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [discarding, setDiscarding] = useState(false);
  const [aligning, setAligning] = useState(false);
  const [signalDetail, setSignalDetail] = useState<{
    rowKey: string;
    coinName?: string | null;
    equalCoinName?: string | null;
    signal?: any;
    orderIds?: string[];
    loading?: boolean;
    error?: string | null;
  } | null>(null);
  /** 已平仓子筛：全部 / 部分平 / 全平 / 死仓删除 */
  const [closedKind, setClosedKind] = useState<'all' | 'partial' | 'full' | 'discard'>('all');
  const pager = usePager(20);
  const loadInflight = useRef(false);
  const coinOpts = useCoinOptions();
  const userOpts = useUserOptions(userText, userId);
  const mwAccounts = useMiddlewareAccounts();
  const isClosed = applied.status === 'CLOSED';
  const isAbnormalTab = tab === 'ABNORMAL';
  const canDiscardLocal = isAbnormalTab;

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (silent && loadInflight.current) return;
    loadInflight.current = true;
    if (!silent) {
      setLoading(true);
      setErr('');
    }
    try {
      const res = await AdminApi.positions({
        status: applied.status,
        ...(applied.status === 'CLOSED'
          ? { closedKind }
          : {
              abnormal:
                applied.abnormal === true
                  ? true
                  : applied.abnormal === 'all'
                    ? 'all'
                    : false,
            }),
        exchange: applied.exchange || undefined,
        period: applied.period || undefined,
        accountGid: applied.accountGid || undefined,
        coinName: applied.coinName || undefined,
        userId: applied.userId || undefined,
        q: !applied.userId && applied.q ? applied.q : undefined,
        from: applied.from || undefined,
        to: applied.to || undefined,
        recordId: applied.recordId || undefined,
      });
      const items = Array.isArray(res.items) ? res.items : [];
      setRows(items);
      if (!silent) setSelected(new Set());
      setErrors(Array.isArray(res.errors) ? res.errors : []);
      pager.setTotal(items.length);
      if (!silent) pager.goFirst();
    } catch (e: any) {
      if (!silent) {
        setErr(e.message);
        setRows([]);
        setErrors([]);
        pager.setTotal(0);
      }
    } finally {
      loadInflight.current = false;
      if (!silent) setLoading(false);
    }
  }, [applied, closedKind]);

  useEffect(() => {
    void load();
    // 未实现盈亏依赖最新价：仅当前/异常持仓约每 5 秒静默刷新
    if (applied.status !== 'OPEN') return;
    const id = setInterval(() => void load({ silent: true }), 5000);
    return () => clearInterval(id);
  }, [load, applied.status]);

  function switchTab(next: PosTab) {
    if (next === tab) return;
    setTab(next);
    setSelected(new Set());
    setRows([]);
    setErrors([]);
    pager.setTotal(0);
    if (next === 'CLOSED') {
      setClosedKind('all');
      setApplied((prev) => ({
        ...prev,
        status: 'CLOSED',
        abnormal: 'all',
      }));
      return;
    }
    setApplied((prev) => ({
      ...prev,
      status: 'OPEN',
      abnormal: next === 'ABNORMAL',
    }));
  }

  async function openFollowDetail(r: any, key: string) {
    setSignalDetail({
      rowKey: key,
      coinName: r.coinName,
      equalCoinName: r.equalCoinName,
      signal: null,
      orderIds: [],
      loading: true,
      error: null,
    });
    if (isClosed) {
      setSignalDetail({
        rowKey: key,
        coinName: r.coinName,
        equalCoinName: r.equalCoinName,
        signal: r.lastFollowSignal,
        orderIds: Array.isArray(r.orderIds) && r.orderIds.length ? r.orderIds : r.orderId ? [r.orderId] : [],
        loading: false,
        error: null,
      });
      return;
    }
    if (!r.userId || !r.exchange || !r.coinName) {
      setSignalDetail({
        rowKey: key,
        coinName: r.coinName,
        equalCoinName: r.equalCoinName,
        signal: null,
        orderIds: [],
        loading: false,
        error: '持仓缺少用户/交易所/币名，无法查流水',
      });
      return;
    }
    try {
      const res = await AdminApi.positionFollowDetail({
        userId: r.userId,
        exchange: r.exchange,
        coinName: r.coinName,
        equalCoinName: r.equalCoinName || undefined,
        positionSide: r.side,
      });
      setSignalDetail((prev) => {
        if (!prev || prev.rowKey !== key) return prev;
        return {
          rowKey: key,
          coinName: r.coinName,
          equalCoinName: r.equalCoinName,
          signal: res.lastFollowSignal,
          orderIds: res.orderIds || (res.orderId ? [res.orderId] : []),
          loading: false,
          error: null,
        };
      });
    } catch (e: any) {
      setSignalDetail((prev) => {
        if (!prev || prev.rowKey !== key) return prev;
        return {
          rowKey: key,
          coinName: r.coinName,
          equalCoinName: r.equalCoinName,
          signal: null,
          orderIds: [],
          loading: false,
          error: e?.message || '查询失败',
        };
      });
    }
  }

  function search() {
    setApplied({
      status: tab === 'CLOSED' ? 'CLOSED' : 'OPEN',
      abnormal: tab === 'ABNORMAL',
      exchange,
      period,
      accountGid,
      coinName: (coinValue || coinText).trim().toUpperCase(),
      q: userText.trim(),
      userId,
      from,
      to,
      recordId: recordId.trim(),
    });
  }

  function resetFilters() {
    setExchange('');
    setPeriod('');
    setAccountGid('');
    setCoinText('');
    setCoinValue('');
    setUserText('');
    setUserId('');
    setFrom('');
    setTo('');
    setRecordId('');
    if (tab === 'CLOSED') setClosedKind('all');
    setApplied({
      status: tab === 'CLOSED' ? 'CLOSED' : 'OPEN',
      abnormal: tab === 'CLOSED' ? 'all' : tab === 'ABNORMAL',
      exchange: '',
      period: '',
      accountGid: '',
      coinName: '',
      q: '',
      userId: '',
      from: '',
      to: '',
      recordId: '',
    });
  }

  async function enqueueAlign() {
    if (isClosed) return;
    setAligning(true);
    setErr('');
    try {
      const res = await AdminApi.enqueueQueryPositionSync({
        userId: applied.userId || undefined,
        exchange: applied.exchange || undefined,
      });
      const parts = [
        res.queued ? `入队 ${res.queued}` : '',
        res.alreadyQueued ? `已在队列 ${res.alreadyQueued}` : '',
        res.cooldown ? `冷却中 ${res.cooldown}` : '',
      ].filter(Boolean);
      toast(
        parts.length
          ? `已提交对齐（不堵当前页）：${parts.join('，')}。按代理每 5 秒打 1 人，稍后刷新列表。`
          : res.noOpen
            ? '没有可对齐的本地 OPEN 合约仓'
            : '没有新的对齐任务',
        parts.length ? 'ok' : 'info',
      );
    } catch (e: any) {
      setErr(e.message);
      toast(e.message || '入队失败', 'err');
    } finally {
      setAligning(false);
    }
  }

  const pageRows = useMemo(
    () => rows.slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize),
    [rows, pager.page, pager.pageSize],
  );

  /** 当前筛选结果的盈亏合计（未实现 / 已实现） */
  const pnlStats = useMemo(() => {
    let sum = 0;
    let counted = 0;
    for (const r of rows) {
      if (isClosed && r.closeKind === 'DISCARD_LOCAL') continue;
      // 已平仓只用 realizedPnl，禁止回退到 pnl（未实现），避免切 tab 时被旧数据覆盖
      const raw = isClosed ? r.realizedPnl : r.pnl;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      sum += n;
      counted += 1;
    }
    return { sum, counted, total: rows.length };
  }, [rows, isClosed]);


  const pageIds = useMemo(
    () => pageRows.map((r) => r.id).filter(Boolean) as string[],
    [pageRows],
  );
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  function rowKey(r: any) {
    return `${r.userId}-${r.id}-${r.exchange}-${r.side}-${r.accountGid || ''}`;
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

  async function discardLocal(ids: string[], label: string) {
    if (!ids.length) {
      toast('请先勾选要删除的异常持仓', 'err');
      return;
    }
    if (
      !(await confirmDialog(
        `${label} ${ids.length} 条？\n` +
          `将视为死仓：不再定时重试平仓，不计利润。\n` +
          `仅删本地记录，不会向交易所下单。\n确认交易所已无对应仓位后再操作。`,
      ))
    ) {
      return;
    }
    setDiscarding(true);
    try {
      const res = await AdminApi.discardLocalPositions(ids);
      const discarded = res.discarded ?? 0;
      const skipped = res.skippedNonAbnormal ?? 0;
      toast(
        skipped
          ? `已删除 ${discarded} 条死仓（跳过非异常 ${skipped}）`
          : `已删除异常死仓 ${discarded} 条`,
        discarded > 0 ? 'ok' : 'err',
      );
      await load();
    } catch (e: any) {
      toast(e.message || '删除失败', 'err');
    } finally {
      setDiscarding(false);
    }
  }

  async function closePosition(r: any) {
    const amt = Number(r.amount);
    if (!r.userId || !r.exchange || !r.coinName || !Number.isFinite(amt) || amt <= 0) {
      toast('持仓数据不完整，无法平仓', 'err');
      return;
    }
    const who = r.user?.nickname || r.user?.email || r.userId;
    if (
      !(await confirmDialog(
        `确认市价平仓？\n${who} · ${r.exchange} · ${r.coinName} · ${sideLabel(r.side)} · 数量 ${r.amount}\n（日常应靠信号自动平仓；此为运营兜底）`,
      ))
    ) {
      return;
    }
    const key = rowKey(r);
    setClosingKey(key);
    try {
      await AdminApi.closePosition({
        userId: r.userId,
        exchange: r.exchange,
        coinName: r.coinName,
        positionSide: r.side,
        amount: amt,
        equalCoinName: r.equalCoinName || undefined,
        symbol: r.symbol || undefined,
        accountType: r.accountType || 'future',
        // 仅写入平仓流水展示用；下单仍用用户自身 Key，不会带入 PlaceOrder.account
        accountGid: r.accountGid || undefined,
        accountName: r.accountName || undefined,
        leverage: r.leverage ?? undefined,
      });
      toast('平仓已提交', 'ok');
      await load();
    } catch (e: any) {
      const msg = String(e?.message || '平仓失败').trim();
      // 手动市价平业务失败时后端会立刻标异常，并在 message 中带失败原因
      const tip = /异常持仓/.test(msg)
        ? msg
        : `${msg}。若已进入异常持仓，请到「异常持仓」查看。`;
      toast(tip, 'err', 8000);
      await load();
    } finally {
      setClosingKey('');
    }
  }

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}

      <div className="tabs">
        <button
          type="button"
          className={tab === 'OPEN' ? 'tab active' : 'tab ghost'}
          onClick={() => switchTab('OPEN')}
        >
          当前持仓
        </button>
        <button
          type="button"
          className={tab === 'ABNORMAL' ? 'tab active' : 'tab ghost'}
          onClick={() => switchTab('ABNORMAL')}
        >
          异常持仓
        </button>
        <button
          type="button"
          className={tab === 'CLOSED' ? 'tab active' : 'tab ghost'}
          onClick={() => switchTab('CLOSED')}
        >
          已平仓
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>
            {isClosed ? '平仓时间' : '开仓时间'}
          </label>
          <DateField value={from} onChange={setFrom} title="开始日期" />
          <span style={{ opacity: 0.6 }}>至</span>
          <DateField value={to} onChange={setTo} title="结束日期" />

          <input
            type="text"
            value={recordId}
            onChange={(e) => setRecordId(e.target.value)}
            placeholder={isClosed ? '平仓记录编号' : '持仓编号'}
            title={
              isClosed
                ? 'profit_records.id；异常清除行为 user_positions.id'
                : 'user_positions.id'
            }
            style={{ width: 168 }}
            className="mono"
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

          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>交易所</label>
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
          {isClosed ? (
            <select
              value={closedKind}
              onChange={(e) =>
                setClosedKind(e.target.value as 'all' | 'partial' | 'full' | 'discard')
              }
              title="平仓类型"
            >
              <option value="all">全部平仓类型</option>
              <option value="partial">部分平仓</option>
              <option value="full">全平</option>
              <option value="discard">死仓删除</option>
            </select>
          ) : null}
          <button onClick={search} disabled={loading}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button className="ghost" onClick={resetFilters} disabled={loading}>
            重置
          </button>
          <button className="ghost" onClick={() => load()} disabled={loading}>
            刷新
          </button>
          {!isClosed ? (
            <button
              className="ghost"
              onClick={() => void enqueueAlign()}
              disabled={aligning || loading}
              title="加入对齐队列，由独立线程按代理串行查询 QueryPosition，不堵当前页"
            >
              {aligning
                ? '入队中…'
                : applied.userId
                  ? '对齐该用户交易所仓'
                  : '对齐交易所持仓'}
            </button>
          ) : null}
          {canDiscardLocal ? (
            <>
              <button
                className="ghost"
                style={{ color: 'var(--danger, #c0392b)' }}
                disabled={discarding || loading || selected.size === 0}
                onClick={() => void discardLocal([...selected], '删除所选异常死仓')}
                title="删除为死仓：停定时重试、不计利润；不对交易所下单"
              >
                {discarding ? '删除中…' : `删除所选${selected.size ? `（${selected.size}）` : ''}`}
              </button>
              <button
                className="ghost"
                style={{ color: 'var(--danger, #c0392b)' }}
                disabled={discarding || loading || pageIds.length === 0}
                onClick={() => void discardLocal(pageIds, '删除本页异常死仓')}
                title="删除当前页全部异常持仓为死仓"
              >
                全选删除本页
              </button>
            </>
          ) : !isClosed ? (
            <span className="hint" style={{ margin: 0 }}>
              正常持仓不可删除；平仓失败进「异常持仓」后可删除为死仓
            </span>
          ) : null}
        </div>
      </div>

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text={isClosed ? '正在拉取已平仓…' : '正在拉取持仓…'} />
        {!loading && rows.length > 0 ? (
          <div
            className="row"
            style={{
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'baseline',
              marginBottom: 10,
              padding: '4px 2px',
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {isClosed ? '已实现盈亏合计' : '未实现盈亏合计'}
              <span style={{ marginLeft: 8, fontFamily: 'monospace', color: pnlColor(pnlStats.sum) }}>
                {pnlStats.sum > 0 ? '+' : ''}
                {pnlStats.sum.toFixed(4)}
              </span>
            </span>
            <span className="hint" style={{ margin: 0 }}>
              计入 {pnlStats.counted} / {pnlStats.total} 笔
              {isClosed ? '' : '（当前筛选结果）'}
            </span>
          </div>
        ) : null}
        <div className="table-scroll">
        <table className="positions-list-table">
          <thead>
            <tr>
              {!isClosed ? (
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    disabled={!canDiscardLocal || pageIds.length === 0 || discarding}
                    onChange={toggleAllPage}
                    title={canDiscardLocal ? '全选本页' : '仅异常持仓可选'}
                  />
                </th>
              ) : null}
              <th style={{ width: 120 }}>{isClosed ? '平仓记录编号' : '持仓编号'}</th>
              <th style={{ width: 120 }}>昵称</th>
              <th style={{ width: 88 }}>用户ID</th>
              <th style={{ width: 140 }}>主账户</th>
              <th style={{ width: 88 }}>交易所</th>
              <th style={{ width: 72 }}>币名</th>
              {isAbnormalTab ? (
                <>
                  <th style={{ width: 72 }}>状态</th>
                  <th style={{ width: 88 }}>失败次数</th>
                  <th style={{ width: 180 }}>最近失败</th>
                  <th style={{ width: 220 }}>失败原因</th>
                </>
              ) : null}
              {isClosed ? (
                <th style={{ width: 160 }} title="来自平仓记录">订单号</th>
              ) : null}
              <th style={{ width: 120 }}>类型</th>
              <th style={{ width: 56 }}>方向</th>
              <th style={{ width: 88 }}>数量</th>
              <th style={{ width: 96 }}>开仓均价</th>
              {!isClosed ? <th style={{ width: 96 }}>标记价格</th> : null}
              {isClosed ? (
                <>
                  <th style={{ width: 88 }}>平仓类型</th>
                  <th style={{ width: 100 }}>已实现盈亏</th>
                  <th style={{ width: 160 }}>平仓时间</th>
                </>
              ) : (
                <>
                  <th style={{ width: 110 }} title="交易所强平价；没有则按杠杆估算">
                    爆仓价
                  </th>
                  <th style={{ width: 100 }}>未实现盈亏</th>
                  <th style={{ width: 160 }}>开仓时间</th>
                  <th style={{ width: 96 }}>操作</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => {
              const key = rowKey(r);
              const busy = closingKey === key;
              const orderLabel =
                Array.isArray(r.orderIds) && r.orderIds.length > 1
                  ? r.orderIds.join(', ')
                  : r.orderId || '—';
              const closedPnl = r.realizedPnl;
              const amt =
                isClosed && (r.amount === '0' || r.amount === 0) ? '—' : r.amount;
              const closeBadge = isClosed ? closedKindBadge(r) : null;
              return (
                <tr key={key}>
                  {!isClosed ? (
                    <td>
                      <input
                        type="checkbox"
                        checked={!!r.id && selected.has(r.id)}
                        disabled={!canDiscardLocal || !r.id || discarding}
                        onChange={() => r.id && toggleOne(r.id)}
                        title={canDiscardLocal ? undefined : '仅异常持仓可勾选清除'}
                      />
                    </td>
                  ) : null}
                  <td className="nowrap">
                    <CopyMonoCell
                      value={r.id}
                      label={isClosed ? '平仓记录编号' : '持仓编号'}
                    />
                  </td>
                  <td title={r.user?.email || undefined}>
                    {r.user?.nickname || r.user?.email || '—'}
                  </td>
                  <td style={{ fontFamily: 'monospace' }}>
                    {r.user?.userNo != null ? r.user.userNo : '—'}
                  </td>
                  <td title={accountGidTitle(r)} style={{ fontSize: 12 }}>
                    {accountGidLabel(r, mwAccounts)}
                    {r.accountGid ? (
                      <div
                        className="hint"
                        style={{ margin: 0, fontFamily: 'monospace', fontSize: 11 }}
                      >
                        {String(r.accountGid).length > 16
                          ? `${String(r.accountGid).slice(0, 10)}…`
                          : r.accountGid}
                      </div>
                    ) : null}
                  </td>
                  <td>{r.exchange}</td>
                  <td className="nowrap">
                    {r.coinName ? (
                      <button
                        type="button"
                        className={`cell-link${signalDetail?.rowKey === key ? ' active' : ''}`}
                        title="点击查看跟单信号"
                        onClick={() => void openFollowDetail(r, key)}
                      >
                        {r.coinName}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  {isAbnormalTab ? (
                    <>
                      <td>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: r.closeRetryStopped ? '#78716c' : '#b45309',
                            color: '#fff',
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {r.closeRetryStopped ? '已停重试' : '异常'}
                        </span>
                      </td>
                      <td title={r.lastCloseFailMsg || undefined}>{r.closeFailCount ?? 0}</td>
                      <td style={{ fontSize: 12 }}>
                        {fmtTime(r.lastCloseFailAt)}
                        {r.lastCloseFailAmt != null && Number(r.lastCloseFailAmt) > 0 ? (
                          <div className="hint" style={{ margin: 0 }}>
                            失败数量 {r.lastCloseFailAmt}
                          </div>
                        ) : null}
                        {r.lastCloseOkAt ? (
                          <div className="hint" style={{ margin: 0 }}>
                            成功 {fmtTime(r.lastCloseOkAt)}
                            {r.lastCloseOkAmt != null && Number(r.lastCloseOkAmt) > 0
                              ? ` 数量 ${r.lastCloseOkAmt}`
                              : ''}
                          </div>
                        ) : null}
                        {r.closeRetryStopAt ? (
                          <div className="hint" style={{ margin: 0 }}>
                            重试至 {fmtTime(r.closeRetryStopAt)}
                          </div>
                        ) : null}
                      </td>
                      <td
                        style={{ fontSize: 12, whiteSpace: 'normal', wordBreak: 'break-word' }}
                        title={r.lastCloseFailMsg || undefined}
                      >
                        {r.lastCloseFailMsg || '—'}
                      </td>
                    </>
                  ) : null}
                  {isClosed ? (
                  <td
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                    title={orderLabel !== '—' ? orderLabel : undefined}
                  >
                    {orderLabel}
                  </td>
                  ) : null}
                  <td>{r.mode || marketPeriodLabel(r)}</td>
                  <td>
                    <span
                      className="badge"
                      style={{ color: r.side === 'short' ? '#dc2626' : '#16a34a' }}
                    >
                      {sideLabel(r.side)}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'monospace' }}>{amt}</td>
                  <td style={{ fontFamily: 'monospace' }}>
                    {r.entryPrice != null && r.entryPrice !== '' ? String(r.entryPrice) : '—'}
                  </td>
                  {!isClosed ? (
                    <td style={{ fontFamily: 'monospace' }}>
                      {r.markPrice != null && r.markPrice !== '' ? String(r.markPrice) : '—'}
                    </td>
                  ) : null}
                  {isClosed ? (
                    <>
                      <td>
                        {closeBadge ? (
                          <>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '2px 8px',
                                borderRadius: 4,
                                background: closeBadge.bg,
                                color: '#fff',
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                              title={closeBadge.title}
                            >
                              {closeBadge.text}
                            </span>
                            {(r.discardedLocal || r.closeKind === 'DISCARD_LOCAL') &&
                            r.lastCloseFailMsg ? (
                              <div
                                className="hint"
                                style={{
                                  margin: '4px 0 0',
                                  fontSize: 11,
                                  whiteSpace: 'normal',
                                  wordBreak: 'break-word',
                                  maxWidth: 220,
                                }}
                                title={r.lastCloseFailMsg}
                              >
                                {r.lastCloseFailMsg}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        style={{
                          fontFamily: 'monospace',
                          color:
                            r.discardedLocal || r.closeKind === 'DISCARD_LOCAL'
                              ? undefined
                              : pnlColor(closedPnl),
                          fontWeight: 600,
                        }}
                      >
                        {r.discardedLocal || r.closeKind === 'DISCARD_LOCAL'
                          ? '—'
                          : closedPnl != null && closedPnl !== ''
                            ? String(closedPnl)
                            : '—'}
                      </td>
                      <td>{fmtTime(r.closeTime)}</td>
                    </>
                  ) : (
                    <>
                      <td style={{ fontFamily: 'monospace' }}>
                        {r.liquidationPrice && r.liquidationPrice !== '—'
                          ? String(r.liquidationPrice)
                          : r.liqPrice && Number(r.liqPrice) > 0
                            ? String(r.liqPrice)
                            : '—'}
                      </td>
                      <td
                        style={{ fontFamily: 'monospace', color: pnlColor(r.pnl), fontWeight: 600 }}
                      >
                        {r.pnl != null ? r.pnl : '—'}
                      </td>
                      <td>{fmtTime(r.openTime)}</td>
                      <td className="ops">
                        <button
                          type="button"
                          className="ghost"
                          style={{ padding: '2px 8px', fontSize: 12 }}
                          disabled={!!closingKey || loading || discarding}
                          onClick={() => void closePosition(r)}
                        >
                          {busy ? '平仓中…' : '市价平仓'}
                        </button>
                        {isAbnormalTab && r.id ? (
                          <button
                            type="button"
                            className="ghost"
                            style={{
                              padding: '2px 8px',
                              fontSize: 12,
                              color: 'var(--danger, #c0392b)',
                              marginLeft: 4,
                            }}
                            disabled={!!closingKey || loading || discarding}
                            title="删除为死仓：停定时重试、不计利润"
                            onClick={() => void discardLocal([r.id], '删除异常死仓')}
                          >
                            删除
                          </button>
                        ) : null}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !loading ? (
          <p className="hint list-empty-in-scroll">
            {isClosed ? '暂无已平仓' : isAbnormalTab ? '暂无异常持仓' : '暂无持仓'}
          </p>
        ) : null}
        </div>
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          disabled={loading}
          onChange={(p, s) => pager.onPageChange(p, s)}
        />
      </div>

      {errors.length > 0 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>拉取失败</h3>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', fontSize: 13 }}>
            {errors.slice(0, 20).map((e, i) => (
              <li key={i}>
                {e.email || e.userId || '—'}
                {e.exchange ? ` · ${e.exchange}` : ''}：{e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
              {signalDetail.signal?.coinName || signalDetail.coinName || '—'}
              {(signalDetail.signal?.equalCoinName || signalDetail.equalCoinName)
                ? `/${signalDetail.signal?.equalCoinName || signalDetail.equalCoinName}`
                : ''}
            </span>
            <span className="k">价格</span>
            <span className="v">
              {signalDetail.signal?.signalPrice != null && signalDetail.signal.signalPrice !== ''
                ? String(signalDetail.signal.signalPrice)
                : '—'}
            </span>
            <span className="k">数量</span>
            <span className="v">
              {signalDetail.signal?.signalAmount != null && signalDetail.signal.signalAmount !== ''
                ? String(signalDetail.signal.signalAmount)
                : signalDetail.signal?.followAmount != null && signalDetail.signal.followAmount !== ''
                  ? String(signalDetail.signal.followAmount)
                  : '—'}
            </span>
            <span className="k">开平</span>
            <span
              className={`v ${
                openCloseLabel(signalDetail.signal) === '开'
                  ? 'side-open'
                  : openCloseLabel(signalDetail.signal) === '平'
                    ? 'side-close'
                    : ''
              }`}
            >
              {openCloseLabel(signalDetail.signal)}
            </span>
            <span className="k">时间</span>
            <span className="v">{fmtSignalTime(signalDetail.signal)}</span>
            <span className="k">订单号</span>
            <span className="v" style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
              {signalDetail.loading
                ? '查询中…'
                : signalDetail.orderIds && signalDetail.orderIds.length
                  ? signalDetail.orderIds.join(', ')
                  : '—'}
            </span>
            {signalDetail.loading ? (
              <>
                <span className="k" />
                <span className="v hint" style={{ gridColumn: '1 / -1' }}>
                  正在查跟单流水…
                </span>
              </>
            ) : signalDetail.error ? (
              <>
                <span className="k" />
                <span className="v hint" style={{ gridColumn: '1 / -1' }}>
                  {signalDetail.error}
                </span>
              </>
            ) : !signalDetail.signal ? (
              <>
                <span className="k" />
                <span className="v hint" style={{ gridColumn: '1 / -1' }}>
                  暂无关联跟单流水
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </DraggableFloatPanel>
    </div>
  );
}
