import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminApi, AuthApi, getAdminMe } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { ListLoading } from '../components/ListLoading';
import { ModalCloseButton } from '../components/ModalCloseButton';
import { TotpSecurityModal } from '../components/TotpSecurityModal';
import { GasFeeTierPicker } from '../components/GasFeeTierPicker';
import { BatchJobProgress } from '../components/BatchJobProgress';
import { toast } from '../components/Toast';
import { isOnChainRateLimitError, useRefreshCooldown } from '../hooks/useRefreshCooldown';
import { copyToClipboard } from '../utils/clipboard';

const CHAIN_META: Record<string, { name: string; explorer: string; gas: string }> = {
  ARB: { name: 'Arbitrum One', explorer: 'https://arbiscan.io/address/', gas: 'ETH' },
  BASE: { name: 'Base', explorer: 'https://basescan.org/address/', gas: 'ETH' },
  ETH: { name: 'Ethereum', explorer: 'https://etherscan.io/address/', gas: 'ETH' },
};

function isEvmAddress(addr: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function fmtBal(v: unknown, digits: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return (0).toFixed(digits);
  return n.toFixed(digits);
}

function isZeroEth(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) && n <= 0;
}

function fmtTime(v: unknown) {
  if (v == null || v === '') return '—';
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return String(v);
  try {
    return new Date(t).toLocaleString();
  } catch {
    return String(v);
  }
}

