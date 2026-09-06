import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminApi } from '../api';
import { DateField } from '../components/DateField';
import { DraggableFloatPanel } from '../components/DraggableFloatPanel';
import { Pagination } from '../components/Pagination';
import { ListLoading } from '../components/ListLoading';
import { SearchSelect } from '../components/SearchSelect';
import { normalizePaged, usePager } from '../hooks/usePager';
import {
  useUserOptions,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

const LEVEL_LABEL: Record<string, string> = {
  DIRECT: '直推',
  INDIRECT: '间推',
  L1: '直推',
  L2: '间推',
  PLATFORM: '平台',
};

const SOURCE_LABEL: Record<string, string> = {
  FOLLOW: '跟单成交',
  MANUAL: '手动录入',
};

function userLabel(u?: { userNo?: number | null; nickname?: string | null; email?: string } | null) {
  if (!u) return '—';
  const name = u.nickname || u.email || '—';
  return u.userNo != null ? `${name}（#${u.userNo}）` : name;
}

function fmtProfit(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  });
  if (n > 0) return `+${s}`;
  if (n < 0) return `-${s}`;
  return s;
}

function coinLabel(p?: { symbol?: string | null } | null) {
  if (!p?.symbol || p.symbol === '—') return '—';
  return p.symbol;
}

type SourceDetail = Awaited<ReturnType<typeof AdminApi.commissionRecordSource>>;

