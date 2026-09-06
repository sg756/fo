/** 持仓价格展示；空/无效返回 — */
export function fmtPriceOrDash(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return String(n);
}

export function fmtAmount(v: string | number | null | undefined, digits = 2): string {
  const n = Number(v ?? 0);
  if (!isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtSigned(v: string | number | null | undefined, digits = 2): string {
  const n = Number(v ?? 0);
  const s = fmtAmount(Math.abs(n), digits);
  return `${n >= 0 ? '+' : '-'}${s}`;
}

/** 已实现盈亏：固定 8 位小数 */
export function fmtProfit(v: string | number | null | undefined, digits = 8): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0.00000000';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtProfitSigned(v: string | number | null | undefined, digits = 8): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0.00000000';
  const s = fmtProfit(Math.abs(n), digits);
  if (n > 0) return `+${s}`;
  if (n < 0) return `-${s}`;
  return s;
}

/**
 * 解析时间：兼容 App（RN iOS/Android）与 H5（含 Safari）。
 * Safari 不认 `YYYY-MM-DD HH:mm:ss`（空格分隔），需规范化后再 new Date。
 */
function parseDateTime(input: string | number | Date | null | undefined): Date | null {
  if (input == null || input === '') return null;
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === 'number') {
    const ms = input > 1e12 ? input : input > 1e9 ? input * 1000 : input;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  const raw = String(input).trim();
  if (!raw || raw === '—') return null;

  // 已是本地展示串（无 T/Z）：按本地墙钟拆字段构造，App/H5 行为一致
  // （Safari 对 "YYYY-MM-DD HH:mm:ss" 直接 new Date 常为 Invalid Date）
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
    if (m) {
      const d = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] || 0),
      );
      return isNaN(d.getTime()) ? null : d;
    }
  }

  // 仅日期
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
  }

  // ISO：支持 Z / +08:00；把中间空格换成 T（部分引擎）
  let s = raw;
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(' ', 'T');

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  // 纯数字时间戳字符串
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length >= 13 ? n : n * 1000;
    const t = new Date(ms);
    return isNaN(t.getTime()) ? null : t;
  }

  return null;
}

function pad2(x: number) {
  return String(x).padStart(2, '0');
}

/** 转本地可读时间：YYYY-MM-DD HH:mm:ss（App / H5 / Safari 一致） */
export function fmtDateTime(iso: string | number | Date | null | undefined): string {
  // 后端已格式化的本地串：补秒后直接返回，避免无谓解析
  if (typeof iso === 'string') {
    const raw = iso.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
  }

  const d = parseDateTime(iso);
  if (!d) {
    if (iso == null || iso === '' || iso === '—') return '';
    return String(iso);
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 展示用；空值返回 — */
export function fmtDateTimeOrDash(iso: string | number | Date | null | undefined): string {
  return fmtDateTime(iso) || '—';
}

const POINT_TX_LABELS: Record<string, string> = {
  RECHARGE: '充值',
  COMMISSION: '佣金入账',
  SHARE_DEDUCT: '分润扣减',
  WITHDRAW: '提现',
  WITHDRAW_REFUND: '提现退回',
  TRADE_PNL: '平仓获利入账',
  ADJUST: '人工调整',
};

/** 筛选用：全部 + 各流水类型 */
export const POINT_TX_FILTERS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  ...Object.entries(POINT_TX_LABELS).map(([value, label]) => ({ value, label })),
];

export function pointTxLabel(type: string): string {
  const raw = String(type || '').trim();
  if (!raw) return '—';
  const key = raw.toUpperCase().replace(/-/g, '_');
  if (POINT_TX_LABELS[key]) return POINT_TX_LABELS[key];
  if (POINT_TX_LABELS[raw]) return POINT_TX_LABELS[raw];
  return raw;
}

/** 资金流水副标题：分润扣减不展示后端 remark（含抽成比例等括号说明） */
export function pointTxRemark(type: string, remark?: string | null): string | null {
  const key = String(type || '')
    .trim()
    .toUpperCase()
    .replace(/-/g, '_');
  if (key === 'SHARE_DEDUCT') return null;
  const r = String(remark || '').trim();
  return r || null;
}

/** 资金流水金额：带符号，固定 8 位小数 */
export function fmtFundSigned(v: string | number | null | undefined): string {
  return fmtSigned(v, 8);
}

const WITHDRAW_STATUS_LABELS: Record<string, string> = {
  PENDING: '待审核',
  APPROVED: '待放行',
  REJECTED: '已驳回',
  RELEASED: '已放行',
  FAILED: '失败',
};

export function withdrawStatusLabel(status: string): string {
  return WITHDRAW_STATUS_LABELS[status] || status;
}
