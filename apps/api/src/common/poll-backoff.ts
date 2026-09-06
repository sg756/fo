/** 正常轮询默认 90s（1 分半） */
export const DEFAULT_POLL_MS = 90_000;
/** 无 Retry-After / reset 头时的兜底（各所另有更短默认，见 defaultBackoffMsForExchange） */
export const DEFAULT_BAN_BACKOFF_MS = 60_000;
/** 退避上限（防币安 418 给到数天把服务冻死；可用 env 调大） */
export const DEFAULT_BAN_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** 退避下限 */
export const DEFAULT_BAN_BACKOFF_MIN_MS = 5_000;

const BODY_LOG_MAX = 800;

/** 各所官方/实务默认等待（无响应头时） */
export function defaultBackoffMsForExchange(exchange?: string): number {
  switch (String(exchange || '').toUpperCase()) {
    case 'BINANCE':
      return 60_000; // 无 Retry-After 时；418 官方会给头，常见从 2min 起
    case 'BYBIT':
      return 10 * 60_000; // 官方：IP 过频至少等 10 分钟
    case 'OKX':
      return 5 * 60_000; // 官方未写死封禁时长，无头时保守 5min
    case 'GATE':
      return 5 * 60_000; // 无头限流保守 5min，避免连打
    case 'BITGET':
      return 5 * 60_000; // 无明确封禁分钟数，保守 5min
    case 'RPC':
    case 'DEPOSIT':
      return 5 * 60_000; // 链上公共 RPC 无标准头
    default:
      return DEFAULT_BAN_BACKOFF_MS;
  }
}

function clampBackoff(ms: number, minMs: number, maxMs: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return minMs;
  return Math.min(maxMs, Math.max(minMs, Math.floor(ms)));
}

/** 解析 Retry-After：秒数或 HTTP-date */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const sec = Number(raw);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return sec * 1000;
  }
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - now);
}

/** 从限流头解析「还要等多久」 */
export function parseResetHeaderMs(
  headers: Record<string, string> | null | undefined,
  now = Date.now(),
): number | null {
  if (!headers) return null;
  const entries = Object.entries(headers);
  for (const [key, value] of entries) {
    const k = key.toLowerCase();
    const v = String(value || '').trim();
    if (!v) continue;
    if (k === 'retry-after') {
      const ms = parseRetryAfterMs(v, now);
      if (ms != null) return ms;
      continue;
    }
    // Bybit: X-Bapi-Limit-Reset-Timestamp（毫秒）
    // Gate: x-gate-ratelimit-reset-timestamp（秒）
    if (k.includes('reset') && /^\d+$/.test(v)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      // 10 位≈秒，13 位≈毫秒
      const abs = n < 1e12 ? n * 1000 : n;
      if (abs > now - 60_000 && abs < now + 7 * 24 * 3600_000) {
        return Math.max(0, abs - now);
      }
    }
  }
  return null;
}

/** 币安文案：IP banned until <ms> */
function parseBannedUntilMs(text: string, now = Date.now()): number | null {
  const m = text.match(/banned until\s+(\d{10,16})/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 1e12) n *= 1000;
  return Math.max(0, n - now);
}

/**
 * 计算退避毫秒：优先 Retry-After / reset 头 / banned until，否则按所默认。
 * 结果夹在 min～max（默认 5s～30min）。
 */
