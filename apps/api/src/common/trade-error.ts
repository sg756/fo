/**
 * 从 Nest / 中间件异常中提取可读失败原因（供挂单失败、开仓失败展示）。
 */
export function formatTradeError(e: unknown): string {
  if (e == null) return '未知错误';
  if (typeof e === 'string') {
    const s = e.trim();
    return s || '未知错误';
  }

  const any = e as any;

  if (typeof any.getResponse === 'function') {
    try {
      const r = any.getResponse();
      // Nest 包装常是 { statusCode, message: "下单失败: …" }；先剥 PlaceOrder 源因
      const placeFromResp = extractPlaceOrderFailReason(r);
      if (placeFromResp) return placeFromResp;
      const fromResp = pickMessage(r);
      if (fromResp) return fromResp;
    } catch {
      /* ignore */
    }
  }

  const body = any.responseBody ?? any.response?.data ?? any.data;
  // PlaceOrder 文档：外层信封常 success=true / message=Success，
  // 业务失败在 data.successed=false，失败原因写在 data.orderID（成功时 orderID 才是订单号）。
  const placeFail = extractPlaceOrderFailReason(body);
  if (placeFail) return placeFail;

  const fromBody = pickMessage(body);
  if (fromBody) return fromBody;

  const msg = any.message != null ? String(any.message).trim() : '';
  if (msg && !isGenericHttpMessage(msg)) {
    // 「下单失败: Success」这类被信封污染的包装，再试从 message 里剥不出源因时保留原文
    const stripped = msg.replace(/^下单失败:\s*/i, '').trim();
    if (stripped && !/^Success$/i.test(stripped)) return msg.startsWith('下单失败:') ? stripped : msg;
    if (!/^Success$/i.test(stripped)) return msg;
  }

  try {
    const s = String(e).trim();
    if (s && s !== '[object Object]') return s;
  } catch {
    /* ignore */
  }
  return '未知错误';
}

/**
 * PlaceOrder 业务失败：successed=false 时 orderID 存放失败原因（非订单号）。
 * 兼容完整信封 { success, message, data } 与剥壳后的 data。
 */
export function extractPlaceOrderFailReason(v: unknown): string | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, any>;
  const candidates = [o, o.data].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  for (const row of candidates) {
    if (row.successed === false) {
      const reason = String(row.orderID || row.errorMsg || row.message || '').trim();
      // 排除信封残留的 Success
      if (reason && !/^(Success|OK)$/i.test(reason)) return reason;
      return '下单失败';
    }
  }
  return null;
}

/** PlaceOrder 成功时的订单号；必须 successed===true，否则 orderID 可能是失败原因 */
export function extractPlaceOrderId(data: unknown): string | null {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, any>;
  const row = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? o.data : o;
  if (row.successed !== true) return null;
  const candidates = [
    row.orderID,
    row.orderId,
    row.id,
    row.clientOrderId,
    o.orderID,
    o.orderId,
    o.id,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (!s || /^(Success|OK)$/i.test(s)) continue;
    // 失败原因常含中文说明，成功订单号一般为字母数字/-_
    if (/[\u4e00-\u9fff]/.test(s)) continue;
    return s;
  }
  return null;
}

function isGenericHttpMessage(msg: string): boolean {
  return /^(Bad Request Exception|Http Exception|Internal Server Error|Service Unavailable Exception|Success)$/i.test(
    msg,
  );
}

function pickMessage(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s || null;
  }
  if (typeof v !== 'object') return null;
  const o = v as Record<string, any>;

  if (Array.isArray(o.message)) {
    const joined = o.message
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join('; ');
    return joined || null;
  }
  for (const key of ['errorMsg', 'message', 'orderID', 'msg', 'error', 'reason']) {
    const val = o[key];
    if (typeof val === 'string' && val.trim() && !isGenericHttpMessage(val.trim())) {
      // 信封 message=Success 不当失败原因
      if (key === 'message' && /^(Success|OK)$/i.test(val.trim())) continue;
      // orderID 在成功时是订单号，仅在失败语义下使用
      if (key === 'orderID' && o.successed !== false) continue;
      return val.trim();
    }
  }
  if (o.data && typeof o.data === 'object') {
    return pickMessage(o.data);
  }
  return null;
}
