import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AdminApi } from '../api';

const LEVEL_LABEL: Record<string, string> = {
  DIRECT: '直推',
  INDIRECT: '间推',
  L1: '直推',
  L2: '间推',
  PLATFORM: '平台',
};

function fmtAmt(n: number | string | undefined | null) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0.0000';
  return v.toFixed(4);
}

export function UserRebatePage() {
  const { userId = '' } = useParams();
  const [tab, setTab] = useState<'txs' | 'daily'>('txs');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [daily, setDaily] = useState<any[]>([]);
  const [dailyTotal, setDailyTotal] = useState<{ count: number; amount: number } | null>(null);

  const load = useCallback(() => {
    if (!userId) return;
    setLoading(true);
    setErr('');
    Promise.all([
      AdminApi.userDetail(userId),
      AdminApi.commissionRecords(userId, 200),
      AdminApi.commissionDailySummary(userId, 90),
    ])
      .then(([user, rec, day]) => {
        setProfile(user);
        setItems(rec.items || []);
        setSummary(rec.summary || null);
        setDaily(day.items || []);
        setDailyTotal(day.total || null);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const totalAmt = summary?.amount ?? 0;
  const totalCnt = summary?.count ?? 0;
  const directAmt = summary?.byLevel?.DIRECT?.amount ?? summary?.byLevel?.L1?.amount ?? 0;
  const indirectAmt = summary?.byLevel?.INDIRECT?.amount ?? summary?.byLevel?.L2?.amount ?? 0;

  return (
    <div className="rebate-page page-list">
      <header className="rebate-page-head">
        <div className="rebate-title-row">
          <div>
            <p className="rebate-sub">
              返利汇总
              {profile?.userNo != null ? ` · ID ${profile.userNo}` : ''}
              {profile?.inviteCode ? ` · 邀请码 ${profile.inviteCode}` : ''}
            </p>
          </div>
          <button type="button" className="ghost" onClick={load} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
      </header>

      {err ? <p className="err">{err}</p> : null}

      <div className="rebate-stats">
        <div className="rebate-stat">
          <div className="label">累计返利</div>
          <div className="value ok">{fmtAmt(totalAmt)}</div>
          <div className="extra">{totalCnt} 笔</div>
        </div>
        <div className="rebate-stat">
          <div className="label">直推返利</div>
          <div className="value">{fmtAmt(directAmt)}</div>
        </div>
        <div className="rebate-stat">
          <div className="label">间推返利</div>
          <div className="value">{fmtAmt(indirectAmt)}</div>
        </div>
        <div className="rebate-stat">
          <div className="label">{tab === 'daily' ? '近 90 日' : '列表笔数'}</div>
          <div className="value">
            {tab === 'daily' ? dailyTotal?.count ?? 0 : totalCnt}
          </div>
          <div className="extra">
            {tab === 'daily' ? `${daily.length} 天 · ${fmtAmt(dailyTotal?.amount ?? 0)}` : '流水记录'}
          </div>
        </div>
      </div>

      <div className="segmented" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'txs'}
          className={tab === 'txs' ? 'active' : ''}
          onClick={() => setTab('txs')}
        >
          返利流水
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'daily'}
          className={tab === 'daily' ? 'active' : ''}
          onClick={() => setTab('daily')}
        >
          日汇总
        </button>
      </div>

      <div className="card rebate-table-card">
        {tab === 'txs' ? (
          items.length === 0 && !loading ? (
            <div className="rebate-empty">暂无返利流水</div>
          ) : (
            <div className="rebate-body">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>来源用户</th>
                    <th>层级</th>
                    <th>比例</th>
                    <th>金额</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td className="muted nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                      <td>
                        {r.fromUser?.nickname || r.fromUser?.email || '—'}
                        {r.fromUser?.userNo != null ? (
                          <span className="muted tag">#{r.fromUser.userNo}</span>
                        ) : null}
                      </td>
                      <td>{LEVEL_LABEL[r.level] || r.level}</td>
                      <td>{r.rate ? `${(Number(r.rate) * 100).toFixed(2)}%` : '—'}</td>
                      <td className="rebate-amt">+{fmtAmt(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : daily.length === 0 && !loading ? (
          <div className="rebate-empty">暂无日汇总</div>
        ) : (
          <div className="rebate-body">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>笔数</th>
                  <th>合计</th>
                  <th>直推</th>
                  <th>间推</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => (
                  <tr key={d.day}>
                    <td className="mono">{d.day}</td>
                    <td>{d.count}</td>
                    <td className="rebate-amt">{fmtAmt(d.amount)}</td>
                    <td>{fmtAmt(d.direct)}</td>
                    <td>{fmtAmt(d.indirect)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
