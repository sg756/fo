import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** 8 位纯数字邀请码 */
export function genNumericInviteCode(length = 8): string {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, '0');
}

export function isNumericInviteCode(code: string | null | undefined): boolean {
  return !!code && /^\d{6,12}$/.test(code.trim());
}

/** 分配库内唯一的纯数字邀请码 */
export async function allocUniqueInviteCode(
  prisma: PrismaService,
  length = 8,
): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const inviteCode = genNumericInviteCode(length);
    const dup = await prisma.user.findUnique({ where: { inviteCode } });
    if (!dup) return inviteCode;
  }
  // 极端碰撞: 加长到 10 位
  for (let i = 0; i < 8; i++) {
    const inviteCode = genNumericInviteCode(10);
    const dup = await prisma.user.findUnique({ where: { inviteCode } });
    if (!dup) return inviteCode;
  }
  return `${Date.now()}`.slice(-10);
}
