import { HttpException, HttpStatus } from '@nestjs/common';

/** 链上余额查询：每管理员 30 秒内最多 8 次（含翻页/进页，防连点打爆 RPC） */
const WINDOW_MS = 30_000;
const MAX_PER_WINDOW = 8;
const hits = new Map<string, number[]>();

export function assertOnChainBalanceQuery(actorId: string) {
  const key = actorId || 'anon';
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    const wait = Math.max(1, Math.ceil((arr[0] + WINDOW_MS - now) / 1000));
    throw new HttpException(
      { message: `链上查询过于频繁，请 ${wait} 秒后再试`, retryAfter: wait },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  arr.push(now);
  hits.set(key, arr);
}
