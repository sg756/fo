import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Wallet } from '@prisma/client';
import { HDNodeWallet, Mnemonic, getAddress, isAddress } from 'ethers';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt } from '../../common/crypto.util';
import { DepositChain, getEnabledDepositChains } from './chain.config';

const HD_INDEX_KEY = 'hd_next_index';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private prisma: PrismaService) {}

  private getMnemonic(): string {
    const m = process.env.HD_MNEMONIC?.trim();
    if (!m) {
      throw new BadRequestException(
        '未配置 HD_MNEMONIC，无法派生充值地址。请在 .env 中设置助记词。',
      );
    }
    return m;
  }

  private async nextDerivIndex(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.systemConfig.findUnique({ where: { key: HD_INDEX_KEY } });
      const current = row ? Number(row.value) : 0;
      const next = current + 1;
      await tx.systemConfig.upsert({
        where: { key: HD_INDEX_KEY },
        create: { key: HD_INDEX_KEY, value: String(next), remark: 'HD 派生下一索引' },
        update: { value: String(next) },
      });
      return current;
    });
  }

  /** 按 BIP44 派生: m/44'/60'/0'/0/{index} */
  deriveAt(index: number): { address: string; privateKey: string } {
    const mnemonic = Mnemonic.fromPhrase(this.getMnemonic());
    const path = `m/44'/60'/0'/0/${index}`;
    const wallet = HDNodeWallet.fromMnemonic(mnemonic, path);
    return { address: getAddress(wallet.address), privateKey: wallet.privateKey };
  }

  /**
   * 确保用户有平台托管充值地址 (资金归平台, 仅用于识别该用户的链上转入)。
   * EVM 同钥同址: 若用户已有任一 EVM 地址, 复用私钥/地址, 仅补一条 chain 记录。
   * BSC 与 ARB/ETH/BASE 是同一 0x 地址，Gas 在 BSC 上用 BNB。
   */
  async ensureUserWallet(userId: string, chain: DepositChain) {
    const existing = await this.prisma.wallet.findFirst({ where: { userId, chain } });
    if (existing) return existing;

    const sibling = await this.prisma.wallet.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (sibling) {
      try {
        return await this.prisma.wallet.create({
          data: {
            userId,
            chain,
            address: sibling.address,
            derivIndex: sibling.derivIndex,
            encPrivateKey: sibling.encPrivateKey,
          },
        });
      } catch (e) {
        this.rethrowWalletWrite(e);
      }
    }

    const index = await this.nextDerivIndex();
    const { address, privateKey } = this.deriveAt(index);
    this.logger.log(`为用户 ${userId} 派生充值地址 index=${index} ${address}`);
    try {
      return await this.prisma.wallet.create({
        data: {
          userId,
          chain,
          address,
          derivIndex: index,
          encPrivateKey: encrypt(privateKey),
        },
      });
    } catch (e) {
      this.rethrowWalletWrite(e);
    }
  }

  /** 旧库 UNIQUE(address) 会挡住同一 0x 的第二条链 */
  private rethrowWalletWrite(e: unknown): never {
    const code = (e as { code?: string })?.code;
    if (code === 'P2002') {
      throw new BadRequestException(
        '托管地址写不进去：数据表仍把地址设成全局唯一，BSC 与 ARB 是同一个地址，需要先去掉 wallets.address 的唯一索引',
      );
    }
    throw e;
  }

  /**
   * 已有托管地址的用户，补齐当前启用链（BSC 与 ARB 同一 0x）。
   * createIfMissing 时连第一条地址也派生出来。
   */
  async ensureEnabledChainWallets(userId: string, opts?: { createIfMissing?: boolean }): Promise<Wallet[]> {
    const any = await this.prisma.wallet.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!any && !opts?.createIfMissing) return [];
    const rows: Wallet[] = [];
    for (const chain of getEnabledDepositChains()) {
      rows.push(await this.ensureUserWallet(userId, chain));
    }
    return rows;
  }

  /** 给已有钱包的用户补上新启用链，供扫块识别 */
  async backfillEnabledChainWallets() {
    const chains = getEnabledDepositChains();
    const rows = await this.prisma.wallet.findMany({
      select: { userId: true, chain: true },
    });
    const byUser = new Map<string, Set<string>>();
    for (const row of rows) {
      let set = byUser.get(row.userId);
      if (!set) {
        set = new Set();
        byUser.set(row.userId, set);
      }
      set.add(row.chain);
    }
    let created = 0;
    for (const [userId, have] of byUser) {
      for (const chain of chains) {
        if (have.has(chain)) continue;
        await this.ensureUserWallet(userId, chain);
        created += 1;
      }
    }
    if (created > 0) {
      this.logger.log(`已为启用链补齐 ${created} 条托管地址`);
    }
    return created;
  }

  async findByAddress(address: string, chain?: DepositChain) {
    if (!isAddress(address)) return null;
    const checksum = getAddress(address);
    return this.prisma.wallet.findFirst({
      where: {
        ...(chain ? { chain } : {}),
        OR: [{ address: checksum }, { address: checksum.toLowerCase() }],
      },
      include: { user: { select: { id: true, email: true, status: true } } },
    });
  }

  /** 某条链上的托管地址（小写），供扫块过滤 */
  async listWatchAddresses(chain?: DepositChain): Promise<string[]> {
    const rows = await this.prisma.wallet.findMany({
      where: chain ? { chain } : undefined,
      select: { address: true },
    });
    return Array.from(new Set(rows.map((r) => r.address.toLowerCase())));
  }
}
