import { Injectable, Logger } from '@nestjs/common';
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  HDNodeWallet,
  formatUnits,
  parseUnits,
  getAddress,
  isAddress,
} from 'ethers';
import { DEPOSIT_CHAINS, DepositChain, getRpcUrl } from '../deposit/chain.config';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

/** Multicall3（ETH/ARB/BASE 同地址） */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
];
const USDT_IFACE = new Interface(ERC20_ABI);
const MC_IFACE = new Interface(MULTICALL3_ABI);
const BALANCE_CHUNK = 200;

export type GasFeeTier = 'standard' | 'fast';

/** 相对当前链建议价的系数（标准=链上建议 1.0 / 快=加价） */
const FEE_TIER_MULT: Record<GasFeeTier, { priority: number; maxFee: number; gasPrice: number }> = {
  standard: { priority: 1.0, maxFee: 1.0, gasPrice: 1.0 },
  fast: { priority: 1.5, maxFee: 1.25, gasPrice: 1.25 },
};

export type BroadcastFee = {
  tier: GasFeeTier;
  /** 估算补给金额用（偏保守，取 maxFee 或 legacy gasPrice） */
  estimateGasPrice: bigint;
  tx:
    | { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    | { type: 'legacy'; gasPrice: bigint };
};

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length || 1) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  if (items.length) await Promise.all(workers);
  return out;
}

/**
 * 链上 USDT 转账 (提现打款 / 归集)
 * 热钱包私钥: WITHDRAW_HOT_PRIVATE_KEY, 或回退 HD 助记词 index=0
 */
@Injectable()
export class ChainPayoutService {
  private readonly logger = new Logger(ChainPayoutService.name);
  private readonly providers = new Map<DepositChain, JsonRpcProvider>();

  resolveChain(chain: string): DepositChain {
    const c = (chain || 'ARB').toUpperCase();
    if (c === 'ETH' || c === 'ARB' || c === 'BASE') return c;
    // 兼容别名
    if (c === 'ARBITRUM') return 'ARB';
    return 'ARB';
  }

  private provider(chain: DepositChain) {
    let p = this.providers.get(chain);
    if (!p) {
      const chainId = Number(this.expectedChainId(chain));
      p = new JsonRpcProvider(getRpcUrl(DEPOSIT_CHAINS[chain]), chainId, {
        staticNetwork: true,
      });
      this.providers.set(chain, p);
    }
    return p;
  }

  private hotWallet(chain: DepositChain): Wallet {
    const pk = process.env.WITHDRAW_HOT_PRIVATE_KEY?.trim();
    if (pk) return new Wallet(pk, this.provider(chain));

    const mnemonic = process.env.HD_MNEMONIC?.trim();
    if (!mnemonic) {
      throw new Error('未配置 WITHDRAW_HOT_PRIVATE_KEY 或 HD_MNEMONIC, 无法链上打款');
    }
    // HD index 0 作为平台热钱包
    const hd = HDNodeWallet.fromPhrase(mnemonic);
    return new Wallet(hd.privateKey, this.provider(chain));
  }

  usdtContract(chain: DepositChain, signerOrProvider: any) {
    const cfg = DEPOSIT_CHAINS[chain];
    return new Contract(cfg.usdt, ERC20_ABI, signerOrProvider);
  }

  async getUsdtBalance(chain: DepositChain, address: string): Promise<number> {
    const cfg = DEPOSIT_CHAINS[chain];
    const provider = this.provider(chain);
    const c = this.usdtContract(chain, provider);
    const bal = await c.balanceOf(getAddress(address));
    return Number(formatUnits(bal, cfg.decimals));
  }

  /** 原生币余额 (gas) */
  async getNativeBalance(chain: DepositChain, address: string): Promise<number> {
    const provider = this.provider(chain);
    const bal = await provider.getBalance(getAddress(address));
    return Number(formatUnits(bal, 18));
  }

  nativeSymbol(chain: DepositChain): string {
    return 'ETH'; // ARB/BASE/ETH 均用 ETH 作 gas
  }

