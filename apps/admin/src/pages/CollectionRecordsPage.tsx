import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { toast } from '../components/Toast';
import { copyToClipboard } from '../utils/clipboard';
import { DateField } from '../components/DateField';
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
  SENT: '已发送',
  FAILED: '失败',
  PENDING: '处理中',
};

function short(addr?: string | null, head = 10, tail = 6) {
  if (!addr) return '—';
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function userLabel(u?: { userNo?: number | null; nickname?: string | null; email?: string } | null) {
  if (!u) return '—';
  const name = u.nickname || u.email || '—';
  return u.userNo != null ? `${name}（#${u.userNo}）` : name;
}

function fmtEth(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(6);
}

export function CollectionRecordsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [token, setToken] = useState('');
  const pager = usePager(20);
  const userOpts = useUserOptions(userText, userId);

  /** 已选用户用 id；未选则按输入：纯数字=用户ID，否则按昵称模糊 */
  function userFilterParams() {
    if (userId) return { userNo: userId };
    const kw = userText.trim();
    if (!kw) return {};
    if (/^\d+$/.test(kw)) return { userNo: kw };
    return { account: kw };
  }

  const load = useCallback(
    async (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? pager.page;
      const size = opts?.pageSize ?? pager.pageSize;
      setLoading(true);
      setErr('');
      try {
        const r = await AdminApi.collectionRecords({
          ...userFilterParams(),
          from: from || undefined,
          to: to || undefined,
          token: token || undefined,
          skip: (p - 1) * size,
          take: size,
        });
        const { items: list, total } = normalizePaged(r);
        setItems(list);
        pager.setTotal(total);
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    },
    [userText, userId, from, to, token, pager.page, pager.pageSize],
  );

  useEffect(() => {
    load({ page: 1 });
  }, []);

  function search() {
    pager.goFirst();
    load({ page: 1 });
  }

  async function copy(text: string, label: string) {
    const ok = await copyToClipboard(text);
    if (ok) toast(`已复制${label}`, 'ok');
    else toast('复制失败，请手动选中', 'err');
  }

  function resetFilters() {
    setUserText('');
    setUserId('');
    setFrom('');
    setTo('');
    setToken('');
    pager.goFirst();
    setLoading(true);
    setErr('');
    AdminApi.collectionRecords({ skip: 0, take: pager.pageSize })
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

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>用户</label>
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
          <select value={token} onChange={(e) => setToken(e.target.value)} style={{ padding: '4px 8px' }}>
            <option value="">全部类型</option>
            <option value="USDT">归集 USDT</option>
            <option value="ETH">补 Gas ETH</option>
          </select>
          <button onClick={search} disabled={loading}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button className="ghost" onClick={resetFilters} disabled={loading}>
            重置
          </button>
          <button className="ghost" onClick={() => load()} disabled={loading} style={{ marginLeft: 'auto' }}>
            刷新
          </button>
        </div>
      </div>

      <div className="card list-loading-wrap">
        <ListLoading show={loading} text="查询中…" />
        <div className="row">
          <h3 style={{ margin: 0, flex: 1 }}>归集 / 补 Gas 记录</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>用户</th>
              <th>金额</th>
              <th>地址</th>
              <th>txHash</th>
              <th>状态</th>
              <th>失败详情</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted, #9aa4b2)' }}>
                  暂无归集 / 补 Gas 记录
                </td>
              </tr>
            ) : (
              items.map((r) => {
                const isEth = String(r.tokenSymbol || '').toUpperCase() === 'ETH';
                const addr = r.targetAddress || r.fromWallet?.address;
                return (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`badge ${isEth ? 'warn' : 'ok'}`}>{isEth ? '补 Gas' : '归集'}</span>
                  </td>
                  <td style={{ userSelect: 'text' }}>{userLabel(r.fromWallet?.user)}</td>
                  <td>
                    {String(r.amount)} {isEth ? 'ETH' : 'USDT'}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {short(addr)}
                      {addr ? (
                        <button
                          type="button"
                          className="ghost"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={() => copy(addr, isEth ? '托管地址' : '归集地址')}
                        >
                          复制
                        </button>
                      ) : null}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {r.txHash ? short(r.txHash, 12, 6) : '—'}
                      {r.txHash ? (
                        <button
                          type="button"
                          className="ghost"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={() => copy(r.txHash, 'txHash')}
                        >
                          复制
                        </button>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${r.status === 'SENT' ? 'ok' : r.status === 'FAILED' ? 'danger' : ''}`}>
                      {STATUS_LABEL[r.status] || r.status}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, maxWidth: 320, whiteSpace: 'normal' }}>
                    {r.status === 'FAILED' ? (
                      <div>
                        <div title={r.failReason || undefined} style={{ wordBreak: 'break-word' }}>
                          {r.failReason || '—'}
                        </div>
                        {r.gasRequired != null || r.gasHave != null || r.gasDeficit != null ? (
                          <div className="hint" style={{ margin: '4px 0 0' }}>
                            Gas 需 {fmtEth(r.gasRequired)} / 有 {fmtEth(r.gasHave)}
                            {r.gasDeficit != null && Number(r.gasDeficit) > 0
                              ? ` · 差 ${fmtEth(r.gasDeficit)}`
                              : ''}
                          </div>
                        ) : null}
                        <div className="hint" style={{ margin: '2px 0 0' }}>
                          损耗 {fmtEth(r.gasLost ?? 0)} ETH
                          {Number(r.gasLost || 0) === 0 ? '（未上链或未扣费）' : ''}
                        </div>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                );
              })
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
