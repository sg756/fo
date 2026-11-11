import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Wallet, isAddress, getAddress, formatUnits } from 'ethers';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt } from '../../common/crypto.util';
import { ChainPayoutService, GasFeeTier } from './chain-payout.service';
import {
  DepositChain,
  getEnabledDepositChains,
  getPrimaryChain,
  depositNetworkOptions,
  isNativeGasSymbol,
} from '../deposit/chain.config';

/**
 * 平台托管充值地址归集:
 * - 后台可查每个用户托管地址的 USDT / 原生币(gas) 余额
 * - 仅当 USDT ≥ 阈值 且 gas 足够时, 才归集到后台配置的目标地址
 */
@Injectable()
export class CollectionService {
  private readonly logger = new Logger(CollectionService.name);
  private running = false;

  /** 批量归集进度（内存；进程重启清空） */
  private collectJob: {
    running: boolean;
    chain: string | null;
    phase: 'idle' | 'scan' | 'send' | 'done';
    totalWallets: number;
    scanned: number;
    queued: number;
    sent: number;
    failed: number;
    skipped: number;
    startedAt: number | null;
    finishedAt: number | null;
    message: string | null;
  } = {
    running: false,
    chain: null,
    phase: 'idle',
    totalWallets: 0,
    scanned: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    startedAt: null,
    finishedAt: null,
    message: null,
  };

  /** 批量补 Gas 进度（内存；进程重启清空） */
  private fundJob: {
    running: boolean;
    chain: string | null;
    phase: 'idle' | 'scan' | 'send' | 'done';
    totalWallets: number;
    scanned: number;
    queued: number;
    funded: number;
    failed: number;
    skipped: number;
    /** 余额没查到、这次没打出的地址数 */
    unqueried: number;
    remaining: number;
    startedAt: number | null;
    finishedAt: number | null;
    message: string | null;
    results: {
      walletId: string;
      address: string;
      ok: boolean;
      nativeAfter?: number;
      amountEth?: number;
      txHash?: string;
      error?: string;
    }[];
  } = {
    running: false,
    chain: null,
    phase: 'idle',
    totalWallets: 0,
    scanned: 0,
    queued: 0,
    funded: 0,
    failed: 0,
    skipped: 0,
    unqueried: 0,
    remaining: 0,
    startedAt: null,
    finishedAt: null,
    message: null,
    results: [],
  };

  constructor(
    private prisma: PrismaService,
    private payout: ChainPayoutService,
  ) {}

  private static readonly CFG_GAS_FEE_TIER = 'gas_fund_fee_tier';
  private static readonly CFG_COLLECTION_AUTO = 'collection_auto';