export function resolveBackoffMs(
  err: unknown,
  opts?: {
    exchange?: string;
    minMs?: number;
    maxMs?: number;
    /** 覆盖各所默认；仍可被响应头覆盖 */
    fallbackMs?: number;
  },
): { ms: number; reason: string } {
  const minMs = Math.max(
    1_000,
    Number(opts?.minMs ?? (process.env.MARKET_BAN_BACKOFF_MIN_MS || DEFAULT_BAN_BACKOFF_MIN_MS)),
  );
  const maxMs = Math.max(
    minMs,
    Number(opts?.maxMs ?? (process.env.MARKET_BAN_BACKOFF_MAX_MS || DEFAULT_BAN_BACKOFF_MAX_MS)),
  );
  const ex = opts?.exchange;
  // MARKET_BAN_BACKOFF_MS 若配置则作为「无响应头时的统一兜底」；否则按所区分
  const envFallback = process.env.MARKET_BAN_BACKOFF_MS;
  const fallback = Math.max(
    minMs,
    Number(
      opts?.fallbackMs ??
        (envFallback && String(envFallback).trim() !== ''
          ? envFallback
          : defaultBackoffMsForExchange(ex)),
    ),
  );

  const e = err as any;
  const now = Date.now();
  const headers: Record<string, string> | undefined = e?.rateHeaders || e?.raw?.rateHeaders;
  const retryAfter = e?.retryAfter ?? e?.raw?.retryAfter ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
  const body = String(e?.bodySnippet || e?.raw?.body || e?.message || '');

  const fromRetry = parseRetryAfterMs(retryAfter != null ? String(retryAfter) : null, now);
  if (fromRetry != null) {
    const ms = clampBackoff(fromRetry, minMs, maxMs);
    return { ms, reason: `Retry-After→${ms}ms` };
  }

  const fromReset = parseResetHeaderMs(headers, now);
  if (fromReset != null && fromReset > 0) {
    const ms = clampBackoff(fromReset, minMs, maxMs);
    return { ms, reason: `reset头→${ms}ms` };
  }

  const fromBanUntil = parseBannedUntilMs(body, now);
  if (fromBanUntil != null && fromBanUntil > 0) {
    const ms = clampBackoff(fromBanUntil, minMs, maxMs);
    return { ms, reason: `banned-until→${ms}ms` };
  }

  // 币安 418 无头时至少按官方下限 2 分钟
  const status = Number(e?.status ?? e?.statusCode ?? 0);
  if (status === 418 && String(ex || '').toUpperCase() === 'BINANCE') {
    const ms = clampBackoff(Math.max(fallback, 120_000), minMs, maxMs);
    return { ms, reason: `BINANCE-418默认→${ms}ms` };
  }

  const ms = clampBackoff(fallback, minMs, maxMs);
  return { ms, reason: `${ex || 'default'}默认→${ms}ms` };
}

/**
 * 是否应进入封禁/限流退避。
 *
 * 仅认明确限流/封禁信号，避免把偶发超时、502、鉴权失败误当成封 IP：
 * - HTTP 418：币安等「继续打 429 后自动封 IP」
 * - HTTP 429：限流（币安会带 Retry-After）
 * - 文案明确含 rate limit / too many / banned / ip ban 等
 *
 * 不认：403（常是 Key/权限，除非 body 写明限流）、503、timeout —— 仍按正常轮询重试。
 * 退避时长见 resolveBackoffMs（优先响应头，否则按所默认）。
 */
export function isAccessBlockedError(err: unknown): boolean {
  const status = Number((err as any)?.status ?? (err as any)?.statusCode ?? 0);
  if (status === 418 || status === 429) return true;

  const msg = String((err as any)?.message || err || '').toLowerCase();
  const body = String(
    (err as any)?.bodySnippet || (err as any)?.raw?.body || (err as any)?.body || '',
  ).toLowerCase();
  const text = `${msg} ${body}`.trim();
  if (!text) return false;

  // 错误串 / 响应体里带状态码
  if (/\b418\b/.test(text) || /\b429\b/.test(text)) return true;

  // Bybit 等常见用 403 + body「Too many visits / Rate Limit」，不能只看 HTTP 码
  return /rate.?limit|too many requests|too many visits|too_many_requests|ip.?ban|auto-?ban|\bbanned\b|temporarily banned|request weight|50011/.test(
    text,
  );
}

/** 各所 HTTP 200 但业务码表示限流/封禁时，构造成可退避错误 */
export function businessRateLimitFromJson(
  exchange: string,
  json: any,
  bodyText?: string,
): Error | null {
  if (json == null || typeof json !== 'object') return null;
  const ex = String(exchange || '').toUpperCase();
  let hit = false;
  let detail = '';

  if (ex === 'OKX') {
    const code = String((json as any).code ?? '');
    const msg = String((json as any).msg ?? '');
    if (code === '50011' || /rate.?limit|too many/i.test(msg)) {
      hit = true;
      detail = `code=${code} msg=${msg}`;
    }
  } else if (ex === 'BYBIT') {
    const code = Number((json as any).retCode ?? 0);
    const msg = String((json as any).retMsg ?? '');
    if (code === 10006 || /too many|rate.?limit/i.test(msg)) {
      hit = true;
      detail = `retCode=${code} retMsg=${msg}`;
    }
  } else if (ex === 'BITGET') {
    const code = String((json as any).code ?? '');
    const msg = String((json as any).msg ?? '');
    if (code === '429' || /too many|rate.?limit/i.test(msg)) {
      hit = true;
      detail = `code=${code} msg=${msg}`;
    }
  } else if (ex === 'GATE') {
    const label = String((json as any).label ?? '');
    const msg = String((json as any).message ?? '');
    if (label === 'TOO_MANY_REQUESTS' || /rate.?limit|too many/i.test(msg)) {
      hit = true;
      detail = `label=${label} message=${msg}`;
    }
  } else if (ex === 'BINANCE' || ex.startsWith('BINANCE')) {
    const code = Number((json as any).code ?? 0);
    const msg = String((json as any).msg ?? '');
    if (code === -1003 || /banned|too many|request weight|rate.?limit/i.test(msg)) {
      hit = true;
      detail = `code=${code} msg=${msg}`;
    }
  }

  if (!hit) return null;
  const body = truncateRaw(bodyText || JSON.stringify(json));
  const err: any = new Error(`${ex} business rate-limit ${detail}`.trim());
  err.status = 429;
  err.bodySnippet = body;
  err.raw = { exchange: ex, status: 429, business: true, detail, body };
  return err;
}

