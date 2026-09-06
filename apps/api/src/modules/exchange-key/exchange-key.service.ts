import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt, mask } from '../../common/crypto.util';

const NEED_PASSPHRASE: Exchange[] = ['OKX', 'BITGET'];

export function exchangeNeedsPassphrase(exchange: Exchange): boolean {
  return NEED_PASSPHRASE.includes(exchange);
}

export function isExchangeKeyComplete(exchange: Exchange, hasPassphrase: boolean): boolean {
  if (exchangeNeedsPassphrase(exchange) && !hasPassphrase) return false;
  return true;
}

/** 是否具备下单/查余额资格：Key+Secret 非空；OKX/Bitget 还须非空 Passphrase */
export function isExchangeKeyRowComplete(k: {
  exchange: Exchange;
  encApiKey?: string | null;
  encApiSecret?: string | null;
  encPassphrase?: string | null;
}): boolean {
  if (!k.encApiKey || !k.encApiSecret) return false;
  if (!exchangeNeedsPassphrase(k.exchange)) return true;
  // 加密串存在但解密后为空/空白 → 仍视为不完整，不得打中间件
  if (!k.encPassphrase) return false;
  try {
    return decrypt(k.encPassphrase).trim().length > 0;
  } catch {
    return false;
  }
}

@Injectable()
export class ExchangeKeyService {
  constructor(private prisma: PrismaService) {}

  async upsert(
    userId: string,
    data: {
      exchange: Exchange;
      apiKey: string;
      apiSecret: string;
      passphrase?: string;
      label?: string;
    },
  ) {
    if (NEED_PASSPHRASE.includes(data.exchange) && !String(data.passphrase || '').trim()) {
      throw new BadRequestException(`${data.exchange} 需要填写 passphrase`);
    }
    const apiKey = String(data.apiKey || '').trim();
    const apiSecret = String(data.apiSecret || '').trim();
    if (!apiKey) throw new BadRequestException('请填写 API Key');
    if (!apiSecret) throw new BadRequestException('请填写 API Secret');

    const label = data.label || 'default';
    const row = await this.prisma.exchangeKey.upsert({
      where: { userId_exchange_label: { userId, exchange: data.exchange, label } },
      create: {
        userId,
        exchange: data.exchange,
        label,
        encApiKey: encrypt(apiKey),
        encApiSecret: encrypt(apiSecret),
        encPassphrase: data.passphrase ? encrypt(data.passphrase) : null,
      },
      update: {
        encApiKey: encrypt(apiKey),
        encApiSecret: encrypt(apiSecret),
        encPassphrase: data.passphrase ? encrypt(data.passphrase) : null,
        active: true,
      },
    });
    // 不回传密文/密文存储字段
    return {
      id: row.id,
      exchange: row.exchange,
      label: row.label,
      apiKeyMasked: mask(apiKey),
      hasPassphrase: !!row.encPassphrase,
      configured: isExchangeKeyComplete(row.exchange, !!row.encPassphrase),
      active: row.active,
      createdAt: row.createdAt,
      ok: true,
      message: '已保存',
    };
  }

  async listForUser(userId: string) {
    const items = await this.prisma.exchangeKey.findMany({ where: { userId } });
    return items.map((k) => {
      const hasPassphrase = !!k.encPassphrase;
      return {
        id: k.id,
        exchange: k.exchange,
        label: k.label,
        apiKeyMasked: mask(decrypt(k.encApiKey)),
        hasPassphrase,
        configured: isExchangeKeyRowComplete(k),
        active: k.active,
        createdAt: k.createdAt,
      };
    });
  }

  /** 启用且凭证完整（OKX/Bitget 必须有 passphrase）的 Key 数量 */
  async countComplete(userId: string) {
    const items = await this.prisma.exchangeKey.findMany({
      where: { userId, active: true },
      select: { exchange: true, encApiKey: true, encApiSecret: true, encPassphrase: true },
    });
    return items.filter((k) => isExchangeKeyRowComplete(k)).length;
  }

  /**
   * 仅返回可查余额/可下单的 Key。
   * 缺 Key/Secret，或 OKX/Bitget 缺 Passphrase → 不返回（调用方不得再去打中间件）。
   */
  async listCompleteKeys(userId: string) {
    const items = await this.prisma.exchangeKey.findMany({
      where: { userId, active: true },
      select: {
        exchange: true,
        label: true,
        encApiKey: true,
        encApiSecret: true,
        encPassphrase: true,
      },
      orderBy: { exchange: 'asc' },
    });
    return items
      .filter((k) => isExchangeKeyRowComplete(k))
      .map((k) => ({ exchange: k.exchange, label: k.label }));
  }

