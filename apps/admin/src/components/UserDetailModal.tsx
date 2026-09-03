import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { ModalCloseButton } from './ModalCloseButton';

function labelOf(u?: { nickname?: string | null; email?: string; inviteCode?: string } | null) {
  if (!u) return '—';
  const name = u.nickname || u.email?.split('@')[0] || u.email || '—';
  return u.inviteCode ? `${name}（${u.inviteCode}）` : name;
}

function fmt(v?: string | Date | null) {
  if (!v) return '—';
  return new Date(v).toLocaleString();
}

type BalAsset = {
  asset: string;
  free: string;
  total: string;
  usdt: string;
  usdtNum: number;
};

type BalAccount = {
  accountType: string;
  label: string;
  ok: boolean;
  message?: string;
  assets: BalAsset[];
  usdt: string;
  usdtNum: number;
};

type BalExchange = {
  exchange: string;
  name: string;
  label: string | null;
  accounts: BalAccount[];
  usdt: string;
  usdtNum: number;
};

type BalPayload = {
  ok: boolean;
  message?: string | null;
  exchanges: BalExchange[];
  totalUsdt: string;
  totalUsdtNum: number;
  fetchedAt: string;
};

export function UserDetailModal({
  userId,
  onClose,
}: {
  userId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const [balances, setBalances] = useState<BalPayload | null>(null);
  const [balErr, setBalErr] = useState('');
  const [balLoading, setBalLoading] = useState(false);

  const loadBalances = useCallback(async (uid: string) => {
    setBalLoading(true);
    setBalErr('');
    try {
      const r = (await AdminApi.userExchangeBalances(uid)) as BalPayload;
      setBalances(r);
      if (!r.ok && r.message) setBalErr(r.message);
    } catch (e: any) {
      setBalances(null);
      setBalErr(e.message || '查询资产失败');
    } finally {
      setBalLoading(false);
    }
  }, []);

  const reload = useCallback((uid: string) => {
    setLoading(true);
    setErr('');
    setBalances(null);
    setBalErr('');
    AdminApi.userDetail(uid)
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!userId) {
      setData(null);
      setErr('');
      setBalances(null);
      setBalErr('');
      return;
    }
    reload(userId);
    void loadBalances(userId);
  }, [userId, reload, loadBalances]);

  if (!userId) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" style={{ width: 'min(920px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>用户详情</h3>
          <ModalCloseButton onClick={onClose} />
        </div>
        {loading ? <p className="hint">加载中…</p> : null}
        {err ? <p className="err">{err}</p> : null}
        {data ? (
          <div className="detail-grid">
            <section>
              <h4>基本信息</h4>
              <dl>
                <dt>用户 ID</dt>
                <dd style={{ fontFamily: 'monospace', userSelect: 'text' }}>{data.userNo ?? '—'}</dd>
                <dt>系统 ID</dt>
                <dd style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', color: 'var(--muted, #888)' }}>
                  {data.id}
                </dd>
                <dt>账号</dt>
                <dd>{data.nickname || data.email}</dd>
                <dt>登录标识</dt>
                <dd style={{ fontFamily: 'monospace', fontSize: 12 }}>{data.email}</dd>
                <dt>邀请码</dt>
                <dd style={{ fontFamily: 'monospace' }}>{data.inviteCode}</dd>
                <dt>状态</dt>
                <dd>
                  <span
                    className={`badge ${
                      data.status === 'ACTIVE' ? 'ok' : data.status === 'PENDING' ? 'warn' : 'danger'
                    }`}
                  >
                    {data.status}
                  </span>
                </dd>
                <dt>注册时间</dt>
                <dd>{fmt(data.createdAt)}</dd>
                <dt>最后登录</dt>
                <dd>{fmt(data.lastLoginAt)}</dd>
                {data.rejectReason ? (
                  <>
                    <dt>拒绝原因</dt>
                    <dd>{data.rejectReason}</dd>
                  </>
                ) : null}
              </dl>
            </section>

            <section>
              <h4>分销关系</h4>
              <dl>
                <dt>直推上级</dt>
                <dd>{labelOf(data.l1)}</dd>
                <dt>间推上级</dt>
                <dd>{labelOf(data.l2)}</dd>
                <dt>直属下级</dt>
                <dd>{data.directCount ?? 0}</dd>
              </dl>
            </section>

            <section>
              <h4>跟单</h4>
              <dl>
                <dt>跟单开关</dt>
                <dd>{data.followEnabled ? '开启' : '关闭'}</dd>
                <dt>开始时间</dt>
                <dd>{fmt(data.followStartedAt)}</dd>
                <dt>停止时间</dt>
                <dd>{fmt(data.followStoppedAt)}</dd>
              </dl>
            </section>

            <section>
              <h4>点卡</h4>
              <dl>
                <dt>余额</dt>
                <dd>{Number(data.pointCard?.balance ?? 0).toFixed(4)}</dd>
                <dt>冻结</dt>
                <dd>{Number(data.pointCard?.frozen ?? 0).toFixed(4)}</dd>
                <dt>可提佣金</dt>
                <dd>{Number(data.pointCard?.commissionBalance ?? 0).toFixed(4)}</dd>
                <dt>佣金冻结</dt>
                <dd>{Number(data.pointCard?.commissionFrozen ?? 0).toFixed(4)}</dd>
              </dl>
            </section>

            <section style={{ gridColumn: '1 / -1' }}>
              <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>交易所资产</h4>
                {balances?.fetchedAt ? (
                  <span className="hint" style={{ flex: 1 }}>
                    {`最近查询 ${new Date(balances.fetchedAt).toLocaleTimeString()} · 合计 ≈ $${balances.totalUsdt}`}
                  </span>
                ) : (
                  <span style={{ flex: 1 }} />
                )}
                <button
                  type="button"
                  className="ghost"
                  disabled={balLoading}
                  onClick={() => void loadBalances(userId)}
                >
                  {balLoading ? '查询中…' : '刷新资产'}
                </button>
              </div>
              {balErr ? <p className="err">{balErr}</p> : null}
              {balLoading && !balances ? <p className="hint">正在查询交易所余额…</p> : null}
              {!balLoading && balances && (balances.exchanges || []).length === 0 ? (
                <p className="hint">{balances.message || '暂无启用中的交易所 Key'}</p>
              ) : null}
              {(balances?.exchanges || []).map((ex) => (
                <div
                  key={ex.exchange}
                  style={{
                    marginBottom: 12,
                    padding: '10px 12px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <div className="row" style={{ alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <strong>
                      {ex.name} {ex.exchange}
                    </strong>
                    {ex.label && ex.label !== 'default' ? (
                      <span className="hint">· {ex.label}</span>
                    ) : null}
                    <span className="hint" style={{ marginLeft: 'auto', fontFamily: 'monospace' }}>
                      本所合计 ≈ ${ex.usdt}
                    </span>
                  </div>
                  {(ex.accounts || []).map((acc) => (
                    <div key={acc.accountType} style={{ marginBottom: 8, paddingLeft: 4 }}>
                      <div className="row" style={{ gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                        <span>
                          {acc.label}
                          <span className="hint"> ({acc.accountType})</span>
                        </span>
                        {acc.ok ? (
                          <span className="hint" style={{ fontFamily: 'monospace' }}>
                            ≈ ${acc.usdt}
                          </span>
                        ) : (
                          <span className="err" style={{ fontSize: 12 }}>
                            {acc.message || '查询失败'}
                          </span>
                        )}
                      </div>
                      {acc.ok && acc.assets.length > 0 ? (
                        <table style={{ width: '100%', fontSize: 12, marginBottom: 4 }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left' }}>币种</th>
                              <th style={{ textAlign: 'right' }}>可用</th>
                              <th style={{ textAlign: 'right' }}>合计</th>
                              <th style={{ textAlign: 'right' }}>≈USDT</th>
                            </tr>
                          </thead>
                          <tbody>
                            {acc.assets.slice(0, 30).map((a) => (
                              <tr key={a.asset}>
                                <td style={{ fontFamily: 'monospace' }}>{a.asset}</td>
                                <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{a.free}</td>
                                <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{a.total}</td>
                                <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{a.usdt}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : null}
                      {acc.ok && acc.assets.length === 0 ? (
                        <p className="hint" style={{ margin: '0 0 4px', fontSize: 12 }}>
                          无持仓资产
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
            </section>

            <section>
              <h4>提现地址</h4>
              {data.withdrawAddress ? (
                <dl>
                  <dt>链</dt>
                  <dd>{data.withdrawChain || '—'}</dd>
                  <dt>地址</dt>
                  <dd style={{ fontFamily: 'monospace', fontSize: 12 }}>{data.withdrawAddress}</dd>
                  <dt>备注</dt>
                  <dd>{data.withdrawAddressLabel || '—'}</dd>
                </dl>
              ) : (
                <p className="hint">未设置</p>
              )}
            </section>

            <section>
              <h4>托管钱包</h4>
              {(data.wallets || []).length === 0 ? (
                <p className="hint">暂无托管地址</p>
              ) : (
                <ul className="detail-list">
                  {data.wallets.map((w: any) => (
                    <li key={w.id}>
                      <strong>{w.chain}</strong>{' '}
                      <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{w.address}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h4>交易所 Key</h4>
              {(data.exchangeKeys || []).length === 0 ? (
                <p className="hint">未绑定</p>
              ) : (
                <ul className="detail-list">
                  {data.exchangeKeys.map((k: any) => (
                    <li key={k.id}>
                      {k.exchange}
                      {k.label && k.label !== 'default' ? ` · ${k.label}` : ''}{' '}
                      <span className={`badge ${k.active ? 'ok' : 'danger'}`}>
                        {k.active ? '启用' : '停用'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function uplineLabel(u: {
  parent?: { nickname?: string | null; email?: string; inviteCode?: string } | null;
  l1?: { nickname?: string | null; email?: string; inviteCode?: string } | null;
  l2?: { nickname?: string | null; email?: string; inviteCode?: string } | null;
  parentId?: string | null;
  l1Id?: string | null;
  l2Id?: string | null;
  which: 'l1' | 'l2';
}) {
  const ref = u.which === 'l1' ? u.l1 || u.parent : u.l2;
  if (ref) return labelOf(ref);
  const id = u.which === 'l1' ? u.parentId || u.l1Id : u.l2Id;
  return id ? `${id.slice(0, 8)}…` : '—';
}
