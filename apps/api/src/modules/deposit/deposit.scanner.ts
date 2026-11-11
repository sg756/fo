import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Contract, FetchRequest, JsonRpcProvider, getAddress, type Log } from 'ethers';
import {
  DEFAULT_POLL_MS,
  enrichRpcError,
  formatErrorRaw,
  isAccessBlockedError,
  resolveBackoffMs,
} from '../../common/poll-backoff';
import { PrismaService } from '../../prisma/prisma.service';
import { DepositService } from './deposit.service';
import { WalletService } from './wallet.service';
import {
  DEPOSIT_CHAINS,
  DepositChain,
  TRANSFER_TOPIC,
  getEnabledDepositChains,
  getRpcUrl,
  isScanEnabled,
} from './chain.config';

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const SCAN_CURSOR_PREFIX = 'deposit_scan_block_';

function safeRpcHost(rpc: string): string {
  try {
    return new URL(rpc).host;
  } catch {
    return rpc.slice(0, 64);
  }
}

/** 未单独配置的链，每次 getLogs 的块跨度。 */
const MAX_LOG_SPAN = 2000;
/** 按充值地址过滤后结果很小，单次可以拉更宽；全网 USDT 才需要把跨度收到一百多块。 */
const FILTERED_LOG_SPAN = 2_000;
/** 一次 eth_getLogs 的 topic[2] 地址数。公共节点对 OR 列表有上限。 */
const ADDR_TOPIC_BATCH = 40;
/** 游标落后时，一轮里连续拉日志的时间上限。 */
const CATCHUP_BUDGET_MS = 25_000;
const CATCHUP_MAX_CHUNKS = 12;
const CATCHUP_WAIT_MS = 3_000;
/** 落后超过这么多块就放弃补历史。BSC 约 0.45 秒一块，2 万块大约 2.5 小时。 */
const DEFAULT_MAX_CATCHUP_BLOCKS = 20_000;

function maxCatchupBlocks(): number {
  const n = Number(process.env.DEPOSIT_MAX_CATCHUP_BLOCKS || DEFAULT_MAX_CATCHUP_BLOCKS);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CATCHUP_BLOCKS;
  return Math.floor(n);
}

type LogFilter = { address: string; topics: (string | string[] | null)[] };

function toAddressTopic(addr: string): string {
  return '0x' + getAddress(addr).slice(2).toLowerCase().padStart(64, '0');
}

/** 只拉打到平台充值地址的 Transfer，避免把 BSC 上全部 USDT 流水拖下来。 */
function depositLogFilters(usdt: string, addresses: string[]): LogFilter[] {
  const filters: LogFilter[] = [];
  for (let i = 0; i < addresses.length; i += ADDR_TOPIC_BATCH) {
    const tos = addresses.slice(i, i + ADDR_TOPIC_BATCH).map(toAddressTopic);
    filters.push({
      address: usdt,
      topics: [TRANSFER_TOPIC, null, tos.length === 1 ? tos[0] : tos],
    });
  }
  return filters;
}

function rpcErrorText(err: unknown): string {
  const e = err as any;
  const chunks: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) chunks.push(v);
  };
  add(e?.shortMessage);
  add(e?.message);
  add(e?.info?.responseBody);
  add(e?.bodySnippet);
  if (e?.error && typeof e.error === 'object') add(e.error.message);
  else add(e?.error);
  return chunks.join('\n');
}

/**
 * PublicNode 等免费节点把超出保留窗口的 eth_getLogs 当成归档请求，
 * HTTP 403 + JSON-RPC -32602：「Archive requests require a personal token」。
 * shortMessage 只有 "403 Forbidden"，判定必须看 responseBody。
 */
function isArchiveRpcError(err: unknown): boolean {
  return /archive requests require a personal token|history has been pruned/i.test(rpcErrorText(err));
}

function isLogRangeLimitError(err: unknown): boolean {
  if (isAccessBlockedError(err)) return false;
  return /limit exceeded|too many results|response size|response too large|exceeds max results|exceed maximum|query returned more than|block range is too wide|at most \d+ blocks/i.test(
    rpcErrorText(err),
  );
}

