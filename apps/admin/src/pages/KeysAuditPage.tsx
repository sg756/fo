import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { Pagination } from '../components/Pagination';
import { SearchSelect } from '../components/SearchSelect';
import { normalizePaged, usePager } from '../hooks/usePager';
import {
  useUserOptions,
  USER_FILTER_PLACEHOLDER,
  USER_FILTER_EMPTY_HINT,
} from '../hooks/useSearchFilterOptions';

type Tab = 'keys' | 'audit';

const AUDIT_ACTION_LABELS: Record<string, string> = {
  EXCHANGE_KEY_ENABLE: '启用交易所 Key',
  EXCHANGE_KEY_DISABLE: '禁用交易所 Key',
  EXCHANGE_KEY_CLEAR: '清除交易所 Key',
  MIDDLEWARE_CONFIG_UPDATE: '更新中间件配置',
  SIGNAL_TIMEOUT_UPDATE: '更新信号超时',
  FOLLOWER_POLL_MS_UPDATE: '更新跟单轮询间隔',
  ORDER_EXPIRE_UPDATE: '更新订单过期时间',
  OPEN_MIN_POINT_UPDATE: '更新开仓最低积分',
  ADMIN_CANCEL_ORDERS: '管理员撤单',
  ADMIN_CLOSE_POSITION: '管理员手动平仓',
  RETRY_CANCEL_FAILED: '重试撤单失败',
  FOLLOW_TEMPLATE_CREATE: '创建跟单模板',
  FOLLOW_TEMPLATE_UPDATE: '更新跟单模板',
  FOLLOW_TEMPLATE_DELETE: '删除跟单模板',
  PROFIT_MANUAL_RECORD: '手动录收益',
  POINT_ADJUST: '调整积分',
  RECHARGE_CREDIT: '点卡充值入账',
  DEPOSIT_CREDIT: '充值入账',
  DEPOSIT_SIMULATE: '模拟充值',
  COLLECTION_CONFIG_UPDATE: '更新归集配置',
  COLLECTION_ADDRESS_ADD: '添加归集地址',
  COLLECTION_ADDRESS_UPDATE: '更新归集地址',
  COLLECTION_ADDRESS_DELETE: '删除归集地址',
  COLLECTION_ADDRESS_SELECT: '选用归集地址',
  COLLECTION_GAS_WALLET_ADD: '添加平台钱包',
  COLLECTION_GAS_WALLET_CREATE: '一键创建平台钱包',
  COLLECTION_GAS_WALLET_UPDATE: '更新平台钱包',
  COLLECTION_GAS_WALLET_DELETE: '废弃平台钱包',
  COLLECTION_GAS_WALLET_RESTORE: '恢复平台钱包',
  COLLECTION_GAS_WALLET_PURGE: '彻底删除平台钱包',
  COLLECTION_GAS_WALLET_SELECT: '选用 Gas 补给钱包',
  COLLECTION_GAS_WALLET_SELECT_TARGET: '选用平台钱包为归集目标',
  COLLECTION_GAS_WALLET_REVEAL_KEY: '查看平台钱包私钥',
  COLLECTION_FUND_GAS: '批量补 Gas',
  COLLECTION_GAS_FEE_TIER: '补 Gas 出价档位',
  HOT_WALLET_TRANSFER: '热钱包转出',
  ADMIN_TOTP_BIND: '绑定 Google 验证器',
  ADMIN_TOTP_DISABLE: '关闭 Google 验证器',
  USER_APPROVE: '审核通过用户',
  USER_REJECT: '驳回用户',
  USER_DISABLE: '禁用用户',
  USER_ENABLE: '启用用户',
  USER_UPDATE: '编辑用户',
  USER_REBIND: '用户换绑',
  ADMIN_CREATE: '创建管理员',
  ADMIN_SET_ROLE: '设置管理员角色',
  ADMIN_DISABLE: '禁用管理员',
  ADMIN_ROLE_CREATE: '创建角色',
  ADMIN_ROLE_UPDATE: '更新角色',
  ADMIN_ROLE_DELETE: '删除角色',
};

