import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { DateField } from '../components/DateField';
import { Pagination } from '../components/Pagination';
import { ListLoading } from '../components/ListLoading';
import { UserDetailModal } from '../components/UserDetailModal';
import { normalizePaged, usePager } from '../hooks/usePager';

export function UsersPage() {
  const [status, setStatus] = useState('PENDING');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const pager = usePager(20);

  const load = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setErr('');
      setLoading(true);
      AdminApi.users({
        q: q.trim() || undefined,
        status: status || undefined,
        from: from || undefined,
        to: to || undefined,
        skip: (p - 1) * size,
        take: size,
      })
        .then((r) => {
          const { items: list, total } = normalizePaged(r);
          setItems(list);
          pager.setTotal(total);
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    },
    [q, status, from, to, pager.page, pager.pageSize],
  );

  useEffect(() => {
    load({ page: 1 });
    pager.goFirst();
  }, []); // 首次加载；条件点查询

  function search() {
    pager.goFirst();
    load({ page: 1 });
  }

  function resetFilters() {
    setStatus('PENDING');
    setQ('');
    setFrom('');
    setTo('');
    pager.goFirst();
    setLoading(true);
    setErr('');
    AdminApi.users({ status: 'PENDING', skip: 0, take: pager.pageSize })
      .then((r) => {
        const { items: list, total } = normalizePaged(r);
        setItems(list);
        pager.setTotal(total);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }

  function onPageChange(nextPage: number, nextSize: number) {
    pager.onPageChange(nextPage, nextSize);
    load({ page: nextPage, pageSize: nextSize });
  }

  async function act(id: string, kind: 'approve' | 'reject' | 'disable') {
    setBusy(id + kind);
    try {
      if (kind === 'approve') await AdminApi.approveUser(id);
      if (kind === 'reject') await AdminApi.rejectUser(id);
      if (kind === 'disable') await AdminApi.disableUser(id);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page-list">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="PENDING">待审核</option>
          <option value="ACTIVE">已通过</option>
          <option value="REJECTED">已拒绝</option>
          <option value="DISABLED">已禁用</option>
        </select>
        <input placeholder="用户ID或昵称" value={q} onChange={(e) => setQ(e.target.value)} />
        <label style={{ margin: 0, whiteSpace: 'nowrap' }}>申请时间</label>
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
      {err ? <p className="err">{err}</p> : null}
      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="查询中…" />
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>状态</th>
              <th>邀请码</th>
              <th>申请时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                  暂无数据
                </td>
              </tr>
            ) : (
              items.map((u) => (
                <tr key={u.id}>
                  <td>{u.nickname || u.email}</td>
                  <td>
                    <span
                      className={`badge ${
                        u.status === 'ACTIVE' ? 'ok' : u.status === 'PENDING' ? 'warn' : 'danger'
                      }`}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td>{u.inviteCode}</td>
                  <td>{new Date(u.createdAt).toLocaleString()}</td>
                  <td className="row">
                    <button className="ghost" onClick={() => setDetailId(u.id)}>
                      详情
                    </button>
                    {u.status === 'PENDING' ? (
                      <>
                        <button disabled={!!busy} className="ok" onClick={() => act(u.id, 'approve')}>
                          通过
                        </button>
                        <button disabled={!!busy} className="danger" onClick={() => act(u.id, 'reject')}>
                          拒绝
                        </button>
                      </>
                    ) : null}
                    {u.status === 'ACTIVE' ? (
                      <button disabled={!!busy} className="ghost" onClick={() => act(u.id, 'disable')}>
                        禁用
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          disabled={loading}
          onChange={onPageChange}
        />
      </div>

      <UserDetailModal userId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
