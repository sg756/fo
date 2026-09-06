import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { ListLoading } from '../components/ListLoading';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { Pagination } from '../components/Pagination';
import { usePager } from '../hooks/usePager';

const EXCHANGES = ['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'] as const;

function fmtAmt(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function accountLabel(gid?: string | null, name?: string | null) {
  const g = String(gid || '').trim();
  const n = String(name || '').trim();
  if (!g && !n) return '—';
  if (n && g) return `${n} (${g})`;
  return n || g;
}

/** 跟单模板管理 */
export function FollowTemplatesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const pager = usePager(20);

  const [formOpen, setFormOpen] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [exchange, setExchange] = useState<(typeof EXCHANGES)[number]>('BINANCE');
  const [accountGid, setAccountGid] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountOptions, setAccountOptions] = useState<{ value: string; name: string }[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsErr, setAccountsErr] = useState('');
  const [unitAmount, setUnitAmount] = useState('');
  const [maxPrincipal, setMaxPrincipal] = useState('');
  const [minInvestAmount, setMinInvestAmount] = useState('');
  const [active, setActive] = useState(true);
  const [remark, setRemark] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await AdminApi.followTemplates();
      const list = Array.isArray(r.items) ? r.items : [];
      setItems(list);
      pager.setTotal(list.length);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAccountOptions = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsErr('');
    try {
      const r = await AdminApi.middlewareAccounts();
      const opts = (r.items || [])
        .map((a: any) => ({
          value: String(a.value ?? a.gid ?? '').trim(),
          name: String(a.name ?? '').trim(),
        }))
        .filter((a) => a.value);
      setAccountOptions(opts);
      if (opts.length === 0) setAccountsErr('中间件未返回交易账户');
    } catch (e: any) {
      setAccountsErr(e.message || '拉取交易账户失败');
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setEditId(null);
    setName('');
    setExchange('BINANCE');
    setAccountGid('');
    setAccountName('');
    setUnitAmount('');
    setMaxPrincipal('');
    setMinInvestAmount('');
    setActive(true);
    setRemark('');
    setFormErr('');
    setAccountsErr('');
  }

  function openCreate() {
    resetForm();
    setMsg('');
    setFormOpen(true);
    void loadAccountOptions();
  }

  function openEdit(t: any) {
    setEditId(t.id);
    setName(t.name || '');
    setExchange(t.exchange || 'BINANCE');
    setAccountGid(t.accountGid || '');
    setAccountName(t.accountName || '');
    setUnitAmount(String(t.unitAmount ?? ''));
    setMaxPrincipal(String(t.maxPrincipal ?? ''));
    setMinInvestAmount(String(t.minInvestAmount ?? ''));
    setActive(t.active !== false);
    setRemark(t.remark || '');
    setFormErr('');
    setAccountsErr('');
    setMsg('');
    setFormOpen(true);
    void loadAccountOptions();
  }

  function closeForm() {
    if (busy === 'save') return;
    setFormOpen(false);
    resetForm();
  }

  function onPickAccount(gid: string) {
    setAccountGid(gid);
    const hit = accountOptions.find((a) => a.value === gid);
    setAccountName(hit?.name || '');
  }

  async function save() {
    setFormErr('');
    const ua = Number(unitAmount);
    const mp = Number(maxPrincipal);
    const mi = Number(minInvestAmount || 0);
    if (!name.trim()) {
      setFormErr('请填写模板名');
      return;
    }
    if (!accountGid.trim()) {
      setFormErr('请选择交易账户');
      return;
    }
    if (!Number.isFinite(ua) || ua < 0) {
      setFormErr('请填写有效的单笔最小金额');
      return;
    }
    if (!Number.isFinite(mp) || mp < 0) {
      setFormErr('请填写有效的比例基准本金');
      return;
    }
    if (!Number.isFinite(mi) || mi < 0) {
      setFormErr('请填写有效的最少投入总本金');
      return;
    }
    if (mp > 0 && ua > mp) {
      setFormErr('单笔最小金额不能大于比例基准本金');
      return;
    }
    setBusy('save');
    try {
      await AdminApi.saveFollowTemplate({
        id: editId || undefined,
        name: name.trim(),
        exchange,
        accountGid: accountGid.trim(),
        accountName: accountName.trim() || undefined,
        unitAmount: ua,
        maxPrincipal: mp,
        minInvestAmount: mi,
        active,
        remark: remark.trim() || undefined,
      });
      setMsg(editId ? '模板已更新' : '模板已创建');
      setFormOpen(false);
      resetForm();
      await load();
    } catch (e: any) {
      setFormErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string, label: string) {
    if (!(await confirmDialog(`删除模板「${label}」？`))) return;
    setBusy(id);
    setErr('');
    try {
      await AdminApi.deleteFollowTemplate(id);
      setMsg('已删除');
      if (formOpen && editId === id) closeForm();
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  const pageItems = useMemo(
    () => items.slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize),
    [items, pager.page, pager.pageSize],
  );

  // 编辑时若当前账户不在列表中，仍展示一项以免空白
  const selectOptions = useMemo(() => {
    if (!accountGid) return accountOptions;
    if (accountOptions.some((a) => a.value === accountGid)) return accountOptions;
    return [{ value: accountGid, name: accountName || accountGid }, ...accountOptions];
  }, [accountOptions, accountGid, accountName]);

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="加载中…" />
        <div className="row">
          <h3 style={{ margin: 0, flex: 1 }}>模板列表</h3>
          <button onClick={openCreate} disabled={!!busy}>
            新建模板
          </button>
          <button className="ghost" onClick={load} disabled={loading}>
            刷新
          </button>
        </div>
        <div className="table-scroll">
          <table className="follow-templates-table">
            <thead>
              <tr>
                <th style={{ width: 100 }}>模板名</th>
                <th style={{ width: 220 }}>交易账户</th>
                <th style={{ width: 88 }}>交易所</th>
                <th style={{ width: 110 }}>单笔最小金额</th>
                <th style={{ width: 120 }}>最少投入总本金</th>
                <th style={{ width: 110 }}>比例基准本金</th>
                <th style={{ width: 64 }}>状态</th>
                <th style={{ width: 120 }}>备注</th>
                <th style={{ width: 150 }}>更新时间</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((t) => (
                <tr key={t.id}>
                  <td title={t.name}>{t.name}</td>
                  <td title={accountLabel(t.accountGid, t.accountName)}>
                    {accountLabel(t.accountGid, t.accountName)}
                  </td>
                  <td>{t.exchange}</td>
                  <td className="mono">{fmtAmt(t.unitAmount)}</td>
                  <td className="mono">{fmtAmt(t.minInvestAmount)}</td>
                  <td className="mono">{fmtAmt(t.maxPrincipal)}</td>
                  <td>
                    <span className={`badge ${t.active ? 'ok' : ''}`}>
                      {t.active ? '启用' : '停用'}
                    </span>
                  </td>
                  <td title={t.remark || ''}>{t.remark || '—'}</td>
                  <td>{t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</td>
                  <td className="ops row" style={{ margin: 0 }}>
                    <button className="ghost" disabled={!!busy} onClick={() => openEdit(t)}>
                      编辑
                    </button>
                    <button
                      className="ghost"
                      disabled={!!busy}
                      onClick={() => remove(t.id, t.name)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 && !loading ? (
          <p className="hint list-empty">暂无模板，请先创建</p>
        ) : null}
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[10, 20, 50]}
          disabled={loading}
          onChange={(p, s) => pager.onPageChange(p, s)}
        />
      </div>

      {formOpen ? (
        <div className="modal-backdrop" onClick={closeForm}>
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 480 }}
          >
            <div className="modal-head">
              <h3>{editId ? '编辑模板' : '新建模板'}</h3>
              <ModalCloseButton onClick={closeForm} disabled={busy === 'save'} />
            </div>

            {formErr ? <p className="err">{formErr}</p> : null}

            <label style={{ display: 'block', marginBottom: 6 }}>模板名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：币安稳健 100U"
              style={{ width: '100%', marginBottom: 14 }}
            />

            <label style={{ display: 'block', marginBottom: 6 }}>交易账户</label>
            <div className="row" style={{ marginBottom: 6, gap: 8 }}>
              <select
                value={accountGid}
                onChange={(e) => onPickAccount(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
                disabled={accountsLoading}
              >
                <option value="">请选择中间件交易账户</option>
                {selectOptions.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.name ? `${a.name} (${a.value})` : a.value}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost"
                onClick={() => void loadAccountOptions()}
                disabled={accountsLoading}
              >
                {accountsLoading ? '拉取中…' : '刷新账户'}
              </button>
            </div>
            {accountsErr ? <p className="err" style={{ marginTop: 0 }}>{accountsErr}</p> : null}
            <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
              来自中间件 MultiAccountList，保存后关联该账户 GID。
            </p>

            <label style={{ display: 'block', marginBottom: 6 }}>交易所</label>
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value as (typeof EXCHANGES)[number])}
              style={{ width: '100%', marginBottom: 14 }}
            >
              {EXCHANGES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>

            <label style={{ display: 'block', marginBottom: 6 }}>单笔最小金额</label>
            <input
              value={unitAmount}
              onChange={(e) => setUnitAmount(e.target.value)}
              placeholder="每笔最少跟单金额"
              style={{ width: '100%', marginBottom: 14 }}
            />

            <label style={{ display: 'block', marginBottom: 6 }}>最少投入总本金</label>
            <input
              value={minInvestAmount}
              onChange={(e) => setMinInvestAmount(e.target.value)}
              placeholder="用户声明投入下限，0 表示不限制"
              style={{ width: '100%', marginBottom: 14 }}
            />

            <label style={{ display: 'block', marginBottom: 6 }}>比例基准本金</label>
            <input
              value={maxPrincipal}
              onChange={(e) => setMaxPrincipal(e.target.value)}
              placeholder="用户声明投入 ÷ 本值 = 开仓比例"
              style={{ width: '100%', marginBottom: 14 }}
            />

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              启用
            </label>

            <label style={{ display: 'block', marginBottom: 6 }}>备注</label>
            <input
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="可选"
              style={{ width: '100%', marginBottom: 14 }}
            />

            <p className="hint">
              「单笔最小金额」为开仓名义金额下限；「最少投入总本金」限制用户声明投入不得低于此值（0=不限制）；「比例基准本金」用于计算开仓数量比例（声明投入
              ÷ 基准），不校验交易所余额。
            </p>

            <div className="row">
              <button onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? '保存中…' : editId ? '保存修改' : '创建模板'}
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
