import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { UserDetailModal, uplineLabel } from '../components/UserDetailModal';
import { UserPasswordModal } from '../components/UserPasswordModal';
import { DateField } from '../components/DateField';
import { Pagination } from '../components/Pagination';
import { ListLoading } from '../components/ListLoading';

function fmtTime(v?: string | null) {
  if (!v) return '—';
  return new Date(v).toLocaleString();
}

function fmtPoint(n?: number) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0.0000';
  return v.toFixed(4);
}

export function UserListPage() {
  const [status, setStatus] = useState('');
  const [userNo, setUserNo] = useState('');
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pwdUserId, setPwdUserId] = useState<string | null>(null);

  const load = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? page;
      const size = opts?.pageSize ?? pageSize;
      setErr('');
      setMsg('');
      setLoading(true);
      AdminApi.users({
        status: status || undefined,
        userNo: userNo.trim() || undefined,
        account: account.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
        skip: (p - 1) * size,
        take: size,
      })
        .then((r) => {
          setItems(r.items || []);
          setTotal(r.total ?? 0);
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    },
    [status, userNo, account, from, to, page, pageSize],
  );

  useEffect(() => {
    load({ page: 1 });
    setPage(1);
  }, [status]); // 切状态自动查；其它条件点查询

  async function disable(u: any) {
    const name = u.nickname || u.email;
    if (!(await confirmDialog(`禁用用户 ${name}？禁用后将停止自动开单。`))) return;
    setBusy(u.id);
    setMsg('');
    setErr('');
    try {
      await AdminApi.disableUser(u.id);
      setMsg('已禁用，该用户不再自动开单');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function enable(u: any) {
    const name = u.nickname || u.email;
    if (!(await confirmDialog({ message: `启用用户 ${name}？`, danger: false }))) return;
    setBusy(u.id);
    setMsg('');
    setErr('');
    try {
      await AdminApi.enableUser(u.id);
      setMsg('已启用');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  function search() {
    setPage(1);
    load({ page: 1 });
  }

  function resetFilters() {
    setUserNo('');
    setAccount('');
    setFrom('');
    setTo('');
    setPage(1);
    setLoading(true);
    setErr('');
    setMsg('');
    AdminApi.users({
      status: status || undefined,
      skip: 0,
      take: pageSize,
    })
      .then((r) => {
        setItems(r.items || []);
        setTotal(r.total ?? 0);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }

  function onPageChange(nextPage: number, nextSize: number) {
    setPage(nextPage);
    setPageSize(nextSize);
    load({ page: nextPage, pageSize: nextSize });
  }

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="PENDING">待审核</option>
            <option value="ACTIVE">已通过</option>
            <option value="REJECTED">已拒绝</option>
            <option value="DISABLED">已禁用</option>
          </select>
          <input
            placeholder="用户ID"
            value={userNo}
            onChange={(e) => setUserNo(e.target.value)}
            style={{ width: 110 }}
          />
          <input
            placeholder="昵称 / 邀请码"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            style={{ width: 180 }}
          />
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>注册时间</label>
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
        <table className="user-list-table">
          <colgroup>
            <col style={{ width: 72 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 148 }} />
            <col style={{ width: 148 }} />
            <col style={{ width: 200 }} />
          </colgroup>
          <thead>
            <tr>
              <th>用户 ID</th>
              <th>账号</th>
              <th>邀请码</th>
              <th>直推上级</th>
              <th>间推上级</th>
              <th>点卡余额</th>
              <th>冻结</th>
              <th>可提佣金</th>
              <th>佣金冻结</th>
              <th>状态</th>
              <th>注册时间</th>
              <th>最后登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={13} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                  暂无用户
                </td>
              </tr>
            ) : (
              items.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.userNo ?? '—'}</td>
                  <td className="ellipsis" title={u.nickname || u.email || ''}>
                    {u.nickname || u.email}
                  </td>
                  <td className="mono">{u.inviteCode || '—'}</td>
                  <td className="ellipsis" title={uplineLabel({ ...u, which: 'l1' })}>
                    {uplineLabel({ ...u, which: 'l1' })}
                  </td>
                  <td className="ellipsis" title={uplineLabel({ ...u, which: 'l2' })}>
                    {uplineLabel({ ...u, which: 'l2' })}
                  </td>
                  <td className="mono num">{fmtPoint(u.pointBalance)}</td>
                  <td className="mono num">{fmtPoint(u.pointFrozen)}</td>
                  <td className="mono num">{fmtPoint(u.commissionBalance)}</td>
                  <td className="mono num">{fmtPoint(u.commissionFrozen)}</td>
                  <td>
                    <span
                      className={`badge ${
                        u.status === 'ACTIVE' ? 'ok' : u.status === 'DISABLED' ? 'danger' : ''
                      }`}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="nowrap muted">{fmtTime(u.createdAt)}</td>
                  <td className="nowrap muted">{fmtTime(u.lastLoginAt)}</td>
                  <td className="ops">
                    <button
                      className="ghost"
                      onClick={() => setDetailId(u.id)}
                    >
                      详情
                    </button>
                    <button className="ghost" onClick={() => setPwdUserId(u.id)}>
                      改密码
                    </button>
                    {u.status === 'ACTIVE' ? (
                      <button
                        className="ghost"
                        disabled={busy === u.id}
                        onClick={() => disable(u)}
                      >
                        禁用
                      </button>
                    ) : u.status === 'DISABLED' ? (
                      <button
                        className="ghost"
                        disabled={busy === u.id}
                        onClick={() => enable(u)}
                      >
                        启用
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <Pagination
          total={total}
          page={page}
          pageSize={pageSize}
          pageSizes={[10, 20, 50, 100]}
          disabled={loading}
          onChange={onPageChange}
        />
      </div>

      <UserDetailModal
        userId={detailId}
        onClose={() => setDetailId(null)}
      />
      <UserPasswordModal
        userId={pwdUserId}
        onClose={() => setPwdUserId(null)}
        onSaved={() => load()}
      />
    </div>
  );
}