  /**
   * Multicall3 批量查 USDT + ETH。失败则对该批回退并发单查。
   */
  async getBalancesBatch(
    chain: DepositChain,
    addresses: string[],
  ): Promise<Map<string, { usdt: number; native: number; ok: boolean }>> {
    const out = new Map<string, { usdt: number; native: number; ok: boolean }>();
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const raw of addresses) {
      if (!raw || !isAddress(raw)) continue;
      const addr = getAddress(raw);
      if (seen.has(addr)) continue;
      seen.add(addr);
      uniq.push(addr);
    }
    for (let i = 0; i < uniq.length; i += BALANCE_CHUNK) {
      const chunk = uniq.slice(i, i + BALANCE_CHUNK);
      const part = await this.getBalancesChunk(chain, chunk);
      for (const [k, v] of part) out.set(k, v);
    }
    return out;
  }

  private async getBalancesChunk(
    chain: DepositChain,
    addrs: string[],
  ): Promise<Map<string, { usdt: number; native: number; ok: boolean }>> {
    const out = new Map<string, { usdt: number; native: number; ok: boolean }>();
    if (!addrs.length) return out;
    const cfg = DEPOSIT_CHAINS[chain];
    const usdtAddr = getAddress(cfg.usdt);
    const provider = this.provider(chain);
    const mc = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
    const calls = addrs.flatMap((addr) => [
      {
        target: usdtAddr,
        allowFailure: true,
        callData: USDT_IFACE.encodeFunctionData('balanceOf', [addr]),
      },
      {
        target: MULTICALL3,
        allowFailure: true,
        callData: MC_IFACE.encodeFunctionData('getEthBalance', [addr]),
      },
    ]);
    try {
      const results: { success: boolean; returnData: string }[] = await mc.aggregate3.staticCall(calls);
      for (let i = 0; i < addrs.length; i++) {
        const usdtRes = results[i * 2];
        const ethRes = results[i * 2 + 1];
        let usdt = 0;
        let native = 0;
        let ok = true;
        try {
          if (!usdtRes?.success || !usdtRes.returnData || usdtRes.returnData === '0x') throw new Error('usdt');
          usdt = Number(formatUnits(USDT_IFACE.decodeFunctionResult('balanceOf', usdtRes.returnData)[0], cfg.decimals));
        } catch {
          ok = false;
        }
        try {
          if (!ethRes?.success || !ethRes.returnData || ethRes.returnData === '0x') throw new Error('eth');
          native = Number(formatUnits(MC_IFACE.decodeFunctionResult('getEthBalance', ethRes.returnData)[0], 18));
        } catch {
          ok = false;
        }
        out.set(addrs[i], { usdt: Number.isFinite(usdt) ? usdt : 0, native: Number.isFinite(native) ? native : 0, ok });
      }
      return out;
    } catch (e: any) {
      this.logger.warn(`Multicall 失败，回退单查 ${addrs.length} 个: ${e?.message || e}`);
      await mapPool(addrs, 12, async (addr) => {
        try {
          const [usdt, native] = await Promise.all([
            this.getUsdtBalance(chain, addr),
            this.getNativeBalance(chain, addr),
          ]);
          out.set(addr, { usdt, native, ok: true });
        } catch {
          out.set(addr, { usdt: 0, native: 0, ok: false });
        }
      });
      return out;
    }
  }

  async getFeeGasPrice(chain: DepositChain): Promise<bigint> {
    const fee = await this.resolveBroadcastFee(chain, 'standard');
    return fee.estimateGasPrice;
  }

  /**
   * ETH 主网简单转账 21000 即可。
   * ARB/BASE 的 gasLimit 还要覆盖 L1 数据费，写死 21000 会被节点拒成 intrinsic gas too low。
   */
  nativeTransferGasLimit(chain: DepositChain): bigint {
    return chain === 'ETH' ? 21_000n : 250_000n;
  }

  async estimateNativeTransferGasLimit(params: {
    chain: DepositChain;
    from: string;
    to: string;
    value: bigint;
  }): Promise<bigint> {
    const floor = this.nativeTransferGasLimit(params.chain);
    try {
      const est = await this.provider(params.chain).estimateGas({
        from: getAddress(params.from),
        to: getAddress(params.to),
        value: params.value,
      });
      const buffered = (est * 120n) / 100n;
      return buffered > floor ? buffered : floor;
    } catch {
      return floor;
    }
  }

  /** 单笔 ETH 转账预估手续费（与 fundGasBatch 广播口径一致：gasLimit × 档位价 × 1.2） */
  async estimateNativeTransferFeeEth(
    chain: DepositChain,
    tier: GasFeeTier = 'standard',
  ): Promise<number> {
    const fee = await this.resolveBroadcastFee(chain, tier);
    const gasLimit = this.nativeTransferGasLimit(chain);
    const wei = (gasLimit * fee.estimateGasPrice * 120n) / 100n;
    return Number(formatUnits(wei, 18));
  }

  /** 一次拉链上建议价，返回标准/快两档单笔 ETH 预估（避免重复 RPC 且口径一致） */
  async previewNativeTransferFees(chain: DepositChain): Promise<
    Record<GasFeeTier, { ethPerTx: number; gwei: number }>
  > {
    const feeData = await this.provider(chain).getFeeData();
    const gasLimit = this.nativeTransferGasLimit(chain);
    const out = {} as Record<GasFeeTier, { ethPerTx: number; gwei: number }>;
    for (const tier of ['standard', 'fast'] as GasFeeTier[]) {
      const broadcast = this.buildBroadcastFee(feeData, tier);
      const wei = (gasLimit * broadcast.estimateGasPrice * 120n) / 100n;
      out[tier] = {
        ethPerTx: Number(formatUnits(wei, 18)),
        gwei: Number(formatUnits(broadcast.estimateGasPrice, 9)),
      };
    }
    return out;
  }

  private scaleFeeUnit(v: bigint, mult: number): bigint {
    if (!(v > 0n)) return 1n;
    if (mult === 1) return v;
    const n = BigInt(Math.round(mult * 1000));
    const out = (v * n) / 1000n;
    return out > 0n ? out : 1n;
  }

  private buildBroadcastFee(
    fee: Awaited<ReturnType<JsonRpcProvider['getFeeData']>>,
    tier: GasFeeTier,
  ): BroadcastFee {
    const m = FEE_TIER_MULT[tier] || FEE_TIER_MULT.standard;
    const baseUnit =
      fee.maxFeePerGas && fee.maxFeePerGas > 0n
        ? fee.maxFeePerGas
        : fee.gasPrice && fee.gasPrice > 0n
          ? fee.gasPrice
          : 1_000_000_000n;
    // 展示/预算用单价：标准=链上建议 1.0，快=1.25（不受 priority 抬价钳制影响）
    const estimateGasPrice = this.scaleFeeUnit(baseUnit, m.maxFee);

    if (fee.maxFeePerGas && fee.maxFeePerGas > 0n) {
      const priorityRaw =
        fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n
          ? fee.maxPriorityFeePerGas
          : 1_000_000n;
      let maxPriorityFeePerGas = this.scaleFeeUnit(priorityRaw, m.priority);
      let maxFeePerGas = this.scaleFeeUnit(fee.maxFeePerGas, m.maxFee);
      if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
      return {
        tier,
        estimateGasPrice,
        tx: { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas },
      };
    }

    const gasPrice = this.scaleFeeUnit(baseUnit, m.gasPrice);
    return {
      tier,
      estimateGasPrice: gasPrice,
      tx: { type: 'legacy', gasPrice },
    };
  }

  /** 补 Gas 出价档位：相对当前 getFeeData() 的系数，不手填 wei */
  static parseFeeTier(v: unknown): GasFeeTier {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'fast') return 'fast';
    // 旧配置 slow 或缺省均视为标准（链上建议）
    return 'standard';
  }

  /**
   * 链上建议价 × 档位系数。
   * 拥堵时 base fee 会自己涨，不必人工判定拥堵。
   */
  async resolveBroadcastFee(
    chain: DepositChain,
    tier: GasFeeTier = 'standard',
  ): Promise<BroadcastFee> {
    const fee = await this.provider(chain).getFeeData();
    return this.buildBroadcastFee(fee, tier);
  }

  private expectedChainId(chain: DepositChain): bigint {
    if (chain === 'ARB') return 42161n;
    if (chain === 'BASE') return 8453n;
    return 1n;
  }

  /**
   * 从指定私钥打原生币（Gas 补给）。不走 .env 热钱包。
   */
  async sendNativeFromPrivateKey(params: {
    chain: string;
    privateKey: string;
    toAddress: string;
    amountEth: number;
    /** 批量并发时预分配，避免同地址 nonce 冲突 */
    nonce?: number;
    fee?: BroadcastFee;
    /** 批量已在入口校验总额时跳过单笔余额检查 */
    skipBalanceCheck?: boolean;
    /** false 时仅广播，由调用方 wait() 确认上链 */
    waitReceipt?: boolean;
  }): Promise<{ txHash: string; from: string; wait?: () => Promise<unknown> }> {
    const chain = this.resolveChain(params.chain);
    if (!isAddress(params.toAddress)) throw new Error('无效收款地址');
    const amount = Number(params.amountEth);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('无效 Gas 金额');

    const provider = this.provider(chain);
    const net = await provider.getNetwork();
    const expected = this.expectedChainId(chain);
    if (net.chainId !== expected) {
      throw new Error(
        `RPC 链不匹配：${chain} 期望 chainId=${expected}，当前 ${net.chainId}。请检查 ${chain} RPC`,
      );
    }

    const wallet = new Wallet(params.privateKey, provider);
    const value = parseUnits(amount.toFixed(12), 18);
    if (value <= 0n) throw new Error('无效 Gas 金额');
    const fee = params.fee || (await this.resolveBroadcastFee(chain, 'standard'));
    const gasLimit = await this.estimateNativeTransferGasLimit({
      chain,
      from: wallet.address,
      to: params.toAddress,
      value,
    });
    const feeCost =
      fee.tx.type === 'eip1559' ? gasLimit * fee.tx.maxFeePerGas : gasLimit * fee.tx.gasPrice;

    if (!params.skipBalanceCheck) {
      const bal = await provider.getBalance(wallet.address);
      if (bal < value + feeCost) {
        throw new Error(
          `Gas 补给钱包 ETH 不足: 需要 ${formatUnits(value + feeCost, 18)}（含矿工费），余额 ${formatUnits(bal, 18)} (${wallet.address})`,
        );
      }
    }

    const txReq: {
      to: string;
      value: bigint;
      gasLimit: bigint;
      chainId: number;
      nonce?: number;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
    } = {
      to: getAddress(params.toAddress),
      value,
      gasLimit,
      chainId: Number(expected),
    };
    if (params.nonce != null && Number.isFinite(params.nonce) && params.nonce >= 0) {
      txReq.nonce = Math.floor(params.nonce);
    }
    if (fee.tx.type === 'eip1559') {
      txReq.maxFeePerGas = fee.tx.maxFeePerGas;
      txReq.maxPriorityFeePerGas = fee.tx.maxPriorityFeePerGas;
    } else {
      txReq.gasPrice = fee.tx.gasPrice;
    }

    this.logger.log(
      `Gas 补给 ${amount} ETH ${wallet.address} → ${params.toAddress} on ${chain} tier=${fee.tier} gasLimit=${gasLimit}` +
        (txReq.nonce != null ? ` nonce=${txReq.nonce}` : ''),
    );
    const tx = await wallet.sendTransaction(txReq);
    const waitReceipt = async () => {
      const receipt = await provider.waitForTransaction(tx.hash, 1, 90_000);
      if (!receipt) {
        throw new Error(`补 Gas 超时未上链 tx=${tx.hash}`);
      }
      if (Number(receipt.status) === 0) {
        throw new Error(`补 Gas 链上失败 tx=${tx.hash}`);
      }
      return receipt;
    };
    if (params.waitReceipt === false) {
      return {
        txHash: tx.hash,
        from: wallet.address,
        wait: waitReceipt,
      };
    }
    await waitReceipt();
    return { txHash: tx.hash, from: wallet.address };
  }

  async getPendingNonce(chain: DepositChain, address: string): Promise<number> {
    const n = await this.provider(chain).getTransactionCount(getAddress(address), 'pending');
    return Number(n);
  }

  /**
   * 托管热钱包对外转 USDT（任意收款地址；不做归集条件判断）
   */
  async transferUsdtWithKey(params: {
    chain: string;
    privateKey: string;
    toAddress: string;
    amount: number | string;
  }): Promise<{ txHash: string; from: string }> {
    const chain = this.resolveChain(params.chain);
    if (!isAddress(params.toAddress)) throw new Error('无效收款地址');
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('无效金额');

    const cfg = DEPOSIT_CHAINS[chain];
    const wallet = new Wallet(params.privateKey, this.provider(chain));
    const contract = this.usdtContract(chain, wallet);
    const units = parseUnits(amount.toFixed(cfg.decimals), cfg.decimals);

    const bal = await contract.balanceOf(wallet.address);
    if (bal < units) {
      throw new Error(`USDT 余额不足: ${formatUnits(bal, cfg.decimals)} < ${amount}`);
    }

    const est = await this.estimateTransferGasNative(
      chain,
      wallet.address,
      params.toAddress,
      amount,
    );
    const native = await this.getNativeBalance(chain, wallet.address);
    if (native < est.requiredNative) {
      throw new Error(
        `Gas 不足: 转出约需 ${est.requiredNative.toFixed(6)} ETH, 现有 ${native.toFixed(6)}`,
      );
    }

    this.logger.log(`热钱包转出 ${amount} USDT → ${params.toAddress} on ${chain}`);
    const tx = await contract.transfer(getAddress(params.toAddress), units);
    const receipt = await tx.wait();
    if (receipt && Number(receipt.status) === 0) {
      throw new Error(`链上交易失败(reverted) tx=${receipt.hash || tx.hash}`);
    }
    return { txHash: receipt?.hash || tx.hash, from: wallet.address };
  }

  /**
   * 估算 ERC20 transfer 所需原生币 (含 20% 缓冲)
   * 不足则不可归集
   */
  async estimateTransferGasNative(
    chain: DepositChain,
    fromAddress: string,
    toAddress: string,
    amount: number,
    gasPriceHint?: bigint,
  ): Promise<{ requiredNative: number; gasLimit: bigint; gasPrice: bigint }> {
    const cfg = DEPOSIT_CHAINS[chain];
    const provider = this.provider(chain);
    const contract = this.usdtContract(chain, provider);
    const units = parseUnits(Math.max(amount, 0.000001).toFixed(cfg.decimals), cfg.decimals);
    let gasPrice = gasPriceHint && gasPriceHint > 0n ? gasPriceHint : 0n;
    if (!gasPrice) {
      const fee = await provider.getFeeData();
      gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 1_000_000_000n;
    }

    let gasLimit = 80_000n;
    try {
      gasLimit = await contract.transfer.estimateGas(getAddress(toAddress), units, {
        from: getAddress(fromAddress),
      });
    } catch {
      // 余额为 0 或节点不支持 estimate 时用默认
      gasLimit = 100_000n;
    }

    const buffered = (gasLimit * gasPrice * 120n) / 100n;
    // 环境可设绝对下限 (原生币)
    const floor = Number(process.env.COLLECTION_MIN_NATIVE_GAS || 0);
    const required = Number(formatUnits(buffered, 18));
    return {
      requiredNative: Math.max(required, floor),
      gasLimit,
      gasPrice,
    };
  }

  /** 是否具备归集条件: USDT 达阈值 + 原生币够付 gas */
  async canCollectWallet(params: {
    chain: DepositChain;
    address: string;
    targetAddress: string;
    threshold: number;
  }): Promise<{
    usdt: number;
    native: number;
    requiredGas: number;
    gasDeficit: number;
    fundSuggest: number;
    gasLimit: string;
    gasPriceGwei: number;
    amountOk: boolean;
    gasOk: boolean;
    collectable: boolean;
    skipReason: string | null;
  }> {
    const usdt = await this.getUsdtBalance(params.chain, params.address);
    const native = await this.getNativeBalance(params.chain, params.address);
    const amountOk = usdt >= params.threshold && usdt > 0;

    let requiredGas = 0;
    let gasLimit = '0';
    let gasPriceGwei = 0;
    // 无 USDT / 未达阈值：不归集，也就没有 gas 费用
    let gasOk = true;

    if (amountOk && isAddress(params.targetAddress)) {
      const est = await this.estimateTransferGasNative(
        params.chain,
        params.address,
        params.targetAddress,
        usdt,
      );
      requiredGas = est.requiredNative;
      gasLimit = est.gasLimit.toString();
      gasPriceGwei = Number(formatUnits(est.gasPrice, 9));
      gasOk = this.coversNativeGas(native, requiredGas);
    }

    const gasDeficit = Math.max(0, requiredGas - native);
    const fundSuggest =
      amountOk && gasDeficit > 0 ? Math.max(requiredGas * 1.5 - native, 0.00005) : 0;

    let skipReason: string | null = null;
    if (!amountOk) skipReason = `USDT 未达阈值(${params.threshold})`;
    else if (!gasOk) {
      skipReason = `Gas 不足(需≈${requiredGas.toFixed(6)} ETH, 有 ${native.toFixed(6)}, 建议补 ${fundSuggest.toFixed(6)})`;
    }

    return {
      usdt,
      native,
      requiredGas,
      gasDeficit,
      fundSuggest,
      gasLimit,
      gasPriceGwei,
      amountOk,
      gasOk,
      collectable: amountOk && gasOk,
      skipReason,
    };
  }

  /** 托管地址 ETH 是否够付一次归集（容忍浮点/展示六位小数误差） */
  coversNativeGas(have: number, need: number): boolean {
    const h = Number(have);
    const n = Number(need);
    if (!Number.isFinite(n) || n <= 0) return true;
    if (!Number.isFinite(h) || h <= 0) return false;
    return h + 1e-8 >= n;
  }

  summarizeCollect(params: {
    usdt: number;
    native: number;
    threshold: number;
    requiredGas?: number;
    gasLimit?: string;
    gasPriceGwei?: number;
  }) {
    const usdt = Number(params.usdt) || 0;
    const native = Number(params.native) || 0;
    const threshold = Number(params.threshold) || 0;
    const amountOk = usdt >= threshold && usdt > 0;
    const requiredGas = amountOk ? Number(params.requiredGas) || 0 : 0;
    const gasOk = !amountOk || this.coversNativeGas(native, requiredGas);
    const gasDeficit = gasOk ? 0 : Math.max(0, requiredGas - native);
    const fundSuggest =
      amountOk && gasDeficit > 0 ? Math.max(requiredGas * 1.5 - native, 0.00005) : 0;
    let skipReason: string | null = null;
    if (!amountOk) skipReason = `USDT 未达阈值(${threshold})`;
    else if (!gasOk) {
      skipReason = `Gas 不足(需≈${requiredGas.toFixed(6)} ETH, 有 ${native.toFixed(6)}, 建议补 ${fundSuggest.toFixed(6)})`;
    }
    return {
      usdt,
      native,
      requiredGas,
      gasDeficit,
      fundSuggest,
      gasLimit: amountOk ? String(params.gasLimit || '0') : '0',
      gasPriceGwei: amountOk ? Number(params.gasPriceGwei) || 0 : 0,
      amountOk,
      gasOk,
      collectable: amountOk && gasOk,
      skipReason,
    };
  }

  /**
   * 热钱包转 USDT 到目标地址
   * @returns txHash
   */
  async sendUsdtFromHot(params: {
    chain: string;
    toAddress: string;
    amount: number | string;
  }): Promise<{ txHash: string; from: string; chain: DepositChain; blockNumber?: number }> {
    const chain = this.resolveChain(params.chain);
    if (!isAddress(params.toAddress)) throw new Error('无效收款地址');
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('无效金额');

    const cfg = DEPOSIT_CHAINS[chain];
    const wallet = this.hotWallet(chain);
    const contract = this.usdtContract(chain, wallet);
    const units = parseUnits(amount.toFixed(cfg.decimals), cfg.decimals);

    const hotBal = await contract.balanceOf(wallet.address);
    if (hotBal < units) {
      throw new Error(
        `热钱包 USDT 不足: 需要 ${amount}, 余额 ${formatUnits(hotBal, cfg.decimals)} (${wallet.address})`,
      );
    }

    this.logger.log(`热钱包打款 ${amount} USDT → ${params.toAddress} on ${chain}`);
    const tx = await contract.transfer(getAddress(params.toAddress), units);
    const receipt = await tx.wait();
    const txHash = receipt?.hash || tx.hash;
    const blockNumber = receipt?.blockNumber != null ? Number(receipt.blockNumber) : undefined;
    this.logger.log(`打款成功 tx=${txHash} block=${blockNumber ?? '?'}`);
    return { txHash, from: wallet.address, chain, blockNumber };
  }

  /**
   * 从用户充值地址转 USDT 到归集目标 (需私钥明文)
   * 失败时抛出带 gasRequired/gasHave/gasDeficit/gasLost/txHash 的 Error，便于写入归集失败记录
   */
  async sendUsdtFromPrivateKey(params: {
    chain: string;
    privateKey: string;
    toAddress: string;
    amount: number | string;
    /** 复用扫描时的 gasPrice，避免再拉一次 fee */
    gasPrice?: bigint;
  }): Promise<{ txHash: string; from: string }> {
    const chain = this.resolveChain(params.chain);
    if (!isAddress(params.toAddress)) throw new Error('无效归集目标地址');
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('无效金额');

    const cfg = DEPOSIT_CHAINS[chain];
    const wallet = new Wallet(params.privateKey, this.provider(chain));
    const contract = this.usdtContract(chain, wallet);
    const units = parseUnits(amount.toFixed(cfg.decimals), cfg.decimals);

    const bal = await contract.balanceOf(wallet.address);
    if (bal < units) {
      throw this.collectionFailError(
        `地址 USDT 余额不足: ${formatUnits(bal, cfg.decimals)} < ${amount}`,
        { gasLost: 0 },
      );
    }

    // 轻量复查：USDT balanceOf + native + estimate（不再走完整 canCollectWallet）
    const nativeBefore = await this.getNativeBalance(chain, wallet.address);
    const est = await this.estimateTransferGasNative(
      chain,
      wallet.address,
      params.toAddress,
      amount,
      params.gasPrice,
    );
    const requiredGas = est.requiredNative;
    const gasDeficit = Math.max(0, requiredGas - nativeBefore);
    if (!this.coversNativeGas(nativeBefore, requiredGas)) {
      throw this.collectionFailError(
        `Gas 不足(需≈${requiredGas.toFixed(6)} ETH, 有 ${nativeBefore.toFixed(6)})`,
        { gasRequired: requiredGas, gasHave: nativeBefore, gasDeficit, gasLost: 0 },
      );
    }

    let txHash: string | undefined;
    try {
      const tx = await contract.transfer(getAddress(params.toAddress), units);
      txHash = tx.hash;
      const receipt = await tx.wait();
      if (receipt && Number(receipt.status) === 0) {
        const gasLost =
          this.gasLostFromReceipt(receipt) ??
          Math.max(0, nativeBefore - (await this.getNativeBalance(chain, wallet.address)));
        throw this.collectionFailError(
          `链上交易失败(reverted)${txHash ? ` tx=${txHash}` : ''}`,
          {
            gasRequired: requiredGas,
            gasHave: nativeBefore,
            gasDeficit,
            gasLost,
            txHash,
          },
        );
      }
      return { txHash: receipt?.hash || tx.hash, from: wallet.address };
    } catch (e: any) {
      if (e?.gasRequired != null || e?.code === 'COLLECTION_FAIL') throw e;
      const nativeAfter = await this.getNativeBalance(chain, wallet.address).catch(() => nativeBefore);
      const fromReceipt = this.gasLostFromReceipt(e?.receipt);
      const gasLost =
        fromReceipt != null ? fromReceipt : Math.max(0, nativeBefore - nativeAfter);
      const msg =
        e?.shortMessage ||
        e?.reason ||
        e?.info?.error?.message ||
        e?.message ||
        '归集发送失败';
      throw this.collectionFailError(String(msg), {
        gasRequired: requiredGas,
        gasHave: nativeBefore,
        gasDeficit: Math.max(0, requiredGas - nativeBefore),
        gasLost,
        txHash: txHash || e?.transactionHash || e?.receipt?.hash,
      });
    }
  }

  private gasLostFromReceipt(receipt: any): number | null {
    if (!receipt?.gasUsed) return null;
    const used = BigInt(receipt.gasUsed.toString());
    const price =
      receipt.gasPrice != null
        ? BigInt(receipt.gasPrice.toString())
        : receipt.effectiveGasPrice != null
          ? BigInt(receipt.effectiveGasPrice.toString())
          : null;
    if (price == null) return null;
    return Number(formatUnits(used * price, 18));
  }

  collectionFailError(
    message: string,
    extra: {
      gasRequired?: number;
      gasHave?: number;
      gasDeficit?: number;
      gasLost?: number;
      txHash?: string;
    } = {},
  ): Error {
    const err: any = new Error(message);
    err.code = 'COLLECTION_FAIL';
    if (extra.gasRequired != null) err.gasRequired = extra.gasRequired;
    if (extra.gasHave != null) err.gasHave = extra.gasHave;
    if (extra.gasDeficit != null) err.gasDeficit = extra.gasDeficit;
    if (extra.gasLost != null) err.gasLost = extra.gasLost;
    if (extra.txHash) err.txHash = extra.txHash;
    return err;
  }
}
