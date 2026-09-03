import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(params: {
    actorId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: any;
    ip?: string;
  }) {
    await this.prisma.auditLog.create({
      data: {
        actorId: params.actorId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        detail: params.detail ? JSON.stringify(params.detail) : null,
        ip: params.ip,
      },
    });
  }

  async list(params: { skip?: number; take?: number; action?: string }) {
    const { skip = 0, take = 50, action } = params;
    const where = action ? { action } : undefined;
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total };
  }
}