  /** 后台开关优先；没配过时才看环境变量 COLLECTION_ENABLED */
  async isAutoCollectEnabled(): Promise<boolean> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CollectionService.CFG_COLLECTION_AUTO },
    });
    if (row && String(row.value ?? '').trim() !== '') {
      const v = String(row.value).trim().toLowerCase();
      return v === 'true' || v === '1' || v === 'yes';
    }
    return (process.env.COLLECTION_ENABLED || 'false').toLowerCase() === 'true';
  }

  async setCollectionAuto(enabled: boolean) {
    const value = enabled ? 'true' : 'false';
    await this.prisma.systemConfig.upsert({
      where: { key: CollectionService.CFG_COLLECTION_AUTO },
      create: {
        key: CollectionService.CFG_COLLECTION_AUTO,
        value,
        remark: '后台自动归集。打开后每 10 分钟归集已开通的链，不自动补 Gas',
      },
      update: { value },
    });
    return { collectionAuto: enabled };
  }

  async getGasFeeTier(): Promise<GasFeeTier> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: CollectionService.CFG_GAS_FEE_TIER },
    });
    return ChainPayoutService.parseFeeTier(row?.value);
  }

  async setGasFeeTier(tierInput: string) {
    const tier = ChainPayoutService.parseFeeTier(tierInput);
    await this.prisma.systemConfig.upsert({
      where: { key: CollectionService.CFG_GAS_FEE_TIER },
      create: {
        key: CollectionService.CFG_GAS_FEE_TIER,
        value: tier,
        remark: '批量补 Gas 出价档位: standard|fast（相对链上建议价）',
      },
      update: { value: tier },
    });
    return { gasFeeTier: tier };
  }

  /** 标准/快 两档单笔 native 转账预估（gasLimit × 档位 gasPrice × 1.2）。链上暂时查不到时不抛错。 */
  async getGasFeeTierPreview(chainInput?: string) {
    const chain = chainInput ? this.payout.resolveChain(chainInput) : getPrimaryChain();
    const gasLimit = Number(this.payout.nativeTransferGasLimit(chain));
    try {
      const tiers = await this.payout.previewNativeTransferFees(chain);
      return { chain, gasLimit, bufferPct: 20, tiers };
    } catch (e: any) {
      this.logger.warn(`Gas 档位预估失败 ${chain}: ${e?.message || e}`);
      return {
        chain,
        gasLimit,
        bufferPct: 20,
        tiers: null,
        message: '链上价格暂时查不到',
      };
    }
  }

  private jobSnapshot() {
    const j = this.collectJob;
    return {
      ...j,
      remaining: Math.max(0, (j.queued || 0) - (j.sent || 0) - (j.failed || 0)),
    };
  }

  private fundJobSnapshot() {
    const j = this.fundJob;
    return {
      ...j,
      remaining: Math.max(0, (j.queued || 0) - (j.funded || 0) - (j.failed || 0)),
    };
  }

  private touchFundRemaining() {
    this.fundJob.remaining = Math.max(
      0,
      (this.fundJob.queued || 0) - (this.fundJob.funded || 0) - (this.fundJob.failed || 0),
    );
  }

  private resetFundJob(chain: string | null) {
    this.fundJob = {
      running: true,
      chain,
      phase: 'scan',
      totalWallets: 0,
      scanned: 0,
      queued: 0,
      funded: 0,
      failed: 0,
      skipped: 0,
      unqueried: 0,
      remaining: 0,
      startedAt: Date.now(),
      finishedAt: null,
      message: null,
      results: [],
    };
  }

  private resetJob(chain: string | null) {
    this.collectJob = {
      running: true,
      chain,
      phase: 'scan',
      totalWallets: 0,
      scanned: 0,
      queued: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      startedAt: Date.now(),
      finishedAt: null,
      message: null,
    };
  }

  /** 管理端：立即启动后台归集（立即返回，避免 HTTP 超时） */
  startRun(chainInput?: string) {
    if (this.running) {
      return {
        ok: false as const,
        started: false as const,
        message: '归集/补 Gas 进行中，请稍后再试',
        job: this.jobSnapshot(),
      };
    }
    this.running = true;
    const chainHint = chainInput ? this.payout.resolveChain(chainInput) : null;
    this.resetJob(chainHint);
    const task = chainInput
      ? this.runForChainUnlocked(chainInput)
      : this.runAllUnlocked();
    void task
      .then((res) => {
        const msg =
          res && typeof res === 'object' && 'message' in res
            ? String((res as any).message || '').trim()
            : '';
        if (msg) this.collectJob.message = msg;
      })
      .catch((e: any) => {
        this.logger.warn(`后台归集异常: ${e?.message}`);
        this.collectJob.message = e?.message || '归集异常';
      })
      .finally(() => {
        this.running = false;
        this.collectJob.running = false;
        this.collectJob.phase = 'done';
        this.collectJob.finishedAt = Date.now();
      });
    return { ok: true as const, started: true as const, job: this.jobSnapshot() };
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async cronCollect() {
    if (!(await this.isAutoCollectEnabled())) return;
    try {
      await this.runAll();
    } catch (e: any) {
      this.logger.warn(`定时归集异常: ${e?.message}`);
    }
  }

  async runAll() {
    if (this.running) return { ok: false, message: '归集进行中' };
    this.running = true;
    this.resetJob(null);
    try {
      return await this.runAllUnlocked();
    } finally {
      this.running = false;
      this.collectJob.running = false;
      this.collectJob.phase = 'done';
      this.collectJob.finishedAt = Date.now();
    }
  }

  private async runAllUnlocked() {
    const chains = getEnabledDepositChains();
    const base = { scanned: 0, sent: 0, failed: 0, skipped: 0, queued: 0, totalWallets: 0 };
    const notes: string[] = [];
    for (const chain of chains) {
      this.collectJob.chain = chain;
      try {
        const res = await this.runForChainUnlocked(chain, base);
        base.scanned += Number(res.scanned || 0);
        base.sent += Number(res.sent || 0);
        base.failed += Number(res.failed || 0);
        base.skipped += Number(res.skipped || 0);
        base.queued += Number(res.queued || 0);
        base.totalWallets += Number(res.totalWallets || 0);
        if (res.ok === false && res.message) notes.push(`${chain}: ${res.message}`);
      } catch (e: any) {
        const msg = e?.message || '归集异常';
        this.logger.warn(`[${chain}] 归集中断，继续下一条链: ${msg}`);
        notes.push(`${chain}: ${msg}`);
      }
    }
    const message = notes.length ? notes.join('；') : undefined;
    if (message) this.collectJob.message = message;
    return { ok: notes.length === 0 || base.sent > 0, ...base, message };
  }

  /**
   * 列出托管钱包 + 链上余额 (供管理端查询)
   */
  async listWalletsWithBalances(params: {
    chain?: string;
    q?: string;
    /** needGas=USDT已达阈值但缺Gas；collectable=可归集 */
    filter?: string;
    skip?: number;
    take?: number;
  }) {
    const chain = params.chain ? this.payout.resolveChain(params.chain) : undefined;
    const skip = params.skip ?? 0;
    const take = Math.min(params.take ?? 50, 100);
    const filter = (params.filter || '').trim();
    const enabled = getEnabledDepositChains();
    const walletInclude = {
      user: { select: { id: true, email: true, nickname: true, userNo: true } },
    } as const;

    let rows: any[] = [];
    let totalAll = 0;
    let addressOrder: string[] = [];
    await this.ensureSharedChainConfigs();
    const allConfigs = await this.prisma.collectionConfig.findMany();
    const sharedTarget = this.sharedTargetAddress(allConfigs);

    if (!chain) {
      const addrWhere: any = { chain: { in: enabled } };
      if (params.q) addrWhere.user = { email: { contains: params.q } };
      if (!filter) {
        const grouped = await this.prisma.wallet.groupBy({
          by: ['address'],
          where: addrWhere,
          _max: { createdAt: true },
        });
        grouped.sort((a, b) => {
          const ta = a._max.createdAt ? new Date(a._max.createdAt).getTime() : 0;
          const tb = b._max.createdAt ? new Date(b._max.createdAt).getTime() : 0;
          return tb - ta;
        });
        totalAll = grouped.length;
        addressOrder = grouped.slice(skip, skip + take).map((g) => g.address);
        rows = addressOrder.length
          ? await this.prisma.wallet.findMany({
              where: { address: { in: addressOrder }, chain: { in: enabled } },
              include: walletInclude,
            })
          : [];
      } else {
        rows = await this.prisma.wallet.findMany({
          where: addrWhere,
          orderBy: { createdAt: 'desc' },
          take: 500,
          include: walletInclude,
        });
      }
    } else {
      const where: any = { chain };
      if (params.q) where.user = { email: { contains: params.q } };
      const [found, counted] = await Promise.all([
        this.prisma.wallet.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: filter ? 0 : skip,
          take: filter ? 500 : take,
          include: walletInclude,
        }),
        this.prisma.wallet.count({ where }),
      ]);
      rows = found;
      totalAll = counted;
    }

    const configByChain = new Map<DepositChain, (typeof allConfigs)[number]>();
    for (const cfg of allConfigs) {
      const key = this.payout.resolveChain(cfg.chain);
      const prev = configByChain.get(key);
      if (!prev || (!this.validTargetAddress(prev.targetAddress) && this.validTargetAddress(cfg.targetAddress))) {
        configByChain.set(key, cfg);
      }
    }
    const filterConfig = chain ? configByChain.get(chain) : null;

    const addrsByChain = new Map<DepositChain, string[]>();
    for (const w of rows) {
      const c = this.payout.resolveChain(w.chain);
      const list = addrsByChain.get(c) || [];
      list.push(w.address);
      addrsByChain.set(c, list);
    }
    const balByChain = new Map<DepositChain, Map<string, { usdt: number; native: number; ok: boolean }>>();
    const gasPriceByChain = new Map<DepositChain, bigint>();
    await Promise.all(
      [...addrsByChain.entries()].map(async ([c, addrs]) => {
        balByChain.set(c, await this.payout.getBalancesBatch(c, addrs));
      }),
    );

    type EstJob = { key: string; chain: DepositChain; address: string; target: string; usdt: number };
    const estJobs: EstJob[] = [];
    for (const w of rows) {
      const c = this.payout.resolveChain(w.chain);
      const config = configByChain.get(c) || null;
      const threshold = Number(config?.threshold ?? 0);
      const targetAddress = this.validTargetAddress(config?.targetAddress) || sharedTarget;
      const bal = balByChain.get(c)?.get(getAddress(w.address));
      if (
        bal?.ok &&
        targetAddress &&
        isAddress(targetAddress) &&
        bal.usdt >= threshold &&
        bal.usdt > 0
      ) {
        estJobs.push({
          key: `${c}:${getAddress(w.address)}`,
          chain: c,
          address: w.address,
          target: targetAddress,
          usdt: bal.usdt,
        });
      }
    }
    const tier = await this.getGasFeeTier();
    const estChains = [...new Set(estJobs.map((j) => j.chain))];
    await Promise.all(
      estChains.map(async (c) => {
        const fee = await this.payout.resolveBroadcastFee(c, tier);
        gasPriceByChain.set(c, fee.estimateGasPrice);
      }),
    );
    const estMap = new Map<string, { requiredNative: number; gasLimit: bigint; gasPrice: bigint }>();
    {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(6, estJobs.length || 1) }, async () => {
        while (cursor < estJobs.length) {
          const i = cursor++;
          const job = estJobs[i];
          try {
            const est = await this.payout.estimateTransferGasNative(
              job.chain,
              job.address,
              job.target,
              job.usdt,
              gasPriceByChain.get(job.chain),
            );
            estMap.set(job.key, est);
          } catch {
            const gp = gasPriceByChain.get(job.chain) || 1_000_000_000n;
            const requiredNative = Number(formatUnits((100_000n * gp * 120n) / 100n, 18));
            estMap.set(job.key, { requiredNative, gasLimit: 100_000n, gasPrice: gp });
          }
        }
      });
      if (estJobs.length) await Promise.all(workers);
    }

    const items: any[] = [];
    for (const w of rows) {
      const c = this.payout.resolveChain(w.chain);
      const config = configByChain.get(c) || null;
      const threshold = Number(config?.threshold ?? 0);
      const targetAddress = this.validTargetAddress(config?.targetAddress) || sharedTarget;
      const addr = isAddress(w.address) ? getAddress(w.address) : w.address;
      const bal = balByChain.get(c)?.get(addr);
      const est = estMap.get(`${c}:${addr}`);

      let usdt = bal?.usdt ?? 0;
      let native = bal?.native ?? 0;
      let requiredGas = 0;
      let gasDeficit = 0;
      let fundSuggest = 0;
      let gasLimit = '0';
      let gasPriceGwei = 0;
      let collectable = false;
      let needGas = false;
      let skipReason: string | null = '未配置归集目标地址';
      let balanceError: string | null = null;

      if (!bal || !bal.ok) {
        balanceError = '查询余额失败';
        skipReason = balanceError;
      } else if (!targetAddress || !isAddress(targetAddress)) {
        skipReason = !targetAddress ? '未配置归集目标地址' : '归集目标地址无效';
      } else {
        const gp = gasPriceByChain.get(c) || est?.gasPrice || 0n;
        const screenNeed =
          gp > 0n ? Number(formatUnits((100_000n * gp * 120n) / 100n, 18)) : 0;
        const check = this.payout.summarizeCollect({
          usdt,
          native,
          threshold,
          requiredGas: Math.max(est?.requiredNative || 0, screenNeed),
          gasLimit: est?.gasLimit?.toString() || '100000',
          gasPriceGwei: est ? Number(formatUnits(est.gasPrice, 9)) : 0,
          nativeSymbol: this.payout.nativeSymbol(c),
        });
        usdt = check.usdt;
        native = check.native;
        requiredGas = check.requiredGas;
        gasDeficit = check.gasDeficit;
        fundSuggest = check.fundSuggest;
        gasLimit = check.gasLimit;
        gasPriceGwei = check.gasPriceGwei;
        collectable = check.collectable;
        needGas = check.usdt >= threshold && check.usdt > 0 && !check.gasOk;
        skipReason = check.skipReason;
      }

      items.push({
        id: w.id,
        userId: w.userId,
        email: w.user.email,
        nickname: (w.user as any).nickname || null,
        userNo: (w.user as any).userNo ?? null,
        chain: w.chain,
        address: w.address,
        usdt,
        native,
        nativeSymbol: this.payout.nativeSymbol(c),
        requiredGas,
        gasDeficit,
        fundSuggest,
        gasLimit,
        gasPriceGwei,
        threshold,
        targetAddress,
        collectable,
        needGas,
        skipReason,
        balanceError,
        hasPrivateKey: !!w.encPrivateKey,
        createdAt: w.createdAt,
      });
    }

    const view = chain ? items : this.collapseCustodialByAddress(items, addressOrder);
    const matchFilter = (row: any) => {
      if (row.byChain) {
        const cells = Object.values(row.byChain) as any[];
        if (filter === 'needGas') return cells.some((c) => c?.needGas);
        if (filter === 'collectable') return cells.some((c) => c?.collectable);
        return true;
      }
      if (filter === 'needGas') return !!row.needGas;
      if (filter === 'collectable') return !!row.collectable;
      return true;
    };
    const filtered = filter ? view.filter(matchFilter) : view;
    const pageItems = filter ? filtered.slice(skip, skip + take) : filtered;
    const total = filter ? filtered.length : totalAll;

    const flatForSummary = chain ? items : items;
    const needGasRows = flatForSummary.filter((i) => i.needGas);
    const byChainSummary: Record<string, { needGasRequiredSum: number; needGasFundSuggestSum: number; nativeSymbol: string }> = {};
    for (const row of needGasRows) {
      const c = String(row.chain || '').toUpperCase();
      if (!c) continue;
      const slot = byChainSummary[c] || {
        needGasRequiredSum: 0,
        needGasFundSuggestSum: 0,
        nativeSymbol: row.nativeSymbol || (c === 'BSC' ? 'BNB' : 'ETH'),
      };
      slot.needGasRequiredSum += Number(row.requiredGas || 0);
      slot.needGasFundSuggestSum += Number(row.fundSuggest || 0);
      byChainSummary[c] = slot;
    }
    const listThreshold = Number(filterConfig?.threshold ?? 0);
    const summaryRows = chain ? items : filter ? filtered : view;
    const collapsedCount = (pred: (cells: any[]) => boolean) =>
      summaryRows.filter((row) => {
        if (!row.byChain) return pred([row]);
        return pred(Object.values(row.byChain) as any[]);
      }).length;
    return {
      items: pageItems,
      total,
      chain: chain || null,
      chains: chain ? [chain] : enabled,
      threshold: listThreshold,
      targetAddress: filterConfig?.targetAddress || null,
      configs: allConfigs.map((c) => ({
        chain: c.chain,
        targetAddress: c.targetAddress,
        threshold: c.threshold,
        gasAddress: c.gasAddress,
        hasGasKey: !!c.encGasPrivateKey,
        active: c.active,
      })),
      summary: {
        collectable: chain
          ? items.filter((i) => i.collectable).length
          : collapsedCount((cells) => cells.some((c) => c?.collectable)),
        needGas: chain ? needGasRows.length : collapsedCount((cells) => cells.some((c) => c?.needGas)),
        belowThreshold: chain
          ? items.filter((i) => i.usdt < Number(i.threshold)).length
          : collapsedCount((cells) => cells.length > 0 && cells.every((c) => Number(c?.usdt || 0) < Number(c?.threshold || 0))),
        needGasRequiredSum: needGasRows.reduce((s, i) => s + Number(i.requiredGas || 0), 0),
        needGasDeficitSum: needGasRows.reduce((s, i) => s + Number(i.gasDeficit || 0), 0),
        needGasFundSuggestSum: needGasRows.reduce((s, i) => s + Number(i.fundSuggest || 0), 0),
        byChain: byChainSummary,
      },
    };
  }

  /** 同一 0x 在多条链上各有一行，列表合成一行，按链放余额和是否要补 Gas */
  private collapseCustodialByAddress(items: any[], addressOrder: string[]) {
    const map = new Map<string, any>();
    for (const row of items) {
      const key = String(row.address || '').toLowerCase();
      if (!key) continue;
      let hit = map.get(key);
      if (!hit) {
        hit = {
          address: row.address,
          email: row.email,
          nickname: row.nickname,
          userNo: row.userNo,
          userId: row.userId,
          byChain: {} as Record<string, any>,
        };
        map.set(key, hit);
      }
      hit.byChain[String(row.chain || '').toUpperCase()] = row;
    }
    if (!addressOrder.length) return [...map.values()];
    return addressOrder
      .map((addr) => map.get(String(addr).toLowerCase()))
      .filter(Boolean);
  }

  /**
   * 平台归集（同步，供定时任务）:
   * Multicall 筛名单 → 有限并发发送；管理端请用 startRun 避免 HTTP 超时
   */
  async runForChain(chainInput?: string) {
    if (this.running) return { ok: false, message: '归集进行中' };
    this.running = true;
    const chain = this.payout.resolveChain(chainInput || getPrimaryChain());
    this.resetJob(chain);
    try {
      return await this.runForChainUnlocked(chainInput);
    } finally {
      this.running = false;
      this.collectJob.running = false;
      this.collectJob.phase = 'done';
      this.collectJob.finishedAt = Date.now();
    }
  }

  private async runForChainUnlocked(
    chainInput?: string,
    progressBase?: {
      scanned: number;
      sent: number;
      failed: number;
      skipped: number;
      queued: number;
      totalWallets: number;
    },
  ) {
    const base = progressBase || {
      scanned: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      queued: 0,
      totalWallets: 0,
    };
    const chain = this.payout.resolveChain(chainInput || getPrimaryChain());
    this.collectJob.chain = chain;
    this.collectJob.phase = 'scan';
    await this.ensureSharedChainConfigs();

    const config = await this.prisma.collectionConfig.findUnique({ where: { chain } });
    if (!config || !config.active) {
      const msg = `无活跃归集配置: ${chain}`;
      this.collectJob.message = msg;
      return { ok: false, scanned: 0, sent: 0, failed: 0, skipped: 0, queued: 0, totalWallets: 0, message: msg };
    }
    if (!config.targetAddress || !isAddress(config.targetAddress)) {
      const msg = '请先在后台配置有效的归集目标地址';
      this.collectJob.message = msg;
      return {
        ok: false,
        scanned: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        queued: 0,
        totalWallets: 0,
        message: msg,
      };
    }
    const targetAddress = getAddress(config.targetAddress);
    const threshold = Number(config.threshold || 0);

    const totalWallets = await this.prisma.wallet.count({
      where: { chain, encPrivateKey: { not: null } },
    });
    this.collectJob.totalWallets = base.totalWallets + totalWallets;

    const SCAN_PAGE = 200;
    const SEND_CONCURRENCY = Math.max(
      1,
      Math.min(10, Number(process.env.COLLECTION_SEND_CONCURRENCY || 6) || 6),
    );
    const SCREEN_GAS_LIMIT = 100_000n;

    const gasPrice = await this.payout.getFeeGasPrice(chain).catch((e: any) => {
      const msg = `${chain} 手续费查不到: ${e?.message || e}`;
      this.logger.warn(msg);
      this.collectJob.message = msg;
      return null;
    });
    if (gasPrice == null) {
      return {
        ok: false,
        scanned: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        queued: 0,
        totalWallets: 0,
        message: this.collectJob.message || `${chain} 手续费查不到`,
      };
    }
    const screenRequired = Number(formatUnits((SCREEN_GAS_LIMIT * gasPrice * 120n) / 100n, 18));

    type Candidate = {
      id: string;
      address: string;
      email?: string;
      amount: number;
      usdt: number;
      native: number;
      requiredGas: number;
    };
    const candidates: Candidate[] = [];
    const skippedDetails: { address: string; email?: string; reason: string }[] = [];

    let scanned = 0;
    let skipped = 0;
    let cursor: string | undefined;

    while (true) {
      const wallets = await this.prisma.wallet.findMany({
        where: {
          chain,
          encPrivateKey: { not: null },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: SCAN_PAGE,
        include: { user: { select: { email: true } } },
      });
      if (!wallets.length) break;
      cursor = wallets[wallets.length - 1].id;

      const bals = await this.payout.getBalancesBatch(
        chain,
        wallets.map((w) => w.address),
      );

      for (const w of wallets) {
        scanned += 1;
        this.collectJob.scanned = base.scanned + scanned;
        try {
          const addr = getAddress(w.address);
          const bal = bals.get(addr);
          if (!bal?.ok) {
            skipped += 1;
            skippedDetails.push({
              address: w.address,
              email: w.user?.email,
              reason: '查询余额失败',
            });
            continue;
          }
          if (!(bal.usdt >= threshold && bal.usdt > 0)) {
            skipped += 1;
            continue;
          }
          // 筛选阶段用固定 gasLimit，避免对每个地址 estimateGas
          const check = this.payout.summarizeCollect({
            usdt: bal.usdt,
            native: bal.native,
            threshold,
            requiredGas: screenRequired,
            gasLimit: SCREEN_GAS_LIMIT.toString(),
            gasPriceGwei: Number(formatUnits(gasPrice, 9)),
          });
          if (!check.collectable) {
            skipped += 1;
            skippedDetails.push({
              address: w.address,
              email: w.user?.email,
              reason: check.skipReason || '不可归集',
            });
            continue;
          }
          candidates.push({
            id: w.id,
            address: w.address,
            email: w.user?.email,
            amount: Math.floor(check.usdt * 1000) / 1000,
            usdt: check.usdt,
            native: check.native,
            requiredGas: check.requiredGas,
          });
        } catch (e: any) {
          skipped += 1;
          this.logger.warn(`扫描失败 ${w.address}: ${e?.message}`);
        }
      }
    }

    this.collectJob.skipped = base.skipped + skipped;
    this.collectJob.queued = base.queued + candidates.length;
    this.collectJob.phase = 'send';

    let sent = 0;
    let failed = 0;
    let next = 0;

    const sendOne = async (c: Candidate) => {
      const record = await this.prisma.collectionRecord.create({
        data: {
          fromWalletId: c.id,
          chain,
          tokenSymbol: 'USDT',
          amount: c.amount,
          targetAddress,
          status: 'PENDING',
        },
      });
      try {
        const wallet = await this.prisma.wallet.findUnique({ where: { id: c.id } });
        if (!wallet?.encPrivateKey) {
          throw new Error('钱包私钥缺失');
        }
        // 发送前只复查原生币（不做完整 canCollect）
        const nativeNow = await this.payout.getNativeBalance(chain, c.address);
        if (!this.payout.coversNativeGas(nativeNow, c.requiredGas)) {
          const reason = `Gas 复查不足(需≈${c.requiredGas.toFixed(6)}, 有 ${nativeNow.toFixed(6)})`;
          await this.prisma.collectionRecord.update({
            where: { id: record.id },
            data: {
              status: 'FAILED',
              failReason: reason,
              gasRequired: c.requiredGas,
              gasHave: nativeNow,
              gasDeficit: Math.max(0, c.requiredGas - nativeNow),
              gasLost: 0,
            },
          });
          failed += 1;
          this.collectJob.failed = base.failed + failed;
          skippedDetails.push({ address: c.address, email: c.email, reason });
          return;
        }

        const pk = decrypt(wallet.encPrivateKey);
        const { txHash } = await this.payout.sendUsdtFromPrivateKey({
          chain,
          privateKey: pk,
          toAddress: targetAddress,
          amount: c.amount,
          gasPrice,
        });
        await this.prisma.collectionRecord.update({
          where: { id: record.id },
          data: { status: 'SENT', txHash },
        });
        sent += 1;
        this.collectJob.sent = base.sent + sent;
        this.logger.log(`归集成功 ${c.email || ''} ${c.address} → ${c.amount} USDT tx=${txHash}`);
      } catch (e: any) {
        const fail = await this.buildCollectionFailFields(e, {
          chain: chain as DepositChain,
          address: c.address,
          targetAddress,
          threshold,
        });
        await this.prisma.collectionRecord.update({
          where: { id: record.id },
          data: {
            status: 'FAILED',
            failReason: fail.failReason,
            gasRequired: fail.gasRequired,
            gasHave: fail.gasHave,
            gasDeficit: fail.gasDeficit,
            gasLost: fail.gasLost,
            ...(fail.txHash ? { txHash: fail.txHash } : {}),
          },
        });
        failed += 1;
        this.collectJob.failed = base.failed + failed;
        this.logger.warn(
          `归集失败 ${c.address}: ${fail.failReason}` +
            ` | 需Gas≈${fail.gasRequired ?? '—'} 有=${fail.gasHave ?? '—'} 缺口=${fail.gasDeficit ?? '—'} 损耗=${fail.gasLost ?? '—'}`,
        );
      }
    };

    const workers = Array.from(
      { length: Math.min(SEND_CONCURRENCY, Math.max(candidates.length, 1)) },
      async () => {
        while (true) {
          const i = next++;
          if (i >= candidates.length) return;
          await sendOne(candidates[i]);
        }
      },
    );
    if (candidates.length) await Promise.all(workers);

    this.collectJob.skipped = base.skipped + skipped;
    this.collectJob.sent = base.sent + sent;
    this.collectJob.failed = base.failed + failed;
    this.collectJob.queued = base.queued + candidates.length;

    return {
      ok: true,
      chain,
      scanned,
      sent,
      failed,
      skipped,
      queued: candidates.length,
      totalWallets,
      threshold,
      target: targetAddress,
      concurrency: SEND_CONCURRENCY,
      skippedDetails: skippedDetails.slice(0, 30),
    };
  }

  /** 归集失败字段：优先用抛错上的 Gas 快照，否则再查一次链 */
  private async buildCollectionFailFields(
    e: any,
    snap: {
      chain: DepositChain;
      address: string;
      targetAddress: string;
      threshold: number;
    },
  ): Promise<{
    failReason: string;
    gasRequired: number | null;
    gasHave: number | null;
    gasDeficit: number | null;
    gasLost: number;
    txHash?: string;
  }> {
    const raw =
      e?.shortMessage ||
      e?.reason ||
      e?.info?.error?.message ||
      e?.message ||
      '归集失败';
    const failReason = String(raw).slice(0, 2000);

    let gasRequired = typeof e?.gasRequired === 'number' ? e.gasRequired : null;
    let gasHave = typeof e?.gasHave === 'number' ? e.gasHave : null;
    let gasDeficit = typeof e?.gasDeficit === 'number' ? e.gasDeficit : null;
    let gasLost = typeof e?.gasLost === 'number' ? e.gasLost : 0;
    const txHash = e?.txHash ? String(e.txHash) : undefined;

    if (gasRequired == null || gasHave == null || gasDeficit == null) {
      try {
        const check = await this.payout.canCollectWallet({
          chain: snap.chain,
          address: snap.address,
          targetAddress: snap.targetAddress,
          threshold: snap.threshold,
        });
        if (gasRequired == null) gasRequired = check.requiredGas;
        if (gasHave == null) gasHave = check.native;
        if (gasDeficit == null) gasDeficit = check.gasDeficit;
      } catch {
        /* 二次查询失败则只保留原因文案 */
      }
    }

    return { failReason, gasRequired, gasHave, gasDeficit, gasLost, txHash };
  }

  async saveTargetConfig(params: {
    chain: string;
    targetAddress: string;
    threshold?: number;
    gasAddress?: string;
    active?: boolean;
    actorId: string;
  }) {
    const chain = this.payout.resolveChain(params.chain);
    if (!params.targetAddress || !isAddress(params.targetAddress)) {
      throw new BadRequestException('归集目标地址无效，请填写正确的钱包或交易所地址');
    }
    const targetAddress = getAddress(params.targetAddress);
    let gasAddress: string | undefined;
    if (params.gasAddress?.trim()) {
      if (!isAddress(params.gasAddress)) {
        throw new BadRequestException('Gas 补给地址无效');
      }
      gasAddress = getAddress(params.gasAddress);
    }

    await this.keepOneAddressBookRow(targetAddress);

    const existing = await this.prisma.collectionConfig.findUnique({ where: { chain } });
    const threshold =
      params.threshold !== undefined && params.threshold !== null
        ? params.threshold
        : Number(existing?.threshold ?? 0);

    const saved = await this.prisma.collectionConfig.upsert({
      where: { chain },
      create: {
        chain,
        targetAddress,
        threshold,
        gasAddress: gasAddress ?? null,
        active: params.active ?? true,
        updatedById: params.actorId,
      },
      update: {
        targetAddress,
        threshold,
        ...(gasAddress !== undefined ? { gasAddress } : {}),
        active: params.active ?? true,
        updatedById: params.actorId,
      },
    });
    // 归集目标全链共用同一地址。这次带了阈值就写到每条已开通链；缺补给钱包的链一并补上
    const sharedGas = gasAddress ?? (existing?.gasAddress && isAddress(existing.gasAddress) ? getAddress(existing.gasAddress) : null);
    const sharedGasKey = existing?.encGasPrivateKey ?? null;
    for (const other of getEnabledDepositChains()) {
      if (other === chain) continue;
      const otherRow = await this.prisma.collectionConfig.findUnique({ where: { chain: other } });
      const otherHasGas = !!(otherRow?.gasAddress && otherRow.encGasPrivateKey && isAddress(otherRow.gasAddress));
      await this.prisma.collectionConfig.upsert({
        where: { chain: other },
        create: {
          chain: other,
          targetAddress,
          threshold:
            params.threshold !== undefined && params.threshold !== null
              ? threshold
              : otherRow
                ? otherRow.threshold
                : threshold,
          gasAddress: otherHasGas ? getAddress(otherRow!.gasAddress!) : sharedGas,
          encGasPrivateKey: otherHasGas ? otherRow!.encGasPrivateKey : sharedGasKey,
          active: params.active ?? true,
          updatedById: params.actorId,
        },
        update: {
          targetAddress,
          updatedById: params.actorId,
          ...(params.threshold !== undefined && params.threshold !== null ? { threshold } : {}),
          ...(!otherHasGas && sharedGas && sharedGasKey
            ? { gasAddress: sharedGas, encGasPrivateKey: sharedGasKey }
            : {}),
        },
      });
    }
    return this.sanitizeConfig(saved);
  }

  private async isCurrentTarget(address: string): Promise<boolean> {
    if (!isAddress(address)) return false;
    const want = getAddress(address);
    const configs = await this.prisma.collectionConfig.findMany({ select: { targetAddress: true } });
    return configs.some((c) => isAddress(c.targetAddress) && getAddress(c.targetAddress) === want);
  }

  private sanitizeConfig(row: {
    id: string;
    chain: string;
    targetAddress: string;
    threshold: any;
    gasAddress: string | null;
    encGasPrivateKey?: string | null;
    active: boolean;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      chain: row.chain,
      targetAddress: row.targetAddress,
      threshold: row.threshold,
      gasAddress: row.gasAddress,
      hasGasKey: !!row.encGasPrivateKey,
      active: row.active,
      updatedAt: row.updatedAt,
    };
  }

  async listConfigs() {
    await this.ensureSharedChainConfigs();
    const rows = await this.prisma.collectionConfig.findMany();
    return rows.map((r) => this.sanitizeConfig(r));
  }

  /**
   * 归集目标和补给钱包各链共用。后开通的链如果还没写上，从已有配置补齐，不必再点一次「设为归集」。
   */
  private validTargetAddress(addr?: string | null): string | null {
    if (!addr || !isAddress(addr)) return null;
    const a = getAddress(addr);
    if (a === '0x0000000000000000000000000000000000000000') return null;
    return a;
  }

  private sharedTargetAddress(configs: { targetAddress?: string | null }[]): string | null {
    for (const c of configs) {
      const t = this.validTargetAddress(c.targetAddress);
      if (t) return t;
    }
    return null;
  }

  private async ensureSharedChainConfigs() {
    const enabled = getEnabledDepositChains();
    if (!enabled.length) return;
    const configs = await this.prisma.collectionConfig.findMany();
    const zero = '0x0000000000000000000000000000000000000000';
    const gasSrc = configs.find((c) => c.gasAddress && c.encGasPrivateKey && isAddress(c.gasAddress));
    const targetSrc = configs.find(
      (c) => isAddress(c.targetAddress) && getAddress(c.targetAddress) !== zero,
    );
    if (!gasSrc && !targetSrc) return;
    for (const chain of enabled) {
      const matches = configs.filter((c) => this.payout.resolveChain(c.chain) === chain);
      let row = matches.find((c) => c.chain === chain) || matches[0];
      if (row && row.chain !== chain && !matches.some((c) => c.chain === chain)) {
        row = await this.prisma.collectionConfig.update({
          where: { id: row.id },
          data: { chain },
        });
      }
      const hasGas = !!(row?.gasAddress && row.encGasPrivateKey && isAddress(row.gasAddress));
      const hasTarget = !!(
        row?.targetAddress &&
        isAddress(row.targetAddress) &&
        getAddress(row.targetAddress) !== zero
      );
      const fillGas = !hasGas && !!gasSrc;
      const fillTarget = !hasTarget && !!targetSrc;
      if (!fillGas && !fillTarget) continue;
      const targetAddress = fillTarget
        ? getAddress(targetSrc!.targetAddress)
        : hasTarget
          ? getAddress(row!.targetAddress)
          : zero;
      await this.prisma.collectionConfig.upsert({
        where: { chain },
        create: {
          chain,
          targetAddress,
          threshold: row?.threshold ?? targetSrc?.threshold ?? 0,
          gasAddress: fillGas ? getAddress(gasSrc!.gasAddress!) : null,
          encGasPrivateKey: fillGas ? gasSrc!.encGasPrivateKey : null,
          active: row?.active ?? true,
        },
        update: {
          ...(fillTarget ? { targetAddress } : {}),
          ...(fillGas
            ? { gasAddress: getAddress(gasSrc!.gasAddress!), encGasPrivateKey: gasSrc!.encGasPrivateKey }
            : {}),
        },
      });
      for (const extra of matches) {
        if (extra.chain !== chain && extra.id !== row?.id) {
          await this.prisma.collectionConfig.delete({ where: { id: extra.id } }).catch(() => undefined);
        }
      }
    }
  }

  private async attachOnChainBalances<T extends { chain: string; address: string }>(rows: T[]) {
    if (!rows.length) return [];
    const addrsByChain = new Map<DepositChain, string[]>();
    for (const row of rows) {
      const c = this.payout.resolveChain(row.chain);
      const list = addrsByChain.get(c) || [];
      list.push(row.address);
      addrsByChain.set(c, list);
    }
    const balByChain = new Map<DepositChain, Map<string, { usdt: number; native: number; ok: boolean }>>();
    await Promise.all(
      [...addrsByChain.entries()].map(async ([c, addrs]) => {
        balByChain.set(c, await this.payout.getBalancesBatch(c, addrs));
      }),
    );
    return rows.map((row) => {
      const chain = this.payout.resolveChain(row.chain);
      const addr = isAddress(row.address) ? getAddress(row.address) : row.address;
      const bal = balByChain.get(chain)?.get(addr);
      if (!bal?.ok) {
        return {
          ...row,
          usdt: null,
          native: null,
          nativeSymbol: this.payout.nativeSymbol(chain),
          balanceOk: false as const,
        };
      }
      return {
        ...row,
        usdt: bal.usdt,
        native: bal.native,
        nativeSymbol: this.payout.nativeSymbol(chain),
        balanceOk: true as const,
      };
    });
  }

  /** 同一 0x 在各 EVM 链通用，列表只出一把，不按链拆成两套 */
  private dedupeByAddress<T extends { address: string; deletedAt?: Date | null }>(rows: T[]): T[] {
    const map = new Map<string, T>();
    for (const row of rows) {
      const addr = row.address;
      let key = addr.toLowerCase();
      if (isAddress(addr)) key = getAddress(addr);
      const prev = map.get(key);
      if (!prev || (prev.deletedAt && !row.deletedAt)) map.set(key, row);
    }
    return [...map.values()];
  }

  async listAddresses(_chain?: string, withBalance = false) {
    await this.collapseAddressBook();
    const rows = this.dedupeByAddress(
      await this.prisma.collectionAddress.findMany({ orderBy: { createdAt: 'desc' } }),
    );
    if (!withBalance) return rows;
    return this.attachEnabledChainBalances(rows);
  }

  /** 同一地址在已开通的每条链上各查一次，ETH / BNB 一起返回 */
  private async attachEnabledChainBalances<T extends { address: string }>(rows: T[]) {
    const chains = getEnabledDepositChains();
    if (!rows.length || !chains.length) return rows;
    const balByChain = new Map<DepositChain, Map<string, { usdt: number; native: number; ok: boolean }>>();
    await Promise.all(
      chains.map(async (c) => {
        balByChain.set(
          c,
          await this.payout.getBalancesBatch(
            c,
            rows.map((r) => r.address),
          ),
        );
      }),
    );
    return rows.map((row) => {
      const addr = isAddress(row.address) ? getAddress(row.address) : row.address;
      const balances: Record<string, { usdt: number | null; native: number | null }> = {};
      for (const c of chains) {
        const bal = balByChain.get(c)?.get(addr);
        balances[c] = {
          usdt: bal?.ok ? bal.usdt : null,
          native: bal?.ok ? bal.native : null,
        };
      }
      const primary = chains.includes(getPrimaryChain()) ? getPrimaryChain() : chains[0];
      const head = balances[primary];
      return {
        ...row,
        usdt: head?.usdt ?? null,
        native: head?.native ?? null,
        nativeSymbol: this.payout.nativeSymbol(primary),
        balances,
      };
    });
  }

  /** 地址簿一个 0x 只留一行，不按 ARB、BSC 各存一条 */
  private async keepOneAddressBookRow(address: string, label?: string | null) {
    const want = getAddress(address);
    const rows = await this.prisma.collectionAddress.findMany({
      where: { address: want },
      orderBy: { createdAt: 'asc' },
    });
    if (!rows.length) {
      return this.prisma.collectionAddress.create({
        data: { chain: getPrimaryChain(), address: want, label: label ?? null },
      });
    }
    const keep = rows[0];
    if (rows.length > 1) {
      await this.prisma.collectionAddress.deleteMany({
        where: { id: { in: rows.slice(1).map((r) => r.id) } },
      });
    }
    return keep;
  }

  private async collapseAddressBook() {
    const rows = await this.prisma.collectionAddress.findMany({ orderBy: { createdAt: 'asc' } });
    const seen = new Set<string>();
    const drop: string[] = [];
    for (const row of rows) {
      if (!isAddress(row.address)) continue;
      const key = getAddress(row.address);
      if (seen.has(key)) drop.push(row.id);
      else seen.add(key);
    }
    if (drop.length) {
      await this.prisma.collectionAddress.deleteMany({ where: { id: { in: drop } } });
    }
  }

  async addAddress(params: { chain?: string; address: string; label?: string }) {
    if (!params.address || !isAddress(params.address)) {
      throw new BadRequestException('地址无效');
    }
    const address = getAddress(params.address);
    const label = params.label?.trim() || null;
    const existing = await this.prisma.collectionAddress.findFirst({ where: { address } });
    if (existing) throw new BadRequestException('该地址已存在');
    return this.keepOneAddressBookRow(address, label);
  }

  async updateAddress(params: { id: string; address?: string; label?: string | null }) {
    const row = await this.prisma.collectionAddress.findUnique({ where: { id: params.id } });
    if (!row) throw new NotFoundException('地址不存在');

    let address = row.address;
    if (params.address !== undefined) {
      if (!params.address || !isAddress(params.address)) {
        throw new BadRequestException('地址无效');
      }
      address = getAddress(params.address);
    }
    const label =
      params.label === undefined ? row.label : params.label?.trim() ? params.label.trim() : null;

    const wasCurrent = await this.isCurrentTarget(row.address);

    try {
      const updated = await this.prisma.collectionAddress.update({
        where: { id: params.id },
        data: { address, label },
      });
      // 若改的是当前归集目标地址，同步配置
      if (wasCurrent && address !== getAddress(row.address)) {
        await this.prisma.collectionConfig.updateMany({
          where: { targetAddress: row.address },
          data: { targetAddress: address },
        });
      }
      await this.prisma.collectionAddress.updateMany({
        where: { address: row.address },
        data: { address, label },
      });
      await this.collapseAddressBook();
      return updated;
    } catch {
      throw new BadRequestException('该地址已存在或更新失败');
    }
  }

  async deleteAddress(id: string) {
    const row = await this.prisma.collectionAddress.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('地址不存在');
    if (await this.isCurrentTarget(row.address)) {
      throw new BadRequestException('该地址是当前归集目标，请先在归集资金页改选其他地址再删除');
    }
    await this.prisma.collectionAddress.deleteMany({ where: { address: row.address } });
    return { ok: true };
  }

  /** 从地址簿选用为当前归集目标 */
  async selectAddress(params: { id: string; actorId: string; threshold?: number }) {
    const row = await this.prisma.collectionAddress.findUnique({ where: { id: params.id } });
    if (!row) throw new NotFoundException('地址不存在');
    return this.saveTargetConfig({
      chain: row.chain,
      targetAddress: row.address,
      threshold: params.threshold,
      actorId: params.actorId,
    });
  }

  private parseHotPrivateKey(privateKey: string, expectAddress?: string) {
    const pk = privateKey.trim().replace(/^0x/i, '');
    if (!/^[a-fA-F0-9]{64}$/.test(pk)) {
      throw new BadRequestException('私钥格式无效（需 64 位 hex）');
    }
    let derived: string;
    try {
      derived = getAddress(new Wallet(`0x${pk}`).address);
    } catch {
      throw new BadRequestException('私钥无法解析');
    }
    if (expectAddress && derived !== getAddress(expectAddress)) {
      throw new BadRequestException(`私钥与地址不匹配（私钥对应 ${derived}）`);
    }
    return { pkHex: `0x${pk}`, address: derived, enc: encrypt(`0x${pk}`) };
  }

  private sanitizeGasWallet(row: {
    id: string;
    chain: string;
    address: string;
    label: string | null;
    createdAt: Date;
    updatedAt?: Date;
    deletedAt?: Date | null;
  }) {
    return {
      id: row.id,
      chain: row.chain,
      address: row.address,
      label: row.label,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt ?? null,
    };
  }

  private async requireGasWallet(id: string, opts?: { allowDiscarded?: boolean }) {
    const row = await this.prisma.collectionGasWallet.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('平台钱包不存在');
    if (!opts?.allowDiscarded && row.deletedAt) {
      throw new BadRequestException('该平台钱包已废弃，请先恢复');
    }
    return row;
  }

  private async assertNotCurrentRole(row: { chain: string; address: string }) {
    const want = getAddress(row.address);
    const configs = await this.prisma.collectionConfig.findMany();
    if (configs.some((cfg) => cfg.gasAddress && isAddress(cfg.gasAddress) && getAddress(cfg.gasAddress) === want)) {
      throw new BadRequestException('该地址是当前 Gas 补给钱包，请先改选其他再废弃');
    }
    if (configs.some((cfg) => cfg.targetAddress && isAddress(cfg.targetAddress) && getAddress(cfg.targetAddress) === want)) {
      throw new BadRequestException('该地址是当前归集目标，请先改选其他再废弃');
    }
  }

  private async findByChainAddress(chain: string, address: string) {
    return this.prisma.collectionGasWallet.findUnique({
      where: { chain_address: { chain, address } },
    });
  }

  async listGasWallets(chain?: string, withBalance = false, discarded = false) {
    const balanceChain = chain ? this.payout.resolveChain(chain) : undefined;
    const where: { deletedAt: null | { not: null } } = discarded
      ? { deletedAt: { not: null } }
      : { deletedAt: null };
    const rows = this.dedupeByAddress(
      await this.prisma.collectionGasWallet.findMany({
        where,
        orderBy: discarded ? { deletedAt: 'desc' } : { createdAt: 'desc' },
      }),
    );
    // 兼容：若使用中地址簿空但配置里已有 Gas，迁入一条
    let list = rows;
    if (!discarded && balanceChain && rows.length === 0) {
      const cfg = await this.prisma.collectionConfig.findUnique({ where: { chain: balanceChain } });
      if (cfg?.gasAddress && cfg.encGasPrivateKey && isAddress(cfg.gasAddress)) {
        const addr = getAddress(cfg.gasAddress);
        const existing = await this.findByChainAddress(balanceChain, addr);
        if (existing) {
          if (!existing.deletedAt) list = [existing];
        } else {
          const migrated = await this.prisma.collectionGasWallet.create({
            data: {
              chain: balanceChain,
              address: addr,
              label: '默认',
              encPrivateKey: cfg.encGasPrivateKey,
            },
          });
          list = [migrated];
        }
      }
    }
    const sanitized = list.map((r) => this.sanitizeGasWallet(r));
    if (!withBalance) return sanitized;
    return this.attachEnabledChainBalances(sanitized);
  }

  async addGasWallet(params: {
    chain?: string;
    address: string;
    label?: string;
    privateKey: string;
    actorId: string;
    setActive?: boolean;
  }) {
    const chain = this.payout.resolveChain(params.chain || 'ARB');
    if (!params.address || !isAddress(params.address)) {
      throw new BadRequestException('平台钱包地址无效');
    }
    const address = getAddress(params.address);
    const { enc } = this.parseHotPrivateKey(params.privateKey, address);
    const existing = await this.prisma.collectionGasWallet.findFirst({ where: { address } });
    if (existing) {
      if (existing.deletedAt) {
        throw new BadRequestException('该地址已在废弃列表中，请先恢复或彻底删除后再添加');
      }
      if (params.setActive !== false) {
        await this.applyGasWalletToConfig(existing.id, params.actorId);
      }
      return this.sanitizeGasWallet(existing);
    }
    try {
      const row = await this.prisma.collectionGasWallet.create({
        data: {
          chain,
          address,
          label: params.label?.trim() || null,
          encPrivateKey: enc,
        },
      });
      if (params.setActive !== false) {
                  await this.applyGasWalletToConfig(row.id, params.actorId);
      }
      return this.sanitizeGasWallet(row);
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('该平台钱包地址已存在');
    }
  }

  /** 服务端随机生成一把 Gas 热钱包；返回明文私钥供管理员备份（仍加密入库） */
  async createGasWallet(params: {
    chain?: string;
    label?: string;
    actorId: string;
    setActive?: boolean;
  }) {
    const chain = this.payout.resolveChain(params.chain || 'ARB');
    const w = Wallet.createRandom();
    const address = getAddress(w.address);
    const privateKey = w.privateKey;
    const enc = encrypt(privateKey);
    try {
      const row = await this.prisma.collectionGasWallet.create({
        data: {
          chain,
          address,
          label: params.label?.trim() || `系统创建 ${new Date().toISOString().slice(0, 10)}`,
          encPrivateKey: enc,
        },
      });
      if (params.setActive !== false) {
        await this.applyGasWalletToConfig(row.id, params.actorId);
      }
      return { ...this.sanitizeGasWallet(row), privateKey };
    } catch {
      throw new BadRequestException('创建失败：地址冲突，请重试');
    }
  }

  /** 查看已入库的 Gas 热钱包私钥（管理员备份/导入外部钱包） */
  async revealGasWalletPrivateKey(id: string) {
    const row = await this.requireGasWallet(id, { allowDiscarded: true });
    try {
      const privateKey = decrypt(row.encPrivateKey);
      // 校验能解出与地址匹配的钱包
      this.parseHotPrivateKey(privateKey, row.address);
      return {
        id: row.id,
        chain: row.chain,
        address: row.address,
        label: row.label,
        privateKey,
      };
    } catch (e: any) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      throw new BadRequestException('私钥解密失败，请检查 ENC_KEY 是否与入库时一致');
    }
  }

  async updateGasWallet(params: {
    id: string;
    address?: string;
    label?: string | null;
    privateKey?: string;
    actorId: string;
  }) {
    const row = await this.requireGasWallet(params.id);

    let address = row.address;
    if (params.address !== undefined) {
      if (!params.address || !isAddress(params.address)) {
        throw new BadRequestException('地址无效');
      }
      address = getAddress(params.address);
    }
    const label =
      params.label === undefined ? row.label : params.label?.trim() ? params.label.trim() : null;

    let encPrivateKey = row.encPrivateKey;
    if (params.privateKey?.trim()) {
      const parsed = this.parseHotPrivateKey(params.privateKey, address);
      encPrivateKey = parsed.enc;
      address = parsed.address;
    } else if (params.address !== undefined) {
      // 改地址但未给新私钥：用原私钥校验是否仍匹配
      try {
        const oldPk = decrypt(row.encPrivateKey);
        this.parseHotPrivateKey(oldPk, address);
      } catch {
        throw new BadRequestException('修改地址时请同时填写匹配的私钥');
      }
    }

    try {
      const updated = await this.prisma.collectionGasWallet.update({
        where: { id: params.id },
        data: { address, label, encPrivateKey },
      });
      await this.prisma.collectionConfig.updateMany({
        where: { gasAddress: row.address },
        data: {
          gasAddress: address,
          encGasPrivateKey: encPrivateKey,
          updatedById: params.actorId,
        },
      });
      return this.sanitizeGasWallet(updated);
    } catch {
      throw new BadRequestException('该地址已存在或更新失败');
    }
  }

  /** 逻辑废弃：移出使用中列表，私钥仍保留，可在废弃列表恢复或彻底删除 */
  async discardGasWallet(id: string) {
    const row = await this.requireGasWallet(id);
    await this.assertNotCurrentRole(row);
    await this.prisma.collectionGasWallet.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async restoreGasWallet(id: string) {
    const row = await this.requireGasWallet(id, { allowDiscarded: true });
    if (!row.deletedAt) throw new BadRequestException('该平台钱包未废弃');
    const updated = await this.prisma.collectionGasWallet.update({
      where: { id },
      data: { deletedAt: null },
    });
    return this.sanitizeGasWallet(updated);
  }

  /** 仅废弃列表允许物理删除（私钥从库中移除） */
  async purgeGasWallet(id: string) {
    const row = await this.requireGasWallet(id, { allowDiscarded: true });
    if (!row.deletedAt) {
      throw new BadRequestException('请先废弃该钱包，再在废弃列表中彻底删除');
    }
    await this.assertNotCurrentRole(row);
    await this.prisma.collectionGasWallet.delete({ where: { id } });
    return { ok: true };
  }

  async applyGasWalletToConfig(gasWalletId: string, actorId: string) {
    const gw = await this.requireGasWallet(gasWalletId);
    const configs = await this.prisma.collectionConfig.findMany();
    const template = configs.find((c) => c.targetAddress && isAddress(c.targetAddress));
    if (!template) {
      throw new BadRequestException('请先选择归集目标地址，再选用 Gas 补给钱包');
    }
    const targetAddress = getAddress(template.targetAddress);
    let last = template;
    for (const chain of getEnabledDepositChains()) {
      const existing = configs.find((c) => c.chain === chain);
      last = await this.prisma.collectionConfig.upsert({
        where: { chain },
        create: {
          chain,
          targetAddress,
          threshold: existing?.threshold ?? template.threshold,
          gasAddress: gw.address,
          encGasPrivateKey: gw.encPrivateKey,
          active: true,
          updatedById: actorId,
        },
        update: {
          gasAddress: gw.address,
          encGasPrivateKey: gw.encPrivateKey,
          updatedById: actorId,
        },
      });
    }
    return this.sanitizeConfig(last);
  }

  /**
   * 将平台钱包（Gas 热钱包）写入归集地址簿并设为当前归集目标。
   * 与用户托管钱包无关；该地址有私钥，后台可转出。
   */
  async applyGasWalletAsCollectionTarget(gasWalletId: string, actorId: string) {
    const gw = await this.requireGasWallet(gasWalletId);
    const address = getAddress(gw.address);
    const label = gw.label?.trim() || '平台钱包';
    await this.keepOneAddressBookRow(address, label);
    return this.saveTargetConfig({
      chain: getPrimaryChain(),
      targetAddress: address,
      actorId,
    });
  }

  /** @deprecated 兼容旧接口：写入地址簿并设为当前 */
  async saveGasWallet(params: {
    chain: string;
    gasAddress: string;
    privateKey: string;
    actorId: string;
  }) {
    return this.addGasWallet({
      chain: params.chain,
      address: params.gasAddress,
      privateKey: params.privateKey,
      actorId: params.actorId,
      setActive: true,
      label: '默认',
    });
  }

  /**
   * 批量给「USDT ≥ 最低归集阈值且缺 Gas」的托管地址打最小原生币（够付一次 USDT 归集）。
   * 传 chains 或都不传：按已开通链依次补（ARB 打 ETH，BSC 打 BNB）。传 chain 则只补这一条。
   * 立即返回，进度见 collection/status.fundJob。
   */
  startFundGas(params: { chain?: string; chains?: string[]; walletIds?: string[] }) {
    if (this.running) {
      return {
        ok: false as const,
        started: false as const,
        message: '归集/补 Gas 进行中，请稍后再试',
        job: this.fundJobSnapshot(),
      };
    }
    const chains = this.resolveFundChains(params);
    if (!chains.length) {
      return {
        ok: false as const,
        started: false as const,
        message: '没有可补 Gas 的链',
        job: this.fundJobSnapshot(),
      };
    }
    this.running = true;
    this.resetFundJob(chains.join(','));
    void this.fundChainsSequential(chains, params.walletIds)
      .then((res) => {
        this.fundJob.scanned = res.scanned ?? this.fundJob.scanned;
        this.fundJob.funded = res.funded ?? 0;
        this.fundJob.failed = res.failed ?? 0;
        this.fundJob.skipped = res.skipped ?? this.fundJob.skipped;
        this.fundJob.unqueried = res.unqueried ?? this.fundJob.unqueried;
        this.fundJob.queued = res.queued ?? this.fundJob.queued;
        this.touchFundRemaining();
        if (res.message) this.fundJob.message = res.message;
      })
      .catch((e: any) => {
        this.logger.warn(`批量补 Gas 异常: ${e?.message}`);
        const funded = this.fundJob.funded || 0;
        const failed = Math.max(this.fundJob.failed || 0, 1);
        const missed = this.fundJob.unqueried || 0;
        this.fundJob.failed = failed;
        let message = `补 Gas 完成：成功 ${funded} 笔，失败 ${failed} 笔`;
        if (missed > 0) message += `，${missed} 个地址没查到余额`;
        message += `。${e?.message || '补 Gas 异常'}。请稍等后再点一次「批量补 Gas」`;
        this.fundJob.message = message;
        this.touchFundRemaining();
      })
      .finally(() => {
        this.running = false;
        this.fundJob.running = false;
        this.fundJob.phase = 'done';
        this.fundJob.finishedAt = Date.now();
        this.touchFundRemaining();
      });
    return { ok: true as const, started: true as const, job: this.fundJobSnapshot() };
  }

  async fundGasBatch(params: { chain?: string; chains?: string[]; walletIds?: string[] }) {
    return this.startFundGas(params);
  }

  /** 指定 chains 时用这些链；只指定 chain 时只补一条；都不传则补全部已开通链 */
  private resolveFundChains(params: { chain?: string; chains?: string[] }): DepositChain[] {
    const enabled = getEnabledDepositChains();
    if (params.chains?.length) {
      const picked = new Set(params.chains.map((c) => this.payout.resolveChain(c)));
      return enabled.filter((c) => picked.has(c));
    }
    if (params.chain) {
      const one = this.payout.resolveChain(params.chain);
      return enabled.includes(one) ? [one] : [];
    }
    return enabled;
  }

  /** 多条链共用一把补给地址，但 ETH / BNB 余额分开，所以按链串行打 */
  private async fundChainsSequential(chains: DepositChain[], walletIds?: string[]) {
    const base = {
      scanned: 0,
      funded: 0,
      failed: 0,
      skipped: 0,
      unqueried: 0,
      heldBack: 0,
      queued: 0,
      totalWallets: 0,
    };
    const notes: string[] = [];
    for (const chain of chains) {
      this.fundJob.chain = chain;
      const sym = this.payout.nativeSymbol(chain);
      try {
        const res = await this.fundNeedGasUnlocked({ chain, walletIds, progressBase: { ...base } });
        base.scanned += res.scanned;
        base.funded += res.funded;
        base.failed += res.failed;
        base.skipped += res.skipped;
        base.unqueried += res.unqueried;
        base.heldBack += res.heldBack;
        base.queued += res.queued;
        base.totalWallets += res.totalWallets;
        if (!res.ok && res.queued === 0 && res.funded === 0 && res.failed === 0 && res.message) {
          notes.push(`${chain} ${sym}: ${res.message}`);
        } else if (res.failed > 0 && res.message) {
          notes.push(`${chain} ${sym}: ${res.message}`);
        }
      } catch (e: any) {
        const msg = e?.message || '补 Gas 异常';
        this.logger.warn(`[${chain}] 补 Gas 中断，继续下一条链: ${msg}`);
        base.failed += 1;
        notes.push(`${chain} ${sym}: ${msg}`);
      }
    }
    const retry = base.failed > 0 || base.unqueried > 0 || base.heldBack > 0 || notes.length > 0;
    let message = `补 Gas 完成：成功 ${base.funded} 笔，失败 ${base.failed} 笔`;
    if (base.unqueried > 0) message += `，${base.unqueried} 个地址没查到余额`;
    if (base.heldBack > 0) message += `，${base.heldBack} 个因补给钱包余额不足未打出`;
    if (base.funded === 0 && base.failed === 0 && base.unqueried === 0 && base.heldBack === 0 && !notes.length) {
      message = '补 Gas 完成：成功 0 笔，失败 0 笔。这次没有需要补的地址';
    } else if (retry) {
      message += '。请稍等后再点一次「批量补 Gas」';
    }
    if (notes.length) message += `。${notes.join('；')}`;
    this.fundJob.unqueried = base.unqueried;
    return {
      ok: base.funded > 0 || notes.length === 0,
      scanned: base.scanned,
      funded: base.funded,
      skipped: base.skipped,
      failed: base.failed,
      unqueried: base.unqueried,
      queued: base.queued,
      message,
    };
  }

  private async fundNeedGasUnlocked(params: {
    chain?: string;
    walletIds?: string[];
    progressBase?: {
      scanned: number;
      funded: number;
      failed: number;
      skipped: number;
      unqueried: number;
      heldBack: number;
      queued: number;
      totalWallets: number;
    };
  }): Promise<{
    ok: boolean;
    message?: string;
    chain?: string;
    scanned: number;
    funded: number;
    skipped: number;
    failed: number;
    unqueried: number;
    heldBack: number;
    queued: number;
    totalWallets: number;
    from?: string;
    details?: any[];
  }> {
    const empty = {
      scanned: 0,
      funded: 0,
      skipped: 0,
      failed: 0,
      unqueried: 0,
      heldBack: 0,
      queued: 0,
      totalWallets: 0,
    };
    const base = params.progressBase || empty;
    const chain = this.payout.resolveChain(params.chain || getPrimaryChain());
    const sym = this.payout.nativeSymbol(chain);
    const config = await this.prisma.collectionConfig.findUnique({ where: { chain } });
    if (!config?.encGasPrivateKey || !config.gasAddress) {
      return { ok: false, ...empty, message: '请先配置 Gas 补给钱包（地址+私钥）' };
    }

    let pk: string;
    try {
      pk = decrypt(config.encGasPrivateKey);
    } catch {
      return { ok: false, ...empty, message: 'Gas 私钥解密失败，请重新配置' };
    }
    const signerAddr = getAddress(new Wallet(pk).address);
    const gasAddr = getAddress(config.gasAddress);
    if (signerAddr !== gasAddr) {
      return {
        ok: false,
        ...empty,
        message: `Gas 私钥与补给地址不一致：私钥对应 ${signerAddr}，配置为 ${gasAddr}。请到平台钱包重新选用补给钱包。`,
      };
    }

    let nativeBal = 0;
    try {
      nativeBal = await this.payout.getNativeBalance(chain, gasAddr);
    } catch {
      return { ok: false, ...empty, message: `无法查询补给钱包 ${sym} 余额，请稍后重试` };
    }
    if (!Number.isFinite(nativeBal) || nativeBal <= 0) {
      return {
        ok: false,
        ...empty,
        message: `当前补给钱包 ${sym} 为 0，无法补 Gas，请先向 ${gasAddr} 打入 ${sym}`,
      };
    }

    const threshold = Number(config.threshold ?? 0);
    const SCAN_PAGE = 200;
    const balsNeed: { w: any; usdt: number; native: number }[] = [];
    let scanned = 0;
    let skipped = 0;
    let unqueried = 0;
    let cursor: string | undefined;

    this.fundJob.chain = chain;
    this.fundJob.phase = 'scan';
    const chainWalletCount = await this.prisma.wallet.count({
      where: {
        chain,
        encPrivateKey: { not: null },
        ...(params.walletIds?.length ? { id: { in: params.walletIds } } : {}),
      },
    });
    this.fundJob.totalWallets = base.totalWallets + chainWalletCount;

    while (true) {
      const wallets = await this.prisma.wallet.findMany({
        where: {
          chain,
          encPrivateKey: { not: null },
          ...(params.walletIds?.length ? { id: { in: params.walletIds } } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: SCAN_PAGE,
        include: { user: { select: { email: true } } },
      });
      if (!wallets.length) break;
      cursor = wallets[wallets.length - 1].id;
      const bals = await this.payout.getBalancesBatch(
        chain,
        wallets.map((w) => w.address),
      );
      for (const w of wallets) {
        scanned += 1;
        this.fundJob.scanned = base.scanned + scanned;
        const addr = getAddress(w.address);
        const bal = bals.get(addr);
        if (!bal?.ok) {
          unqueried += 1;
          this.fundJob.unqueried = base.unqueried + unqueried;
          continue;
        }
        if (!(bal.usdt >= threshold && bal.usdt > 0)) {
          skipped += 1;
          continue;
        }
        balsNeed.push({ w, usdt: bal.usdt, native: bal.native });
      }
      if (params.walletIds?.length) break;
    }

    const tier = await this.getGasFeeTier();
    const broadcastFee = await this.payout.resolveBroadcastFee(chain, tier);
    const gasPrice = broadcastFee.estimateGasPrice;
    const targetAddress =
      config.targetAddress && isAddress(config.targetAddress) ? config.targetAddress : '';
    const fallbackRequired = Number(formatUnits((100_000n * gasPrice * 120n) / 100n, 18));

    type FundJob = { id: string; address: string; email?: string; amountEth: number; nativeBefore: number };
    const jobs: FundJob[] = [];

    for (const row of balsNeed) {
      try {
        let requiredGas = fallbackRequired;
        if (targetAddress) {
          try {
            const est = await this.payout.estimateTransferGasNative(
              chain,
              row.w.address,
              targetAddress,
              row.usdt,
              gasPrice,
            );
            // 与「立即归集」筛选口径对齐：至少按 10 万 gas×1.2 补给，避免估低了归集仍跳过
            requiredGas = Math.max(est.requiredNative, fallbackRequired);
          } catch {
            requiredGas = fallbackRequired;
          }
        }
        if (this.payout.coversNativeGas(row.native, requiredGas)) {
          skipped += 1;
          continue;
        }
        const targetNative = requiredGas * 1.1;
        const amountEth = Number(Math.max(targetNative - row.native, 0).toFixed(12));
        if (!(amountEth > 0)) {
          skipped += 1;
          continue;
        }
        jobs.push({
          id: row.w.id,
          address: row.w.address,
          email: row.w.user?.email,
          amountEth,
          nativeBefore: row.native,
        });
      } catch {
        skipped += 1;
      }
    }

    const perTxGasLimit = this.payout.nativeTransferGasLimit(chain);
    const perTxFeeEth = Number(formatUnits((gasPrice * perTxGasLimit * 120n) / 100n, 18));
    const sendJobs: FundJob[] = [];
    let reserved = 0;
    let skippedNoReserve = 0;
    for (const j of jobs) {
      const need = j.amountEth + perTxFeeEth;
      if (reserved + need > nativeBal) {
        skippedNoReserve += 1;
        skipped += 1;
        continue;
      }
      reserved += need;
      sendJobs.push(j);
    }

    this.fundJob.skipped = base.skipped + skipped;
    this.fundJob.queued = base.queued + sendJobs.length;
    this.fundJob.phase = 'send';
    this.touchFundRemaining();

    const concurrency = Math.max(
      1,
      Math.min(4, Number(process.env.FUND_GAS_CONCURRENCY || 1) || 1),
    );
    let funded = 0;
    let failed = 0;
    const details: any[] = [];
    let jobCursor = 0;
    let nextNonce = await this.payout.getPendingNonce(chain, gasAddr);
    let sendLock: Promise<void> = Promise.resolve();
    const withSendLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      let release!: () => void;
      const prev = sendLock;
      sendLock = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    };

    const sendOne = async (j: FundJob) => {
      const record = await this.prisma.collectionRecord.create({
        data: {
          fromWalletId: j.id,
          chain,
          tokenSymbol: this.payout.nativeSymbol(chain),
          amount: j.amountEth,
          targetAddress: j.address,
          status: 'PENDING',
        },
      });
      let txHash: string | undefined;
      try {
        const sent = await withSendLock(async () => {
          const nonce = nextNonce;
          const result = await this.payout.sendNativeFromPrivateKey({
            chain,
            privateKey: pk,
            toAddress: j.address,
            amountEth: j.amountEth,
            nonce,
            fee: broadcastFee,
            skipBalanceCheck: concurrency > 1,
            waitReceipt: false,
          });
          nextNonce += 1;
          return result;
        });
        txHash = sent.txHash;
        if (sent.wait) await sent.wait();
        let nativeAfter = await this.payout.getNativeBalance(chain, j.address);
        if (nativeAfter + 1e-12 < j.nativeBefore + j.amountEth * 0.5) {
          await new Promise((r) => setTimeout(r, 2500));
          nativeAfter = await this.payout.getNativeBalance(chain, j.address);
        }
        if (nativeAfter + 1e-12 < j.nativeBefore + j.amountEth * 0.5) {
          throw new Error(
            `交易已广播但托管地址未到账(补前 ${j.nativeBefore} → 现 ${nativeAfter}，应到 ≈${j.amountEth}) tx=${sent.txHash}`,
          );
        }
        await this.prisma.collectionRecord.update({
          where: { id: record.id },
          data: { status: 'SENT', txHash: sent.txHash },
        });
        funded += 1;
        this.fundJob.funded = base.funded + funded;
        this.fundJob.results = [
          ...(this.fundJob.results || []),
          {
            walletId: j.id,
            address: j.address,
            ok: true,
            nativeAfter,
            amountEth: j.amountEth,
            txHash: sent.txHash,
          },
        ];
        this.touchFundRemaining();
        details.push({
          walletId: j.id,
          email: j.email,
          address: j.address,
          amountEth: j.amountEth,
          txHash: sent.txHash,
          nativeAfter,
        });
        this.logger.log(
          `Gas 补给成功 ${j.email || ''} ${j.address} ${j.amountEth} ${this.payout.nativeSymbol(chain)} 余额 ${nativeAfter} tx=${sent.txHash}`,
        );
      } catch (e: any) {
        const reason = e?.message || '失败';
        failed += 1;
        this.fundJob.failed = base.failed + failed;
        this.fundJob.results = [
          ...(this.fundJob.results || []),
          { walletId: j.id, address: j.address, ok: false, error: reason, txHash },
        ];
        this.touchFundRemaining();
        await this.prisma.collectionRecord.update({
          where: { id: record.id },
          data: {
            status: 'FAILED',
            failReason: reason,
            gasHave: j.nativeBefore,
            gasRequired: j.amountEth,
            gasDeficit: j.amountEth,
            gasLost: 0,
            ...(txHash ? { txHash } : {}),
          },
        });
        details.push({
          walletId: j.id,
          address: j.address,
          error: reason,
          txHash,
        });
        this.logger.warn(`Gas 补给失败 ${j.address}: ${reason}`);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(sendJobs.length, 1)) },
      async () => {
        while (true) {
          const i = jobCursor++;
          if (i >= sendJobs.length) return;
          await sendOne(sendJobs[i]);
        }
      },
    );
    if (sendJobs.length) await Promise.all(workers);

    const firstErr = details.find((d) => d?.error)?.error;
    let message: string | undefined;
    if (jobs.length === 0) {
      message = `扫描 ${scanned} 个地址，没有「USDT≥${threshold} 且 ${sym} 不够一次归集」的托管钱包需要补 Gas`;
    } else if (sendJobs.length === 0) {
      message = `补给钱包 ${sym} 不够支付本次补 Gas（余额 ${nativeBal.toFixed(6)}），已跳过 ${skippedNoReserve} 个缺 Gas 地址`;
    } else if (failed > 0 && funded === 0) {
      message = `补 Gas 全部失败（${failed} 笔）${firstErr ? `：${firstErr}` : ''}。托管地址未到账`;
    } else if (funded > 0 && failed > 0) {
      message = `补 Gas 失败 ${failed} 笔`;
    }

    return {
      ok: funded > 0 || jobs.length === 0,
      chain,
      scanned,
      funded,
      skipped,
      failed,
      unqueried,
      heldBack: skippedNoReserve,
      queued: sendJobs.length,
      totalWallets: chainWalletCount,
      from: gasAddr,
      details: details.slice(0, 50),
      message,
    };
  }

  /**
   * 从服务端托管的 Gas 热钱包转出 USDT/ETH（需调用方已校验 TOTP）
   * 仅 collection_gas_wallets 内地址可转。
   */
  async transferFromGasWallet(params: {
    gasWalletId: string;
    token: 'USDT' | 'ETH' | 'BNB';
    toAddress: string;
    amount: number;
    actorId: string;
    chain?: string;
  }) {
    if (this.running) {
      return { ok: false as const, message: '归集/补 Gas/转出进行中，请稍后再试' };
    }
    this.running = true;
    try {
      const amount = Number(params.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('无效金额');
      }
      if (!isAddress(params.toAddress)) {
        throw new BadRequestException('无效收款地址');
      }

      const gw = await this.prisma.collectionGasWallet.findUnique({
        where: { id: params.gasWalletId },
      });
      if (!gw?.encPrivateKey) {
        throw new NotFoundException('未找到托管热钱包或无私钥');
      }

      const enabled = getEnabledDepositChains();
      const chain = this.payout.resolveChain(params.chain || gw.chain);
      if (!enabled.includes(chain)) {
        throw new BadRequestException(`${chain} 未开通`);
      }
      const token = isNativeGasSymbol(params.token) ? this.payout.nativeSymbol(chain) : 'USDT';
      const toAddress = getAddress(params.toAddress);
      if (getAddress(gw.address) === toAddress) {
        throw new BadRequestException('收款地址不能与转出地址相同');
      }

      const record = await this.prisma.hotWalletTransfer.create({
        data: {
          gasWalletId: gw.id,
          chain,
          tokenSymbol: token,
          amount,
          fromAddress: gw.address,
          toAddress,
          status: 'PENDING',
          actorId: params.actorId,
        },
      });

      try {
        let pk: string;
        try {
          pk = decrypt(gw.encPrivateKey);
        } catch {
          throw new BadRequestException('热钱包私钥解密失败');
        }

        let txHash: string;
        if (token !== 'USDT') {
          const native = await this.payout.getNativeBalance(chain, gw.address);
          const reserve = Number(process.env.HOT_WALLET_ETH_RESERVE || 0.00005);
          if (amount + reserve > native) {
            throw new BadRequestException(
              `${token} 不足（需 ${amount} + 预留 ${reserve}，现有 ${native.toFixed(6)}）`,
            );
          }
          const fee = await this.payout.resolveBroadcastFee(chain, await this.getGasFeeTier());
          const sent = await this.payout.sendNativeFromPrivateKey({
            chain,
            privateKey: pk,
            toAddress,
            amountEth: amount,
            fee,
          });
          txHash = sent.txHash;
        } else {
          const sent = await this.payout.transferUsdtWithKey({
            chain,
            privateKey: pk,
            toAddress,
            amount,
          });
          txHash = sent.txHash;
        }

        await this.prisma.hotWalletTransfer.update({
          where: { id: record.id },
          data: { status: 'SENT', txHash },
        });
        this.logger.log(
          `热钱包转出成功 ${token} ${amount} ${gw.address} → ${toAddress} tx=${txHash}`,
        );
        return {
          ok: true as const,
          id: record.id,
          chain,
          token,
          amount,
          fromAddress: gw.address,
          toAddress,
          txHash,
          status: 'SENT' as const,
        };
      } catch (e: any) {
        const failReason = String(e?.message || '转出失败').slice(0, 2000);
        await this.prisma.hotWalletTransfer.update({
          where: { id: record.id },
          data: { status: 'FAILED', failReason },
        });
        this.logger.warn(`热钱包转出失败 ${gw.address}: ${failReason}`);
        throw new BadRequestException(failReason);
      }
    } finally {
      this.running = false;
    }
  }

  /** 当前地址是否为本系统托管的 Gas 热钱包（可转出） */
  async isManagedHotWallet(chainInput?: string, address?: string) {
    if (!address || !isAddress(address)) return { managed: false as const };
    const chain = this.payout.resolveChain(chainInput || getPrimaryChain());
    const all = await this.prisma.collectionGasWallet.findMany({
      where: { chain },
      select: { id: true, address: true, label: true },
    });
    const hit = all.find((a) => a.address.toLowerCase() === address.toLowerCase());
    if (!hit) return { managed: false as const, chain };
    return {
      managed: true as const,
      chain,
      gasWalletId: hit.id,
      address: hit.address,
      label: hit.label,
    };
  }

  async adminStatus() {
    await this.ensureSharedChainConfigs();
    const configs = await this.prisma.collectionConfig.findMany();
    const pending = await this.prisma.collectionRecord.count({ where: { status: 'PENDING' } });
    const sent = await this.prisma.collectionRecord.count({ where: { status: 'SENT' } });
    const failed = await this.prisma.collectionRecord.count({ where: { status: 'FAILED' } });
    const enabled = getEnabledDepositChains();
    const primary = getPrimaryChain();
    return {
      mode: 'platform_custody',
      primaryChain: primary,
      enabledChains: enabled,
      networks: depositNetworkOptions(),
      message:
        enabled.length === 1
          ? `当前仅开放 ${depositNetworkOptions()[0]?.label || primary} 充值与归集；以后可通过 DEPOSIT_ENABLED_CHAINS 加网。`
          : '归集目标和补给钱包各链共用。下拉只切换在哪条链上归集、补 Gas。',
      configs: configs.map((c) => this.sanitizeConfig(c)),
      stats: { pending, sent, failed },
      collectJob: this.jobSnapshot(),
      fundJob: this.fundJobSnapshot(),
      gasFeeTier: await this.getGasFeeTier(),
      collectionAuto: await this.isAutoCollectEnabled(),
    };
  }
}
