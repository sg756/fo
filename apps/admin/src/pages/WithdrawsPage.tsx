import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminApi } from '../api';
import { DateField } from '../components/DateField';
import { Pagination } from '../components/Pagination';
import { ListLoading } from '../components/ListLoading';
import { SearchSelect } from '../components/SearchSelect';
import { toast } from '../components/Toast';
import { CopyMonoCell } from '../components/CopyMonoCell';
import { normalizePaged, usePager } from '../hooks/usePager';
import {
  useUserOptions,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待审核',
  APPROVED: '已通过·待打款',
  REJECTED: '已驳回',
  RELEASED: '已结算',
  SETTLED: '已结算',
  FAILED: '失败',
};

function userLabel(u?: { userNo?: number | null; nickname?: string | null; email?: string } | null) {
  if (!u) return '—';
  const name = u.nickname || u.email || '—';
  return u.userNo != null ? `${name}（#${u.userNo}）` : name;
}

export function WithdrawsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') || '';
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [minAmount, setMinAmount] = useState('0');
  const [cfgBusy, setCfgBusy] = useState(false);
  const pager = usePager(20);
  const userOpts = useUserOptions(userText, userId);

  function setStatus(next: string) {
    const p = new URLSearchParams(searchParams);
    if (next) p.set('status', next);
    else p.delete('status');
    setSearchParams(p, { replace: true });
  }

  function userFilterParams() {
    if (userId) return { userNo: userId };
    const kw = userText.trim();
    if (!kw) return {};
    if (/^\d+$/.test(kw)) return { userNo: kw };
    return { account: kw };
  }

  const load = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setErr('');
      setLoading(true);
      AdminApi.withdraws({
        status: status || undefined,
        ...userFilterParams(),
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
    [status, userText, userId, from, to, pager.page, pager.pageSize],
  );

  useEffect(() => {
    pager.goFirst();
    load({ page: 1 });
  }, [status]);

  useEffect(() => {
    AdminApi.withdrawConfig()
      .then((c) => setMinAmount(String(c.minWithdrawAmount ?? 0)))
      .catch(() => {});
  }, []);

  async function saveMin() {
    const n = Number(minAmount);
    if (!Number.isFinite(n) || n < 0) {
      setErr('最低提现金额须为 ≥0 的数字；0 表示不限制');
      return;
    }
    setCfgBusy(true);
    setErr('');
    try {
      const r = await AdminApi.setWithdrawMinAmount(n);
      setMinAmount(String(r.minWithdrawAmount));
      toast('保存成功', 'ok');
    } catch (e: any) {
      setErr(e.message);
      toast(e.message || '保存失败', 'err');
    } finally {
      setCfgBusy(false);
    }
  }

  function search() {
    pager.goFirst();
    load({ page: 1 });
  }

  async function act(id: string, kind: 'approve' | 'reject' | 'settle') {
    try {
      if (kind === 'approve') {
        await AdminApi.approveWithdraw(id);
        toast('已通过，待打款', 'ok');
      }
      if (kind === 'reject') {
        const remark = prompt('驳回原因（可选）') || undefined;
        await AdminApi.rejectWithdraw(id, remark);
        toast('已驳回', 'ok');
      }
      if (kind === 'settle') {
        const tx = prompt('请输入已打款的交易哈希 txHash（留档确认）');
        if (!tx?.trim()) return;
        await AdminApi.settleWithdraw(id, tx.trim());
        toast('已确认打款，状态变为已结算', 'ok');
      }
      load();
    } catch (e: any) {
      setErr(e.message);
      toast(e.message || '操作失败', 'err');
    }
  }

  function resetFilters() {
    setUserText('');
    setUserId('');
    setFrom('');
    setTo('');
    setStatus('');
    pager.goFirst();
    setLoading(true);
    setErr('');
    AdminApi.withdraws({ skip: 0, take: pager.pageSize })
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

      <div className="card" style={{ padding: '8px 12px', marginBottom: 10 }}>
        <div className="row" style={{ marginBottom: 0, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>提现配置</strong>
          <span className="hint" style={{ margin: 0, fontSize: 12 }}>
            最低提现(USDT)
          </span>
          <input
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
            placeholder="0=不限制"
            title="填 0 时金额 >0 即可申请；大于 0 后 App 会展示并校验"
            style={{ width: 100, padding: '4px 8px', fontSize: 12 }}
          />
          <button
            type="button"
            style={{ padding: '4px 10px', fontSize: 12 }}
            disabled={cfgBusy}
            onClick={() => void saveMin()}
          >
            {cfgBusy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="PENDING">待审核</option>
            <option value="APPROVED">待打款</option>
            <option value="SETTLED">已结算</option>
            <option value="RELEASED">已结算(旧)</option>
            <option value="REJECTED">已驳回</option>
          </select>
          <SearchSelect
            text={userText}
            onTextChange={(t) => {
              setUserText(t);
              if (userId) setUserId('');
            }}
            value={userId}
            onSelect={(o) => setUserId(o?.value || '')}
            options={userOpts.options}
            loading={userOpts.loading}
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
              <th>用户</th>
              <th>金额</th>
              <th>链</th>
              <th>收款地址</th>
              <th>状态</th>
              <th>时间</th>
              <th>交易哈希</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                  暂无提现记录
                </td>
              </tr>
            ) : (
              items.map((w) => (
                <tr key={w.id}>
                  <td style={{ userSelect: 'text' }}>{userLabel(w.user)}</td>
                  <td>{String(w.amount)}</td>
                  <td>{w.chain}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 240 }}>
                    <CopyMonoCell value={w.toAddress} label="收款地址" full />
                    {w.user?.withdrawAddressLabel ? (
                      <div style={{ color: '#8b9bb0' }}>{w.user.withdrawAddressLabel}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className="badge">{STATUS_LABEL[w.status] || w.status}</span>
                  </td>
                  <td>{new Date(w.createdAt).toLocaleString()}</td>
                  <td style={{ maxWidth: 280 }}>
                    <CopyMonoCell value={w.releaseTxHash} label="交易哈希" full />
                  </td>
                  <td className="row">
                    {w.status === 'PENDING' ? (
                      <>
                        <button className="ok" onClick={() => act(w.id, 'approve')}>
                          通过
                        </button>
                        <button className="danger" onClick={() => act(w.id, 'reject')}>
                          驳回
                        </button>
                      </>
                    ) : null}
                    {w.status === 'APPROVED' ? (
                      <>
                        <button onClick={() => act(w.id, 'settle')}>确认已打款→已结算</button>
                        <button className="danger" onClick={() => act(w.id, 'reject')}>
                          驳回解锁
                        </button>
                      </>
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
    </div>
  );
}