function shortAddr(addr: string) {
  const s = String(addr || '');
  if (s.length < 12) return s || '—';
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

/** 平台钱包：Gas 补给 + 可作归集收款；余额 / 私钥 / 转出 */
export function GasWalletsPage() {
  const [chainFilter, setChainFilter] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [configs, setConfigs] = useState<any[]>([]);
  const [enabledChains, setEnabledChains] = useState<string[]>(['ARB']);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [gasFeeTier, setGasFeeTier] = useState<'standard' | 'fast'>('standard');
  const [savingTier, setSavingTier] = useState(false);
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'import' | 'edit'>('create');
  const [editId, setEditId] = useState<string | null>(null);
  const [formChain, setFormChain] = useState('ARB');
  const [formAddress, setFormAddress] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formPk, setFormPk] = useState('');
  const [modalErr, setModalErr] = useState('');
  const [revealed, setRevealed] = useState<{ address: string; privateKey: string } | null>(null);

  const [xferOpen, setXferOpen] = useState(false);
  const [xferRow, setXferRow] = useState<any>(null);
  const [xferToken, setXferToken] = useState<'USDT' | 'ETH'>('USDT');
  const [xferTo, setXferTo] = useState('');
  const [xferAmount, setXferAmount] = useState('');
  const [xferTotp, setXferTotp] = useState('');
  const [xferErr, setXferErr] = useState('');
  const [totpOpen, setTotpOpen] = useState(false);
  const [listMode, setListMode] = useState<'active' | 'discarded'>('active');
  const [fundJob, setFundJob] = useState<any>(null);
  const [discardedCount, setDiscardedCount] = useState(0);
  const refreshCd = useRefreshCooldown();

  const activeGasByChain = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of configs) {
      if (c?.chain && c?.gasAddress) m.set(String(c.chain).toUpperCase(), String(c.gasAddress));
    }
    return m;
  }, [configs]);

  const hasTargetByChain = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const c of configs) {
      if (c?.chain) m.set(String(c.chain).toUpperCase(), !!c.targetAddress);
    }
    return m;
  }, [configs]);

  const collectionTargetByChain = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of configs) {
      if (c?.chain && c?.targetAddress) {
        m.set(String(c.chain).toUpperCase(), String(c.targetAddress));
      }
    }
    return m;
  }, [configs]);

  const summary = useMemo(() => {
    let eth = 0;
    let usdt = 0;
    let active = 0;
    let asTarget = 0;
    for (const r of items) {
      const n = Number(r.native);
      const u = Number(r.usdt);
      if (Number.isFinite(n)) eth += n;
      if (Number.isFinite(u)) usdt += u;
      const chainKey = String(r.chain || '').toUpperCase();
      const cur = activeGasByChain.get(chainKey);
      if (cur && r.address && cur.toLowerCase() === String(r.address).toLowerCase()) active += 1;
      const tgt = collectionTargetByChain.get(chainKey);
      if (tgt && r.address && tgt.toLowerCase() === String(r.address).toLowerCase()) asTarget += 1;
    }
    return { count: items.length, eth, usdt, active, asTarget };
  }, [items, activeGasByChain, collectionTargetByChain]);

  const load = useCallback(async (opts?: { quietRateLimit?: boolean }) => {
    setLoading(true);
    setErr('');
    try {
      const discardedView = listMode === 'discarded';
      const [status, cfgs, gasList, otherList] = await Promise.all([
        AdminApi.collectionStatus(),
        AdminApi.collectionConfigs(),
        AdminApi.collectionGasWallets(chainFilter || undefined, {
          withBalance: true,
          discarded: discardedView,
        }),
        AdminApi.collectionGasWallets(chainFilter || undefined, { discarded: !discardedView }),
      ]);
      setItems(Array.isArray(gasList) ? gasList : []);
      setDiscardedCount(discardedView ? (gasList?.length ?? 0) : (otherList?.length ?? 0));
      setConfigs(Array.isArray(cfgs) ? cfgs : status?.configs || []);
      const enabled: string[] =
        Array.isArray(status?.enabledChains) && status.enabledChains.length
          ? status.enabledChains
          : [status?.primaryChain || 'ARB'];
      setEnabledChains(enabled);
      const t = String(status?.gasFeeTier || 'standard');
      setGasFeeTier(t === 'fast' ? 'fast' : 'standard');
      if (status?.fundJob) setFundJob(status.fundJob);
    } catch (e: any) {
      if (opts?.quietRateLimit && isOnChainRateLimitError(e)) return;
      toast(e.message || '加载失败', 'err');
    } finally {
      setLoading(false);
    }
  }, [chainFilter, listMode]);

  useEffect(() => {
    void load({ quietRateLimit: true });
  }, [load]);

  useEffect(() => {
    if (!enabledChains.includes(formChain)) {
      setFormChain(enabledChains[0] || 'ARB');
    }
  }, [enabledChains, formChain]);

  function openCreate() {
    setModalMode('create');
    setEditId(null);
    setFormChain(enabledChains[0] || 'ARB');
    setFormAddress('');
    setFormLabel('');
    setFormPk('');
    setModalErr('');
    setRevealed(null);
    setModalOpen(true);
  }

  function openImport() {
    setModalMode('import');
    setEditId(null);
    setFormChain(enabledChains[0] || 'ARB');
    setFormAddress('');
    setFormLabel('');
    setFormPk('');
    setModalErr('');
    setRevealed(null);
    setModalOpen(true);
  }

  function openEdit(row: any) {
    setModalMode('edit');
    setEditId(row.id);
    setFormChain(row.chain || 'ARB');
    setFormAddress(row.address || '');
    setFormLabel(row.label || '');
    setFormPk('');
    setModalErr('');
    setRevealed(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (busy === 'save' || busy === 'reveal') return;
    setModalOpen(false);
    setEditId(null);
    setModalErr('');
    setRevealed(null);
  }

  async function copyText(text: string, label: string) {
    const ok = await copyToClipboard(text);
    if (ok) toast(`${label}已复制`, 'ok');
    else toast('复制失败，请手动选中', 'err');
  }

  async function saveModal() {
    setBusy('save');
    setModalErr('');
    try {
      if (modalMode === 'create') {
        const setActive = !!hasTargetByChain.get(formChain.toUpperCase());
        const row = await AdminApi.createCollectionGasWallet({
          chain: formChain,
          label: formLabel.trim() || undefined,
          setActive,
        });
        if (row?.address && row?.privateKey) {
          setRevealed({ address: row.address, privateKey: row.privateKey });
        }
        toast(
          setActive
            ? `已创建并设为当前补给：${row?.address || ''}`
            : `已创建（未设为补给：请先配置归集目标）：${row?.address || ''}`,
          'ok',
        );
        await load();
        return;
      }

      if (modalMode === 'import') {
        const addr = formAddress.trim();
        if (!isEvmAddress(addr)) {
          setModalErr('请填写有效地址');
          return;
        }
        if (!formPk.trim()) {
          setModalErr('请填写私钥');
          return;
        }
        const setActive = !!hasTargetByChain.get(formChain.toUpperCase());
        await AdminApi.addCollectionGasWallet({
          chain: formChain,
          gasAddress: addr,
          privateKey: formPk.trim(),
          label: formLabel.trim() || undefined,
          setActive,
        });
        toast('已导入平台钱包', 'ok');
        setModalOpen(false);
        await load();
        return;
      }

      if (modalMode === 'edit' && editId) {
        const addr = formAddress.trim();
        if (!isEvmAddress(addr)) {
          setModalErr('请填写有效地址');
          return;
        }
        const old = items.find((g) => g.id === editId);
        if (old && old.address.toLowerCase() !== addr.toLowerCase() && !formPk.trim()) {
          setModalErr('修改地址时必须填写匹配的私钥');
          return;
        }
        await AdminApi.updateCollectionGasWallet(editId, {
          address: addr,
          label: formLabel.trim() || '',
          privateKey: formPk.trim() || undefined,
        });
        toast('已更新', 'ok');
        setModalOpen(false);
        await load();
      }
    } catch (e: any) {
      setModalErr(e.message || '保存失败');
    } finally {
      setBusy('');
    }
  }

  async function revealKey(id: string, address: string) {
    if (
      !(await confirmDialog(
        `确认查看该平台钱包私钥？\n${address}\n请注意周围环境，操作会记入审计。`,
      ))
    ) {
      return;
    }
    setBusy('reveal');
    setErr('');
    try {
      const res = await AdminApi.revealCollectionGasWalletKey(id);
      setRevealed({ address: res.address, privateKey: res.privateKey });
      if (!modalOpen) {
        setModalMode('edit');
        setEditId(id);
        setFormChain(res.chain || 'ARB');
        setFormAddress(res.address);
        setFormLabel(res.label || '');
        setFormPk('');
        setModalErr('');
        setModalOpen(true);
      }
      toast('私钥已显示', 'ok');
    } catch (e: any) {
      setErr(e.message || '查看失败');
      toast(e.message || '查看失败', 'err');
    } finally {
      setBusy('');
    }
  }

  async function selectAsActive(id: string) {
    setBusy(id);
    setErr('');
    try {
      await AdminApi.selectCollectionGasWallet(id);
      toast('已设为当前 Gas 补给钱包', 'ok');
      await load();
    } catch (e: any) {
      setErr(e.message || '设置失败');
      toast(e.message || '设置失败', 'err');
    } finally {
      setBusy('');
    }
  }

  async function selectAsCollection(id: string) {
    if (!(await confirmDialog('确认将该平台钱包设为当前归集目标？用户托管 USDT 将归集到此地址。'))) return;
    setBusy(id);
    setErr('');
    try {
      await AdminApi.selectCollectionGasWalletAsTarget(id);
      toast('已设为当前归集目标', 'ok');
      await load();
    } catch (e: any) {
      setErr(e.message || '设置失败');
      toast(e.message || '设置失败', 'err');
    } finally {
      setBusy('');
    }
  }

  async function discardRow(id: string) {
    if (
      !(await confirmDialog(
        '确认废弃该平台钱包？将移入「已废弃」列表，私钥仍保留，链上资产不受影响。可稍后恢复或彻底删除。',
      ))
    ) {
      return;
    }
    setBusy(id);
    setErr('');
    try {
      await AdminApi.deleteCollectionGasWallet(id);
      toast('已废弃', 'ok');
      await load();
    } catch (e: any) {
      setErr(e.message || '废弃失败');
      toast(e.message || '废弃失败', 'err');
    } finally {
      setBusy('');
    }
  }

  async function restoreRow(id: string) {
    setBusy(id);
    setErr('');
    try {
      await AdminApi.restoreCollectionGasWallet(id);
      toast('已恢复到使用中', 'ok');
      await load();
    } catch (e: any) {
      setErr(e.message || '恢复失败');
      toast(e.message || '恢复失败', 'err');
    } finally {
      setBusy('');
    }
  }

  async function purgeRow(id: string, address: string) {
    if (
      !(await confirmDialog(
        `确认彻底删除该废弃钱包？\n${address}\n私钥将从系统移除且无法恢复。请确认链上已无资产。`,
      ))
    ) {
      return;
    }
    setBusy(id);
    setErr('');
    try {
      await AdminApi.purgeCollectionGasWallet(id);
      toast('已彻底删除', 'ok');
      await load();
    } catch (e: any) {
      setErr(e.message || '删除失败');
      toast(e.message || '删除失败', 'err');
    } finally {
      setBusy('');
    }
  }

  async function pollFundJob() {
    for (let i = 0; i < 900; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const s = await AdminApi.collectionStatus();
        const job = s?.fundJob;
        setFundJob(job || null);
        if (!job?.running && (job?.phase === 'done' || job?.phase === 'idle')) return job;
      } catch {
        /* 短暂失败继续轮询 */
      }
    }
    return null;
  }

  async function fundGas() {
    const chain = chainFilter || enabledChains[0] || 'ARB';
    if (!hasTargetByChain.get(chain.toUpperCase())) {
      setErr('请先在「归集地址」设置归集目标，再补 Gas');
      return;
    }
    const active = activeGasByChain.get(chain.toUpperCase());
    if (!active) {
      setErr('请先设一个当前 Gas 补给钱包');
      toast('请先设一个当前 Gas 补给钱包', 'err');
      return;
    }
    const activeRow = items.find(
      (r) =>
        String(r.chain || '').toUpperCase() === chain.toUpperCase() &&
        r.address &&
        String(r.address).toLowerCase() === active.toLowerCase(),
    );
    if (activeRow && isZeroEth(activeRow.native)) {
      setErr('');
      toast('当前补给钱包没有 ETH，请先打入 ETH', 'err');
      return;
    }
    if (!(await confirmDialog(`确认对 ${chain} 给「USDT 已达阈值且缺 ETH」的托管地址打最小 Gas？`))) return;
    setBusy('fund');
    setErr('');
    setFundJob(null);
    try {
      const res = await AdminApi.fundCollectionGas({ chain });
      if (res?.started === false || res?.ok === false) {
        toast(res?.message || '补 Gas 未启动', 'err', 5000);
        setFundJob(res?.job || null);
        return;
      }
      setFundJob(res?.job || null);
      toast('补 Gas 已开始，可看下方进度；明细见「归集/补Gas记录」', 'ok', 2500);
      const done = await pollFundJob();
      if (done?.message && Number(done.funded || 0) === 0) {
        toast(done.message, 'err', 6000);
      } else if (done) {
        toast(
          `补 Gas 完成：合计 ${done.queued ?? 0} · 完成 ${done.funded ?? 0} · 剩余 ${done.remaining ?? 0} · 失败 ${done.failed ?? 0}`,
          Number(done.funded || 0) > 0 ? 'ok' : 'err',
          5000,
        );
      } else {
        toast('补 Gas 进度查询超时，请到「归集/补Gas记录」查看 ETH 明细', 'err');
      }
      await load();
    } catch (e: any) {
      setErr(e.message || '补 Gas 失败');
      toast(e.message || '补 Gas 失败', 'err');
    } finally {
      setBusy('');
    }
  }

  function openTransfer(row: any) {
    setXferRow(row);
    setXferToken('USDT');
    setXferTo('');
    setXferAmount('');
    setXferTotp('');
    setXferErr('');
    setXferOpen(true);
  }

  function closeTransfer() {
    if (busy === 'xfer') return;
    setXferOpen(false);
    setXferRow(null);
  }

  async function submitTransfer() {
    if (!xferRow?.id) return;
    setXferErr('');
    const to = xferTo.trim();
    const amount = Number(xferAmount);
    if (!isEvmAddress(to)) {
      setXferErr('收款地址无效');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setXferErr('请输入有效金额');
      return;
    }
    if (!/^\d{6}$/.test(xferTotp.trim())) {
      setXferErr('请输入 6 位 Google 验证码');
      return;
    }
    const me = getAdminMe();
    if (!me?.totpEnabled) {
      try {
        const st = await AuthApi.totpStatus();
        if (!st.enabled) {
          setXferErr('请先在右上角「安全设置」绑定 Google 验证器');
          return;
        }
      } catch {
        setXferErr('请先绑定 Google 验证器');
        return;
      }
    }
    if (
      !(await confirmDialog(
        `确认从 ${shortAddr(xferRow.address)} 转出 ${amount} ${xferToken} 到\n${to}？`,
      ))
    ) {
      return;
    }
    setBusy('xfer');
    try {
      const res = await AdminApi.transferCollectionGasWallet(xferRow.id, {
        token: xferToken,
        toAddress: to,
        amount,
        totpCode: xferTotp.trim(),
      });
      if (res?.ok === false) {
        setXferErr(res.message || '转出未执行');
        toast(res.message || '转出未执行', 'err');
        return;
      }
      toast(`转出成功 tx=${res?.txHash || '—'}`, 'ok', 4000);
      closeTransfer();
      await load();
    } catch (e: any) {
      setXferErr(e.message || '转出失败');
      toast(e.message || '转出失败', 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page-list">
      <div className="card gas-wallets-head">
        <div className="gas-wallets-toolbar">
          <div className="gas-wallets-toolbar-row">
            <label style={{ margin: 0 }}>网络</label>
            <select
              value={chainFilter}
              onChange={(e) => setChainFilter(e.target.value)}
              style={{ maxWidth: 180 }}
            >
              <option value="">全部网络</option>
              {enabledChains.map((c) => (
                <option key={c} value={c}>
                  {CHAIN_META[c]?.name || c} ({c})
                </option>
              ))}
            </select>
            {listMode === 'active' ? (
              <>
                <button type="button" onClick={() => openCreate()} disabled={!!busy}>
                  一键创建
                </button>
                <button type="button" className="ghost" onClick={() => openImport()} disabled={!!busy}>
                  手动导入
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="ghost"
              onClick={() => {
                if (!refreshCd.tryStart()) return;
                void load();
              }}
              disabled={loading || !!busy}
            >
              {loading ? '刷新中…' : '刷新余额'}
            </button>
            <span className="gas-wallets-toolbar-end">
              <Link to="/wallet" className="hint gas-wallets-toolbar-link">
                去归集资金 →
              </Link>
            </span>
          </div>
          {listMode === 'active' ? (
            <div className="gas-wallets-toolbar-row gas-wallets-toolbar-row2">
            <GasFeeTierPicker
              value={gasFeeTier}
              chain={chainFilter || undefined}
              disabled={!!busy}
              saving={savingTier}
              onSaving={setSavingTier}
              onChange={setGasFeeTier}
            />
              <button type="button" className="ghost" onClick={() => void fundGas()} disabled={!!busy}>
                {busy === 'fund'
                  ? fundJob?.phase === 'send'
                    ? `发送 ${fundJob.funded ?? 0}/${fundJob.queued ?? 0}…`
                    : fundJob?.phase === 'scan'
                      ? `扫描 ${fundJob.scanned ?? 0}/${fundJob.totalWallets || '…'}…`
                      : '补 Gas 中…'
                  : '批量补 Gas'}
              </button>
              <Link to="/collection-records" className="hint gas-wallets-toolbar-link">
                归集/补Gas记录
              </Link>
            </div>
          ) : null}
        </div>
        {fundJob && fundJob.phase && fundJob.phase !== 'idle' ? (
          <div style={{ marginTop: 8 }}>
          <BatchJobProgress
            running={!!fundJob.running}
            phase={fundJob.phase}
            total={Number(fundJob.queued || 0)}
            done={Number(fundJob.funded || 0)}
            failed={Number(fundJob.failed || 0)}
            remaining={Number(fundJob.remaining || 0)}
            scanned={Number(fundJob.scanned || 0)}
            totalWallets={Number(fundJob.totalWallets || 0)}
          />
          </div>
        ) : null}
        <div className="gas-wallets-summary">
          <span title="当前列表所有平台钱包的 ETH 余额加总">
            ETH <b>{summary.eth.toFixed(6)}</b>
          </span>
          <span className="gas-wallets-summary-sep" aria-hidden>
            ·
          </span>
          <span title="当前列表所有平台钱包的 USDT 余额加总">
            USDT <b>{summary.usdt.toFixed(4)}</b>
          </span>
          <span className="gas-wallets-summary-sep" aria-hidden>
            ·
          </span>
          <span>
            {listMode === 'discarded' ? '废弃' : '使用中'} <b>{summary.count}</b>
          </span>
          {listMode === 'active' ? (
            <>
              <span className="gas-wallets-summary-sep" aria-hidden>
                ·
              </span>
              <span>
                补给 <b>{summary.active}</b>
              </span>
              <span className="gas-wallets-summary-sep" aria-hidden>
                ·
              </span>
              <span>
                归集 <b>{summary.asTarget}</b>
              </span>
            </>
          ) : null}
        </div>
      </div>
      {err ? <p className="err">{err}</p> : null}

      <div className="tabs">
        <button
          type="button"
          className={listMode === 'active' ? 'tab active' : 'tab ghost'}
          onClick={() => setListMode('active')}
        >
          使用中
        </button>
        <button
          type="button"
          className={listMode === 'discarded' ? 'tab active' : 'tab ghost'}
          onClick={() => setListMode('discarded')}
        >
          已废弃{discardedCount > 0 ? ` (${discardedCount})` : ''}
        </button>
      </div>

      <div className="card">
        <div className="table-scroll list-loading-wrap">
          <ListLoading show={loading} text="正在拉取平台钱包…" />
          <table>
            <thead>
              <tr>
                <th>网络</th>
                <th>备注</th>
                <th>地址</th>
                <th>ETH（Gas）</th>
                <th>USDT</th>
                <th>状态</th>
                <th>{listMode === 'discarded' ? '废弃时间' : '创建时间'}</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
                    {listMode === 'discarded' ? '暂无废弃钱包' : '暂无平台钱包，请点「一键创建」'}
                  </td>
                </tr>
              ) : (
                items.map((row) => {
                  const chain = String(row.chain || '').toUpperCase();
                  const meta = CHAIN_META[chain] || { name: chain, explorer: '', gas: 'ETH' };
                  const cur = activeGasByChain.get(chain);
                  const isActive =
                    !!cur && !!row.address && cur.toLowerCase() === String(row.address).toLowerCase();
                  const tgt = collectionTargetByChain.get(chain);
                  const isTarget =
                    !!tgt && !!row.address && tgt.toLowerCase() === String(row.address).toLowerCase();
                  const explorer = meta.explorer ? `${meta.explorer}${row.address}` : '';
                  return (
                    <tr key={row.id}>
                      <td>
                        <div>{meta.name}</div>
                        <div className="hint" style={{ margin: 0 }}>
                          {chain}
                        </div>
                      </td>
                      <td>{row.label || '—'}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }} title={row.address}>
                        <span style={{ userSelect: 'text' }}>{shortAddr(row.address)}</span>
                        <div className="row" style={{ gap: 4, marginTop: 4 }}>
                          <button
                            type="button"
                            className="ghost"
                            style={{ padding: '0 6px', fontSize: 11 }}
                            onClick={() => void copyText(row.address, '地址')}
                          >
                            复制
                          </button>
                          {explorer ? (
                            <a
                              href={explorer}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: 11 }}
                            >
                              浏览器
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ fontFamily: 'monospace' }}>{fmtBal(row.native, 6)}</td>
                      <td style={{ fontFamily: 'monospace' }}>{fmtBal(row.usdt, 4)}</td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: 'wrap', margin: 0 }}>
                          {listMode === 'discarded' ? (
                            <span className="badge warn">已废弃</span>
                          ) : (
                            <>
                              {isActive ? <span className="badge ok">当前补给</span> : null}
                              {isTarget ? <span className="badge ok">当前归集</span> : null}
                              {!isActive && !isTarget ? (
                                <span className="hint" style={{ margin: 0 }}>
                                  备用
                                </span>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {fmtTime(listMode === 'discarded' ? row.deletedAt : row.createdAt)}
                      </td>
                      <td className="ops">
                        {listMode === 'discarded' ? (
                          <>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => void restoreRow(row.id)}
                            >
                              恢复
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => openTransfer(row)}
                              title="转出剩余资产（需 Google 验证码）"
                            >
                              转出
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => void revealKey(row.id, row.address)}
                            >
                              私钥
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => void purgeRow(row.id, row.address)}
                            >
                              彻底删除
                            </button>
                          </>
                        ) : (
                          <>
                            {!isActive ? (
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: '2px 8px', fontSize: 12 }}
                                disabled={!!busy}
                                onClick={() => void selectAsActive(row.id)}
                              >
                                设为补给
                              </button>
                            ) : null}
                            {!isTarget ? (
                              <button
                                type="button"
                                className="ghost"
                                style={{ padding: '2px 8px', fontSize: 12 }}
                                disabled={!!busy}
                                onClick={() => void selectAsCollection(row.id)}
                              >
                                设为归集
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => openTransfer(row)}
                              title="转出 USDT/ETH（需 Google 验证码）"
                            >
                              转出
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => void revealKey(row.id, row.address)}
                            >
                              私钥
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => openEdit(row)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              style={{ padding: '2px 8px', fontSize: 12 }}
                              disabled={!!busy || isActive || isTarget}
                              title={
                                isActive
                                  ? '当前补给不可废弃，请先改选其他'
                                  : isTarget
                                    ? '当前归集不可废弃，请先改选其他'
                                    : undefined
                              }
                              onClick={() => void discardRow(row.id)}
                            >
                              废弃
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen ? (
        <div className="modal-backdrop" onClick={closeModal}>
          <div
            className="modal-panel"
            style={{ maxWidth: 560, width: 'min(560px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h3>
                {modalMode === 'create'
                  ? '一键创建平台钱包'
                  : modalMode === 'import'
                    ? '手动导入平台钱包'
                    : '编辑平台钱包'}
              </h3>
              <ModalCloseButton disabled={busy === 'save' || busy === 'reveal'} onClick={closeModal} />
            </div>
            {modalErr ? <p className="err">{modalErr}</p> : null}
            {revealed ? (
              <div
                style={{
                  marginBottom: 12,
                  padding: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.08)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 8 }}>私钥（请备份）</div>
                <div className="hint" style={{ margin: '0 0 4px' }}>
                  地址
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>
                  {revealed.address}
                </div>
                <div className="hint" style={{ margin: '0 0 4px' }}>
                  私钥
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>
                  {revealed.privateKey}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="ghost" onClick={() => void copyText(revealed.address, '地址')}>
                    复制地址
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void copyText(revealed.privateKey, '私钥')}
                  >
                    复制私钥
                  </button>
                  <button type="button" className="ghost" onClick={() => setRevealed(null)}>
                    关闭显示
                  </button>
                </div>
              </div>
            ) : null}
            <div className="user-edit-fields">
              <label>
                网络
                <select
                  value={formChain}
                  disabled={modalMode === 'edit'}
                  onChange={(e) => setFormChain(e.target.value)}
                >
                  {enabledChains.map((c) => (
                    <option key={c} value={c}>
                      {CHAIN_META[c]?.name || c} ({c})
                    </option>
                  ))}
                </select>
              </label>
              {modalMode !== 'create' ? (
                <label>
                  地址
                  <input
                    value={formAddress}
                    onChange={(e) => setFormAddress(e.target.value.trim())}
                    placeholder="0x…"
                  />
                </label>
              ) : null}
              <label>
                备注
                <input
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder="如：主补给钱包"
                />
              </label>
              {modalMode === 'import' || modalMode === 'edit' ? (
                <label>
                  私钥{modalMode === 'edit' ? '（改地址时必填）' : '（必填）'}
                  <input
                    type="password"
                    value={formPk}
                    onChange={(e) => setFormPk(e.target.value)}
                    placeholder="64 位 hex"
                    autoComplete="off"
                  />
                </label>
              ) : (
                <p className="hint">创建后将显示私钥，请立即备份；并向该地址充入 Arb ETH。</p>
              )}
            </div>
            <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
              <button type="button" disabled={busy === 'save'} onClick={() => void saveModal()}>
                {busy === 'save'
                  ? '处理中…'
                  : modalMode === 'create'
                    ? '创建'
                    : modalMode === 'import'
                      ? '导入'
                      : '保存'}
              </button>
              {modalMode === 'edit' && editId ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={!!busy}
                  onClick={() => void revealKey(editId, formAddress)}
                >
                  {busy === 'reveal' ? '读取中…' : '查看私钥'}
                </button>
              ) : null}
              <button type="button" className="ghost" disabled={busy === 'save'} onClick={closeModal}>
                {revealed && modalMode === 'create' ? '完成' : '取消'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {xferOpen && xferRow ? (
        <div className="modal-backdrop" onClick={closeTransfer}>
          <div
            className="modal-panel"
            style={{ maxWidth: 440, width: 'min(440px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h3>热钱包转出</h3>
              <ModalCloseButton disabled={busy === 'xfer'} onClick={closeTransfer} />
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              从本系统托管的平台钱包转出。须已绑定 Google 验证器并输入动态码。
            </p>
            <p style={{ fontSize: 13, margin: '0 0 8px' }}>
              转出地址：{' '}
              <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{xferRow.address}</span>
            </p>
            <p className="hint" style={{ margin: '0 0 10px' }}>
              可用 ETH {fmtBal(xferRow.native, 6)} · USDT {fmtBal(xferRow.usdt, 4)}
            </p>
            {xferErr ? <p className="err">{xferErr}</p> : null}
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>币种</label>
            <select
              value={xferToken}
              onChange={(e) => setXferToken(e.target.value as 'USDT' | 'ETH')}
              style={{ width: '100%', marginBottom: 10 }}
              disabled={busy === 'xfer'}
            >
              <option value="USDT">USDT</option>
              <option value="ETH">ETH</option>
            </select>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>收款地址</label>
            <input
              value={xferTo}
              onChange={(e) => setXferTo(e.target.value.trim())}
              placeholder="0x…"
              style={{ width: '100%', marginBottom: 10, fontFamily: 'monospace', fontSize: 12 }}
              disabled={busy === 'xfer'}
            />
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>金额</label>
            <input
              value={xferAmount}
              onChange={(e) => setXferAmount(e.target.value)}
              placeholder={xferToken === 'ETH' ? 'ETH 数量' : 'USDT 数量'}
              style={{ width: '100%', marginBottom: 10 }}
              disabled={busy === 'xfer'}
            />
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Google 验证码</label>
            <input
              value={xferTotp}
              onChange={(e) => setXferTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 位动态码"
              inputMode="numeric"
              style={{ width: '100%', marginBottom: 8 }}
              disabled={busy === 'xfer'}
            />
            <button
              type="button"
              style={{
                display: 'block',
                margin: '0 0 14px',
                padding: 0,
                border: 'none',
                background: 'none',
                color: 'var(--primary)',
                fontSize: 13,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
              onClick={() => setTotpOpen(true)}
            >
              未绑定？打开安全设置
            </button>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" disabled={busy === 'xfer'} onClick={() => void submitTransfer()}>
                {busy === 'xfer' ? '转出中…' : '确认转出'}
              </button>
              <button type="button" className="ghost" disabled={busy === 'xfer'} onClick={closeTransfer}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <TotpSecurityModal open={totpOpen} onClose={() => setTotpOpen(false)} />
    </div>
  );
}