function auditActionLabel(action: string) {
  return AUDIT_ACTION_LABELS[action] || action;
}

const AUDIT_TARGET_TYPE_LABELS: Record<string, string> = {
  User: '用户',
  Admin: '管理员',
  AdminRole: '角色',
  ExchangeKey: '交易所 Key',
  FollowTemplate: '跟单模板',
  ProfitRecord: '收益记录',
  RechargeOrder: '充值单',
  CollectionConfig: '归集配置',
  CollectionAddress: '归集地址',
  CollectionGasWallet: '平台钱包',
};

function auditTargetLabel(r: {
  targetType?: string | null;
  targetId?: string | null;
  targetNickname?: string | null;
  targetEmail?: string | null;
  targetUserNo?: number | null;
}) {
  if (!r.targetType && !r.targetId) return '—';
  if (r.targetType === 'User') {
    const name = r.targetNickname || r.targetEmail || '—';
    const no = r.targetUserNo != null ? `#${r.targetUserNo}` : r.targetId ? `${r.targetId.slice(0, 8)}…` : '';
    return no ? `${name}（${no}）` : name;
  }
  const type = AUDIT_TARGET_TYPE_LABELS[r.targetType || ''] || r.targetType || '—';
  if (!r.targetId) return type;
  return `${type} · ${r.targetId.slice(0, 8)}…`;
}

function userCell(k: any) {
  const name = k.nickname || k.email || '—';
  const no = k.userNo != null ? `#${k.userNo}` : '';
  return no ? `${name}（${no}）` : name;
}

