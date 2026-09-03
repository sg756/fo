import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { Pagination } from '../components/Pagination';
import { usePager } from '../hooks/usePager';

export function AdminsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [adminRoleId, setAdminRoleId] = useState('');
  const pager = usePager(20);

  const load = useCallback(() => {
    setErr('');
    Promise.all([AdminApi.admins(q || undefined), AdminApi.roles()])
      .then(([a, r]) => {
        setItems(a.items || []);
        setRoles(r.items || []);
        setAdminRoleId((prev) => {
          if (prev) return prev;
          const system = r.items?.find((x: any) => x.code === 'system') || r.items?.[0];
          return system?.id || '';
        });
      })
      .catch((e) => setErr(e.message));
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  async function createAdmin() {
    setMsg('');
    setErr('');
    if (account.trim().length < 6 || password.length < 6) {
      setErr('账号和密码均至少 6 位');
      return;
    }
    setBusy('create');
    try {
      await AdminApi.createAdmin({
        account: account.trim(),
        password,
        adminRoleId: adminRoleId || undefined,
      });
      setMsg('管理员已创建');
      setAccount('');
      setPassword('');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function changeRole(id: string, roleId: string) {
    if (!roleId) return;
    setBusy(id);
    setErr('');
    try {
      await AdminApi.setAdminRole(id, roleId);
      setMsg('岗位已更新');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function disable(id: string, label: string) {
    if (!(await confirmDialog(`禁用管理员 ${label}？`))) return;
    setBusy(id);
    setErr('');
    try {
      await AdminApi.disableAdmin(id);
      setMsg('已禁用');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page-list">
      <p className="hint">与普通用户分开管理；通过岗位角色控制可见菜单。</p>
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card">
        <h3>新增管理员</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input
            placeholder="账号（至少 6 位）"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            style={{ width: 180 }}
          />
          <input
            type="password"
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: 160 }}
          />
          <select
            value={adminRoleId}
            onChange={(e) => setAdminRoleId(e.target.value)}
            style={{ minWidth: 140 }}
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button onClick={createAdmin} disabled={busy === 'create'}>
            创建
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <input placeholder="搜索账号" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="ghost" onClick={load}>
            刷新
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>岗位</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items
              .slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize)
              .map((a) => (
              <tr key={a.id}>
                <td>{a.nickname || a.email}</td>
                <td>
                  <select
                    value={a.adminRoleId || ''}
                    disabled={!!busy}
                    onChange={(e) => changeRole(a.id, e.target.value)}
                  >
                    {!a.adminRoleId ? <option value="">未分配</option> : null}
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={`badge ${a.status === 'ACTIVE' ? 'ok' : 'danger'}`}>{a.status}</span>
                </td>
                <td>{new Date(a.createdAt).toLocaleString()}</td>
                <td>
                  {a.status === 'ACTIVE' ? (
                    <button
                      className="ghost"
                      disabled={!!busy}
                      onClick={() => disable(a.id, a.nickname || a.email)}
                    >
                      禁用
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 ? <p className="hint list-empty">暂无管理员</p> : null}
        <Pagination
          total={items.length}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          onChange={pager.onPageChange}
        />
      </div>
    </div>
  );
}
