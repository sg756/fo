import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminApi } from '../api';
import { DateField } from '../components/DateField';
import { SearchSelect } from '../components/SearchSelect';
import {
  useUserOptions,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

const STATUS_LABEL: Record<string, string> = {
  ok: '平衡',
  skip: '跳过(亏损)',
  unsettled: '未结算',
  missing_deduct: '缺扣点卡',
  missing_commission: '缺佣金',
  mismatch: '金额不符',
};

const ISSUE_LABEL: Record<string, string> = {
  UNSETTLED: '未结算',
  MISSING_DEDUCT: '缺 SHARE_DEDUCT',
  MISSING_COMMISSION: '缺佣金',
  AMOUNT_MISMATCH: '扣点卡≠佣金',
  ORPHAN_DEDUCT: '孤儿扣点卡',
  CROSS_DAY_DEDUCT: '跨日扣点卡',
};

type Tab = 'recent' | 'day' | 'issues';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 含今天在内往前 n 天的起始日 */
function rangeStartStr(daysInclusive: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (Math.max(1, daysInclusive) - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmt(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function userDisplay(r: {
  userNickname?: string | null;
  userEmail?: string | null;
  userNo?: number | null;
}) {
  const nick = String(r.userNickname || '').trim();
  const name = nick || r.userEmail || '—';
  return r.userNo != null ? `${name}（#${r.userNo}）` : name;
}

export function ReconcilePage() {
  const [searchParams] = useSearchParams();
  const [date, setDate] = useState(todayStr);
  const [data, setData] = useState<any>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(() => searchParams.get('issues') === '1');
  const [tab, setTab] = useState<Tab>(() =>
    searchParams.get('issues') === '1' || searchParams.get('tab') === 'issues'
      ? 'day'
      : 'recent',
  );

  const [rangeFrom, setRangeFrom] = useState(() => rangeStartStr(7));
  const [rangeTo, setRangeTo] = useState(todayStr);
  const [appliedRange, setAppliedRange] = useState(() => ({
    from: rangeStartStr(7),
    to: todayStr(),
  }));
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [appliedUser, setAppliedUser] = useState('');
  const userOpts = useUserOptions(userText, userId);

  function draftUser(): string {
    return userId.trim() || userText.trim();
  }

  const loadDay = useCallback(async (userOverride?: string) => {
    const user = userOverride !== undefined ? userOverride : appliedUser;
    setBusy(true);
    setErr('');
    try {
      const day = await AdminApi.reconcileDay(date, user || undefined);
      setData(day);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, [date, appliedUser]);

  const loadRecent = useCallback(async (from: string, to: string, user?: string) => {
    const u = user !== undefined ? user : appliedUser;
    setBusy(true);
    setErr('');
    try {
      const res = await AdminApi.reconcileRecent({ from, to, user: u || undefined });
      setRecent(Array.isArray(res?.items) ? res.items : []);
      if (res?.from && res?.to) {
        setAppliedRange({ from: res.from, to: res.to });
        setRangeFrom(res.from);
        setRangeTo(res.to);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, [appliedUser]);

  useEffect(() => {
    void loadDay();
  }, [loadDay]);

  useEffect(() => {
    void loadRecent(appliedRange.from, appliedRange.to, appliedUser);
    // 仅首次 + 主动查询时改 appliedRange / appliedUser
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedRange.from, appliedRange.to, appliedUser]);

  const rows = useMemo(() => {
    const list = Array.isArray(data?.rows) ? data.rows : [];
    if (!onlyIssues) return list;
    return list.filter((r: any) => r.status !== 'ok' && r.status !== 'skip');
  }, [data, onlyIssues]);

  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const s = data?.summary;

  useEffect(() => {
    if (tab === 'issues' && issues.length === 0) setTab('day');
  }, [tab, issues.length]);

  function openDay(day: string) {
    setDate(day);
    setTab('day');
  }

  function queryRange() {
    const f = rangeFrom.trim();
    const t = rangeTo.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      setErr('请选择有效的起止日期（YYYY-MM-DD）');
      return;
    }
    const from = f <= t ? f : t;
    const to = f <= t ? t : f;
    const fromMs = Date.parse(`${from}T00:00:00`);
    const toMs = Date.parse(`${to}T00:00:00`);
    const span = Math.floor((toMs - fromMs) / 86400000) + 1;
    if (!(span >= 1) || span > 62) {
      setErr('日期跨度最多 62 天');
      return;
    }
    setErr('');
    const u = draftUser();
    setAppliedUser(u);
    setAppliedRange({ from, to });
    if (from === appliedRange.from && to === appliedRange.to && u === appliedUser) {
      void loadRecent(from, to, u);
      void loadDay(u);
    }
    setTab('recent');
  }

  function presetDays(n: number) {
    const to = todayStr();
    const from = rangeStartStr(n);
    const u = draftUser();
    setRangeFrom(from);
    setRangeTo(to);
    setAppliedUser(u);
    setAppliedRange({ from, to });
    if (from === appliedRange.from && to === appliedRange.to && u === appliedUser) {
      void loadRecent(from, to, u);
      void loadDay(u);
    }
    setTab('recent');
  }

  const summaryDays = useMemo(() => {
    const fromMs = Date.parse(`${appliedRange.from}T00:00:00`);
    const toMs = Date.parse(`${appliedRange.to}T00:00:00`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return recent.length || 7;
    return Math.max(1, Math.floor((toMs - fromMs) / 86400000) + 1);
  }, [appliedRange.from, appliedRange.to, recent.length]);

  return (
    <div className="page-list reconcile-page">
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <div
          className="row"
          style={{
            marginTop: 8,
            marginBottom: 0,
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
            fontSize: 12,
          }}
        >
          <span className="hint" style={{ margin: 0 }}>
            对账日
          </span>
          <DateField value={date} onChange={setDate} />
          <button
            type="button"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => {
              const u = draftUser();
              setAppliedUser(u);
              if (u === appliedUser) void loadDay(u);
            }}
            disabled={busy}
          >
            {busy ? '核对中…' : '重新核对'}
          </button>
          <span className="hint" style={{ margin: '0 0 0 8px' }}>
            用户
          </span>
          <SearchSelect
            text={userText}
            onTextChange={(t) => {
              setUserText(t);
              if (userId) setUserId('');
            }}
            value={userId}
            onSelect={(o) => {
              setUserId(o?.value || '');
              if (o?.label) setUserText(o.label);
            }}
            options={userOpts.options}
            loading={userOpts.loading}
            remote
            placeholder={USER_FILTER_PLACEHOLDER}
            width={168}
            emptyHint={USER_FILTER_EMPTY_HINT}
          />
          <span className="hint" style={{ margin: '0 0 0 8px' }}>
            时间范围
          </span>
          <DateField value={rangeFrom} onChange={setRangeFrom} title="开始日期" />
          <span style={{ opacity: 0.6 }}>至</span>
          <DateField value={rangeTo} onChange={setRangeTo} title="结束日期" />
          <button
            type="button"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={queryRange}
            disabled={busy}
          >
            查询
          </button>
          <button
            type="button"
            className="ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => presetDays(7)}
            disabled={busy}
          >
            近7日
          </button>
          <button
            type="button"
            className="ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => presetDays(30)}
            disabled={busy}
          >
            近30日
          </button>
          {s ? (
            <>
              <span
                className={`badge ${s.balanced ? 'ok' : 'danger'}`}
                style={{ marginLeft: 4 }}
              >
                {s.balanced
                  ? s.issueCount
                    ? `平衡·跨日${s.issueCount}`
                    : '平衡'
                  : `异常 ${s.hardIssueCount ?? s.issueCount}`}
              </span>
              <span className="hint" style={{ margin: 0 }}>
                正利润 {s.profitPositiveCount}/{fmt(s.profitPositiveSum)} · 扣 {fmt(s.deductSum)} · 佣{' '}
                {fmt(s.commissionSum)} · 差 {fmt(s.deductVsCommissionDiff)} · OK {s.matchedOk}
              </span>
            </>
          ) : null}
        </div>

        <div className="tabs" style={{ alignItems: 'center' }}>
          <button
            type="button"
            className={tab === 'recent' ? 'tab active' : 'tab'}
            onClick={() => setTab('recent')}
          >
            近 {summaryDays} 日摘要
          </button>
          <button
            type="button"
            className={tab === 'day' ? 'tab active' : 'tab'}
            onClick={() => setTab('day')}
          >
            当日利润行（{rows.length}）
          </button>
          {issues.length > 0 ? (
            <button
              type="button"
              className={tab === 'issues' ? 'tab active' : 'tab'}
              onClick={() => setTab('issues')}
            >
              异常明细（{issues.length}）
            </button>
          ) : null}
          {tab === 'day' ? (
            <label
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 6,
                cursor: 'pointer',
                userSelect: 'none',
                fontSize: 12,
              }}
            >
              <input
                type="checkbox"
                checked={onlyIssues}
                onChange={(e) => setOnlyIssues(e.target.checked)}
                style={{ width: 14, height: 14, margin: 0 }}
              />
              仅看异常行
            </label>
          ) : null}
        </div>

        <div className="table-scroll">
          {tab === 'recent' ? (
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>正利润</th>
                  <th>扣点卡</th>
                  <th>佣金</th>
                  <th>差</th>
                  <th>异常</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.day}>
                    <td>{r.day}</td>
                    <td>{fmt(r.profitPositiveSum)}</td>
                    <td>{fmt(r.deductSum)}</td>
                    <td>{fmt(r.commissionSum)}</td>
                    <td
                      style={{
                        color:
                          Math.abs(r.deductVsCommissionDiff || 0) > 1e-4 ? 'var(--danger)' : undefined,
                      }}
                    >
                      {fmt(r.deductVsCommissionDiff)}
                    </td>
                    <td style={{ color: r.issueCount ? 'var(--danger)' : 'var(--ok)' }}>
                      {r.balanced ? 'OK' : r.issueCount}
                    </td>
                    <td>
                      <button type="button" className="ghost" onClick={() => openDay(r.day)}>
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
                {!recent.length && !busy ? (
                  <tr>
                    <td colSpan={7} className="hint list-empty">
                      暂无摘要
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          ) : null}

          {tab === 'day' ? (
            <table>
              <thead>
                <tr>
                  <th>状态</th>
                  <th>用户</th>
                  <th>品种</th>
                  <th>利润</th>
                  <th>扣点卡</th>
                  <th>佣金</th>
                  <th>来源</th>
                  <th>平仓时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.profitId}>
                    <td
                      style={{
                        color: r.status === 'ok' || r.status === 'skip' ? undefined : 'var(--danger)',
                      }}
                    >
                      {STATUS_LABEL[r.status] || r.status}
                    </td>
                    <td>{userDisplay(r)}</td>
                    <td>{r.symbol}</td>
                    <td style={{ color: r.profit >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                      {fmt(r.profit)}
                    </td>
                    <td>{fmt(r.deduct)}</td>
                    <td>{fmt(r.commission)}</td>
                    <td>{r.source}</td>
                    <td>{r.closedAt ? new Date(r.closedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={8} className="hint list-empty">
                      当日无利润记录
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          ) : null}

          {tab === 'issues' ? (
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>用户</th>
                  <th>利润</th>
                  <th>扣点卡</th>
                  <th>佣金</th>
                  <th>说明</th>
                  <th>profitId</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i: any, idx: number) => (
                  <tr key={`${i.kind}-${i.profitId || idx}`}>
                    <td>{ISSUE_LABEL[i.kind] || i.kind}</td>
                    <td>{userDisplay(i)}</td>
                    <td>{fmt(i.profit)}</td>
                    <td>{fmt(i.deduct)}</td>
                    <td>{fmt(i.commission)}</td>
                    <td>{i.detail}</td>
                    <td style={{ fontSize: 12 }}>{i.profitId || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </div>
  );
}
