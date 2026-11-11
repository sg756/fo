import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { CopyMonoCell } from '../components/CopyMonoCell';
import { ListLoading } from '../components/ListLoading';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { Pagination } from '../components/Pagination';
import { usePager } from '../hooks/usePager';
import { EXCHANGES, type ExchangeCode } from '../exchanges';
type AccountPick = { value: string; name: string };

function fmtAmt(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function exchangeText(t: any) {
  if (t.allExchanges) return '全部';
  const list = Array.isArray(t.exchanges) ? t.exchanges : [];
  return list.length ? list.join('、') : '—';
}

function accountRows(t: any): { name: string; gid: string }[] {
  return (t.accounts || [])
    .map((a: any) => ({
      name: String(a.accountName || '').trim(),
      gid: String(a.accountGid || '').trim(),
    }))
    .filter((a: { gid: string }) => a.gid);
}

/** 跟单模板管理 */
export function FollowTemplatesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const pager = usePager(20);

  const [gidView, setGidView] = useState<{
    title: string;
    rows: { name: string; gid: string; missing: boolean }[];
  } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [exchanges, setExchanges] = useState<ExchangeCode[]>([]);
  const [allAccounts, setAllAccounts] = useState(false);
  const [picked, setPicked] = useState<AccountPick[]>([]);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountQuery, setAccountQuery] = useState('');
  const [accountOptions, setAccountOptions] = useState<AccountPick[]>([]);
  const [accountsReady, setAccountsReady] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsErr, setAccountsErr] = useState('');
  const [unitAmount, setUnitAmount] = useState('');
  const [maxPrincipal, setMaxPrincipal] = useState('');
  const [minInvestAmount, setMinInvestAmount] = useState('');
  const [active, setActive] = useState(true);
  const [isGlobal, setIsGlobal] = useState(false);
  const [listTab, setListTab] = useState<'global' | 'custom'>('global');
  const [globalApplied, setGlobalApplied] = useState(false);
  const [remark, setRemark] = useState('');
  const accountBoxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await AdminApi.followTemplates();
      const list = Array.isArray(r.items) ? r.items : [];
      setItems(list);
      setGlobalApplied(!!(r as any).globalApplied);
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
      setAccountsReady(true);
      if (opts.length === 0) setAccountsErr('中间件未返回交易账户');
    } catch (e: any) {
      setAccountsReady(false);
      setAccountsErr(e.message || '拉取交易账户失败');
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    void loadAccountOptions();
  }, [load, loadAccountOptions]);

  useEffect(() => {
    if (!accountOpen) return;
    function onDoc(e: MouseEvent) {
      if (!accountBoxRef.current?.contains(e.target as Node)) setAccountOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [accountOpen]);

  function resetForm() {
    setEditId(null);
    setName('');
    setExchanges([]);
    setAllAccounts(false);
    setPicked([]);
    setAccountOpen(false);
    setAccountQuery('');
    setUnitAmount('');
    setMaxPrincipal('');
    setMinInvestAmount('');
    setActive(true);
    setIsGlobal(false);
    setRemark('');
    setFormErr('');
    setAccountsErr('');
  }

  function openCreate(asGlobal: boolean) {
    resetForm();
    setIsGlobal(asGlobal);
    setMsg('');
    setFormOpen(true);
    void loadAccountOptions();
  }

  function openEdit(t: any) {
    setEditId(t.id);
    setName(t.name || '');
    setExchanges(
      t.allExchanges
        ? [...EXCHANGES]
        : (Array.isArray(t.exchanges) ? t.exchanges : []).filter((x: string) =>
            (EXCHANGES as readonly string[]).includes(x),
          ),
    );
    setAllAccounts(!!t.allAccounts);
    setPicked(
      t.allAccounts
        ? []
        : (t.accounts || [])
            .map((a: any) => ({
              value: String(a.accountGid || '').trim(),
              name: String(a.accountName || '').trim(),
            }))
            .filter((a: AccountPick) => a.value),
    );
    setAccountOpen(false);
    setAccountQuery('');
    setUnitAmount(String(t.unitAmount ?? ''));
    setMaxPrincipal(String(t.maxPrincipal ?? ''));
    setMinInvestAmount(String(t.minInvestAmount ?? ''));
    setActive(t.active !== false);
    setIsGlobal(!!t.isGlobal);
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

  const allExchangesOn = EXCHANGES.every((x) => exchanges.includes(x));

  function toggleExchange(ex: ExchangeCode) {
    setExchanges((prev) => (prev.includes(ex) ? prev.filter((x) => x !== ex) : [...prev, ex]));
  }

  function toggleAllExchanges() {
    setExchanges(allExchangesOn ? [] : [...EXCHANGES]);
  }

  function toggleAccount(a: AccountPick) {
    setAllAccounts(false);
    setPicked((prev) => {
      if (prev.some((x) => x.value === a.value)) return prev.filter((x) => x.value !== a.value);
      return [...prev, { value: a.value, name: a.name }];
    });
  }

  function toggleAllAccounts() {
    setAllAccounts((on) => {
      if (!on) setPicked([]);
      return !on;
    });
    setAccountOpen(false);
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
    if (exchanges.length === 0) {
      setFormErr('请选择交易所');
      return;
    }
    if (!allAccounts && picked.length === 0) {
      setFormErr('请选择交易账户，或选择全部账户');
      return;
    }
    if (!allAccounts) {
      if (!accountsReady) {
        setFormErr('无法核对中间件交易账户，请先刷新账户');
        return;
      }
      const dead = picked.filter((a) => !accountOptions.some((o) => o.value === a.value));
      if (dead.length) {
        setFormErr(`交易账户已失效：${dead.map((a) => a.name || a.value).join('、')}，请去掉后再保存`);
        return;
      }
    }
    if (!Number.isFinite(ua) || ua < 0) {
      setFormErr('请填写有效的单笔最小金额');
      return;
    }
    if (!Number.isFinite(mp) || mp <= 0) {
      setFormErr('请填写有效的比例基准本金');
      return;
    }
    if (!Number.isFinite(mi) || mi <= 0) {
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
        allExchanges: false,
        exchanges,
        allAccounts,
        accounts: allAccounts
          ? []
          : picked.map((a) => ({
              accountGid: a.value,
              accountName: a.name || undefined,
            })),
        unitAmount: ua,
        maxPrincipal: mp,
        minInvestAmount: mi,
        active,
        isGlobal,
        remark: remark.trim() || undefined,
      });
      if (!editId) {
        setListTab(isGlobal ? 'global' : 'custom');
        pager.setPage(1);
      }
      setMsg(editId ? '' : '模板已创建');
      setFormOpen(false);
      resetForm();
      await load();
    } catch (e: any) {
      setFormErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function applyGlobal(id: string, label: string) {
    if (!(await confirmDialog(`将模板「${label}」应用到所有用户？之后新用户也使用这份模板。`))) return;
    setBusy(id);
    setErr('');
    try {
      await AdminApi.applyGlobalTemplate(id);
      setMsg('已应用到所有用户');
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function cancelGlobal(id: string, label: string) {
    if (
      !(await confirmDialog(
        `取消应用模板「${label}」？之后用户使用自己的合约模板，没选的需要先在 App 里选择。`,
      ))
    ) {
      return;
    }
    setBusy(id);
    setErr('');
    try {
      await AdminApi.cancelGlobalTemplate(id);
      setMsg('已取消应用');
      await load();
    } catch (e: any) {
      setErr(e.message);
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

  const filtered = useMemo(
    () => items.filter((t) => (listTab === 'global' ? !!t.isGlobal : !t.isGlobal)),
    [items, listTab],
  );

  useEffect(() => {
    pager.setTotal(filtered.length);
  }, [filtered.length]);

  const pageItems = useMemo(
    () => filtered.slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize),
    [filtered, pager.page, pager.pageSize],
  );

  function staleRows(t: any) {
    if (!accountsReady || t.allAccounts) return [] as { name: string; gid: string }[];
    const known = new Set(accountOptions.map((a) => a.value));
    return accountRows(t).filter((a) => !known.has(a.gid));
  }

  function accountLabel(t: any) {
    const stale = new Set(staleRows(t).map((a) => a.gid));
    if (t.allAccounts) return '全部账户';
    const names = accountRows(t).map((a) => {
      const label = a.name || a.gid;
      return stale.has(a.gid) ? `${label}（已失效）` : label;
    });
    return names.length ? names.join('、') : '—';
  }

  const visibleAccounts = useMemo(() => {
    const q = accountQuery.trim().toLowerCase();
    const base = accountOptions.slice();
    for (const p of picked) {
      if (!base.some((a) => a.value === p.value)) base.unshift(p);
    }
    if (!q) return base;
    return base.filter(
      (a) => a.name.toLowerCase().includes(q) || a.value.toLowerCase().includes(q),
    );
  }, [accountOptions, picked, accountQuery]);

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="加载中…" />
        <div className="row">
          <h3 style={{ margin: 0, flex: 1 }}>模板列表</h3>
          <button onClick={() => openCreate(false)} disabled={!!busy}>
            创建自定义模板
          </button>
          <button onClick={() => openCreate(true)} disabled={!!busy}>
            创建全局模板
          </button>
          <button className="ghost" onClick={load} disabled={loading}>
            刷新
          </button>
        </div>
        <div className="tabs">
          <button
            type="button"
            className={listTab === 'global' ? 'tab active' : 'tab ghost'}
            onClick={() => {
              setListTab('global');
              pager.setPage(1);
            }}
          >
            全局模板
          </button>
          <button
            type="button"
            className={listTab === 'custom' ? 'tab active' : 'tab ghost'}
            onClick={() => {
              setListTab('custom');
              pager.setPage(1);
            }}
          >
            自定义模板
          </button>
        </div>
        <div className="table-scroll">
          <table className="follow-templates-table">
            <thead>
              <tr>
                <th style={{ width: 100 }}>模板名</th>
                <th style={{ width: 140 }}>交易账户</th>
                <th style={{ width: 140 }}>交易所</th>
                <th style={{ width: 110 }}>单笔最小金额</th>
                <th style={{ width: 120 }}>最少投入总本金</th>
                <th style={{ width: 110 }}>比例基准本金</th>
                <th style={{ width: 72 }}>状态</th>
                <th style={{ width: 120 }}>备注</th>
                <th style={{ width: 150 }}>更新时间</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((t) => {
                const stale = staleRows(t);
                const label = accountLabel(t);
                return (
                <tr key={t.id}>
                  <td title={t.name}>
                    {t.name}
                    {t.isGlobal && globalApplied ? (
                      <span className="badge ok" style={{ marginLeft: 6 }}>已应用</span>
                    ) : null}
                  </td>
                  <td title={label}>
                    {t.allAccounts || accountRows(t).length === 0 ? (
                      label
                    ) : (
                      <button
                        type="button"
                        className="cell-link"
                        onClick={() =>
                          setGidView({
                            title: t.name || '交易账户',
                            rows: accountRows(t).map((a) => ({
                              ...a,
                              missing: stale.some((s) => s.gid === a.gid),
                            })),
                          })
                        }
                      >
                        {label}
                      </button>
                    )}
                  </td>
                  <td title={exchangeText(t)}>{exchangeText(t)}</td>
                  <td className="mono">{fmtAmt(t.unitAmount)}</td>
                  <td className="mono">{fmtAmt(t.minInvestAmount)}</td>
                  <td className="mono">{fmtAmt(t.maxPrincipal)}</td>
                  <td>
                    {stale.length ? (
                      <span
                        className="badge danger"
                        title={`交易账户已不在中间件：${stale.map((a) => a.name || a.gid).join('、')}`}
                      >
                        失效
                      </span>
                    ) : (
                      <span className={`badge ${t.active ? 'ok' : ''}`}>
                        {t.active ? '启用' : '停用'}
                      </span>
                    )}
                  </td>
                  <td title={t.remark || ''}>{t.remark || '—'}</td>
                  <td>{t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</td>
                  <td className="ops row" style={{ margin: 0 }}>
                    {t.isGlobal && !globalApplied ? (
                      <button className="ghost" disabled={!!busy} onClick={() => applyGlobal(t.id, t.name)}>
                        应用
                      </button>
                    ) : null}
                    {t.isGlobal && globalApplied ? (
                      <button className="ghost" disabled={!!busy} onClick={() => cancelGlobal(t.id, t.name)}>
                        取消应用
                      </button>
                    ) : null}
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
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && !loading ? (
          <p className="hint list-empty">
            {listTab === 'global' ? '暂无全局模板' : '暂无自定义模板'}
          </p>
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

      {gidView ? (
        <div className="modal-backdrop" onClick={() => setGidView(null)}>
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 520 }}
          >
            <div className="modal-head">
              <h3>{gidView.title} · GID</h3>
              <ModalCloseButton onClick={() => setGidView(null)} />
            </div>
            <ul className="tpl-gid-list">
              {gidView.rows.map((a) => (
                <li key={a.gid} className="tpl-gid-row">
                  <div>
                    {a.name || '未命名账户'}
                    {a.missing ? <span className="badge danger" style={{ marginLeft: 8 }}>已失效</span> : null}
                  </div>
                  <CopyMonoCell value={a.gid} label="GID" full />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {formOpen ? (
        <div className="modal-backdrop" onClick={closeForm}>
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 820 }}
          >
            <div className="modal-head">
              <h3>
                {editId
                  ? isGlobal
                    ? '编辑全局模板'
                    : '编辑自定义模板'
                  : isGlobal
                    ? '创建全局模板'
                    : '创建自定义模板'}
              </h3>
              <ModalCloseButton onClick={closeForm} disabled={busy === 'save'} />
            </div>

            {formErr ? <p className="err">{formErr}</p> : null}

            <div className="tpl-form">
            <div className="tpl-form-row">
              <div className="tpl-field">
                <label>模板名</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：币安稳健 100U"
                />
              </div>
              <div className="tpl-field">
                <label>备注</label>
                <input
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>

            <div className="tpl-field">
            <label>交易所</label>
            <div className="tpl-chips">
              <button
                type="button"
                className={`tpl-chip${allExchangesOn ? ' on' : ''}`}
                onClick={toggleAllExchanges}
              >
                全部
              </button>
              {EXCHANGES.map((x) => (
                <button
                  key={x}
                  type="button"
                  className={`tpl-chip${exchanges.includes(x) ? ' on' : ''}`}
                  onClick={() => toggleExchange(x)}
                >
                  {x}
                </button>
              ))}
            </div>
            </div>

            <div className="tpl-field">
            <label>交易账户</label>
            <div className="tpl-scope" ref={accountBoxRef}>
              <div className="row" style={{ marginBottom: 0, gap: 8, alignItems: 'flex-start' }}>
                <div
                  className="tpl-account-box"
                  onClick={() => setAccountOpen(true)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {allAccounts ? <span className="tpl-chip on">全部账户</span> : null}
                  {!allAccounts && picked.length === 0 ? (
                    <span className="muted">选择账户</span>
                  ) : null}
                  {!allAccounts
                    ? picked.map((a) => {
                        const stale =
                          accountsReady && !accountOptions.some((o) => o.value === a.value);
                        return (
                        <button
                          key={a.value}
                          type="button"
                          className={`tpl-chip on${stale ? ' stale' : ''}`}
                          title={stale ? `${a.value}\n该账户已不在中间件` : a.value}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleAccount(a);
                          }}
                        >
                          {stale ? `${a.name || a.value} · 已失效` : a.name || a.value}
                        </button>
                        );
                      })
                    : null}
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void loadAccountOptions()}
                  disabled={accountsLoading}
                >
                  {accountsLoading ? '拉取中…' : '刷新账户'}
                </button>
              </div>
              {accountOpen ? (
                <div className="tpl-account-pop">
                  <input
                    value={accountQuery}
                    onChange={(e) => setAccountQuery(e.target.value)}
                    placeholder="搜索账户名"
                    autoFocus
                  />
                  <button
                    type="button"
                    className={`tpl-account-item${allAccounts ? ' on' : ''}`}
                    onClick={toggleAllAccounts}
                  >
                    全部账户
                  </button>
                  {visibleAccounts.map((a) => {
                    const on = !allAccounts && picked.some((x) => x.value === a.value);
                    return (
                      <button
                        key={a.value}
                        type="button"
                        className={`tpl-account-item${on ? ' on' : ''}`}
                        onClick={() => toggleAccount(a)}
                      >
                        {a.name || a.value}
                      </button>
                    );
                  })}
                  {!accountsLoading && visibleAccounts.length === 0 ? (
                    <div className="tpl-account-item muted">没有匹配的账户</div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {accountsErr ? <p className="err" style={{ margin: '6px 0 0' }}>{accountsErr}</p> : null}
            </div>

            <div className="tpl-form-row three">
              <div className="tpl-field">
                <label>单笔最小金额</label>
                <input
                  value={unitAmount}
                  onChange={(e) => setUnitAmount(e.target.value)}
                  placeholder="每笔最少金额"
                />
              </div>
              <div className="tpl-field">
                <label>最少投入总本金</label>
                <input
                  value={minInvestAmount}
                  onChange={(e) => setMinInvestAmount(e.target.value)}
                  placeholder="须大于 0"
                />
              </div>
              <div className="tpl-field">
                <label>比例基准本金</label>
                <input
                  value={maxPrincipal}
                  onChange={(e) => setMaxPrincipal(e.target.value)}
                  placeholder="开仓倍数的分母"
                />
              </div>
            </div>

            <div className="tpl-checks">
              <label>
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                启用
              </label>
              <span className="hint">
                {isGlobal
                  ? '全系统只能有一个。保存后在「全局模板」里点「应用」，所有用户都用这一份。'
                  : '开仓倍数 = 最少投入总本金 ÷ 比例基准本金。'}
              </span>
            </div>

            <div className="row" style={{ margin: 0 }}>
              <button onClick={save} disabled={busy === 'save'}>
                {busy === 'save'
                  ? '保存中…'
                  : editId
                    ? '保存修改'
                    : isGlobal
                      ? '创建全局模板'
                      : '创建自定义模板'}
              </button>
              <button type="button" className="ghost" onClick={closeForm} disabled={busy === 'save'}>
                取消
              </button>
            </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
