import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NoticeService } from './notice.service';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const LOW_100 = 100;
const LOW_10 = 10;

type CardRow = {
  userId: string;
  balance: unknown;
  low100Notified: boolean;
  low10Notified: boolean;
  user: { pushTokens: { token: string }[] };
};

/**
 * 点卡跌破门槛推送：
 * - 同时低于 100 与 10（如新用户余额 0）→ 只推门槛更低的「低于 10」一条
 * - 仅低于 100 → 推「低于 100」
 * - 先前只推过 100、后来再跌破 10 → 再推「低于 10」
 * 回到门槛以上后清标记，下次再跌破才推。
 */
@Injectable()
export class PointAlertService {
  private readonly logger = new Logger(PointAlertService.name);

  constructor(
    private prisma: PrismaService,
    private notices: NoticeService,
  ) {}

  async registerToken(userId: string, rawToken: string, rawPlatform: string) {
    const token = String(rawToken || '').trim();
    const platform = String(rawPlatform || '').trim().toLowerCase();
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) {
      throw new BadRequestException('推送令牌无效');
    }
    if (platform !== 'ios' && platform !== 'android') {
      throw new BadRequestException('平台无效');
    }
    await this.prisma.devicePushToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    await this.syncUser(userId);
    return { ok: true };
  }

  async removeToken(userId: string, rawToken: string) {
    const token = String(rawToken || '').trim();
    if (!token) return { ok: true };
    await this.prisma.devicePushToken.deleteMany({ where: { userId, token } });
    return { ok: true };
  }

  /** 扫余额低于 100，或曾经推过、需要在充值后清标记的点卡 */
  async scan() {
    const cards = await this.prisma.pointCard.findMany({
      where: {
        user: { isPlatform: false },
        OR: [
          { balance: { lt: LOW_100 } },
          { low100Notified: true },
          { low10Notified: true },
        ],
      },
      select: {
        userId: true,
        balance: true,
        low100Notified: true,
        low10Notified: true,
        user: { select: { pushTokens: { select: { token: true } } } },
      },
    });
    for (const card of cards) {
      await this.apply(card);
    }
  }

  async syncUser(userId: string) {
    const card = await this.prisma.pointCard.findUnique({
      where: { userId },
      select: {
        userId: true,
        balance: true,
        low100Notified: true,
        low10Notified: true,
        user: { select: { isPlatform: true, pushTokens: { select: { token: true } } } },
      },
    });
    if (!card || card.user.isPlatform) return;
    await this.apply(card);
  }

  private async apply(card: CardRow) {
    const balance = Number(card.balance);
    if (!Number.isFinite(balance)) return;
    const below100 = balance < LOW_100;
    const below10 = balance < LOW_10;

    if (!below100) {
      if (card.low100Notified || card.low10Notified) {
        await this.prisma.pointCard.update({
          where: { userId: card.userId },
          data: { low100Notified: false, low10Notified: false },
        });
      }
      return;
    }

    if (!below10 && card.low10Notified) {
      await this.prisma.pointCard.update({
        where: { userId: card.userId },
        data: { low10Notified: false },
      });
      card.low10Notified = false;
    }

    const tokens = card.user.pushTokens.map((t) => t.token).filter(Boolean);

    // 同时低于两档：只发更严重的「低于 10」，并记上 100 档已处理，避免再发一条
    if (below10) {
      if (!card.low10Notified) {
        const claimed = await this.claimFlag(card.userId, 'low10Notified');
        if (claimed) {
          try {
            await this.notices.create(card.userId, {
              title: '点卡余额严重不足',
              body: `当前点卡 ${fmtAmt(balance)}，已低于 10，请尽快充值`,
              kind: 'point_low',
            });
            // 同时低于 100：只记 100 档已处理，不再另发「低于 100」
            if (!card.low100Notified) {
              await this.prisma.pointCard.update({
                where: { userId: card.userId },
                data: { low100Notified: true },
              });
              card.low100Notified = true;
            }
            card.low10Notified = true;
            if (tokens.length) {
              await this.sendExpo(tokens, {
                title: '点卡余额严重不足',
                body: `当前点卡 ${fmtAmt(balance)}，已低于 10，请尽快充值`,
                level: LOW_10,
              }).catch((e) => this.logger.warn(`点卡推送失败 user=${card.userId} level=10: ${e?.message || e}`));
            }
          } catch (e: any) {
            card.low10Notified = false;
            await this.prisma.pointCard
              .update({
                where: { userId: card.userId },
                data: { low10Notified: false },
              })
              .catch(() => undefined);
            this.logger.warn(`点卡消息写入失败 user=${card.userId}: ${e?.message || e}`);
          }
        }
      }
      return;
    }

    if (!card.low100Notified) {
      const claimed = await this.claimFlag(card.userId, 'low100Notified');
      if (claimed) {
        try {
          await this.notices.create(card.userId, {
            title: '点卡余额不足',
            body: `当前点卡 ${fmtAmt(balance)}，已低于 100，请及时充值`,
            kind: 'point_low',
          });
          card.low100Notified = true;
          if (tokens.length) {
            await this.sendExpo(tokens, {
              title: '点卡余额不足',
              body: `当前点卡 ${fmtAmt(balance)}，已低于 100，请及时充值`,
              level: LOW_100,
            }).catch((e) => this.logger.warn(`点卡推送失败 user=${card.userId} level=100: ${e?.message || e}`));
          }
        } catch (e: any) {
          card.low100Notified = false;
          await this.prisma.pointCard
            .update({ where: { userId: card.userId }, data: { low100Notified: false } })
            .catch(() => undefined);
          this.logger.warn(`点卡消息写入失败 user=${card.userId}: ${e?.message || e}`);
        }
      }
    }
  }

  private async claimFlag(userId: string, flag: 'low100Notified' | 'low10Notified') {
    const claimed = await this.prisma.pointCard.updateMany({
      where: { userId, [flag]: false },
      data: { [flag]: true },
    });
    return claimed.count === 1;
  }

  private async sendExpo(
    tokens: string[],
    msg: { title: string; body: string; level: number },
  ): Promise<boolean> {
    const messages = tokens.map((to) => ({
      to,
      title: msg.title,
      body: msg.body,
      sound: 'default',
      channelId: 'point-card',
      data: { type: 'point_low', level: msg.level },
    }));
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      this.logger.warn(`Expo 推送 HTTP ${res.status}`);
      return false;
    }
    const payload = (await res.json()) as {
      data?: { status?: string; details?: { error?: string } }[];
    };
    const tickets = Array.isArray(payload?.data) ? payload.data : [];
    const dead: string[] = [];
    let delivered = 0;
    tickets.forEach((ticket, i) => {
      if (ticket?.status === 'ok') {
        delivered += 1;
        return;
      }
      if (ticket?.details?.error === 'DeviceNotRegistered') {
        const token = tokens[i];
        if (token) dead.push(token);
      }
    });
    if (dead.length) {
      await this.prisma.devicePushToken.deleteMany({ where: { token: { in: dead } } });
    }
    return delivered > 0;
  }
}

function fmtAmt(n: number) {
  const s = n.toFixed(4).replace(/\.?0+$/, '');
  return s || '0';
}