/** 从 Response 抽出限流相关头（币安等） */
export function pickRateLimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (
      k === 'retry-after' ||
      k.startsWith('x-mbx-') ||
      k.startsWith('x-bapi-') ||
      k.startsWith('ok-access-') ||
      k.includes('rate') ||
      k.includes('limit') ||
      k.includes('weight')
    ) {
      out[key] = value;
    }
  });
  return out;
}

export function truncateRaw(text: string, max = BODY_LOG_MAX): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/**
 * 构造带原始现场的 HTTP 错误（status / Retry-After / 限流头 / body 片段）。
 * 调用方应先读完 body 再传入 bodyText。
 */
export async function httpErrorFromResponse(
  res: Response,
  label: string,
  opts?: { bodyText?: string; url?: string },
): Promise<Error> {
  let bodyText = opts?.bodyText;
  if (bodyText == null) {
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
  }
  const retryAfter = res.headers.get('retry-after');
  const rateHeaders = pickRateLimitHeaders(res.headers);
  const bodySnippet = truncateRaw(bodyText || '');
  const suffix = retryAfter ? ` Retry-After=${retryAfter}` : '';
  const err: any = new Error(`${label} HTTP ${res.status}${suffix}`);
  err.status = res.status;
  err.retryAfter = retryAfter;
  err.url = opts?.url || res.url || undefined;
  err.rateHeaders = rateHeaders;
  err.bodySnippet = bodySnippet;
  err.raw = {
    url: err.url,
    status: res.status,
    statusText: res.statusText,
    retryAfter,
    rateHeaders,
    body: bodySnippet,
  };
  return err;
}

/** @deprecated 优先用 httpErrorFromResponse，保留兼容 */
export function attachHttpError(status: number, label: string, retryAfter?: string | null): Error {
  const suffix = retryAfter ? ` Retry-After=${retryAfter}` : '';
  const err: any = new Error(`${label} HTTP ${status}${suffix}`);
  err.status = status;
  if (retryAfter) err.retryAfter = retryAfter;
  err.raw = { status, retryAfter };
  return err;
}

/** 把错误展成一行可检索的原始现场 JSON */
export function formatErrorRaw(err: unknown): string {
  const e = err as any;
  if (!e) return '';
  if (e.raw && typeof e.raw === 'object') {
    try {
      return JSON.stringify(e.raw);
    } catch {
      /* fallthrough */
    }
  }
  const payload: Record<string, unknown> = {
    message: e.message || String(err),
  };
  if (e.status != null) payload.status = e.status;
  if (e.statusCode != null) payload.statusCode = e.statusCode;
  if (e.code != null) payload.code = e.code;
  if (e.retryAfter != null) payload.retryAfter = e.retryAfter;
  if (e.url) payload.url = e.url;
  if (e.rateHeaders) payload.rateHeaders = e.rateHeaders;
  if (e.bodySnippet) payload.body = e.bodySnippet;
  if (e.info) payload.info = e.info;
  if (e.error) payload.error = truncateRaw(String(e.error?.message || e.error), 400);
  if (e.shortMessage) payload.shortMessage = e.shortMessage;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(e.message || err);
  }
}

/** ethers / RPC 错误尽量保留原始字段 */
export function enrichRpcError(err: unknown, ctx: Record<string, unknown>): Error {
  const src = err as any;
  const msg = src?.shortMessage || src?.message || String(err);
  const out: any = new Error(msg);
  out.status = src?.status ?? src?.statusCode;
  out.code = src?.code;
  out.info = src?.info;
  out.error = src?.error;
  out.shortMessage = src?.shortMessage;
  out.raw = {
    ...ctx,
    message: msg,
    code: src?.code,
    status: src?.status ?? src?.statusCode,
    shortMessage: src?.shortMessage,
    info: src?.info,
    error: src?.error
      ? truncateRaw(typeof src.error === 'string' ? src.error : JSON.stringify(src.error), 600)
      : undefined,
    stack: typeof src?.stack === 'string' ? truncateRaw(src.stack, 400) : undefined,
  };
  return out;
}