export function CommissionRecordsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [earnerText, setEarnerText] = useState('');
  const [earnerId, setEarnerId] = useState('');
  const [fromUserText, setFromUserText] = useState('');
  const [fromUserId, setFromUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState({
    earnerId: '',
    fromUserId: '',
    from: '',
    to: '',
  });
  const [sourceDetail, setSourceDetail] = useState<SourceDetail | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceErr, setSourceErr] = useState('');
  const [summary, setSummary] = useState<{ profitSum: string; amount: string } | null>(null);
  const pager = usePager(20);
  const earnerOpts = useUserOptions(earnerText, earnerId);
  const fromUserOpts = useUserOptions(fromUserText, fromUserId);

  const load = useCallback(
    async (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setLoading(true);
      setErr('');
      try {
        const rec = await AdminApi.commissionRecords({
          earnerId: applied.earnerId || undefined,
          fromUser: applied.fromUserId || undefined,
          from: applied.from || undefined,
          to: applied.to || undefined,
          skip: (p - 1) * size,
          take: size,
        });
        const { items: list, total } = normalizePaged(rec);
        setItems(list);
        pager.setTotal(total);
        setSummary({
          profitSum: String(rec.summary?.profitSum ?? 0),
          amount: String(rec.summary?.amount ?? 0),
        });
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    },
    [applied, pager.page, pager.pageSize],
  );

  function search() {
    setApplied({
      earnerId: earnerId.trim(),
      fromUserId: fromUserId.trim(),
      from,
      to,
    });
    pager.goFirst();
  }

  useEffect(() => {
    load({ page: 1 });
  }, [applied]);

  function resetFilters() {
    setEarnerText('');
    setEarnerId('');
    setFromUserText('');
    setFromUserId('');
    setFrom('');
    setTo('');
    setApplied({ earnerId: '', fromUserId: '', from: '', to: '' });
    pager.goFirst();
  }

  function onPageChange(nextPage: number, nextSize: number) {
    pager.onPageChange(nextPage, nextSize);
    load({ page: nextPage, pageSize: nextSize });
  }

  async function openSource(commissionId: string) {
    setSourceLoading(true);
    setSourceErr('');
    setSourceDetail(null);
    try {
      const detail = await AdminApi.commissionRecordSource(commissionId);
      setSourceDetail(detail);
    } catch (e: any) {
      setSourceErr(e.message || '加载来源失败');
    } finally {
      setSourceLoading(false);
    }
  }

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>目标</label>
          <SearchSelect
            text={earnerText}
            onTextChange={(t) => {
              setEarnerText(t);
              if (earnerId) setEarnerId('');
            }}
            value={earnerId}
            onSelect={(o) => setEarnerId(o?.value || '')}
            options={earnerOpts.options}
            loading={earnerOpts.loading}
            remote
            placeholder={USER_FILTER_PLACEHOLDER}
            width={200}
            emptyHint={USER_FILTER_EMPTY_HINT}
          />
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>来源</label>
          <SearchSelect
            text={fromUserText}
            onTextChange={(t) => {
              setFromUserText(t);
              if (fromUserId) setFromUserId('');
            }}
            value={fromUserId}
            onSelect={(o) => setFromUserId(o?.value || '')}
            options={fromUserOpts.options}
            loading={fromUserOpts.loading}
            remote
            placeholder={USER_FILTER_PLACEHOLDER}
            width={200}
            emptyHint={USER_FILTER_EMPTY_HINT}
          />
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>时间</label>
          <DateField value={from} onChange={setFrom} />
          <span style={{ opacity: 0.6 }}>至</span>
          <DateField value={to} onChange={setTo} />
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
        <div className="row">
          <h3 style={{ margin: 0, flex: 1 }}>全部记录</h3>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>获得者（目标）</th>
                <th>层级</th>
                <th>来源用户</th>
                <th>平仓利润</th>
                <th>品种</th>
                <th>平仓订单号</th>
                <th>利润来源</th>
                <th>比例</th>
                <th>佣金</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && !loading ? (
                <tr>
                  <td colSpan={11} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                    暂无佣金记录
                  </td>
                </tr>
              ) : (
                items.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                    <td style={{ userSelect: 'text' }}>{userLabel(r.earner)}</td>
                    <td>{LEVEL_LABEL[r.level] || r.level}</td>
                    <td style={{ userSelect: 'text' }}>{userLabel(r.fromUser)}</td>
                    <td
                      className="mono nowrap"
                      style={{
                        color:
                          Number(r.profit?.profit) >= 0 ? 'var(--ok)' : 'var(--danger, #c0392b)',
                      }}
                    >
                      {r.profit ? fmtProfit(r.profit.profit) : '—'}
                    </td>
                    <td className="nowrap">{coinLabel(r.profit)}</td>
                    <td className="mono nowrap" title={r.profit?.orderId || undefined}>
                      {r.profit?.orderId || '—'}
                    </td>
                    <td className="nowrap">
                      {SOURCE_LABEL[r.profit?.source] || r.profit?.source || '—'}
                    </td>
                    <td>{r.rate ? `${(Number(r.rate) * 100).toFixed(2)}%` : '—'}</td>
                    <td className="mono nowrap" style={{ color: 'var(--ok)' }}>
                      +{Number(r.amount).toLocaleString('en-US', {
                        minimumFractionDigits: 8,
                        maximumFractionDigits: 8,
                      })}
                    </td>
                    <td className="nowrap">
                      <button type="button" className="ghost" onClick={() => void openSource(r.id)}>
                        查看来源
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="list-footer">
          <div className="list-summary" title="按当前筛选全量汇总，非本页小计；同一平仓拆成多条佣金时利润只计一次">
            <span className="sum-item">
              平仓利润汇总
              <span
                className="sum-val"
                style={{
                  color:
                    Number(summary?.profitSum) >= 0 ? 'var(--ok)' : 'var(--danger, #c0392b)',
                }}
              >
                {loading && !summary ? '—' : fmtProfit(summary?.profitSum)}
              </span>
            </span>
            <span className="sum-item">
              佣金汇总
              <span className="sum-val" style={{ color: 'var(--ok)' }}>
                {loading && !summary ? '—' : fmtProfit(summary?.amount)}
              </span>
            </span>
          </div>
          <Pagination
            total={pager.total}
            page={pager.page}
            pageSize={pager.pageSize}
            pageSizes={[10, 20, 50, 100]}
            disabled={loading}
            onChange={onPageChange}
          />
        </div>
      </div>

      <DraggableFloatPanel
        open={sourceLoading || !!sourceDetail || !!sourceErr}
        title="佣金来源"
        onClose={() => {
          setSourceDetail(null);
          setSourceErr('');
          setSourceLoading(false);
        }}
        initialX={Math.max(40, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 800) / 2 - 200))}
        initialY={100}
        width={420}
      >
        {sourceLoading ? <p className="hint">加载中…</p> : null}
        {sourceErr ? <p className="err">{sourceErr}</p> : null}
        {sourceDetail ? (
          <div className="float-kv">
            <span className="k">佣金层级</span>
            <span className="v">
              {LEVEL_LABEL[sourceDetail.commission.level] || sourceDetail.commission.level}
            </span>
            <span className="k">佣金比例</span>
            <span className="v">{(Number(sourceDetail.commission.rate) * 100).toFixed(2)}%</span>
            <span className="k">佣金金额</span>
            <span className="v" style={{ color: 'var(--ok)' }}>
              +{Number(sourceDetail.commission.amount).toLocaleString('en-US', {
                minimumFractionDigits: 8,
                maximumFractionDigits: 8,
              })}
            </span>
            <span className="k">获得者</span>
            <span className="v">{userLabel(sourceDetail.commission.earner)}</span>
            <span className="k">来源用户</span>
            <span className="v">{userLabel(sourceDetail.commission.fromUser)}</span>

            <span className="k">平仓利润</span>
            <span
              className="v"
              style={{
                color: Number(sourceDetail.profit.profit) >= 0 ? 'var(--ok)' : 'var(--danger, #c0392b)',
              }}
            >
              {fmtProfit(sourceDetail.profit.profit)}
            </span>
            <span className="k">品种</span>
            <span className="v">{sourceDetail.profit.symbol}</span>
            <span className="k">交易所</span>
            <span className="v">{sourceDetail.profit.exchange}</span>
            <span className="k">平仓时间</span>
            <span className="v">{new Date(sourceDetail.profit.closedAt).toLocaleString()}</span>
            <span className="k">利润来源</span>
            <span className="v">
              {SOURCE_LABEL[sourceDetail.profit.source] || sourceDetail.profit.source}
            </span>
            <span className="k">平仓订单号</span>
            <span className="v mono">{sourceDetail.profit.orderId || '—'}</span>

            {sourceDetail.traceHint ? (
              <>
                <span className="k">说明</span>
                <span className="v hint">{sourceDetail.traceHint}</span>
              </>
            ) : null}

            {sourceDetail.closeLog ? (
              <>
                <span className="k" style={{ marginTop: 8 }}>
                  平仓挂单
                </span>
                <span className="v">
                  {sourceDetail.closeLog.coinName || '—'}
                  {sourceDetail.closeLog.equalCoinName
                    ? `/${sourceDetail.closeLog.equalCoinName}`
                    : ''}{' '}
                  · {sourceDetail.closeLog.positionSide || '—'} · {sourceDetail.closeLog.status}
                </span>
                <span className="k">成交量 / 均价</span>
                <span className="v mono">
                  {sourceDetail.closeLog.filledAmt || '—'} @ {sourceDetail.closeLog.avgPrice || '—'}
                </span>
                <span className="k">手续费</span>
                <span className="v mono">{sourceDetail.closeLog.tradeFee || '—'}</span>
                <span className="k">挂单时间</span>
                <span className="v">
                  {new Date(sourceDetail.closeLog.createdAt).toLocaleString()}
                </span>
                <span className="k">主账户</span>
                <span className="v">
                  {sourceDetail.closeLog.accountName || sourceDetail.closeLog.accountGid || '—'}
                </span>
              </>
            ) : null}

            {sourceDetail.openLots.length > 0 ? (
              <>
                <span className="k" style={{ marginTop: 8 }}>
                  配对开仓
                </span>
                <span className="v">
                  {sourceDetail.openLots.map((o, i) => (
                    <div key={o.id} style={{ marginBottom: i < sourceDetail.openLots.length - 1 ? 8 : 0 }}>
                      <div>
                        {o.coinName || '—'} · 开 · {o.status}
                        {o.profitConsumed ? ' · 已配完' : ''}
                      </div>
                      <div className="mono hint" style={{ fontSize: 11 }}>
                        成交 {o.filledAmt || '—'} · 已消耗 {o.consumedAmt || '—'} · 均价{' '}
                        {o.avgPrice || '—'}
                      </div>
                      {o.orderId ? (
                        <div className="mono hint" style={{ fontSize: 11 }}>
                          订单 {o.orderId}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </span>
              </>
            ) : null}

            <span className="k" style={{ marginTop: 8 }}>
              相关页面
            </span>
            <span className="v">
              <Link to="/trade/order-logs">挂单日志</Link>
              {' · '}
              <Link to="/reconcile">日对账</Link>
            </span>
          </div>
        ) : null}
      </DraggableFloatPanel>
    </div>
  );
}
