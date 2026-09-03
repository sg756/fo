/**
 * 工作线程与主线程共用：不含 Nest。
 * 大包 JSON 的正则 / parse / 盘口压缩都在 worker 里做，主线程只收结果。
 */

export function protectLargeIdsInJson(text: string): string {
  return String(text || '').replace(
    /"(orderID|orderId|apiBillID|clientBillID|clientOrderId|origClientOrderId)"\s*:\s*(\d{16,})/g,
    '"$1":"$2"',
  );
}

export function parseJsonPreservingLargeIds(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(protectLargeIdsInJson(text));
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/** [ts, askPx×n, askQty×n, bidPx×n, bidQty×n]，n=(len-1)/4 */
export function parseFirstLevelMidFromDepthValue(value: any): number | null {
  if (typeof value === 'number') {
    return value > 0 && Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return n > 0 && Number.isFinite(n) ? n : null;
  }
  if (!Array.isArray(value) || value.length < 5) return null;
  const rest = value.length - 1;
  if (rest % 4 !== 0) return null;
  const n = rest / 4;
  const ask = Number(value[1]);
  const bid = Number(value[1 + 2 * n]);
  if (ask > 0 && bid > 0) return (ask + bid) / 2;
  if (ask > 0) return ask;
  if (bid > 0) return bid;
  return null;
}

/** 全量 GetDepth 字典压成 key → 第一档中间价，避免把买卖档 clone 回主线程 */
export function compactDepthToMids(data: any): Record<string, number> {
  const root =
    data && typeof data === 'object' && !Array.isArray(data) && 'data' in data && !Array.isArray((data as any).data)
      ? (data as any).data
      : data;
  const out: Record<string, number> = {};
  if (!root || typeof root !== 'object' || Array.isArray(root)) return out;
  for (const [k, v] of Object.entries(root)) {
    const mid = parseFirstLevelMidFromDepthValue(v);
    if (mid && mid > 0) out[String(k).toUpperCase()] = mid;
  }
  return out;
}

export function stripEnvelopeKeepMeta(parsed: any, data: any) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in parsed) {
    return {
      success: parsed.success,
      httpCode: parsed.httpCode,
      message: parsed.message,
      errors: parsed.errors,
      data,
    };
  }
  return data;
}

export type MapiOffloadJob = {
  id: number;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  compact?: 'depth-mids' | null;
};

export type MapiOffloadReply = {
  id: number;
  ok: boolean;
  statusCode: number;
  bytes: number;
  parsed: any;
  error?: string;
};
