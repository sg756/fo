import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { toast } from '../components/Toast';
import { isOnChainRateLimitError, useRefreshCooldown } from '../hooks/useRefreshCooldown';
import { copyToClipboard } from '../utils/clipboard';

function isEvmAddress(addr: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function fmtBal(v: unknown, digits: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return (0).toFixed(digits);
  return n.toFixed(digits);
}

function shortAddr(addr: string) {
  const s = String(addr || '');
  if (s.length < 12) return s || '—';
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

/** 归集目标：外部地址（交易所/冷钱包）+ 选用平台自持钱包 */
export function CollectionAddressesPage() {
  const [chain, setChain] = useState('ARB');
  const [items, setItems] = useState<any[]>([]);
  const [configs, setConfigs] = useState<any[]>([]);
  const [platformWallets, setPlatformWallets] = useState<any[]>([]);
  const [enabledChains, setEnabledChains] = useState<string[]>(['ARB']);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalErr, setModalErr] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [formAddress, setFormAddress] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [pickPlatformId, setPickPlatformId] = useState('');
  const [createdReveal, setCreatedReveal] = useState<{ address: string; privateKey: string } | null>(
    null,
  );
  const refreshCd = useRefreshCooldown();

  const currentCfg = useMemo(() => configs.find((c) => c.chain === chain), [configs, chain]);
  const singleChain = enabledChains.length <= 1;

  const currentTarget = useMemo(() => {
    return currentCfg?.targetAddress ? String(currentCfg.targetAddress) : '';
  }, [currentCfg]);

  const platformAddrSet = useMemo(() => {
    const s = new Set<string>();
    for (const w of platformWallets) {
      const a = String(w.address || '').toLowerCase();
      if (a) s.add(a);
    }
    return s;
  }, [platformWallets]);

  const pickedIsCurrent = useMemo(() => {
    const w = platformWallets.find((x) => x.id === pickPlatformId);
    return (
      !!w &&
      !!currentTarget &&
      !!w.address &&
      currentTarget.toLowerCase() === String(w.address).toLowerCase()
    );
  }, [platformWallets, pickPlatformId, currentTarget]);

  const load = useCallback(async (opts?: { quietRateLimit?: boolean }) => {
    setLoading(true);
    setErr('');
    try {
      const [list, status, cfgs, gasList] = await Promise.all([
        AdminApi.collectionAddresses(chain, { withBalance: true }),
        AdminApi.collectionStatus(),
        AdminApi.collectionConfigs(),
        AdminApi.collectionGasWallets(chain),
      ]);
      setItems(Array.isArray(list) ? list : []);
      const cfgList = Array.isArray(cfgs) ? cfgs : status?.configs || [];
      setConfigs(cfgList);
      const wallets = Array.isArray(gasList) ? gasList : [];
      setPlatformWallets(wallets);
      const enabled: string[] =
        Array.isArray(status?.enabledChains) && status.enabledChains.length
          ? status.enabledChains
          : [status?.primaryChain || 'ARB'];
      setEnabledChains(enabled);
      const nextChain = enabled.includes(chain) ? chain : enabled[0] || 'ARB';
      if (nextChain !== chain) setChain(nextChain);
    } catch (e: any) {
      if (opts?.quietRateLimit && isOnChainRateLimitError(e)) return;
      toast(e.message);
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    void load({ quietRateLimit: true });
  }, [load]);

  function openModal(forEdit?: any) {
    setModalErr('');
    if (forEdit) {
      setEditId(forEdit.id);
      setFormAddress(forEdit.address || '');
      setFormLabel(forEdit.label || '');
    } else {
      setEditId(null);
      setFormAddress('');
      setFormLabel('');
    }
    setModalOpen(true);
  }

  function closeModal() {
    if (busy === 'save' || busy === 'pick-platform' || busy === 'create-platform') return;
    setModalOpen(false);
    setEditId(null);
    setFormAddress('');
    setFormLabel('');
    setModalErr('');
    setCreatedReveal(null);
  }

  async function saveInModal() {
    const addr = formAddress.trim();
    if (!isEvmAddress(addr)) {
      setModalErr('请填写有效的 0x 地址（42 位）');
      return;
    }
    setBusy('save');
    setModalErr('');
    try {
      if (editId) {
        await AdminApi.updateCollectionAddress(editId, {
          address: addr,
          label: formLabel.trim() || '',
        });
        toast('已更新', 'ok');
      } else {
        await AdminApi.addCollectionAddress({
          chain,
          address: addr,
          label: formLabel.trim() || undefined,
        });
        toast('已添加', 'ok');
      }
      setEditId(null);
      setFormAddress('');
      setFormLabel('');
      await load();
    } catch (e: any) {
      setModalErr(e.message || '保存失败');
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string) {
    if (!(await confirmDialog('确认删除该归集地址？'))) return;
    setBusy(id);
    setModalErr('');
    setErr('');
    try {
      await AdminApi.deleteCollectionAddress(id);
      toast('已删除', 'ok');
      if (editId === id) {
        setEditId(null);
        setFormAddress('');
        setFormLabel('');
      }
      await load();
    } catch (e: any) {
      const msg = e.message || '删除失败';
      if (modalOpen) setModalErr(msg);
      else setErr(msg);
    } finally {
      setBusy('');
    }
  }

  async function select(id: string) {
    setBusy(id);
    setErr('');
    try {
      await AdminApi.selectCollectionAddress(id);
      toast('已设为当前归集地址', 'ok');
      await load();
    } catch (e: any) {
      setErr(e.message || '设置失败');
    } finally {
      setBusy('');
    }
  }

  async function selectPlatformAsTarget() {
    if (!pickPlatformId) {
      setModalErr('请选择平台钱包');
      return;
    }
    setBusy('pick-platform');
    setModalErr('');
    try {
      await AdminApi.selectCollectionGasWalletAsTarget(pickPlatformId);
      toast('已设为当前归集目标', 'ok');
      await load();
    } catch (e: any) {
      setModalErr(e.message || '设置失败');
    } finally {
      setBusy('');
    }
  }

  async function createPlatformAndSetTarget() {
    if (
      !(await confirmDialog(
        '将创建一把新的平台钱包并设为当前归集目标。创建后请立即备份私钥（也可稍后在「平台钱包」页查看）。',
      ))
    ) {
      return;
    }
    setBusy('create-platform');
    setModalErr('');
    try {
      const row = await AdminApi.createCollectionGasWallet({
        chain,
        label: '归集收款',
        setActive: false,
      });
      setCreatedReveal({ address: row.address, privateKey: row.privateKey });
      setPickPlatformId(row.id);
      await AdminApi.selectCollectionGasWalletAsTarget(row.id);
      toast('已创建并设为归集目标，请备份私钥', 'ok');
      await load();
    } catch (e: any) {
      setModalErr(e.message || '创建失败');
    } finally {
      setBusy('');
    }
  }

  function isPlatformAddr(addr: string) {
    return platformAddrSet.has(String(addr || '').toLowerCase());
  }

  async function copyText(text: string, label: string) {
    const ok = await copyToClipboard(text);
    if (ok) toast(`已复制${label}`, 'ok');
    else toast('复制失败，请手动选中', 'err');
  }

  return (
    <div className="page-list">
      <p className="hint" style={{ marginTop: 0 }}>
        本页管理<strong>外部</strong>归集地址（交易所充值/冷钱包，无私钥）。平台自持收款请到{' '}
        <Link to="/gas-wallets">平台钱包</Link> 选用，或在弹窗内一键创建。
      </p>
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <div className="row" style={{ marginBottom: 12, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {singleChain ? (
            <span className="badge ok">{chain}</span>
          ) : (
            <select
              value={chain}
              onChange={(e) => setChain(e.target.value)}
              style={{ padding: '4px 8px', fontSize: 12 }}
            >
              {enabledChains.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}
            disabled={loading}
            onClick={() => {
              if (!refreshCd.tryStart()) return;
              void load();
            }}
          >
            {loading ? '查询中…' : '刷新余额'}
          </button>
          <button type="button" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => openModal()}>
            管理归集地址
          </button>
        </div>

        <table>
          <thead>
            <tr>
              <th>备注</th>
              <th>地址</th>
              <th>USDT</th>
              <th>ETH</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
                  暂无地址，请点「管理归集地址」添加外部地址或选用平台钱包
                </td>
              </tr>
            ) : (
              items.map((row) => {
                const isCurrent =
                  currentTarget &&
                  row.address &&
                  currentTarget.toLowerCase() === String(row.address).toLowerCase();
                return (
                  <tr key={row.id}>
                    <td>
                      {row.label || '—'}
                      {isPlatformAddr(row.address) ? (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          平台钱包
                        </span>
                      ) : null}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, userSelect: 'text' }}>
                      {row.address}
                    </td>
                    <td>{fmtBal(row.usdt, 4)}</td>
                    <td>{fmtBal(row.native, 6)}</td>
                    <td>{isCurrent ? <span className="badge ok">当前归集</span> : '—'}</td>
                    <td className="ops">
                      {!isCurrent ? (
                        <button
                          className="ghost"
                          style={{ padding: '2px 8px', fontSize: 12 }}
                          disabled={!!busy}
                          onClick={() => void select(row.id)}
                        >
                          设为归集
                        </button>
                      ) : null}
                      <button
                        className="ghost"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        disabled={!!busy}
                        onClick={() => openModal(row)}
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modalOpen ? (
        <div className="modal-backdrop" onClick={closeModal}>
          <div
            className="modal-panel"
            style={{ maxWidth: 640, width: 'min(640px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h3>管理归集地址（{chain}）</h3>
              <ModalCloseButton
                disabled={busy === 'save' || busy === 'pick-platform' || busy === 'create-platform'}
                onClick={closeModal}
              />
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              外部地址（交易所/冷钱包）与平台自持钱包分开添加。选用平台钱包后可在{' '}
              <Link to="/gas-wallets">平台钱包</Link> 转出。
            </p>
            {modalErr ? <p className="err">{modalErr}</p> : null}

            {createdReveal ? (
              <div
                style={{
                  marginBottom: 12,
                  padding: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.08)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 8 }}>新平台钱包私钥（请立即备份）</div>
                <div className="hint" style={{ margin: '0 0 4px' }}>
                  地址
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>
                  {createdReveal.address}
                </div>
                <div className="hint" style={{ margin: '0 0 4px' }}>
                  私钥
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>
                  {createdReveal.privateKey}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void copyText(createdReveal.address, '地址')}
                  >
                    复制地址
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void copyText(createdReveal.privateKey, '私钥')}
                  >
                    复制私钥
                  </button>
                  <button type="button" className="ghost" onClick={() => setCreatedReveal(null)}>
                    关闭显示
                  </button>
                </div>
              </div>
            ) : null}

            <div
              style={{
                marginBottom: 16,
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 8 }}>平台钱包（自持）</div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
                <select
                  value={pickPlatformId}
                  onChange={(e) => setPickPlatformId(e.target.value)}
                  style={{ flex: 1, minWidth: 220 }}
                  disabled={!!busy}
                >
                  <option value="">选用已有平台钱包…</option>
                  {platformWallets.map((w) => {
                    const isCurrent =
                      currentTarget &&
                      w.address &&
                      currentTarget.toLowerCase() === String(w.address).toLowerCase();
                    return (
                      <option key={w.id} value={w.id}>
                        {(w.label || '平台钱包') + ' · ' + shortAddr(w.address) + (isCurrent ? '（当前）' : '')}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="button"
                  disabled={!!busy || !pickPlatformId || pickedIsCurrent}
                  onClick={() => void selectPlatformAsTarget()}
                >
                  {busy === 'pick-platform' ? '设置中…' : pickedIsCurrent ? '已是当前' : '设为归集'}
                </button>
              </div>
              <button
                type="button"
                className="ghost"
                disabled={!!busy}
                onClick={() => void createPlatformAndSetTarget()}
              >
                {busy === 'create-platform' ? '创建中…' : '一键创建平台钱包并设为归集'}
              </button>
              {platformWallets.length === 0 ? (
                <p className="hint" style={{ margin: '8px 0 0' }}>
                  本链尚无平台钱包，可一键创建，或先到「平台钱包」页导入。
                </p>
              ) : null}
            </div>

            <div className="user-edit-fields" style={{ marginBottom: 16 }}>
              <label>
                {editId ? '编辑外部地址' : '新增外部地址'}
                <input
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value.trim())}
                  placeholder="0x 交易所/冷钱包地址"
                />
              </label>
              <label>
                备注（选填）
                <input
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder="如：币安收款"
                />
              </label>
            </div>
            <div className="row" style={{ marginBottom: 16, gap: 8 }}>
              <button type="button" disabled={busy === 'save'} onClick={() => void saveInModal()}>
                {busy === 'save' ? '保存中…' : editId ? '保存修改' : '添加外部地址'}
              </button>
              {editId ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy === 'save'}
                  onClick={() => {
                    setEditId(null);
                    setFormAddress('');
                    setFormLabel('');
                    setModalErr('');
                  }}
                >
                  取消编辑
                </button>
              ) : null}
            </div>
            <div style={{ maxHeight: 280, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>备注</th>
                    <th>地址</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
                        暂无地址
                      </td>
                    </tr>
                  ) : (
                    items.map((row) => {
                      const isCurrent =
                        currentTarget &&
                        row.address &&
                        currentTarget.toLowerCase() === String(row.address).toLowerCase();
                      const platform = isPlatformAddr(row.address);
                      return (
                        <tr
                          key={row.id}
                          style={editId === row.id ? { background: 'rgba(59,130,246,0.1)' } : undefined}
                        >
                          <td>
                            {row.label || '—'}
                            {platform ? (
                              <span className="badge" style={{ marginLeft: 6 }}>
                                平台
                              </span>
                            ) : null}
                          </td>
                          <td style={{ fontFamily: 'monospace', fontSize: 11, userSelect: 'text' }}>
                            {row.address}
                            {isCurrent ? (
                              <span className="badge ok" style={{ marginLeft: 6 }}>
                                当前
                              </span>
                            ) : null}
                          </td>
                          <td className="ops">
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => openModal(row)}
                            >
                              改
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy || !!isCurrent}
                              title={isCurrent ? '当前归集地址不可删' : undefined}
                              onClick={() => void remove(row.id)}
                            >
                              删
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
