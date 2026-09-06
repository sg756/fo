import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HDNodeWallet, Mnemonic, getAddress, isAddress } from 'ethers';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt } from '../../common/crypto.util';
import { DepositChain } from './chain.config';

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
   */
  async ensureUserWallet(userId: string, chain: DepositChain) {
    const existing = await this.prisma.wallet.findFirst({ where: { userId, chain } });
    if (existing) return existing;

    // 复用同用户其他链的钱包 (EVM 地址相同)
    const sibling = await this.prisma.wallet.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (sibling) {
      return this.prisma.wallet.create({
        data: {
          userId,
          chain,
          address: sibling.address,
          derivIndex: sibling.derivIndex,
          encPrivateKey: sibling.encPrivateKey,
        },
      });
    }

    const index = await this.nextDerivIndex();
    const { address, privateKey } = this.deriveAt(index);
    this.logger.log(`为用户 ${userId} 派生充值地址 index=${index} ${address}`);
    return this.prisma.wallet.create({
      data: {
        userId,
        chain,
        address,
        derivIndex: index,
        encPrivateKey: encrypt(privateKey),
      },
    });
  }

  async findByAddress(address: string) {
    if (!isAddress(address)) return null;
    const checksum = getAddress(address);
    return this.prisma.wallet.findFirst({
      where: {
        OR: [{ address: checksum }, { address: checksum.toLowerCase() }],
      },
      include: { user: { select: { id: true, email: true, status: true } } },
    });
  }

  /** 当前所有活跃充值地址 (小写), 供扫块过滤 */
  async listWatchAddresses(): Promise<string[]> {
    const rows = await this.prisma.wallet.findMany({ select: { address: true } });
    return Array.from(new Set(rows.map((r) => r.address.toLowerCase())));
  }
}