/** 429 只失败一次。ethers 默认会把同一次调用重试最多 12 次，免费节点的分钟额度会被这一下打光。 */
function createScanProvider(rpc: string, chainId: number): JsonRpcProvider {
  const req = new FetchRequest(rpc);
  req.setThrottleParams({ maxAttempts: 1 });
  req.retryFunc = async () => false;
  return new JsonRpcProvider(req, chainId, { staticNetwork: true });
}

type ScanOutcome = 'ok' | 'blocked' | 'error';

@Injectable()
export class DepositScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DepositScannerService.name);
  private running = false;
  private stopped = false;
  /** 某条链被封后单独等到这个时间再查，不影响其它链 */
  private chainBackoffUntil = new Map<DepositChain, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private lastErrorRaw: string | null = null;
  private lastFail: unknown = null;
  /** 有链的游标仍明显落后，下一轮缩短间隔继续补 */
  private catchupSoon = false;
  private lastLagLogAt = new Map<DepositChain, number>();
  private readonly pollMs = Math.max(30_000, Number(process.env.DEPOSIT_SCAN_MS || DEFAULT_POLL_MS));

  constructor(
    private prisma: PrismaService,
    private deposit: DepositService,
    private wallets: WalletService,
  ) {}

  onModuleInit() {
    this.logger.log(
      `充值启用链: ${getEnabledDepositChains().join(',') || '(无)'}（DEPOSIT_ENABLED_CHAINS=${JSON.stringify(process.env.DEPOSIT_ENABLED_CHAINS || '')}）`,
    );
    if (!isScanEnabled()) {
      this.logger.warn('DepositScanner 已禁用');
      return;
    }
    this.logger.log(
      `DepositScanner 已启动: 正常=${(this.pollMs / 1000).toFixed(0)}s, 封禁退避=优先响应头/RPC默认(可用 DEPOSIT_BAN_BACKOFF_MS)`,
    );
    void this.loop();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop() {
    await this.tick();
    let wait = this.catchupSoon ? CATCHUP_WAIT_MS : this.pollMs;
    this.catchupSoon = false;
    const now = Date.now();
    for (const until of this.chainBackoffUntil.values()) {
      if (until > now) wait = Math.min(wait, Math.max(1000, until - now));
    }
    this.scheduleNext(wait);
  }

  private banBackoffMs(): { ms: number; reason: string } {
    const depositFallback = process.env.DEPOSIT_BAN_BACKOFF_MS
      ? Number(process.env.DEPOSIT_BAN_BACKOFF_MS)
      : undefined;
    return resolveBackoffMs(this.lastFail, {
      exchange: 'RPC',
      fallbackMs: depositFallback,
      maxMs: Number(process.env.DEPOSIT_BAN_BACKOFF_MAX_MS || process.env.MARKET_BAN_BACKOFF_MAX_MS || 30 * 60_000),
    });
  }

  /** @returns ok=可继续正常轮询；blocked=疑似封禁；error=其它失败 */
  async tick(): Promise<ScanOutcome> {
    if (!isScanEnabled()) return 'ok';
    if (this.running) return 'ok';
    this.running = true;
    let worst: ScanOutcome = 'ok';
    try {
      try {
        await this.wallets.backfillEnabledChainWallets();
      } catch (e: any) {
        this.logger.warn(`补齐托管地址失败，继续扫已有地址: ${e?.message || e}`);
      }
      const now = Date.now();
      for (const chain of getEnabledDepositChains()) {
        const until = this.chainBackoffUntil.get(chain) || 0;
        if (until > now) continue;
        const r = await this.scanChain(chain);
        if (r === 'blocked') {
          const { ms, reason } = this.banBackoffMs();
          this.chainBackoffUntil.set(chain, Date.now() + ms);
          this.logger.warn(
            `[${chain}] 扫块进入封禁退避 ${(ms / 1000).toFixed(0)}s (${reason})，其它链继续查 | ${this.lastError || r}`,
          );
          worst = 'blocked';
        } else if (r === 'error') {
          this.chainBackoffUntil.delete(chain);
          if (worst === 'ok') worst = 'error';
        } else if (this.chainBackoffUntil.delete(chain)) {
          this.logger.log(`[${chain}] 扫块已恢复`);
        }
      }
    } catch (e: any) {
      const wrapped = enrichRpcError(e, { phase: 'tick' });
      this.lastFail = wrapped;
      this.lastError = wrapped.message;
      this.lastErrorRaw = formatErrorRaw(wrapped);
      this.logger.error(`扫块异常: ${this.lastError}`);
      this.logger.error(`扫块异常原始现场: ${this.lastErrorRaw}`);
      worst = isAccessBlockedError(wrapped) ? 'blocked' : 'error';
    } finally {
      this.running = false;
    }
    return worst;
  }

  private cursorKey(chain: DepositChain) {
    return `${SCAN_CURSOR_PREFIX}${chain}`;
  }

  private async getCursor(chain: DepositChain): Promise<number | null> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: this.cursorKey(chain) },
    });
    return row ? Number(row.value) : null;
  }

  private async setCursor(chain: DepositChain, block: number) {
    await this.prisma.systemConfig.upsert({
      where: { key: this.cursorKey(chain) },
      create: {
        key: this.cursorKey(chain),
        value: String(block),
        remark: `${chain} 充值扫块游标`,
      },
      update: { value: String(block) },
    });
  }

  /** 将游标回退到指定块之前，确保刚上链的交易能被扫到 */
  async rewindCursor(chain: DepositChain, beforeBlock: number) {
    const cur = await this.getCursor(chain);
    const target = Math.max(0, beforeBlock - 1);
    if (cur == null || cur > target) {
      await this.setCursor(chain, target);
      this.logger.log(`[${chain}] 扫块游标回退至 ${target}`);
    }
  }

  private rememberFail(chain: DepositChain, phase: string, err: unknown, extra?: Record<string, unknown>) {
    const wrapped = enrichRpcError(err, { chain, phase, ...extra });
    this.lastFail = wrapped;
    this.lastError = wrapped.message;
    this.lastErrorRaw = formatErrorRaw(wrapped);
    this.logger.warn(`[${chain}] ${phase} 失败: ${this.lastError}`);
    this.logger.warn(`[${chain}] ${phase} 原始现场: ${this.lastErrorRaw}`);
    return isAccessBlockedError(wrapped) ? ('blocked' as const) : ('error' as const);
  }

  async scanChain(chain: DepositChain): Promise<ScanOutcome> {
    const cfg = DEPOSIT_CHAINS[chain];
    const rpc = getRpcUrl(cfg);
    if (!rpc) return 'ok';

    const addresses = await this.wallets.listWatchAddresses(chain);
    if (addresses.length === 0) return 'ok';

    let provider: JsonRpcProvider;
    try {
      provider = createScanProvider(rpc, cfg.chainId);
    } catch (e: any) {
      return this.rememberFail(chain, 'RPC初始化', e, { rpcHost: safeRpcHost(rpc) });
    }

    let latest: number;
    try {
      latest = await provider.getBlockNumber();
    } catch (e: any) {
      return this.rememberFail(chain, 'getBlockNumber', e, { rpcHost: safeRpcHost(rpc) });
    }

    let from = await this.getCursor(chain);
    if (from == null) {
      // 首次从 latest-5 开始, 避免全链回溯
      from = Math.max(0, latest - 5);
      await this.setCursor(chain, from);
    }

    const maxCatchup = maxCatchupBlocks();
    if (latest - from > maxCatchup) {
      const resume = latest - maxCatchup;
      this.logger.warn(
        `[${chain}] 游标落后 ${latest - from} 块，超过 ${maxCatchup} 块，已跳过 ${from + 1}-${resume}。这段里的充值不会自动入账，只继续扫最近 ${maxCatchup} 块`,
      );
      await this.setCursor(chain, resume);
      from = resume;
    }

    // 留确认窗口: 只扫到 latest - (confirmations-1) 也可; 这里扫到 latest, 用确认数决定是否入账
    if (from >= latest) {
      await this.deposit.refreshPendingConfirmations(chain, latest);
      return 'ok';
    }

    const usdt = getAddress(cfg.usdt);
    const addressSet = new Set(addresses.map((a) => a.toLowerCase()));
    const logFilters = depositLogFilters(usdt, addresses);
    const contract = new Contract(usdt, ERC20_ABI, provider);

    // 公共节点拒绝过旧区块时，同一轮里跳过读不到的历史再扫近期；区间过大则缩小后重试。
    const normalSpan = Math.max(cfg.maxLogSpan ?? MAX_LOG_SPAN, FILTERED_LOG_SPAN);
    const lag = latest - from;
    if (lag > 10_000 && Date.now() - (this.lastLagLogAt.get(chain) || 0) > 60_000) {
      this.lastLagLogAt.set(chain, Date.now());
      this.logger.warn(
        `[${chain}] 扫块落后 ${lag} 块，按 ${addresses.length} 个充值地址过滤补扫（每批 ${ADDR_TOPIC_BATCH} 个，跨度 ${normalSpan} 块），不再拉取全网 USDT`,
      );
    }
    let span = normalSpan;
    let lastErr: unknown = null;
    const started = Date.now();
    let chunks = 0;
    let recovers = 0;
    while (from < latest && chunks < CATCHUP_MAX_CHUNKS && recovers < 6 && Date.now() - started < CATCHUP_BUDGET_MS) {
      const fromBlock = from + 1;
      const to = Math.min(latest, from + span);
      let activeFilter = logFilters[0];
      try {
        const logs: Log[] = [];
        for (const filter of logFilters) {
          activeFilter = filter;
          logs.push(...(await provider.getLogs({ ...filter, fromBlock, toBlock: to })));
        }

        let ingested = 0;
        for (const log of logs) {
          // topics: [sig, from, to]
          if (!log.topics || log.topics.length < 3) continue;
          const toAddr = getAddress('0x' + log.topics[2].slice(26)).toLowerCase();
          if (!addressSet.has(toAddr)) continue;

          let value: bigint;
          try {
            const parsed = contract.interface.parseLog({
              topics: log.topics as string[],
              data: log.data,
            });
            value = BigInt(parsed?.args?.value?.toString() || '0');
          } catch {
            // data 是 uint256
            value = BigInt(log.data);
          }

          const blockNumber = Number(log.blockNumber);
          await this.deposit.ingestTransfer({
            chain,
            txHash: log.transactionHash,
            logIndex: log.index,
            toAddress: toAddr,
            amountRaw: value,
            blockNumber,
            currentBlock: latest,
          });
          ingested++;
        }

        if (ingested > 0) {
          this.logger.log(`[${chain}] 块 ${fromBlock}-${to} 摄入 ${ingested} 笔充值`);
        }

        await this.setCursor(chain, to);
        from = to;
        chunks++;
        span = normalSpan;
        this.lastError = null;
        this.lastErrorRaw = null;
        this.lastFail = null;
      } catch (e: any) {
        lastErr = e;
        if (isAccessBlockedError(e)) break;
        let next: { from: number; span: number } | null;
        try {
          next = await this.recoverGetLogs(chain, provider, activeFilter, cfg.envRpcKey, {
            from,
            fromBlock,
            to,
            span,
            normalSpan,
            latest,
            err: e,
          });
        } catch (probeErr) {
          lastErr = probeErr;
          break;
        }
        if (!next) break;
        recovers++;
        from = next.from;
        span = next.span;
      }
    }

    if (lastErr && isAccessBlockedError(lastErr)) {
      if (chunks > 0) await this.deposit.refreshPendingConfirmations(chain, latest);
      return this.rememberFail(chain, 'getLogs', lastErr, {
        rpcHost: safeRpcHost(rpc),
        fromBlock: from + 1,
        toBlock: Math.min(latest, from + span),
      });
    }

    if (chunks > 0) {
      await this.deposit.refreshPendingConfirmations(chain, latest);
      if (from < latest) {
        this.catchupSoon = true;
        this.logger.log(`[${chain}] 扫块仍落后 ${latest - from} 块，${(CATCHUP_WAIT_MS / 1000).toFixed(0)}s 后继续`);
      }
      return 'ok';
    }

    const failFrom = from + 1;
    const failTo = Math.min(latest, from + span);
    return this.rememberFail(chain, 'getLogs', lastErr, {
      rpcHost: safeRpcHost(rpc),
      fromBlock: failFrom,
      toBlock: failTo,
    });
  }

  /**
   * getLogs 失败后的一次恢复。返回 null 表示无法恢复，调用方按原错误停下且不推进游标。
   * - 起始块已超出节点保留窗口：从链头往回找到还能读的块，跳过中间缺口
   * - 起始块能读、区间太大：缩小跨度
   */
  private async recoverGetLogs(
    chain: DepositChain,
    provider: JsonRpcProvider,
    logFilter: LogFilter,
    envRpcKey: string,
    ctx: {
      from: number;
      fromBlock: number;
      to: number;
      span: number;
      normalSpan: number;
      latest: number;
      err: unknown;
    },
  ): Promise<{ from: number; span: number } | null> {
    const { from, fromBlock, to, span, normalSpan, latest, err } = ctx;
    const archive = isArchiveRpcError(err);
    const rangeLimit = isLogRangeLimitError(err);
    if (!archive && !rangeLimit) return null;

    if (rangeLimit && span > 1) {
      const nextSpan = Math.max(1, Math.floor(span / 4));
      this.logger.warn(`[${chain}] getLogs 区间 ${fromBlock}-${to} 超出节点限制，缩小到 ${nextSpan} 块后重试`);
      return { from, span: nextSpan };
    }

    if (!archive) return null;

    let startReadable = false;
    try {
      await provider.getLogs({ ...logFilter, fromBlock, toBlock: fromBlock });
      startReadable = true;
    } catch (probeErr) {
      if (!isArchiveRpcError(probeErr)) throw probeErr;
    }

    if (startReadable) {
      if (span <= 1) return null;
      const nextSpan = Math.max(1, Math.floor(span / 4));
      this.logger.warn(
        `[${chain}] getLogs 区间 ${fromBlock}-${to} 被节点拒绝，起始块仍可读，缩小到 ${nextSpan} 块后重试`,
      );
      return { from, span: nextSpan };
    }

    try {
      await provider.getLogs({ ...logFilter, fromBlock: latest, toBlock: latest });
    } catch (probeErr) {
      // 链头也读不到，不是「游标落后」能跳过的情况
      if (isArchiveRpcError(probeErr)) return null;
      throw probeErr;
    }

    // 从链头往回探几档，停在仍可读的最老一块。PublicNode 免费端大约只留最近 1 小时。
    const lookbacks = [500, 2000, 8000, 32000];
    let oldestOk = latest;
    for (const back of lookbacks) {
      const block = latest - back;
      if (block <= fromBlock) break;
      try {
        await provider.getLogs({ ...logFilter, fromBlock: block, toBlock: block });
        oldestOk = block;
      } catch (probeErr) {
        if (!isArchiveRpcError(probeErr)) throw probeErr;
        break;
      }
    }
    if (oldestOk <= fromBlock) return null;

    const skipped = oldestOk - fromBlock;
    this.logger.warn(
      `[${chain}] 公共 RPC 不保留块 ${fromBlock}-${oldestOk - 1} 的日志（Archive requests require a personal token），已跳过 ${skipped} 块，游标改到 ${oldestOk - 1}。这段内的充值无法用当前节点补扫，需要 ${envRpcKey} 指向可查历史日志的节点`,
    );
    await this.setCursor(chain, oldestOk - 1);
    return { from: oldestOk - 1, span: normalSpan };
  }

  /** 手动触发一次扫描 (管理接口) */
  async scanNow(chain?: DepositChain) {
    if (chain) return this.scanChain(chain);
    for (const c of getEnabledDepositChains()) {
      await this.scanChain(c);
    }
    return { ok: true };
  }
}
