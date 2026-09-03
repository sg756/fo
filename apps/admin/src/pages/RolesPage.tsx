import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { Pagination } from '../components/Pagination';
import { usePager } from '../hooks/usePager';

export function RolesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<{ key: string; label: string }[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const pager = usePager(20);

  const [formOpen, setFormOpen] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [menus, setMenus] = useState<string[]>([]);
  const [isSystemEdit, setIsSystemEdit] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [r, c] = await Promise.all([AdminApi.roles(), AdminApi.menuCatalog()]);
      setItems(r.items || []);
      setCatalog(c.items || []);
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setEditId(null);
    setCode('');
    setName('');
    setDescription('');
    setMenus([]);
    setIsSystemEdit(false);
    setFormErr('');
  }

  function openCreate() {
    resetForm();
    setMsg('');
    setFormOpen(true);
  }

  function openEdit(r: any) {
    setEditId(r.id);
    setCode(r.code);
    setName(r.name);
    setDescription(r.description || '');
    setMenus([...(r.menus || [])]);
    setIsSystemEdit(!!r.isSystem);
    setFormErr('');
    setMsg('');
    setFormOpen(true);
  }

  function closeForm() {
    if (busy === 'save') return;
    setFormOpen(false);
    resetForm();
  }

  function toggleMenu(key: string) {
    setMenus((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function save() {
    setFormErr('');
    if (!code.trim() || !name.trim()) {
      setFormErr('请填写编码和名称');
      return;
    }
    if (!menus.length) {
      setFormErr('至少勾选一个菜单');
      return;
    }
    setBusy('save');
    try {
      await AdminApi.saveRole({
        id: editId || undefined,
        code: code.trim(),
        name: name.trim(),
        menus,
        description: description.trim() || undefined,
      });
      setMsg(editId ? '角色已更新' : '角色已创建');
      setFormOpen(false);
      resetForm();
      load();
    } catch (e: any) {
      setFormErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string, label: string) {
    if (!(await confirmDialog(`删除角色「${label}」？`))) return;
    setBusy(id);
    setErr('');
    try {
      await AdminApi.deleteRole(id);
      setMsg('已删除');
      if (formOpen && editId === id) closeForm();
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page-list">
      <p className="hint">配置后台岗位角色及可见菜单；系统管理员可给不同岗位分配不同菜单范围。</p>
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card list-body">
        <div className="row" style={{ marginBottom: 8 }}>
          <button onClick={openCreate} disabled={!!busy}>
            新建角色
          </button>
          <button className="ghost" onClick={load}>
            刷新
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>编码</th>
              <th>名称</th>
              <th>菜单数</th>
              <th>人数</th>
              <th>类型</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items
              .slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize)
              .map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.code}</td>
                  <td>
                    <div>{r.name}</div>
                    {r.description ? <div className="hint" style={{ margin: 0 }}>{r.description}</div> : null}
                  </td>
                  <td>{(r.menus || []).length}</td>
                  <td>{r.userCount ?? 0}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.isSystem ? '内置' : '自定义'}</td>
                  <td className="row" style={{ margin: 0 }}>
                    <button className="ghost" disabled={!!busy} onClick={() => openEdit(r)}>
                      编辑
                    </button>
                    {!r.isSystem ? (
                      <button
                        className="ghost"
                        disabled={!!busy}
                        onClick={() => remove(r.id, r.name)}
                      >
                        删除
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {items.length === 0 ? <p className="hint list-empty">暂无角色</p> : null}
        <Pagination
          total={items.length}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          onChange={pager.onPageChange}
        />
      </div>

      {formOpen ? (
        <div className="modal-backdrop" onClick={closeForm}>
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 640 }}
          >
            <div className="modal-head">
              <h3>{editId ? '编辑角色' : '新建角色'}</h3>
              <ModalCloseButton onClick={closeForm} disabled={busy === 'save'} />
            </div>

            {formErr ? <p className="err">{formErr}</p> : null}

            <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <input
                placeholder="编码（如 ops）"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={isSystemEdit}
                style={{ width: 130 }}
              />
              <input
                placeholder="显示名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: 140 }}
              />
              <input
                placeholder="说明（可选）"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ flex: 1, minWidth: 140 }}
              />
            </div>

            <div className="row" style={{ marginBottom: 6, gap: 6, alignItems: 'center' }}>
              <span className="hint" style={{ margin: 0 }}>菜单权限</span>
              <button
                type="button"
                className="ghost"
                onClick={() => setMenus(catalog.map((c) => c.key))}
              >
                全选
              </button>
              <button type="button" className="ghost" onClick={() => setMenus([])}>
                清空
              </button>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))',
                gap: '4px 8px',
                marginBottom: 14,
              }}
            >
              {catalog.map((c) => (
                <label
                  key={c.key}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, margin: 0 }}
                >
                  <input
                    type="checkbox"
                    checked={menus.includes(c.key)}
                    onChange={() => toggleMenu(c.key)}
                  />
                  {c.label}
                </label>
              ))}
            </div>

            <div className="row">
              <button onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? '保存中…' : editId ? '保存' : '创建'}
              </button>
              <button type="button" className="ghost" onClick={closeForm} disabled={busy === 'save'}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