  /** 不完整 Key（有记录但缺 Passphrase 等），供管理端展示「已跳过」 */
  async listIncompleteKeys(userId: string) {
    const items = await this.prisma.exchangeKey.findMany({
      where: { userId, active: true },
      select: {
        exchange: true,
        label: true,
        encApiKey: true,
        encApiSecret: true,
        encPassphrase: true,
      },
      orderBy: { exchange: 'asc' },
    });
    return items
      .filter((k) => !isExchangeKeyRowComplete(k))
      .map((k) => {
        const reasons: string[] = [];
        if (!k.encApiKey) reasons.push('缺 API Key');
        if (!k.encApiSecret) reasons.push('缺 API Secret');
        if (exchangeNeedsPassphrase(k.exchange)) {
          let passOk = false;
          if (k.encPassphrase) {
            try {
              passOk = decrypt(k.encPassphrase).trim().length > 0;
            } catch {
              passOk = false;
            }
          }
          if (!passOk) reasons.push('缺 Passphrase');
        }
        return {
          exchange: k.exchange,
          label: k.label,
          reason: reasons.join('、') || '凭证不完整',
        };
      });
  }

  async remove(userId: string, id: string) {
    const k = await this.prisma.exchangeKey.findUnique({ where: { id } });
    if (!k || k.userId !== userId) throw new NotFoundException('Key 不存在');
    await this.prisma.exchangeKey.delete({ where: { id } });
    return { ok: true };
  }

  // 供下单模块使用: 返回明文(仅内部)
  async getDecrypted(userId: string, exchange: Exchange, label = 'default') {
    const k = await this.prisma.exchangeKey.findUnique({
      where: { userId_exchange_label: { userId, exchange, label } },
    });
    if (!k || !k.active) return null;
    if (!isExchangeKeyRowComplete(k)) return null;
    return {
      apiKey: decrypt(k.encApiKey),
      apiSecret: decrypt(k.encApiSecret),
      passphrase: k.encPassphrase ? decrypt(k.encPassphrase) : undefined,
    };
  }

  // 后台查看(脱敏)
  async listForAdmin(params: {
    userId?: string;
    q?: string;
    skip?: number;
    take?: number;
  }) {
    const { userId, q, skip = 0, take = 50 } = params;
    const where: any = {};
    if (userId?.trim()) {
      where.userId = userId.trim();
    } else if (q?.trim()) {
      const kw = q.trim();
      const userOr: any[] = [
        { email: { contains: kw } },
        { nickname: { contains: kw } },
        { id: kw },
      ];
      if (/^\d+$/.test(kw)) userOr.push({ userNo: Number(kw) });
      where.user = { OR: userOr };
    }
    const [rows, total] = await Promise.all([
      this.prisma.exchangeKey.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(Math.max(take, 1), 200),
        include: {
          user: { select: { email: true, nickname: true, userNo: true } },
        },
      }),
      this.prisma.exchangeKey.count({ where }),
    ]);
    return {
      items: rows.map((k) => ({
        id: k.id,
        userId: k.userId,
        userNo: k.user.userNo,
        nickname: k.user.nickname,
        email: k.user.email,
        exchange: k.exchange,
        label: k.label,
        apiKeyMasked: mask(decrypt(k.encApiKey)),
        hasPassphrase: !!k.encPassphrase,
        configured: isExchangeKeyComplete(k.exchange, !!k.encPassphrase),
        active: k.active,
        createdAt: k.createdAt,
      })),
      total,
    };
  }

  // 后台: 启用/禁用某 Key (禁用后不参与下单)
  async setActiveByAdmin(id: string, active: boolean) {
    const k = await this.prisma.exchangeKey.findUnique({ where: { id } });
    if (!k) throw new NotFoundException('Key 不存在');
    await this.prisma.exchangeKey.update({ where: { id }, data: { active } });
    return { id, active };
  }

  // 后台: 清除某 Key (用户需回 App 重新绑定)
  async removeByAdmin(id: string) {
    const k = await this.prisma.exchangeKey.findUnique({ where: { id } });
    if (!k) throw new NotFoundException('Key 不存在');
    await this.prisma.exchangeKey.delete({ where: { id } });
    return { ok: true };
  }
}
