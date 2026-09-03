import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { DateField } from '../components/DateField';
import { ListLoading } from '../components/ListLoading';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { Pagination } from '../components/Pagination';
import { normalizePaged, usePager } from '../hooks/usePager';

const TX_LABEL: Record<string, string> = {
  RECHARGE: '充值',
  COMMISSION: '佣金入账',
  SHARE_DEDUCT: '分润扣减',
  WITHDRAW: '提现',
  WITHDRAW_REFUND: '提现退回',
  TRADE_PNL: '平仓获利',
  ADJUST: '人工调整',
};

const RECHARGE_STATUS: Record<string, string> = {
  PENDING: '待确认',
  CONFIRMED: '已确认',
  CREDITED: '已入账',
  FAILED: '失败',
};

type Tab = 'cards' | 'txs' | 'recharges';

function userLabel(u?: { userNo?: number | null; nickname?: string | null; email?: string } | null, fallback?: string) {
  if (!u) return fallback || '—';
  const name = u.nickname || u.email || fallback || '—';
  return u.userNo != null ? `${name}（#${u.userNo}）` : name;
}

export function PointCardPage() {
  const [tab, setTab] = useState<Tab>('cards');
  const [userNo, setUserNo] = useState('');
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cards, setCards] = useState<any[]>([]);
  const [txs, setTxs] = useState<any[]>([]);
  const [recharges, setRecharges] = useState<any[]>([]);
  const [filterUserId, setFilterUserId] = useState('');
  const [filterUserLabel, setFilterUserLabel] = useState('');
  const [txType, setTxType] = useState('');
  const [rechargeStatus, setRechargeStatus] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const pager = usePager(20);

  const [adjustTarget, setAdjustTarget] = useState<{
    userId: string;
    label: string;
    balance: string;
  } | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustRemark, setAdjustRemark] = useState('');

  const commonFilters = useCallback(
    () => ({
      userNo: userNo.trim() || undefined,
      account: account.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      userId: filterUserId || undefined,
    }),
    [userNo, account, from, to, filterUserId],
  );

  const loadCards = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setErr('');
      setLoading(true);
      const f = commonFilters();
      AdminApi.pointCards({
        userNo: f.userNo,
        account: f.account,
        from: f.from,
        to: f.to,
        skip: (p - 1) * size,
        take: size,
      })
        .then((r) => {
          const { items, total } = normalizePaged(r);
          setCards(items);
          pager.setTotal(total);
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    },
    [commonFilters, pager.page, pager.pageSize],
  );

  const loadTxs = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setErr('');
      setLoading(true);
      const f = commonFilters();
      AdminApi.pointTxs({
        userId: f.userId,
        userNo: f.userNo,
        account: f.account,
        type: txType || undefined,
        from: f.from,
        to: f.to,
        skip: (p - 1) * size,
        take: size,
      })
        .then((r) => {
          const { items, total } = normalizePaged(r);
          setTxs(items);
          pager.setTotal(total);
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    },
    [commonFilters, txType, pager.page, pager.pageSize],
  );

  const loadRecharges = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setErr('');
      setLoading(true);
      const f = commonFilters();
      AdminApi.recharges({
        status: rechargeStatus || undefined,
        userId: f.userId,
        userNo: f.userNo,
        account: f.account,
        from: f.from,
        to: f.to,
        skip: (p - 1) * size,
        take: size,
      })
        .then((r) => {
          const { items, total } = normalizePaged(r);
          setRecharges(items);
          pager.setTotal(total);
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    },
    [commonFilters, rechargeStatus, pager.page, pager.pageSize],
  );

  const reload = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      if (tab === 'cards') loadCards(opts);
      else if (tab === 'txs') loadTxs(opts);
      else loadRecharges(opts);
    },
    [tab, loadCards, loadTxs, loadRecharges],
  );

  useEffect(() => {
    pager.goFirst();
    reload({ page: 1 });
  }, [tab, txType, rechargeStatus, filterUserId]);

  function search() {
    pager.goFirst();
    reload({ page: 1 });
  }

  function onPageChange(nextPage: number, nextSize: number) {
    pager.onPageChange(nextPage, nextSize);
    reload({ page: nextPage, pageSize: nextSize });
  }

  function openAdjust(c: any) {
    setAdjustTarget({
      userId: c.userId,
      label: userLabel(c.user, c.userId),
      balance: String(c.balance),
    });
    setAdjustAmount('');
    setAdjustRemark('');
    setErr('');
    setMsg('');
  }

  async function submitAdjust() {
    if (!adjustTarget) return;
    const amount = Number(adjustAmount);
    if (!isFinite(amount) || amount === 0) {
      setErr('请输入有效非零金额（正数增加，负数扣减）');
      return;
    }
    if (!adjustRemark.trim()) {
      setErr('请填写调账备注');
      return;
    }
    setBusy(adjustTarget.userId);
    setErr('');
    try {
      await AdminApi.adjustPointCard(adjustTarget.userId, amount, adjustRemark.trim());
      const label = adjustTarget.label;
      const uid = adjustTarget.userId;
      setAdjustTarget(null);
      setMsg(`已调账 ${label}：${amount > 0 ? '+' : ''}${amount}，已跳转流水记录`);
      setFilterUserId(uid);
      setFilterUserLabel(label);
      setTxType('ADJUST');
      setTab('txs');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  function viewUser(userId: string, label: string, next: Tab) {
    setFilterUserId(userId);
    setFilterUserLabel(label);
    setTab(next);
  }

  function clearUserFilter() {
    setFilterUserId('');
    setFilterUserLabel('');
  }

  function resetFilters() {
    setUserNo('');
    setAccount('');
    setFrom('');
    setTo('');
    setFilterUserId('');
    setFilterUserLabel('');
    pager.goFirst();
    setLoading(true);
    setErr('');
    const size = pager.pageSize;
    const run =
      tab === 'cards'
        ? AdminApi.pointCards({ skip: 0, take: size }).then((r) => {
            const { items, total } = normalizePaged(r);
            setCards(items);
            pager.setTotal(total);
          })
        : tab === 'txs'
          ? AdminApi.pointTxs({ type: txType || undefined, skip: 0, take: size }).then((r) => {
              const { items, total } = normalizePaged(r);
              setTxs(items);
              pager.setTotal(total);
            })
          : AdminApi.recharges({ status: rechargeStatus || undefined, skip: 0, take: size }).then((r) => {
              const { items, total } = normalizePaged(r);
              setRecharges(items);
              pager.setTotal(total);
            });
    run.catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }

  const pagerEl = (
    <Pagination
      total={pager.total}
      page={pager.page}
      pageSize={pager.pageSize}
      pageSizes={[10, 20, 50, 100]}
      disabled={loading}
      onChange={onPageChange}
    />
  );

  return (
    <div className="page-list">
      <p className="hint">
        调账写入流水类型「人工调整」；正式加款请到「链上充值」页用手动充值（类型「充值」并记充值单）。
      </p>
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="tabs">
        <button
          className={tab === 'cards' ? 'tab active' : 'tab ghost'}
          onClick={() => setTab('cards')}
        >
          点卡列表
        </button>
        <button className={tab === 'txs' ? 'tab active' : 'tab ghost'} onClick={() => setTab('txs')}>
          流水记录
        </button>
        <button
          className={tab === 'recharges' ? 'tab active' : 'tab ghost'}
          onClick={() => setTab('recharges')}
        >
          充值记录
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {tab === 'txs' ? (
            <select value={txType} onChange={(e) => setTxType(e.target.value)}>
              <option value="">全部类型</option>
              {Object.entries(TX_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          ) : null}
          {tab === 'recharges' ? (
            <select value={rechargeStatus} onChange={(e) => setRechargeStatus(e.target.value)}>
              <option value="">全部状态</option>
              {Object.entries(RECHARGE_STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          ) : null}
          <input
            placeholder="用户ID"
            value={userNo}
            onChange={(e) => setUserNo(e.target.value)}
            style={{ width: 110 }}
          />
          <input
            placeholder="昵称"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            style={{ width: 160 }}
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
          <button className="ghost" onClick={() => reload()} disabled={loading}>
            刷新
          </button>
        </div>
        {filterUserId ? (
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            当前定点用户：{filterUserLabel || filterUserId}{' '}
            <button type="button" className="ghost" onClick={clearUserFilter}>
              清除
            </button>
          </p>
        ) : null}
      </div>

      {tab === 'cards' ? (
        <div className="card list-loading-wrap">
          <ListLoading show={loading} text="查询中…" />
          <table>
            <thead>
              <tr>
                <th>用户</th>
                <th>状态</th>
                <th>可用余额</th>
                <th>冻结</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {cards.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                    暂无点卡数据
                  </td>
                </tr>
              ) : (
                cards.map((c) => {
                  const label = userLabel(c.user, c.userId);
                  return (
                    <tr key={c.id}>
                      <td style={{ userSelect: 'text' }}>{label}</td>
                      <td>
                        <span className={`badge ${c.user?.status === 'ACTIVE' ? 'ok' : ''}`}>
                          {c.user?.status}
                        </span>
                      </td>
                      <td>{String(c.balance)}</td>
                      <td>{String(c.frozen)}</td>
                      <td>{new Date(c.updatedAt).toLocaleString()}</td>
                      <td className="row">
                        <button disabled={busy === c.userId} onClick={() => openAdjust(c)}>
                          调账
                        </button>
                        <button className="ghost" onClick={() => viewUser(c.userId, label, 'txs')}>
                          流水
                        </button>
                        <button
                          className="ghost"
                          onClick={() => viewUser(c.userId, label, 'recharges')}
                        >
                          充值
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {pagerEl}
        </div>
      ) : null}

      {tab === 'txs' ? (
        <div className="card list-loading-wrap">
          <ListLoading show={loading} text="查询中…" />
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>用户</th>
                <th>类型</th>
                <th>变动</th>
                <th>余额后</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {txs.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                    暂无流水
                  </td>
                </tr>
              ) : (
                txs.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.createdAt).toLocaleString()}</td>
                    <td style={{ userSelect: 'text' }}>{userLabel(t.user, t.userId)}</td>
                    <td>{TX_LABEL[t.type] || t.type}</td>
                    <td style={{ color: Number(t.amount) >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                      {Number(t.amount) >= 0 ? '+' : ''}
                      {String(t.amount)}
                    </td>
                    <td>{String(t.balanceAfter)}</td>
                    <td>{t.remark || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {pagerEl}
        </div>
      ) : null}

      {tab === 'recharges' ? (
        <div className="card list-loading-wrap">
          <ListLoading show={loading} text="查询中…" />
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>用户</th>
                <th>金额</th>
                <th>链</th>
                <th>状态</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {recharges.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                    暂无充值记录
                  </td>
                </tr>
              ) : (
                recharges.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td style={{ userSelect: 'text' }}>{userLabel(r.user, r.userId)}</td>
                    <td>
                      {String(r.amount)} {r.tokenSymbol || ''}
                    </td>
                    <td>{r.chain || '—'}</td>
                    <td>
                      <span className={`badge ${r.status === 'CREDITED' ? 'ok' : ''}`}>
                        {RECHARGE_STATUS[r.status] || r.status}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                      {r.txHash ? `${String(r.txHash).slice(0, 10)}…` : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {pagerEl}
        </div>
      ) : null}

      {adjustTarget ? (
        <div className="modal-backdrop" onClick={() => setAdjustTarget(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="modal-head">
              <h3>点卡调账</h3>
              <ModalCloseButton onClick={() => setAdjustTarget(null)} />
            </div>
            <p className="hint" style={{ marginBottom: 16 }}>
              用户：{adjustTarget.label}
              <br />
              当前余额：{adjustTarget.balance}
            </p>
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--muted)', fontSize: 12 }}>
              调整金额（正数增加，负数扣减）
            </label>
            <input
              value={adjustAmount}
              onChange={(e) => setAdjustAmount(e.target.value)}
              placeholder="例如 100 或 -50"
              style={{ width: '100%', marginBottom: 16 }}
            />
            <label style={{ display: 'block', marginBottom: 8, color: 'var(--muted)', fontSize: 12 }}>
              备注（必填）
            </label>
            <input
              value={adjustRemark}
              onChange={(e) => setAdjustRemark(e.target.value)}
              placeholder="调账原因，将写入流水"
              style={{ width: '100%', marginBottom: 20 }}
            />
            <div className="row">
              <button onClick={submitAdjust} disabled={busy === adjustTarget.userId}>
                确认调账
              </button>
              <button type="button" className="ghost" onClick={() => setAdjustTarget(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

