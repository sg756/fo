import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class NoticeService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, input: { title: string; body: string; kind?: string }) {
    return this.prisma.userNotice.create({
      data: {
        userId,
        title: input.title,
        body: input.body,
        kind: input.kind || 'point_low',
      },
      select: { id: true },
    });
  }

  /**
   * 这次登录之前就已经在的未读消息，登录满 1 天还没点开，标成已读。
   * 登录之后新到的消息继续显示红点，直到点开或下一次登录再满 1 天。
   */
  private async expireAfterLogin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lastLoginAt: true },
    });
    const loginAt = user?.lastLoginAt;
    if (!loginAt) return;
    if (Date.now() < loginAt.getTime() + DAY_MS) return;
    await this.prisma.userNotice.updateMany({
      where: { userId, readAt: null, createdAt: { lte: loginAt } },
      data: { readAt: new Date() },
    });
  }

  async list(userId: string) {
    await this.expireAfterLogin(userId);
    const items = await this.prisma.userNotice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, title: true, body: true, kind: true, readAt: true, createdAt: true },
    });
    const unread = items.filter((it) => !it.readAt).length;
    return {
      unread,
      items: items.map((it) => ({
        id: it.id,
        title: it.title,
        body: it.body,
        kind: it.kind,
        read: !!it.readAt,
        createdAt: it.createdAt,
      })),
    };
  }

  async unreadCount(userId: string) {
    await this.expireAfterLogin(userId);
    const unread = await this.prisma.userNotice.count({ where: { userId, readAt: null } });
    return { unread };
  }

  async markRead(userId: string, id: string) {
    const row = await this.prisma.userNotice.findFirst({
      where: { id, userId },
      select: { id: true, readAt: true },
    });
    if (!row) throw new NotFoundException('消息不存在');
    if (!row.readAt) {
      await this.prisma.userNotice.update({ where: { id }, data: { readAt: new Date() } });
    }
    return { ok: true };
  }
}
