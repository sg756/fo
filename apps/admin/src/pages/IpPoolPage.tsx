import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { DateField } from '../components/DateField';
import { Pagination } from '../components/Pagination';
import { SearchSelect } from '../components/SearchSelect';
import { usePager, normalizePaged } from '../hooks/usePager';
import { useUserOptions, USER_FILTER_PLACEHOLDER, USER_FILTER_EMPTY_HINT } from '../hooks/useSearchFilterOptions';

const RECLAIM_REASON: Record<string, string> = {
  idle_no_fill: '开启中无成交',
  follow_off_stale: '关闭跟单过久仍占坑',
  evacuate_no_slot: '疏散时无空位',
  manual: '手动',
};

const REFLOW_RESULT: Record<string, string> = {
  SUCCESS: '成功',
  FAIL_NO_CAPACITY: '满仓失败',
  FAIL_NO_PROXY: '无代理',
};

type Tab = 'proxies' | 'reclaims' | 'reflow';

/** 代理列表：从中间件 PublicHttpProxyList 同步展示 */
export function IpPoolPage() {
  const [tab, setTab] = useState<Tab>('proxies');
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [errBody, setErrBody] = useState('');
  const [msg, setMsg] = useState('');
  const [previewUserText, setPreviewUserText] = useState('');
  const [previewUserId, setPreviewUserId] = useState('');
  const [previewResult, setPreviewResult] = useState<any>(null);
  const previewUserOpts = useUserOptions(previewUserText, previewUserId);
  const [usersPerProxy, setUsersPerProxy] = useState(10);
  const [reclaims, setReclaims] = useState<any[]>([]);
  const [reclaimFrom, setReclaimFrom] = useState('');
  const [reclaimTo, setReclaimTo] = useState('');
  const [reclaimUserNo, setReclaimUserNo] = useState('');
  const [reclaimAccount, setReclaimAccount] = useState('');
  const [reclaimUserText, setReclaimUserText] = useState('');
  const [reclaimUserId, setReclaimUserId] = useState('');
  const reclaimUserOpts = useUserOptions(reclaimUserText, reclaimUserId);
  const [reflowLogs, setReflowLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const pager = usePager(20);
  const reclaimPager = usePager(20);
  const reflowPager = usePager(20);

  const load = useCallback((opts?: { force?: boolean }) => {
    setErr('');
    setErrBody('');
    setLoading(true);
    return AdminApi.ipPool({ force: !!opts?.force })
      .then((r) => {
        setItems(Array.isArray(r.items) ? r.items : []);
        if (r.syncError) {
          setMsg('');
          setErr(
            `中间件同步失败${r.syncErrorStatus != null ? ` (HTTP ${r.syncErrorStatus})` : ''}：${r.syncError}`,
          );
          if (r.syncErrorBody != null) {
            setErrBody(
              typeof r.syncErrorBody === 'string'
                ? r.syncErrorBody
                : JSON.stringify(r.syncErrorBody, null, 2),
            );
          }
        } else if (opts?.force) {
          const n = Array.isArray(r.items) ? r.items.length : 0;
          setMsg(`已从中间件同步 ${n} 个代理`);
        }
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const loadReclaims = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? reclaimPager.page;
      const size = opts?.pageSize ?? reclaimPager.pageSize;
      setErr('');
      AdminApi.ipPoolReclaims({
        status: 'REMOVED',
        userId: reclaimUserId || undefined,
        userNo: reclaimUserNo.trim() || undefined,
        account: reclaimAccount.trim() || undefined,
        from: reclaimFrom || undefined,
        to: reclaimTo || undefined,
        skip: (p - 1) * size,
        take: size,
      })
        .then((r) => {
          const { items: list, total } = normalizePaged(r);
          setReclaims(list);
          reclaimPager.setTotal(total);
        })
        .catch((e) => setErr(e.message));
    },
    [
      reclaimPager.page,
      reclaimPager.pageSize,
      reclaimUserId,
      reclaimUserNo,
      reclaimAccount,
      reclaimFrom,
      reclaimTo,
    ],
  );

  const loadReflows = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? reflowPager.page;
      const size = opts?.pageSize ?? reflowPager.pageSize;
      AdminApi.ipPoolReflowLogs({ skip: (p - 1) * size, take: size })
        .then((r) => {
          const { items: list, total } = normalizePaged(r);
          setReflowLogs(list);
          reflowPager.setTotal(total);
        })
        .catch((e) => setErr(e.message));
    },
    [reflowPager.page, reflowPager.pageSize],
  );

  useEffect(() => {
    load();
    AdminApi.ipPoolConfig()
      .then((c) => setUsersPerProxy(c.usersPerProxy ?? 10))
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    if (tab === 'reclaims') loadReclaims({ page: 1 });
    if (tab === 'reflow') loadReflows({ page: 1 });
  }, [tab]);

  async function preview() {
    setErr('');
    setPreviewResult(null);
    if (!previewUserId) {
      setErr('请先选择用户');
      return;
    }
    try {
      const res = await AdminApi.previewProxy(previewUserId);
      setPreviewResult(res);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  function userLabel(u?: any) {
    if (!u) return '—';
    const name = u.nickname || u.email || '—';
    return u.userNo != null ? `${name}（#${u.userNo}）` : name;
  }

  const inactiveCount = items.filter((p) => !p.active).length;
  const inactiveBound = items
    .filter((p) => !p.active)
    .reduce((n, p) => n + (Number(p.assignedCount) || 0), 0);

  async function cleanupInactive() {
    setErr('');
    setMsg('');
    if (inactiveCount === 0) {
      setMsg('当前没有失效代理');
      return;
    }
    const ok = window.confirm(
      `将清理 ${inactiveCount} 个失效代理（其上约 ${inactiveBound} 个绑定）：\n` +
        `用户迁到启用健康代理；无空位则停跟单。\n` +
        `请确认中间件已刷新且有足够健康代理空位。\n\n继续？`,
    );
    if (!ok) return;
    setLoading(true);
    try {
      const r = await AdminApi.cleanupInactiveProxies();
      setMsg(
        `清理完成：删除 ${r.deletedProxies} 个失效代理，迁绑 ${r.movedUsers} 人` +
          (r.pausedUsers ? `，停跟单 ${r.pausedUsers} 人（无空位）` : ''),
      );
      setLoading(false);
      await load();
    } catch (e: any) {
      setErr(e.message || '清理失败');
      setLoading(false);
    }
  }

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {errBody ? (
        <pre
          className="err"
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontSize: 12,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 10,
            marginTop: 0,
            maxHeight: 220,
            overflow: 'auto',
          }}
        >
          {errBody}
        </pre>
      ) : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="tabs">
        <button className={tab === 'proxies' ? 'tab active' : 'tab ghost'} onClick={() => setTab('proxies')}>
          代理
        </button>
        <button className={tab === 'reclaims' ? 'tab active' : 'tab ghost'} onClick={() => setTab('reclaims')}>
          已移除
        </button>
        <button className={tab === 'reflow' ? 'tab active' : 'tab ghost'} onClick={() => setTab('reflow')}>
          回流记录
        </button>
      </div>

      {tab === 'proxies' ? (
        <>
          <div className="card">
            <h3>预览用户分配</h3>
            <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <SearchSelect
                text={previewUserText}
                onTextChange={setPreviewUserText}
                value={previewUserId}
                onSelect={(o) => setPreviewUserId(o?.value || '')}
                options={previewUserOpts.options}
                loading={previewUserOpts.loading}
                remote
                placeholder={USER_FILTER_PLACEHOLDER}
                width={260}
                emptyHint={USER_FILTER_EMPTY_HINT}
              />
              <button className="ghost" onClick={preview}>
                预览命中代理
              </button>
              {previewResult ? (
                <span className="hint">
                  {previewResult.proxyId
                    ? `→ ${previewResult.name} (${previewResult.egressIp})`
                    : previewResult.message || '无可用代理'}
                </span>
              ) : null}
            </div>
          </div>

          <div className="card list-body">
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <h3 style={{ margin: 0, flex: 1 }}>代理列表</h3>
              {inactiveCount > 0 ? (
                <span className="hint">失效 {inactiveCount} 个（绑定约 {inactiveBound}）</span>
              ) : null}
              <button
                className="ghost"
                onClick={cleanupInactive}
                disabled={loading || inactiveCount === 0}
                title="先刷新中间件并确保有健康空位，再清理"
              >
                清理失效代理
              </button>
              <button
                className="ghost"
                onClick={() => void load({ force: true })}
                disabled={loading}
              >
                {loading ? '同步中…' : '从中间件刷新'}
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>公网IP</th>
                  <th>代理地址</th>
                  <th>绑定</th>
                  <th>状态</th>
                  <th>健康</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items
                  .slice((pager.page - 1) * pager.pageSize, pager.page * pager.pageSize)
                  .map((p) => (
                    <tr key={p.id} style={!p.active ? { opacity: 0.75 } : undefined}>
                      <td style={{ fontFamily: 'monospace' }}>{p.egressIp || p.name}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {Number(p.port) > 0 ? `${p.host}:${p.port}` : p.host || '—'}
                      </td>
                      <td>
                        {p.assignedCount ?? 0}/{usersPerProxy}
                      </td>
                      <td>
                        <span className={`badge ${p.active ? 'ok' : 'danger'}`}>
                          {p.active ? '启用' : '失效'}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${p.healthy ? 'ok' : 'warn'}`}>
                          {p.healthy ? '健康' : '异常'}
                        </span>
                      </td>
                      <td>
                        {!p.active && (p.assignedCount ?? 0) > 0 ? (
                          <button
                            className="ghost"
                            style={{ fontSize: 12 }}
                            disabled={loading}
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `疏散 ${p.egressIp || p.name} 上 ${p.assignedCount} 个绑定？`,
                                )
                              )
                                return;
                              setLoading(true);
                              setErr('');
                              try {
                                const r = await AdminApi.evacuateProxy(p.id);
                                setMsg(
                                  `已疏散：迁 ${r.movedUsers}，停跟单 ${r.pausedUsers}`,
                                );
                                setLoading(false);
                                await load();
                              } catch (e: any) {
                                setErr(e.message);
                                setLoading(false);
                              }
                            }}
                          >
                            疏散
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {items.length === 0 && !loading ? (
              <p className="hint list-empty">暂无代理</p>
            ) : null}
            <Pagination
              total={items.length}
              page={pager.page}
              pageSize={pager.pageSize}
              pageSizes={[10, 20, 50, 100]}
              onChange={pager.onPageChange}
            />
          </div>
        </>
      ) : null}

      {tab === 'reclaims' ? (
        <div className="card list-body">
          <div className="row">
            <h3 style={{ margin: 0, flex: 1 }}>已移除（可自助回流）</h3>
            <button className="ghost" onClick={() => loadReclaims()}>
              刷新
            </button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <label style={{ margin: 0, whiteSpace: 'nowrap' }}>时间</label>
            <DateField value={reclaimFrom} onChange={setReclaimFrom} />
            <span style={{ opacity: 0.6 }}>至</span>
            <DateField value={reclaimTo} onChange={setReclaimTo} />
            <input
              placeholder="用户ID"
              value={reclaimUserNo}
              onChange={(e) => setReclaimUserNo(e.target.value)}
              style={{ width: 110 }}
            />
            <input
              placeholder="昵称"
              value={reclaimAccount}
              onChange={(e) => setReclaimAccount(e.target.value)}
              style={{ width: 160 }}
            />
            <SearchSelect
              text={reclaimUserText}
              onTextChange={setReclaimUserText}
              value={reclaimUserId}
              onSelect={(o) => setReclaimUserId(o?.value || '')}
              options={reclaimUserOpts.options}
              loading={reclaimUserOpts.loading}
              remote
              placeholder={USER_FILTER_PLACEHOLDER}
              width={200}
              emptyHint={USER_FILTER_EMPTY_HINT}
            />
            <button
              onClick={() => {
                reclaimPager.goFirst();
                loadReclaims({ page: 1 });
              }}
            >
              查询
            </button>
            <button
              className="ghost"
              onClick={() => {
                setReclaimFrom('');
                setReclaimTo('');
                setReclaimUserNo('');
                setReclaimAccount('');
                setReclaimUserText('');
                setReclaimUserId('');
                reclaimPager.goFirst();
                setTimeout(() => {
                  AdminApi.ipPoolReclaims({
                    status: 'REMOVED',
                    skip: 0,
                    take: reclaimPager.pageSize,
                  })
                    .then((r) => {
                      const { items: list, total } = normalizePaged(r);
                      setReclaims(list);
                      reclaimPager.setTotal(total);
                    })
                    .catch((e) => setErr(e.message));
                }, 0);
              }}
            >
              重置
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>用户</th>
                <th>原因</th>
                <th>原出口</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {reclaims.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={{ userSelect: 'text' }}>{userLabel(r.user)}</td>
                  <td>{RECLAIM_REASON[r.reason] || r.reason}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.prevEgress || '—'}</td>
                  <td>
                    <span className="badge">{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {reclaims.length === 0 ? <p className="hint list-empty">暂无已移除记录</p> : null}
          <Pagination
            total={reclaimPager.total}
            page={reclaimPager.page}
            pageSize={reclaimPager.pageSize}
            pageSizes={[10, 20, 50, 100]}
            onChange={(p, s) => {
              reclaimPager.onPageChange(p, s);
              loadReclaims({ page: p, pageSize: s });
            }}
          />
        </div>
      ) : null}

      {tab === 'reflow' ? (
        <div className="card list-body">
          <div className="row">
            <h3 style={{ margin: 0, flex: 1 }}>回流 / 开启跟单记录</h3>
            <button className="ghost" onClick={() => loadReflows()}>
              刷新
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>用户</th>
                <th>结果</th>
                <th>容量快照</th>
                <th>分配出口</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {reflowLogs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={{ userSelect: 'text' }}>{userLabel(r.user)}</td>
                  <td>
                    <span
                      className={`badge ${
                        r.result === 'SUCCESS' ? 'ok' : r.result === 'FAIL_NO_CAPACITY' ? 'warn' : 'danger'
                      }`}
                    >
                      {REFLOW_RESULT[r.result] || r.result}
                    </span>
                    {r.wasReclaim ? <span className="hint"> · 回流</span> : null}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.occupied != null && r.capacity != null ? `${r.occupied}/${r.capacity}` : '—'}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.egressIp || '—'}</td>
                  <td style={{ fontSize: 12 }}>{r.message || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {reflowLogs.length === 0 ? <p className="hint list-empty">暂无回流记录</p> : null}
          <Pagination
            total={reflowPager.total}
            page={reflowPager.page}
            pageSize={reflowPager.pageSize}
            pageSizes={[10, 20, 50, 100]}
            onChange={(p, s) => {
              reflowPager.onPageChange(p, s);
              loadReflows({ page: p, pageSize: s });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
