import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '../../common/auth-role';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsArray } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { AuditService } from '../../common/audit.service';
import { CollectionService } from './collection.service';
import { AdminTotpService } from './admin-totp.service';
import { assertOnChainBalanceQuery } from '../../common/onchain-query.limiter';

class CollectionConfigDto {
  @IsOptional() @IsString() chain?: string;
  @IsString() targetAddress: string;
  @IsOptional() @IsNumber() threshold?: number;
  @IsOptional() @IsString() gasAddress?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class CollectionAddressDto {
  @IsOptional() @IsString() chain?: string;
  @IsString() address: string;
  @IsOptional() @IsString() label?: string;
}

class GasWalletDto {
  @IsOptional() @IsString() chain?: string;
  @IsString() gasAddress: string;
  @IsString() privateKey: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsBoolean() setActive?: boolean;
}

class FundGasDto {
  @IsOptional() @IsString() chain?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) walletIds?: string[];
}

class GasFeeTierDto {
  @IsIn(['standard', 'fast'])
  tier: 'standard' | 'fast';
}

class HotWalletTransferDto {
  @IsString() token: string; // USDT | ETH
  @IsString() toAddress: string;
  @IsNumber() amount: number;
  @IsString() totpCode: string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/wallet')
export class WalletAdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private collection: CollectionService,
    private totp: AdminTotpService,
  ) {}

  @Get('collection-config')
  configs() {
    return this.collection.listConfigs();
  }

  /** 保存归集指定地址 (必填有效目标地址) */
  @Post('collection-config')
  async upsertConfig(@Body() dto: CollectionConfigDto, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.saveTargetConfig({
      chain: dto.chain || 'ARB',
      targetAddress: dto.targetAddress,
      threshold: dto.threshold,
      gasAddress: dto.gasAddress,
      active: dto.active,
      actorId,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_CONFIG_UPDATE',
      targetType: 'CollectionConfig',
      targetId: res.id,
      detail: { chain: res.chain, targetAddress: res.targetAddress, threshold: res.threshold },
    });
    return res;
  }

  @Get('collection-addresses')
  listAddresses(
    @Query('chain') chain?: string,
    @Query('withBalance') withBalance?: string,
    @CurrentUser('sub') actorId?: string,
  ) {
    const wantBal = withBalance === '1' || withBalance === 'true';
    if (wantBal) assertOnChainBalanceQuery(actorId || '');
    return this.collection.listAddresses(chain, wantBal);
  }

  @Post('collection-addresses')
  async addAddress(@Body() dto: CollectionAddressDto, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.addAddress({
      chain: dto.chain,
      address: dto.address,
      label: dto.label,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_ADDRESS_ADD',
      targetType: 'CollectionAddress',
      targetId: res.id,
      detail: { chain: res.chain, address: res.address },
    });
    return res;
  }

  @Post('collection-addresses/:id/update')
  async updateAddress(
    @Param('id') id: string,
    @Body() dto: { address?: string; label?: string },
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.collection.updateAddress({
      id,
      address: dto.address,
      label: dto.label,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_ADDRESS_UPDATE',
      targetType: 'CollectionAddress',
      targetId: id,
      detail: { address: res.address, label: res.label },
    });
    return res;
  }

  @Delete('collection-addresses/:id')
  async deleteAddress(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.deleteAddress(id);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_ADDRESS_DELETE',
      targetType: 'CollectionAddress',
      targetId: id,
    });
    return res;
  }

  /** 将地址簿中的地址设为当前归集目标 */
  @Post('collection-addresses/:id/select')
  async selectAddress(
    @Param('id') id: string,
    @Body() body: { threshold?: number },
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.collection.selectAddress({
      id,
      actorId,
      threshold: body?.threshold,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_ADDRESS_SELECT',
      targetType: 'CollectionConfig',
      targetId: res.id,
      detail: { targetAddress: res.targetAddress, chain: res.chain },
    });
    return res;
  }

  /** 平台热钱包地址簿；discarded=1 查废弃（已逻辑删除）列表 */
  @Get('collection-gas-wallets')
  listGasWallets(
    @Query('chain') chain?: string,
    @Query('withBalance') withBalance?: string,
    @Query('discarded') discarded?: string,
    @CurrentUser('sub') actorId?: string,
  ) {
    const wantBal = withBalance === '1' || withBalance === 'true';
    if (wantBal) assertOnChainBalanceQuery(actorId || '');
    return this.collection.listGasWallets(
      chain,
      wantBal,
      discarded === '1' || discarded === 'true',
    );
  }

  @Post('collection-gas-wallets')
  async addGasWallet(
    @Body() dto: GasWalletDto & { label?: string; setActive?: boolean },
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.collection.addGasWallet({
      chain: dto.chain || 'ARB',
      address: dto.gasAddress,
      label: dto.label,
      privateKey: dto.privateKey,
      actorId,
      setActive: dto.setActive,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_ADD',
      targetType: 'CollectionGasWallet',
      targetId: res.id,
      detail: { chain: res.chain, address: res.address },
    });
    return res;
  }

  /** 服务端一键创建 Gas 热钱包（返回明文私钥供备份） */
  @Post('collection-gas-wallets/create')
  async createGasWallet(
    @Body() dto: { chain?: string; label?: string; setActive?: boolean },
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.collection.createGasWallet({
      chain: dto.chain || 'ARB',
      label: dto.label,
      actorId,
      setActive: dto.setActive,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_CREATE',
      targetType: 'CollectionGasWallet',
      targetId: res.id,
      detail: { chain: res.chain, address: res.address },
    });
    return res;
  }

  /** 查看 Gas 热钱包私钥 */
  @Post('collection-gas-wallets/:id/reveal-key')
  async revealGasWalletKey(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.revealGasWalletPrivateKey(id);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_REVEAL_KEY',
      targetType: 'CollectionGasWallet',
      targetId: id,
      detail: { address: res.address },
    });
    return res;
  }

  @Post('collection-gas-wallets/:id/update')
  async updateGasWallet(
    @Param('id') id: string,
    @Body() dto: { address?: string; label?: string; privateKey?: string },
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.collection.updateGasWallet({
      id,
      address: dto.address,
      label: dto.label,
      privateKey: dto.privateKey,
      actorId,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_UPDATE',
      targetType: 'CollectionGasWallet',
      targetId: id,
      detail: { address: res.address },
    });
    return res;
  }

  @Delete('collection-gas-wallets/:id')
  async deleteGasWallet(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.discardGasWallet(id);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_DELETE',
      targetType: 'CollectionGasWallet',
      targetId: id,
      detail: { discarded: true },
    });
    return res;
  }

  @Post('collection-gas-wallets/:id/restore')
  async restoreGasWallet(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.restoreGasWallet(id);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_RESTORE',
      targetType: 'CollectionGasWallet',
      targetId: id,
      detail: { address: res.address },
    });
    return res;
  }

  /** 仅废弃列表：物理删除（私钥从库中移除） */
  @Post('collection-gas-wallets/:id/purge')
  async purgeGasWallet(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.purgeGasWallet(id);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_PURGE',
      targetType: 'CollectionGasWallet',
      targetId: id,
    });
    return res;
  }

  @Post('collection-gas-wallets/:id/select')
  async selectGasWallet(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.applyGasWalletToConfig(id, actorId);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_SELECT',
      targetType: 'CollectionConfig',
      targetId: res.id,
      detail: { gasAddress: res.gasAddress },
    });
    return res;
  }

  /** 将平台钱包设为当前归集目标（写入地址簿） */
  @Post('collection-gas-wallets/:id/select-collection')
  async selectGasWalletAsCollection(
    @Param('id') id: string,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.collection.applyGasWalletAsCollectionTarget(id, actorId);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_SELECT_TARGET',
      targetType: 'CollectionConfig',
      targetId: res.id,
      detail: { targetAddress: res.targetAddress, chain: res.chain },
    });
    return res;
  }

  /** 托管热钱包转出（USDT/ETH），须 Google 验证码；仅 Gas 地址簿内钱包 */
  @Post('collection-gas-wallets/:id/transfer')
  async transferGasWallet(
    @Param('id') id: string,
    @Body() dto: HotWalletTransferDto,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.totp.assertValidCode(actorId, dto.totpCode);
    const token = String(dto.token || 'USDT').toUpperCase() === 'ETH' ? 'ETH' : 'USDT';
    const res = await this.collection.transferFromGasWallet({
      gasWalletId: id,
      token,
      toAddress: dto.toAddress,
      amount: Number(dto.amount),
      actorId,
    });
    await this.audit.log({
      actorId,
      action: 'HOT_WALLET_TRANSFER',
      targetType: 'CollectionGasWallet',
      targetId: id,
      detail: {
        token,
        amount: dto.amount,
        toAddress: dto.toAddress,
        txHash: (res as any).txHash,
        ok: (res as any).ok,
      },
    });
    return res;
  }

  /** 兼容：写入地址簿并设为当前 Gas 补给 */
  @Post('collection-gas-wallet')
  async saveGasWallet(@Body() dto: GasWalletDto, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.saveGasWallet({
      chain: dto.chain || 'ARB',
      gasAddress: dto.gasAddress,
      privateKey: dto.privateKey,
      actorId,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_WALLET_UPDATE',
      targetType: 'CollectionGasWallet',
      targetId: (res as any).id,
      detail: { address: (res as any).address || dto.gasAddress },
    });
    return res;
  }

  /** 批量给缺 Gas 的托管地址补 ETH */
  @Post('collection/fund-gas')
  async fundGas(@Body() dto: FundGasDto, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.fundGasBatch({
      chain: dto.chain,
      walletIds: dto.walletIds,
    });
    await this.audit.log({
      actorId,
      action: 'COLLECTION_FUND_GAS',
      targetType: 'CollectionConfig',
      detail: {
        chain: dto.chain,
        started: (res as any).started,
        message: (res as any).message,
      },
    });
    return res;
  }

  @Get('collection/gas-fee-tier')
  gasFeeTier() {
    return this.collection.getGasFeeTier().then((gasFeeTier) => ({ gasFeeTier }));
  }

  @Get('collection/gas-fee-preview')
  gasFeePreview(@Query('chain') chain?: string) {
    return this.collection.getGasFeeTierPreview(chain);
  }

  @Post('collection/gas-fee-tier')
  async setGasFeeTier(@Body() dto: GasFeeTierDto, @CurrentUser('sub') actorId: string) {
    const res = await this.collection.setGasFeeTier(dto.tier);
    await this.audit.log({
      actorId,
      action: 'COLLECTION_GAS_FEE_TIER',
      detail: res,
    });
    return res;
  }

  @Get('collection-records')
  async records(
    @Query('userNo') userNo?: string,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('token') token?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    const where: any = {};
    if (status) where.status = status;
    const tok = token?.trim().toUpperCase();
    if (tok === 'ETH') where.tokenSymbol = 'ETH';
    else if (tok === 'USDT') where.tokenSymbol = { not: 'ETH' };

    if (from || to) {
      where.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) where.createdAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(to.trim())) d.setHours(23, 59, 59, 999);
          where.createdAt.lte = d;
        }
      }
    }

    const userFilter: any = {};
    const no = userNo?.trim();
    if (no) {
      if (/^\d+$/.test(no)) userFilter.userNo = Number(no);
      else userFilter.id = no;
    }
    const acc = account?.trim();
    if (acc) {
      userFilter.OR = [
        { email: { contains: acc } },
        { nickname: { contains: acc } },
      ];
    }
    if (Object.keys(userFilter).length) {
      where.fromWallet = { user: userFilter };
    }

    const takeN = Math.min(Number(take) || 50, 200);
    const skipN = Number(skip) || 0;
    const [items, total] = await Promise.all([
      this.prisma.collectionRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipN,
        take: takeN,
        include: {
          fromWallet: {
            select: {
              address: true,
              chain: true,
              user: { select: { id: true, userNo: true, email: true, nickname: true } },
            },
          },
        },
      }),
      this.prisma.collectionRecord.count({ where }),
    ]);
    return { items, total };
  }

  @Get('collection/status')
  collectionStatus() {
    return this.collection.adminStatus();
  }

  /** 立即归集：后台异步执行，立即返回；进度见 collection/status.collectJob */
  @Post('collection/run')
  runCollection(@Body() dto: { chain?: string }) {
    return this.collection.startRun(dto?.chain);
  }

  /**
   * 用户托管钱包列表 + 链上 USDT/Gas 余额
   * filter=needGas|collectable
   */
  @Get('wallets')
  wallets(
    @Query('q') q?: string,
    @Query('chain') chain?: string,
    @Query('filter') filter?: string,
    @Query('withBalance') withBalance = '1',
    @Query('skip') skip = '0',
    @Query('take') take = '50',
    @CurrentUser('sub') actorId?: string,
  ) {
    if (withBalance === '0' || withBalance === 'false') {
      return this.prisma.wallet
        .findMany({
          where: {
            ...(chain ? { chain } : {}),
            ...(q ? { user: { email: { contains: q } } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          skip: Number(skip),
          take: Number(take),
          include: { user: { select: { email: true } } },
        })
        .then((items) => ({
          items: items.map((w) => ({
            id: w.id,
            email: w.user.email,
            chain: w.chain,
            address: w.address,
            hasPrivateKey: !!w.encPrivateKey,
            createdAt: w.createdAt,
          })),
          total: items.length,
        }));
    }
    assertOnChainBalanceQuery(actorId || '');
    return this.collection.listWalletsWithBalances({
      chain,
      q,
      filter,
      skip: Number(skip),
      take: Number(take),
    });
  }
}
