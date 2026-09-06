import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { DateField } from '../components/DateField';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { Pagination } from '../components/Pagination';
import { ListLoading } from '../components/ListLoading';
import { SearchSelect } from '../components/SearchSelect';
import { normalizePaged, usePager } from '../hooks/usePager';
import {
  useUserOptions,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待确认',
  CONFIRMED: '已确认',
  CREDITED: '已入账',
  FAILED: '失败',
};

/** 手动充值原因（仅可选，不允许自由填写） */
const MANUAL_RECHARGE_REASONS = [
  '线下收款',
  '漏扫补入',
  '链上延迟补入',
  '运营补发',
] as const;

function userLabel(u?: { userNo?: number | null; nickname?: string | null; email?: string } | null) {
  if (!u) return '—';
  const name = u.nickname || u.email || '—';
  return u.userNo != null ? `${name}（#${u.userNo}）` : name;
}

/** 库内幂等键为 txHash:logIndex；展示只留链上 hash */
function displayTxHash(raw?: string | null) {
  if (!raw) return '';
  const hash = raw.includes(':') ? raw.slice(0, raw.lastIndexOf(':')) : raw;
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function RechargesPage() {
  const [status, setStatus] = useState('');
  const [filterUserText, setFilterUserText] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [chainStatus, setChainStatus] = useState<any>(null);
  const [scanChain, setScanChain] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUserText, setManualUserText] = useState('');
  const [manualUserId, setManualUserId] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [manualRemark, setManualRemark] = useState('');
  const [manualTx, setManualTx] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const [manualErr, setManualErr] = useState('');
  const pager = usePager(20);
  const filterUserOpts = useUserOptions(filterUserText, filterUserId);
  const manualUserOpts = useUserOptions(manualUserText, manualUserId);

  const enabledChains: string[] = useMemo(() => {
    const list = chainStatus?.enabledChains;
    if (Array.isArray(list) && list.length) return list;
    return [chainStatus?.primaryChain || 'ARB'];
  }, [chainStatus]);

  const singleChain = enabledChains.length <= 1;

  const load = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setErr('');
      setLoading(true);
      AdminApi.recharges({
        status: status || undefined,
        userId: filterUserId || undefined,
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
    [status, filterUserId, from, to, pager.page, pager.pageSize],
  );

  useEffect(() => {
    pager.goFirst();
    load({ page: 1 });
  }, [status]);

  useEffect(() => {
    AdminApi.collectionStatus()
      .then((s) => {
        setChainStatus(s);
        const primary = s?.primaryChain || s?.enabledChains?.[0] || 'ARB';
        const enabled: string[] =
          Array.isArray(s?.enabledChains) && s.enabledChains.length ? s.enabledChains : [primary];
        setScanChain((c) => (c && enabled.includes(c) ? c : ''));
      })
      .catch(() => {});
  }, []);

  async function credit(id: string) {
    if (!(await confirmDialog('确认将该笔充值入账到用户点卡？'))) return;
    setBusy(id);
    setMsg('');
    try {
      await AdminApi.creditRecharge(id);
      setMsg('入账成功');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function scan() {
    setMsg('');
    try {
      const res = await AdminApi.depositScan(scanChain || undefined);
      setMsg(res?.ok === false ? '扫块未完成' : '扫块完成');
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  function openManual() {
    setManualUserText('');
    setManualUserId('');
    setManualAmount('');
    setManualRemark('');
    setManualTx('');
    setManualErr('');
    setManualOpen(true);
    setErr('');
  }

  async function submitManual() {
    if (!manualUserId) {
      setManualErr('请选择用户');
      return;
    }
    const amount = Number(manualAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setManualErr('充值金额必须为正数');
      return;
    }
    if (!manualRemark.trim()) {
      setManualErr('请选择备注');
      return;
    }
    setManualSaving(true);
    setManualErr('');
    setErr('');
    setMsg('');
    try {
      await AdminApi.manualRecharge({
        userId: manualUserId,
        amount,
        remark: manualRemark.trim(),
        txHash: manualTx.trim() || undefined,
      });
      setManualOpen(false);
      setMsg(`手动充值成功：${manualUserText || manualUserId} +${amount}`);
      load();
    } catch (e: any) {
      setManualErr(e.message || '手动充值失败');
    } finally {
      setManualSaving(false);
    }
  }

  function search() {
    pager.goFirst();
    load({ page: 1 });
  }

  function resetFilters() {
    setFilterUserText('');
    setFilterUserId('');
    setFrom('');
    setTo('');
    pager.goFirst();
    setLoading(true);
    setErr('');
    AdminApi.recharges({ status: status || undefined, skip: 0, take: pager.pageSize })
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

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card">
        <h3>运维工具</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <label>手动扫块</label>
          {singleChain ? (
            <span className="badge ok" style={{ padding: '8px 12px' }}>
              {enabledChains[0]}
            </span>
          ) : (
            <select value={scanChain} onChange={(e) => setScanChain(e.target.value)}>
              <option value="">全部启用链</option>
              {enabledChains.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <button className="ghost" onClick={scan}>
            立即扫块
          </button>
          <button onClick={openManual}>手动充值</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="PENDING">待确认</option>
            <option value="CONFIRMED">已确认</option>
            <option value="CREDITED">已入账</option>
            <option value="FAILED">失败</option>
          </select>
          <SearchSelect
            text={filterUserText}
            onTextChange={setFilterUserText}
            value={filterUserId}
            onSelect={(o) => setFilterUserId(o?.value || '')}
            options={filterUserOpts.options}
            loading={filterUserOpts.loading}
            remote
            placeholder={USER_FILTER_PLACEHOLDER}
            width={200}
            emptyHint={USER_FILTER_EMPTY_HINT}
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
          <button className="ghost" onClick={() => load()} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="查询中…" />
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>用户</th>
              <th>链</th>
              <th>收款地址</th>
              <th>金额</th>
              <th>确认数</th>
              <th>状态</th>
              <th>txHash</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                  暂无充值记录
                </td>
              </tr>
            ) : (
              items.map((o) => (
                <tr key={o.id}>
                  <td>{new Date(o.createdAt).toLocaleString()}</td>
                  <td style={{ userSelect: 'text' }}>{userLabel(o.user)}</td>
                  <td>{o.chain}</td>
                  <td
                    style={{
                      fontFamily: 'monospace',
                      fontSize: 11,
                      maxWidth: 200,
                      wordBreak: 'break-all',
                      userSelect: 'text',
                    }}
                    title={o.wallet?.address || ''}
                  >
                    {o.wallet?.address || '—'}
                  </td>
                  <td>
                    {String(o.amount)} {o.tokenSymbol}
                  </td>
                  <td>{o.confirmations}</td>
                  <td>
                    <span
                      className={`badge ${
                        o.status === 'CREDITED' ? 'ok' : o.status === 'FAILED' ? 'danger' : 'warn'
                      }`}
                    >
                      {STATUS_LABEL[o.status] || o.status}
                    </span>
                  </td>
                  <td
                    style={{ fontFamily: 'monospace', fontSize: 11, maxWidth: 160 }}
                    title={o.txHash?.includes(':') ? o.txHash.slice(0, o.txHash.lastIndexOf(':')) : o.txHash || ''}
                  >
                    {o.txHash ? displayTxHash(o.txHash) : '—'}
                  </td>
                  <td>
                    {o.status === 'PENDING' || o.status === 'CONFIRMED' ? (
                      <button disabled={busy === o.id} onClick={() => credit(o.id)}>
                        手动入账
                      </button>
                    ) : (
                      '—'
                    )}
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

      {manualOpen ? (
        <div className="modal-backdrop" onClick={() => !manualSaving && setManualOpen(false)}>
          <div className="modal-panel" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>手动充值</h3>
              <ModalCloseButton disabled={manualSaving} onClick={() => setManualOpen(false)} />
            </div>

            <label style={{ display: 'block', marginBottom: 8, color: 'var(--muted)', fontSize: 12 }}>
              用户
            </label>
            <div style={{ marginBottom: 14 }}>
              <SearchSelect
                text={manualUserText}
                onTextChange={(t) => {
                  setManualUserText(t);
                  setManualErr('');
                }}
                value={manualUserId}
                onSelect={(o) => {
                  setManualUserId(o?.value || '');
                  if (o) setManualErr('');
                }}
                options={manualUserOpts.options}
                loading={manualUserOpts.loading}
                remote
                placeholder={USER_FILTER_PLACEHOLDER}
                width="100%"
                emptyHint={USER_FILTER_EMPTY_HINT}
                disabled={manualSaving}
              />
            </div>

            {manualErr ? <p className="err">{manualErr}</p> : null}

            <div className="user-edit-fields">
              <label>
                充值金额（USDT）
                <input
                  value={manualAmount}
                  onChange={(e) => setManualAmount(e.target.value)}
                  placeholder="必须为正数"
                  disabled={!manualUserId}
                />
              </label>
              <label>
                备注（必填）
                <select
                  value={manualRemark}
                  onChange={(e) => setManualRemark(e.target.value)}
                  disabled={!manualUserId}
                >
                  <option value="">请选择原因</option>
                  {MANUAL_RECHARGE_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                txHash（选填）
                <input
                  value={manualTx}
                  onChange={(e) => setManualTx(e.target.value)}
                  placeholder="有链上哈希可填，否则系统自动生成"
                  disabled={!manualUserId}
                />
              </label>
            </div>
            <div className="row" style={{ marginTop: 20, marginBottom: 0 }}>
              <button type="button" disabled={manualSaving || !manualUserId} onClick={() => void submitManual()}>
                {manualSaving ? '提交中…' : '确认充值'}
              </button>
              <button type="button" className="ghost" disabled={manualSaving} onClick={() => setManualOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
