import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { GasFeeTierPicker } from '../components/GasFeeTierPicker';
import { BatchJobProgress } from '../components/BatchJobProgress';
import { toast } from '../components/Toast';
import { ListLoading } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { usePager } from '../hooks/usePager';
import { isOnChainRateLimitError, useRefreshCooldown } from '../hooks/useRefreshCooldown';
import { copyToClipboard } from '../utils/clipboard';

function isEvmAddress(addr: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

function shortAddr(addr: string) {
  const a = addr.trim();
  if (a.length < 12) return a;
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

function AddrPeek({ address }: { address: string }) {
  const [open, setOpen] = useState(false);
  const full = address.trim();
  if (!full) return null;
  return (
    <span
      className="hint"
      style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <span style={{ fontFamily: 'monospace', fontSize: 12, userSelect: 'text' }}>
        {open ? full : shortAddr(full)}
      </span>
      <button
        type="button"
        className="ghost"
        title={open ? '隐藏完整地址' : '查看完整地址'}
        aria-label={open ? '隐藏完整地址' : '查看完整地址'}
        style={{
          padding: '1px 5px',
          fontSize: 12,
          lineHeight: 1,
          border: 'none',
          minWidth: 0,
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {open ? (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </>
          ) : (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </span>
  );
}

export function WalletPage() {
  const [configs, setConfigs] = useState<any[]>([]);
  const [wallets, setWallets] = useState<any[]>([]);
  const [walletSummary, setWalletSummary] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const walletPager = usePager(20);
  const [form, setForm] = useState({
    chain: 'ARB',
    threshold: '10',
    active: true,
  });
  const [walletFilter, setWalletFilter] = useState('');
  const [loadingBal, setLoadingBal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [collectJob, setCollectJob] = useState<any>(null);
  const [funding, setFunding] = useState(false);
  const [fundJob, setFundJob] = useState<any>(null);
  const [gasFeeTier, setGasFeeTier] = useState<'standard' | 'fast'>('standard');
  const [savingTier, setSavingTier] = useState(false);
  const [progressPanel, setProgressPanel] = useState<'collect' | 'fund' | null>(null);
  const collectAutoHide = useRef(false);
  const closedByUser = useRef<'collect' | 'fund' | null>(null);
  const appliedFundKeys = useRef(new Set<string>());
  const refreshCd = useRefreshCooldown();

  const thresholdCheck = useMemo(() => {
    const n = Number(form.threshold);
    if (!Number.isFinite(n) || n < 0) return { ok: false, text: '阈值须为 ≥ 0 的数字' };
    return { ok: true, text: '' };
  }, [form.threshold]);

  const enabledChains: string[] = useMemo(() => {
    const list = status?.enabledChains;
    if (Array.isArray(list) && list.length) return list;
    return [status?.primaryChain || 'ARB'];
  }, [status]);

  const singleChain = enabledChains.length <= 1;
  const currentCfg = configs.find((c) => c.chain === form.chain);
  const currentTarget = currentCfg?.targetAddress ? String(currentCfg.targetAddress) : '';
  const hasTarget = isEvmAddress(currentTarget);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        AdminApi.collectionConfigs(),
        AdminApi.collectionStatus(),
      ]);
      const cfgs = Array.isArray(c) ? c : [];
      setConfigs(cfgs);
      setStatus(s);
      if (s?.collectJob) setCollectJob(s.collectJob);
      if (s?.fundJob) setFundJob(s.fundJob);
      const t = String(s?.gasFeeTier || 'standard');
      setGasFeeTier(t === 'fast' ? 'fast' : 'standard');
      const primary = s?.primaryChain || s?.enabledChains?.[0] || 'ARB';
      setForm((f) => {
        const chain = (s?.enabledChains || []).includes(f.chain) ? f.chain : primary;
        const hit = cfgs.find((x: any) => x.chain === chain);
        return {
          ...f,
          chain,
          threshold: hit ? String(hit.threshold ?? 10) : f.threshold,
          active: hit ? hit.active !== false : f.active,
        };
      });
    } catch (e: any) {
      toast(e.message || '加载失败', 'err');
    }
  }, []);

  const loadWallets = useCallback(
    async (opts?: { page?: number; pageSize?: number; filter?: string; quietRateLimit?: boolean }) => {
      const p = opts?.page ?? walletPager.page;
      const size = opts?.pageSize ?? walletPager.pageSize;
      const filter = opts?.filter ?? walletFilter;
      setLoadingBal(true);
      try {
        const res = await AdminApi.walletsWithBalance(form.chain, undefined, {
          skip: (p - 1) * size,
          take: size,
          filter: filter || undefined,
        });
        setWallets(res.items || []);
        setWalletSummary(res.summary || null);
        walletPager.setTotal(res.total ?? 0);
      } catch (e: any) {
        if (opts?.quietRateLimit && isOnChainRateLimitError(e)) return;
        toast(e.message || '查询失败', 'err');
      } finally {
        setLoadingBal(false);
      }
    },
    [form.chain, walletFilter, walletPager.page, walletPager.pageSize],
  );

  const toggleProgress = useCallback((kind: 'collect' | 'fund') => {
    setProgressPanel((p) => {
      if (p === kind) {
        closedByUser.current = kind;
        if (kind === 'collect') collectAutoHide.current = false;
        return null;
      }
      closedByUser.current = null;
      if (kind === 'collect') collectAutoHide.current = false;
      return kind;
    });
  }, []);

  const applyFundResults = useCallback((results: any[] | undefined) => {
    if (!Array.isArray(results) || !results.length) return;
    const fresh: any[] = [];
    for (const r of results) {
      const k = `${r.walletId || r.address}:${r.ok ? '1' : '0'}:${r.txHash || r.error || ''}`;
      if (appliedFundKeys.current.has(k)) continue;
      appliedFundKeys.current.add(k);
      fresh.push(r);
    }
    const okHits = fresh.filter((r) => r?.ok);
    if (!okHits.length) return;
    setWallets((ws) => {
      let flipped = 0;
      const next = ws.map((w) => {
        const hit = okHits.find(
          (r) =>
            r.walletId === w.id ||
            String(r.address || '').toLowerCase() === String(w.address || '').toLowerCase(),
        );
        if (!hit) return w;
        const native = Number(hit.nativeAfter);
        if (!Number.isFinite(native)) return w;
        const required = Number(w.requiredGas || 0);
        const usdt = Number(w.usdt || 0);
        const threshold = Number(w.threshold || 0);
        const amountOk = usdt >= threshold && usdt > 0;
        const gasOk = native + 1e-8 >= required;
        if (w.needGas && amountOk && gasOk) flipped += 1;
        return {
          ...w,
          native,
          gasDeficit: gasOk ? 0 : Math.max(0, required - native),
          fundSuggest: 0,
          needGas: amountOk && !gasOk,
          collectable: amountOk && gasOk,
          skipReason: amountOk && gasOk ? null : w.skipReason,
        };
      });
      if (flipped) {
        setWalletSummary((s: any) =>
          s
            ? {
                ...s,
                collectable: Number(s.collectable || 0) + flipped,
                needGas: Math.max(0, Number(s.needGas || 0) - flipped),
              }
            : s,
        );
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    walletPager.goFirst();
    void loadWallets({ page: 1, quietRateLimit: true });
  }, [form.chain, walletFilter]);

  const pollJob = useCallback(async (key: 'collectJob' | 'fundJob') => {
    for (let i = 0; i < 900; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1000));
      try {
        const s = await AdminApi.collectionStatus();
        const job = s?.[key];
        if (key === 'collectJob') setCollectJob(job || null);
        else {
          setFundJob(job || null);
          applyFundResults(job?.results);
        }
        if (!job?.running && (job?.phase === 'done' || job?.phase === 'idle')) {
          return job;
        }
      } catch {
        /* 短暂失败继续轮询 */
      }
    }
    return null;
  }, [applyFundResults]);

  // 进入页面时若已有归集任务在跑，接上进度
  useEffect(() => {
    const job = status?.collectJob;
    if (!job?.running || running) return;
    setRunning(true);
    setCollectJob(job);
    if (closedByUser.current !== 'collect') {
      setProgressPanel('collect');
      collectAutoHide.current = true;
    }
    void (async () => {
      try {
        const done = await pollJob('collectJob');
        if (done) {
          toast(
            `归集完成：扫描 ${done.scanned ?? 0} · 成功 ${done.sent ?? 0} · 跳过 ${done.skipped ?? 0} · 失败 ${done.failed ?? 0}`,
            Number(done.sent || 0) > 0 ? 'ok' : 'err',
            4500,
          );
          await load();
          await loadWallets();
        }
      } finally {
        setRunning(false);
      }
    })();
  }, [status?.collectJob?.running]);

  useEffect(() => {
    const job = status?.fundJob;
    if (!job?.running || funding) return;
    setFunding(true);
    setFundJob(job);
    if (closedByUser.current !== 'fund') setProgressPanel('fund');
    void (async () => {
      try {
        const done = await pollJob('fundJob');
        if (done) {
          toast(
            done.message ||
              `补 Gas 完成：合计 ${done.queued ?? 0} · 完成 ${done.funded ?? 0} · 失败 ${done.failed ?? 0}`,
            Number(done.funded || 0) > 0 ? 'ok' : 'err',
            4500,
          );
          applyFundResults(done?.results);
          await new Promise((r) => setTimeout(r, 1200));
          await loadWallets();
        }
      } finally {
        setFunding(false);
      }
    })();
  }, [status?.fundJob?.running]);

  useEffect(() => {
    if (progressPanel !== 'collect' || !collectAutoHide.current) return;
    if (
      collectJob?.phase === 'done' &&
      !collectJob?.running &&
      Number(collectJob?.failed || 0) === 0
    ) {
      collectAutoHide.current = false;
      setProgressPanel(null);
    }
  }, [collectJob?.phase, collectJob?.running, collectJob?.failed, progressPanel]);

  async function save() {
    if (!hasTarget) {
      toast('请先在「归集地址」将地址设为当前归集目标', 'err');
      return;
    }
    if (!thresholdCheck.ok) {
      toast(thresholdCheck.text, 'err');
      return;
    }
    setSaving(true);
    try {
      const saved = await AdminApi.saveCollectionConfig({
        chain: form.chain,
        targetAddress: currentTarget,
        threshold: Number(form.threshold),
        active: form.active,
      });
      toast(
        `阈值已保存：${saved?.chain || form.chain} · USDT ≥ ${saved?.threshold ?? form.threshold}`,
        'ok',
        3200,
      );
      await load();
      await loadWallets();
    } catch (e: any) {
      toast(`保存失败：${e.message || '未知错误'}`, 'err');
    } finally {
      setSaving(false);
    }
  }

  async function run() {
    if (!hasTarget) {
      toast('请先在「归集地址」设为当前归集目标，再执行归集', 'err');
      return;
    }
    setRunning(true);
    setCollectJob(null);
    closedByUser.current = null;
    setProgressPanel('collect');
    collectAutoHide.current = true;
    try {
      const res = await AdminApi.runCollection(form.chain);
      if (res?.started === false || res?.ok === false) {
        const m = `归集未启动：${res?.message || '请稍后再试'}`;
        toast(m, 'err');
        setCollectJob(res?.job || null);
        return;
      }
      setCollectJob(res?.job || null);
      toast('归集已开始：只转已有足够 Gas 的托管 USDT…', 'ok', 2500);
      const done = await pollJob('collectJob');
      if (done?.message && Number(done.sent || 0) === 0) {
        toast(done.message, 'err', 5000);
      } else if (done) {
        toast(
          `归集完成：扫描 ${done.scanned ?? 0} · 成功 ${done.sent ?? 0} · 跳过 ${done.skipped ?? 0} · 失败 ${done.failed ?? 0}`,
          Number(done.sent || 0) > 0 ? 'ok' : 'err',
          4500,
        );
      } else {
        toast('归集进度查询超时，请稍后刷新查看记录', 'err');
      }
      await load();
      await loadWallets();
    } catch (e: any) {
      toast(`归集失败：${e.message || '未知错误'}`, 'err');
    } finally {
      setRunning(false);
    }
  }

  async function fundGas() {
    if (!currentCfg?.hasGasKey) {
      toast('请先配置并保存 Gas 补给钱包', 'err');
      return;
    }
    if (
      !(await confirmDialog(
        '确认给「USDT 已达归集阈值且缺 ETH」的托管地址打最小 Gas？到账后再点「立即归集」。',
      ))
    )
      return;
    setFunding(true);
    setFundJob(null);
    closedByUser.current = null;
    appliedFundKeys.current.clear();
    setProgressPanel('fund');
    try {
      const res = await AdminApi.fundCollectionGas({ chain: form.chain });
      if (res?.started === false || res?.ok === false) {
        toast(res?.message || '补 Gas 未启动', 'err', 5000);
        setFundJob(res?.job || null);
        return;
      }
      setFundJob(res?.job || null);
      toast('补 Gas 已开始，可在下方看进度；明细见「归集记录」', 'ok', 2500);
      const done = await pollJob('fundJob');
      if (done?.message && Number(done.funded || 0) === 0) {
        toast(done.message, 'err', 6000);
      } else if (done) {
        toast(
          `补 Gas 完成：合计 ${done.queued ?? 0} · 完成 ${done.funded ?? 0} · 剩余 ${done.remaining ?? 0} · 失败 ${done.failed ?? 0}`,
          Number(done.funded || 0) > 0 ? 'ok' : 'err',
          5000,
        );
      } else {
        toast('补 Gas 进度查询超时，请到「归集记录」查看 ETH 明细', 'err');
      }
      applyFundResults(done?.results);
      await new Promise((r) => setTimeout(r, 1200));
      await loadWallets();
    } catch (e: any) {
      toast(e.message || '补 Gas 失败', 'err');
    } finally {
      setFunding(false);
    }
  }

  return (
    <div className="page-list">
      <div className="card" style={{ padding: '10px 12px', marginBottom: 10 }}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
        <div className="row" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>归集</strong>
          {singleChain ? (
            <span className="badge ok">{form.chain}</span>
          ) : (
            <select
              value={form.chain}
              style={{ padding: '4px 8px', fontSize: 12 }}
              onChange={(e) => {
                const chain = e.target.value;
                const hit = configs.find((x) => x.chain === chain);
                setForm((f) => ({
                  ...f,
                  chain,
                  threshold: hit ? String(hit.threshold ?? 10) : f.threshold,
                  active: hit ? hit.active !== false : f.active,
                }));
              }}
            >
              {enabledChains.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          {hasTarget ? (
            <AddrPeek address={currentTarget} />
          ) : (
            <span className="hint" style={{ margin: 0, color: 'var(--danger)' }}>
              未设目标
            </span>
          )}
          <Link to="/collection-addresses" style={{ fontSize: 12 }}>
            地址簿
          </Link>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', fontSize: 12 }}>
            阈值
            <input
              style={{ width: 72, padding: '4px 8px', fontSize: 12 }}
              title="托管钱包 USDT 达到该金额才触发归集"
              value={form.threshold}
              onChange={(e) => setForm({ ...form, threshold: e.target.value })}
            />
          </label>
          <button
            type="button"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => void save()}
            disabled={saving || !hasTarget || !thresholdCheck.ok}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => void run()}
            disabled={running || funding || !hasTarget}
          >
            {running
              ? collectJob?.phase === 'send'
                ? `发送 ${collectJob.sent ?? 0}/${collectJob.queued ?? 0}…`
                : collectJob?.phase === 'scan'
                  ? `扫描 ${collectJob.scanned ?? 0}/${collectJob.totalWallets || '…'}…`
                  : '归集中…'
              : '立即归集'}
          </button>
        </div>
        <div className="row" style={{ marginBottom: 0, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>Gas</strong>
          {currentCfg?.hasGasKey ? (
            <AddrPeek address={String(currentCfg.gasAddress || '')} />
          ) : (
            <span className="hint" style={{ margin: 0, color: 'var(--danger)' }}>
              未设补给钱包
            </span>
          )}
          <Link to="/gas-wallets" style={{ fontSize: 12 }}>
            平台钱包
          </Link>
          <GasFeeTierPicker
            value={gasFeeTier}
            chain={form.chain}
            disabled={funding || running}
            saving={savingTier}
            onSaving={setSavingTier}
            onChange={setGasFeeTier}
          />
          <button
            type="button"
            className="ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}
            disabled={funding || running || !currentCfg?.hasGasKey}
            onClick={() => void fundGas()}
          >
            {funding
              ? fundJob?.phase === 'send'
                ? `发送 ${fundJob.funded ?? 0}/${fundJob.queued ?? 0}…`
                : fundJob?.phase === 'scan'
                  ? `扫描 ${fundJob.scanned ?? 0}/${fundJob.totalWallets || '…'}…`
                  : '补 Gas 中…'
              : '批量补 Gas'}
          </button>
          <Link to="/collection-records" style={{ fontSize: 12 }}>
            归集/补Gas记录
          </Link>
        </div>
          </div>
          <div style={{ flex: '1 1 280px', minWidth: 240, paddingTop: 2 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <button
                type="button"
                className="ghost"
                style={{
                  padding: '2px 8px',
                  fontSize: 12,
                  ...(progressPanel === 'collect'
                    ? { borderColor: 'var(--primary)', color: 'var(--primary)' }
                    : {}),
                }}
                onClick={() => toggleProgress('collect')}
                aria-pressed={progressPanel === 'collect'}
              >
                归集进度
              </button>
              <button
                type="button"
                className="ghost"
                style={{
                  padding: '2px 8px',
                  fontSize: 12,
                  ...(progressPanel === 'fund'
                    ? { borderColor: 'var(--primary)', color: 'var(--primary)' }
                    : {}),
                }}
                onClick={() => toggleProgress('fund')}
                aria-pressed={progressPanel === 'fund'}
              >
                补 Gas 进度
              </button>
            </div>
            {progressPanel === 'collect' && collectJob && collectJob.phase && collectJob.phase !== 'idle' ? (
              <BatchJobProgress
                running={!!collectJob.running}
                phase={collectJob.phase}
                total={Number(collectJob.queued || 0)}
                done={Number(collectJob.sent || 0)}
                failed={Number(collectJob.failed || 0)}
                remaining={Number(collectJob.remaining || 0)}
                scanned={Number(collectJob.scanned || 0)}
                totalWallets={Number(collectJob.totalWallets || 0)}
              />
            ) : null}
            {progressPanel === 'fund' && fundJob && fundJob.phase && fundJob.phase !== 'idle' ? (
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
            ) : null}
            {progressPanel === 'collect' &&
            (!collectJob || !collectJob.phase || collectJob.phase === 'idle') ? (
              <span className="hint" style={{ margin: 0, fontSize: 12 }}>
                暂无归集任务
              </span>
            ) : null}
            {progressPanel === 'fund' && (!fundJob || !fundJob.phase || fundJob.phase === 'idle') ? (
              <span className="hint" style={{ margin: 0, fontSize: 12 }}>
                暂无补 Gas 任务
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card list-loading-wrap">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>用户托管钱包余额（{form.chain}）</h3>
          <select
            value={walletFilter}
            onChange={(e) => setWalletFilter(e.target.value)}
            title="列表筛选"
          >
            <option value="">全部</option>
            <option value="needGas">可归集却缺 Gas</option>
            <option value="collectable">可归集</option>
          </select>
          <button
            className="ghost"
            disabled={loadingBal}
            onClick={() => {
              if (!refreshCd.tryStart()) return;
              void loadWallets();
            }}
          >
            {loadingBal ? '查询中…' : '刷新余额'}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          仅当地址 <b>USDT 达归集阈值</b> 时才估算 Gas。「批量补 Gas」给达阈值且缺 ETH 的托管地址打最小 ETH（够付一次归集）；「立即归集」只把已有足够 Gas 的托管 USDT 转到归集地址，Gas 不够会跳过。每笔都会写入「归集/补Gas记录」。
        </p>
        {walletSummary ? (
          <div className="row" style={{ marginTop: 0, marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <span className="badge ok">可归集 {walletSummary.collectable}</span>
            <span className="badge warn">缺Gas {walletSummary.needGas}</span>
            <span className="badge">未达阈值 {walletSummary.belowThreshold}</span>
            {walletSummary.needGas > 0 ? (
              <>
                <span className="badge warn" title="缺 Gas 地址的预估需 Gas 合计">
                  缺Gas预估合计 {(Number(walletSummary.needGasRequiredSum) || 0).toFixed(6)} ETH
                </span>
                <span className="badge warn" title="建议补给合计（批量补 Gas 口径）">
                  建议补给合计 {(Number(walletSummary.needGasFundSuggestSum) || 0).toFixed(6)} ETH
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        <ListLoading show={loadingBal} text="正在查询链上余额…" />
        <table>
          <thead>
            <tr>
              <th style={{ width: 56 }}>行号</th>
              <th>链</th>
              <th>地址</th>
              <th>USDT</th>
              <th>ETH（现有）</th>
              <th>预估需Gas</th>
              <th>Gas缺口</th>
              <th>建议补给</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w, idx) => (
              <tr key={w.id}>
                <td style={{ fontFamily: 'monospace', textAlign: 'center' }}>
                  {(walletPager.page - 1) * walletPager.pageSize + idx + 1}
                </td>
                <td>{w.chain}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {w.address?.slice(0, 8)}…{w.address?.slice(-6)}
                    {w.address ? (
                      <button
                        type="button"
                        className="ghost"
                        style={{ fontSize: 11, padding: '2px 8px' }}
                        title="复制完整地址"
                        onClick={() => {
                          void copyToClipboard(w.address).then((ok) =>
                            toast(ok ? '已复制地址' : '复制失败，请手动选中', ok ? 'ok' : 'err'),
                          );
                        }}
                      >
                        复制
                      </button>
                    ) : null}
                  </span>
                </td>
                <td>{Number(w.usdt || 0).toFixed(4)}</td>
                <td style={{ fontFamily: 'monospace' }}>{Number(w.native || 0).toFixed(6)}</td>
                <td
                  style={{ fontFamily: 'monospace' }}
                  title={
                    w.gasLimit
                      ? `gasLimit=${w.gasLimit} · ~${Number(w.gasPriceGwei || 0).toFixed(4)} gwei`
                      : undefined
                  }
                >
                  {Number(w.requiredGas || 0).toFixed(6)}
                </td>
                <td style={{ fontFamily: 'monospace', color: Number(w.gasDeficit) > 0 ? '#b45309' : undefined }}>
                  {Number(w.gasDeficit || 0).toFixed(6)}
                </td>
                <td style={{ fontFamily: 'monospace', fontWeight: Number(w.fundSuggest) > 0 ? 600 : undefined }}>
                  {Number(w.fundSuggest || 0).toFixed(6)}
                </td>
                <td>
                  {w.collectable ? (
                    <span className="badge ok">可归集</span>
                  ) : w.needGas ? (
                    <span className="badge warn">缺 Gas</span>
                  ) : (
                    <span className="badge warn">{w.skipReason || '—'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {wallets.length === 0 && !loadingBal ? <p className="hint list-empty">暂无钱包</p> : null}
        <Pagination
          total={walletPager.total}
          page={walletPager.page}
          pageSize={walletPager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          disabled={loadingBal}
          onChange={(p, s) => {
            walletPager.onPageChange(p, s);
            void loadWallets({ page: p, pageSize: s, quietRateLimit: true });
          }}
        />
      </div>
    </div>
  );
}
