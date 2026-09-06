import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Contract, JsonRpcProvider, getAddress } from 'ethers';
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

type ScanOutcome = 'ok' | 'blocked' | 'error';

@Injectable()
export class DepositScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DepositScannerService.name);
  private running = false;
  private stopped = false;
  private inBackoff = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private lastErrorRaw: string | null = null;
  private lastFail: unknown = null;
  private readonly pollMs = Math.max(30_000, Number(process.env.DEPOSIT_SCAN_MS || DEFAULT_POLL_MS));

  constructor(
    private prisma: PrismaService,
    private deposit: DepositService,
    private wallets: WalletService,
  ) {}

  onModuleInit() {
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
    const outcome = await this.tick();
    if (outcome === 'ok') {
      if (this.inBackoff) {
        this.inBackoff = false;
        this.logger.log(`扫块已恢复，改回 ${(this.pollMs / 1000).toFixed(0)}s 轮询`);
      }
      this.scheduleNext(this.pollMs);
      return;
    }
    if (outcome === 'blocked' || this.inBackoff) {
      const entering = !this.inBackoff;
      this.inBackoff = true;
      const depositFallback = process.env.DEPOSIT_BAN_BACKOFF_MS
        ? Number(process.env.DEPOSIT_BAN_BACKOFF_MS)
        : undefined;
      const { ms, reason } = resolveBackoffMs(this.lastFail, {
        exchange: 'RPC',
        fallbackMs: depositFallback,
        maxMs: Number(process.env.DEPOSIT_BAN_BACKOFF_MAX_MS || process.env.MARKET_BAN_BACKOFF_MAX_MS || 30 * 60_000),
      });
      this.logger.warn(
        `扫块${entering ? '进入' : '继续'}封禁退避 ${(ms / 1000).toFixed(0)}s (${reason}) | ${this.lastError || outcome}`,
      );
      if (this.lastErrorRaw) {
        this.logger.warn(`扫块封禁原始现场: ${this.lastErrorRaw}`);
      }
      this.scheduleNext(ms);
      return;
    }
    this.logger.warn(
      `扫块失败(不退避，${(this.pollMs / 1000).toFixed(0)}s 后再试): ${this.lastError || outcome}`,
    );
    if (this.lastErrorRaw) {
      this.logger.warn(`扫块失败原始现场: ${this.lastErrorRaw}`);
    }
    this.scheduleNext(this.pollMs);
  }

  /** @returns ok=可继续正常轮询；blocked=疑似封禁；error=其它失败 */
  async tick(): Promise<ScanOutcome> {
    if (!isScanEnabled()) return 'ok';
    if (this.running) return 'ok';
    this.running = true;
    let worst: ScanOutcome = 'ok';
    try {
      for (const chain of getEnabledDepositChains()) {
        const r = await this.scanChain(chain);
        if (r === 'blocked') worst = 'blocked';
        else if (r === 'error' && worst === 'ok') worst = 'error';
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

    const addresses = await this.wallets.listWatchAddresses();
    if (addresses.length === 0) return 'ok';

    let provider: JsonRpcProvider;
    try {
      provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
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

    // 留确认窗口: 只扫到 latest - (confirmations-1) 也可; 这里扫到 latest, 用确认数决定是否入账
    if (from >= latest) {
      await this.deposit.refreshPendingConfirmations(chain, latest);
      return 'ok';
    }

    // 每次最多扫 2000 块, 防 RPC 限制
    const to = Math.min(latest, from + 2000);
    const usdt = getAddress(cfg.usdt);
    const addressSet = new Set(addresses.map((a) => a.toLowerCase()));

    // topic[2] = to (indexed). 地址过多时无法一次过滤, 改为拉合约全部 Transfer 再本地滤
    // 小规模: 按地址分批 topic 过滤更省; 这里用合约日志 + 本地过滤, 适合地址量 < 数千
    const contract = new Contract(usdt, ERC20_ABI, provider);

    try {
      const logs = await provider.getLogs({
        address: usdt,
        fromBlock: from + 1,
        toBlock: to,
        topics: [TRANSFER_TOPIC],
      });

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
        this.logger.log(`[${chain}] 块 ${from + 1}-${to} 摄入 ${ingested} 笔充值`);
      }

      await this.setCursor(chain, to);
      await this.deposit.refreshPendingConfirmations(chain, latest);
      this.lastError = null;
      this.lastErrorRaw = null;
      this.lastFail = null;
      return 'ok';
    } catch (e: any) {
      // 不推进游标, 下次重试
      return this.rememberFail(chain, 'getLogs', e, {
        rpcHost: safeRpcHost(rpc),
        fromBlock: from + 1,
        toBlock: to,
      });
    }
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
