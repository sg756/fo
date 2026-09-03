import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';

/** 代理配置：容量概览 + 池参数 */
export function ProxyConfigPage() {
  const [err, setErr] = useState('');
  const [errBody, setErrBody] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [capacity, setCapacity] = useState<any>(null);
  const [cfg, setCfg] = useState({ usersPerProxy: 10, idleNoFillDays: 14, idleFollowOffDays: 14 });

  const loadCapacity = useCallback(() => {
    setErr('');
    setErrBody('');
    AdminApi.ipPoolCapacity()
      .then((c) => {
        setCapacity(c);
        if (c?.syncError) {
          setErr(
            `中间件同步失败${c.syncErrorStatus != null ? ` (HTTP ${c.syncErrorStatus})` : ''}：${c.syncError}`,
          );
          if (c.syncErrorBody != null) {
            setErrBody(
              typeof c.syncErrorBody === 'string'
                ? c.syncErrorBody
                : JSON.stringify(c.syncErrorBody, null, 2),
            );
          }
        }
      })
      .catch((e) => {
        setCapacity(null);
        setErr(e.message || '容量加载失败');
      });
  }, []);

  const loadConfig = useCallback(() => {
    AdminApi.ipPoolConfig()
      .then((c) =>
        setCfg({
          usersPerProxy: c.usersPerProxy ?? 10,
          idleNoFillDays: c.idleNoFillDays ?? 14,
          idleFollowOffDays: c.idleFollowOffDays ?? 14,
        }),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadCapacity();
    loadConfig();
  }, [loadCapacity, loadConfig]);

  async function saveConfig() {
    setMsg('');
    setErr('');
    try {
      const c = await AdminApi.setIpPoolConfig({
        usersPerProxy: Number(cfg.usersPerProxy) || 10,
        idleNoFillDays: Number(cfg.idleNoFillDays) || 14,
        idleFollowOffDays: Number(cfg.idleFollowOffDays) || 14,
      });
      setCfg(c);
      setMsg('配置已保存');
      loadCapacity();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function runReclaim() {
    if (!(await confirmDialog('立即执行闲置回收？将关闭长期无成交/关闭跟单过久仍占坑的用户并释放代理。'))) return;
    setLoading(true);
    setMsg('');
    setErr('');
    try {
      const res = await AdminApi.reclaimIdleProxies();
      setMsg(`回收完成：${res?.reclaimed ?? 0} 人`);
      loadCapacity();
    } catch (e: any) {
      setErr(e.message);
    } finally {
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

      <div
        className="card"
        style={{
          borderColor: capacity?.full
            ? 'var(--danger)'
            : capacity?.nearFull
              ? 'var(--warn)'
              : undefined,
        }}
      >
        <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <strong>容量</strong>
          {capacity ? (
            <>
              <span>
                占用 {capacity.occupied}/{capacity.capacity}（剩余 {capacity.remaining}）
              </span>
              <span>
                健康出口 {capacity.healthyProxies} × 每台 {capacity.usersPerProxy}
              </span>
              {!capacity.message ? <span className="badge ok">正常</span> : null}
            </>
          ) : (
            <span className="hint" style={{ margin: 0 }}>
              加载中…
            </span>
          )}
          <button className="ghost" onClick={loadCapacity} style={{ marginLeft: 'auto' }}>
            刷新容量
          </button>
        </div>
        <p className="hint" style={{ margin: '8px 0 0' }}>
          每台最多绑定 {cfg.usersPerProxy}{' '}
          人；新用户按代理创建顺序填满，满了换下一台。满仓禁止新开跟单并记录失败。闲置可回收腾坑，用户稍后可自助回流。
        </p>
        {capacity?.message ? (
          <p className={capacity.full ? 'err' : 'hint'} style={{ margin: '6px 0 0' }}>
            {capacity.message}
          </p>
        ) : null}
      </div>

      <div className="card">
        <h3>池参数</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: '10px 20px', alignItems: 'center' }}>
          <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            每台人数
            <input
              type="number"
              min={1}
              value={cfg.usersPerProxy}
              onChange={(e) => setCfg({ ...cfg, usersPerProxy: Number(e.target.value) || 1 })}
              style={{ width: 70 }}
            />
          </label>
          <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            无成交回收(天)
            <input
              type="number"
              min={1}
              value={cfg.idleNoFillDays}
              onChange={(e) => setCfg({ ...cfg, idleNoFillDays: Number(e.target.value) || 1 })}
              style={{ width: 70 }}
            />
          </label>
          <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            关跟单占坑回收(天)
            <input
              type="number"
              min={1}
              value={cfg.idleFollowOffDays}
              onChange={(e) => setCfg({ ...cfg, idleFollowOffDays: Number(e.target.value) || 1 })}
              style={{ width: 70 }}
            />
          </label>
          <button onClick={saveConfig}>保存配置</button>
          <button className="ghost" onClick={runReclaim} disabled={loading}>
            {loading ? '回收中…' : '立即回收闲置'}
          </button>
        </div>
      </div>
    </div>
  );
}
