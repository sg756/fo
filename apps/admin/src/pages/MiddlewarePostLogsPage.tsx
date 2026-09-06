import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { ListLoading } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { confirmDialog } from '../components/ConfirmDialog';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { toast } from '../components/Toast';
import { normalizePaged, usePager } from '../hooks/usePager';

function fmtJson(v: any) {
  if (v == null || v === '') return '—';
  if (typeof v !== 'string') {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

/** 中间件 POST / GET 请求日志 */
export function MiddlewarePostLogsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [features, setFeatures] = useState<{ feature: string; count: number }[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [feature, setFeature] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<any | null>(null);
  const [fromAt, setFromAt] = useState('');
  const [toAt, setToAt] = useState('');
  const [purging, setPurging] = useState<'all' | 'range' | null>(null);
  const [logEnabled, setLogEnabled] = useState(false);
  const [logSaving, setLogSaving] = useState(false);
  const pager = usePager(20);

  const load = useCallback(
    (opts?: { page?: number; pageSize?: number; refreshFeatures?: boolean }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setErr('');
      setLoading(true);
      const tasks: Promise<any>[] = [
        AdminApi.postLogs({
          success: success === '' ? undefined : success === 'true',
          feature: feature || undefined,
          endpoint: endpoint.trim() || undefined,
          q: q.trim() || undefined,
          skip: (p - 1) * size,
          take: size,
        }),
      ];
      if (opts?.refreshFeatures || features.length === 0) {
        tasks.push(AdminApi.postLogFeatures());
      }
      Promise.all(tasks)
        .then(([r, f]) => {
          const { items: list, total } = normalizePaged(r);
          setItems(list);
          pager.setTotal(total);
          if (Array.isArray(f)) setFeatures(f);
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    },
    [success, feature, endpoint, q, pager.page, pager.pageSize, features.length],
  );

  useEffect(() => {
    AdminApi.postLogConfig()
      .then((c) => setLogEnabled(!!c.enabled))
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    load({ page: 1, refreshFeatures: true });
    pager.goFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success, feature]);

  async function toggleLogEnabled(on: boolean) {
    setLogSaving(true);
    setErr('');
    try {
      const r = await AdminApi.setPostLogEnabled(on);
      setLogEnabled(!!r.enabled);
      toast(on ? '已开启中间件日志' : '已关闭中间件日志，不再写入', 'ok');
    } catch (e: any) {
      toast(e.message || '保存失败', 'err');
    } finally {
      setLogSaving(false);
    }
  }

  function search() {
    pager.goFirst();
    load({ page: 1 });
  }

  async function openDetail(id: string) {
    setErr('');
    try {
      const row = await AdminApi.postLogDetail(id);
      setDetail(row);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function purgeAll() {
    if (!(await confirmDialog('确认清空全部中间件日志？此操作不可恢复。'))) return;
    setPurging('all');
    setErr('');
    try {
      await AdminApi.purgePostLogs({ mode: 'all' });
      setDetail(null);
      load({ page: 1, refreshFeatures: true });
      pager.goFirst();
    } catch (e: any) {
      toast(e.message || '清理失败', 'err');
    } finally {
      setPurging(null);
    }
  }

  async function purgeRange() {
    if (!fromAt && !toAt) {
      toast('请填写开始或结束时间', 'err');
      return;
    }
    const label = [fromAt || '…', toAt || '…'].join(' ~ ');
    if (!(await confirmDialog(`确认清理时间范围内的日志？\n${label}\n此操作不可恢复。`))) return;
    setPurging('range');
    setErr('');
    try {
      await AdminApi.purgePostLogs({
        mode: 'range',
        from: fromAt || undefined,
        to: toAt || undefined,
      });
      setDetail(null);
      load({ page: 1, refreshFeatures: true });
      pager.goFirst();
    } catch (e: any) {
      toast(e.message || '清理失败', 'err');
    } finally {
      setPurging(null);
    }
  }

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <div
          style={{
            marginBottom: 14,
            padding: '12px 14px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--hover)',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              cursor: logSaving ? 'wait' : 'pointer',
              margin: 0,
            }}
          >
            <input
              type="checkbox"
              checked={logEnabled}
              disabled={logSaving}
              onChange={(e) => void toggleLogEnabled(e.target.checked)}
              style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0 }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 650, fontSize: 14, color: 'var(--text)' }}>
                记录中间件日志
              </span>
              <span className="hint" style={{ display: 'block', marginTop: 4 }}>
                勾选后才把中间件 GET/POST 写入本页列表。默认关闭，关闭后不再存储。
                盘口、交易对、跟单信号始终不写。
              </span>
            </span>
          </label>
        </div>

        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select value={success} onChange={(e) => setSuccess(e.target.value)}>
            <option value="">全部状态</option>
            <option value="true">成功</option>
            <option value="false">失败</option>
          </select>
          <select value={feature} onChange={(e) => setFeature(e.target.value)}>
            <option value="">全部功能</option>
            {features.map((f) => (
              <option key={f.feature} value={f.feature}>
                {f.feature} ({f.count})
              </option>
            ))}
          </select>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="接口名"
            style={{ width: 160 }}
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="关键词（功能/接口/路径）"
            style={{ width: 200 }}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button onClick={search} disabled={loading || !!purging}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button
            className="ghost"
            disabled={loading || !!purging}
            onClick={() => {
              setSuccess('');
              setFeature('');
              setEndpoint('');
              setQ('');
              pager.goFirst();
              setLoading(true);
              setErr('');
              Promise.all([
                AdminApi.postLogs({ skip: 0, take: pager.pageSize }),
                AdminApi.postLogFeatures(),
              ])
                .then(([r, f]) => {
                  const { items: list, total } = normalizePaged(r);
                  setItems(list);
                  pager.setTotal(total);
                  setFeatures(Array.isArray(f) ? f : []);
                })
                .catch((e) => setErr(e.message))
                .finally(() => setLoading(false));
            }}
          >
            重置
          </button>
        </div>

        <div
          className="row"
          style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 }}
        >
          <span className="hint">清理</span>
          <input
            type="datetime-local"
            value={fromAt}
            onChange={(e) => setFromAt(e.target.value)}
            title="开始时间"
          />
          <span className="hint">至</span>
          <input
            type="datetime-local"
            value={toAt}
            onChange={(e) => setToAt(e.target.value)}
            title="结束时间"
          />
          <button
            className="ghost btn-with-spinner"
            disabled={!!purging || loading}
            onClick={() => void purgeRange()}
          >
            {purging === 'range' ? <span className="btn-spinner" aria-hidden /> : null}
            清理时间范围
          </button>
          <button
            className="ghost btn-with-spinner"
            style={{ color: 'var(--danger, #c0392b)' }}
            disabled={!!purging || loading}
            onClick={() => void purgeAll()}
          >
            {purging === 'all' ? <span className="btn-spinner" aria-hidden /> : null}
            清理全部
          </button>
        </div>
      </div>

      <div className="card list-body list-loading-wrap">
        <ListLoading show={loading} text="加载中…" />
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>功能</th>
              <th>接口名</th>
              <th>请求路径</th>
              <th>方法</th>
              <th>状态</th>
              <th>HTTP</th>
              <th>耗时</th>
              <th>用户</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}
                </td>
                <td>{r.feature || '—'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.endpoint}</td>
                <td
                  style={{ fontFamily: 'monospace', fontSize: 11, maxWidth: 320 }}
                  title={r.path || r.endpoint || ''}
                >
                  {r.path || r.endpoint || '—'}
                </td>
                <td>{r.method || '—'}</td>
                <td>
                  <span className={`badge ${r.success ? 'ok' : 'danger'}`}>
                    {r.success ? '成功' : '失败'}
                  </span>
                </td>
                <td>{r.statusCode ?? '—'}</td>
                <td>{r.latencyMs != null ? `${r.latencyMs}ms` : '—'}</td>
                <td style={{ fontSize: 12 }}>{r.userLabel || '—'}</td>
                <td className="row" style={{ margin: 0 }}>
                  <button className="ghost" onClick={() => void openDetail(r.id)}>
                    详情
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && !loading ? (
          <p className="hint list-empty">暂无中间件请求日志</p>
        ) : null}
        <Pagination
          total={pager.total}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[20, 50, 100]}
          disabled={loading}
          onChange={(p, s) => {
            pager.onPageChange(p, s);
            load({ page: p, pageSize: s });
          }}
        />
      </div>

      {detail ? (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 820 }}
          >
            <div className="modal-head">
              <h3>请求详情</h3>
              <ModalCloseButton onClick={() => setDetail(null)} />
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              {detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '—'} ·{' '}
              {detail.feature || '—'} · {detail.method}{' '}
              <span style={{ fontFamily: 'monospace' }}>
                {detail.path || detail.endpoint}
              </span>{' '}
              ·{' '}
              <span className={detail.success ? 'ok-msg' : 'err'}>
                {detail.success ? '成功' : '失败'}
              </span>
              {detail.statusCode != null ? ` · HTTP ${detail.statusCode}` : ''}
              {detail.latencyMs != null ? ` · ${detail.latencyMs}ms` : ''}
            </p>
            <label style={{ display: 'block', marginBottom: 6 }}>请求路径</label>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontSize: 12,
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 10,
                marginBottom: 12,
              }}
            >
              {detail.path || detail.endpoint || '—'}
            </pre>
            <label style={{ display: 'block', marginBottom: 6 }}>请求参数（原始 JSON）</label>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontSize: 12,
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 10,
                maxHeight: 240,
                overflow: 'auto',
                marginTop: 0,
              }}
            >
              {fmtJson(detail.requestBody)}
            </pre>
            <label style={{ display: 'block', marginBottom: 6 }}>返回值（原始）</label>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontSize: 12,
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 10,
                maxHeight: 280,
                overflow: 'auto',
                marginTop: 0,
              }}
            >
              {fmtJson(detail.responseBody)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