export function KeysAuditPage() {
  const [tab, setTab] = useState<Tab>('keys');
  const [keys, setKeys] = useState<any[]>([]);
  const [userText, setUserText] = useState('');
  const [userId, setUserId] = useState('');
  const [appliedUserId, setAppliedUserId] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [logs, setLogs] = useState<any[]>([]);
  const [actions, setActions] = useState<{ action: string; count: number }[]>([]);
  const [action, setAction] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const keysPager = usePager(20);
  const auditPager = usePager(20);
  const userOpts = useUserOptions(userText, userId);

  const loadKeys = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? keysPager.page;
      const size = opts?.pageSize ?? keysPager.pageSize;
      setErr('');
      AdminApi.exchangeKeys({
        userId: appliedUserId || undefined,
        q: !appliedUserId && appliedQ ? appliedQ : undefined,
        skip: (p - 1) * size,
        take: size,
      })
        .then((r) => {
          const { items, total } = normalizePaged(r);
          setKeys(items);
          keysPager.setTotal(total);
        })
        .catch((e) => setErr(e.message));
    },
    [appliedUserId, appliedQ, keysPager.page, keysPager.pageSize],
  );

  const loadAudit = useCallback(
    (opts?: { page?: number; pageSize?: number }) => {
      const p = opts?.page ?? auditPager.page;
      const size = opts?.pageSize ?? auditPager.pageSize;
      setErr('');
      Promise.all([
        AdminApi.auditLogs({
          action: action || undefined,
          skip: (p - 1) * size,
          take: size,
        }),
        AdminApi.auditActions(),
      ])
        .then(([l, a]) => {
          const { items, total } = normalizePaged(l);
          setLogs(items);
          auditPager.setTotal(total);
          setActions(Array.isArray(a) ? a : []);
        })
        .catch((e) => setErr(e.message));
    },
    [action, auditPager.page, auditPager.pageSize],
  );

  useEffect(() => {
    if (tab === 'keys') {
      keysPager.goFirst();
      loadKeys({ page: 1 });
    } else {
      auditPager.goFirst();
      loadAudit({ page: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, action, appliedUserId, appliedQ]);

  async function toggleActive(k: any) {
    setBusy(k.id);
    setMsg('');
    try {
      await AdminApi.setExchangeKeyActive(k.id, !k.active);
      setMsg(`${userCell(k)} 的 ${k.exchange} Key 已${k.active ? '禁用' : '启用'}`);
      loadKeys();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  async function clearKey(k: any) {
    if (!(await confirmDialog(`清除 ${userCell(k)} 的 ${k.exchange} Key？用户需回 App 重新绑定`))) return;
    setBusy(k.id);
    setMsg('');
    try {
      await AdminApi.removeExchangeKey(k.id);
      setMsg('已清除');
      loadKeys();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  function searchKeys() {
    setAppliedUserId(userId);
    setAppliedQ(userText.trim());
    keysPager.goFirst();
  }

  function resetKeysFilter() {
    setUserText('');
    setUserId('');
    setAppliedUserId('');
    setAppliedQ('');
    keysPager.goFirst();
  }

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="tabs">
        <button className={tab === 'keys' ? 'tab active' : 'tab ghost'} onClick={() => setTab('keys')}>
          交易所 Key
        </button>
        <button className={tab === 'audit' ? 'tab active' : 'tab ghost'} onClick={() => setTab('audit')}>
          审计日志
        </button>
      </div>

      {tab === 'keys' ? (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <SearchSelect
              text={userText}
              onTextChange={setUserText}
              value={userId}
              onSelect={(o) => setUserId(o?.value || '')}
              options={userOpts.options}
              loading={userOpts.loading}
              remote
              placeholder={USER_FILTER_PLACEHOLDER}
              width={240}
              emptyHint={USER_FILTER_EMPTY_HINT}
            />
            <button onClick={searchKeys}>查询</button>
            <button className="ghost" onClick={resetKeysFilter}>
              重置
            </button>
            <button className="ghost" onClick={() => loadKeys()}>
              刷新
            </button>
          </div>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>交易所</th>
                  <th>标签</th>
                  <th>API Key</th>
                  <th>Passphrase</th>
                  <th>状态</th>
                  <th>绑定时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{userCell(k)}</td>
                    <td>{k.exchange}</td>
                    <td>{k.label}</td>
                    <td style={{ fontFamily: 'monospace' }}>{k.apiKeyMasked}</td>
                    <td>{k.hasPassphrase ? '有' : '—'}</td>
                    <td>
                      <span className={`badge ${k.active ? 'ok' : 'danger'}`}>
                        {k.active ? '启用' : '禁用'}
                      </span>
                    </td>
                    <td>{new Date(k.createdAt).toLocaleString()}</td>
                    <td className="row">
                      <button className="ghost" disabled={busy === k.id} onClick={() => toggleActive(k)}>
                        {k.active ? '禁用' : '启用'}
                      </button>
                      <button className="danger" disabled={busy === k.id} onClick={() => clearKey(k)}>
                        清除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {keys.length === 0 ? <p className="hint list-empty">暂无绑定的交易所 Key</p> : null}
            <Pagination
              total={keysPager.total}
              page={keysPager.page}
              pageSize={keysPager.pageSize}
              pageSizes={[10, 20, 50, 100]}
              onChange={(p, s) => {
                keysPager.onPageChange(p, s);
                loadKeys({ page: p, pageSize: s });
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">全部动作</option>
              {actions.map((a) => (
                <option key={a.action} value={a.action}>
                  {auditActionLabel(a.action)} ({a.count})
                </option>
              ))}
            </select>
            <button className="ghost" onClick={() => loadAudit()}>
              刷新
            </button>
          </div>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>动作</th>
                  <th>目标</th>
                  <th>明细</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>{r.actorEmail || (r.actorId ? `${r.actorId.slice(0, 8)}…` : '系统')}</td>
                    <td>
                      <span className="badge">{auditActionLabel(r.action)}</span>
                    </td>
                    <td style={{ fontSize: 12 }}>{auditTargetLabel(r)}</td>
                    <td style={{ maxWidth: 320, fontSize: 12, wordBreak: 'break-all' }}>{r.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {logs.length === 0 ? <p className="hint list-empty">暂无审计记录</p> : null}
            <Pagination
              total={auditPager.total}
              page={auditPager.page}
              pageSize={auditPager.pageSize}
              pageSizes={[10, 20, 50, 100]}
              onChange={(p, s) => {
                auditPager.onPageChange(p, s);
                loadAudit({ page: p, pageSize: s });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
