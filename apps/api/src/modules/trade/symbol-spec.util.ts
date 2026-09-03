/**
 * CryptoSymbolList 字段（价格一套、数量一套，互不替代）：
 *
 * 价格
 * - PriceStep：tick。委托价 / PriceStep 必须是整数（100.03/0.01=10003）。
 *   Step=0.01 → 100.00/100.01；Step=1 → 100/101，不能 100.5。
 * - PricePrecision：最多几位小数，只管展示。Precision=4 且 Step=0.01 时
 *   不能下 123.4567，只能 123.45/123.46。
 *
 * 数量（中间件没有 QtyPrecision 字段）
 * - MinAmt：数量步进 + 最小量（QtyStep / MinQty）；买入量须为其整数倍。
 *   合约上同时是面额（一张多少币）。
 * - BoardLotSize：每手币数；为 0 则用 MinAmt。
 * - MinSize：张的可拆单位（如 0.1 张），不是价格、不是币。
 */

export type SymbolQtySpec = {
  minAmt?: number | null;
  minSize?: number | null;
  boardLotSize?: number | null;
  priceStep?: number | null;
  pricePrecision?: number | null;
  MinAmt?: number | null;
  MinSize?: number | null;
  BoardLotSize?: number | null;
  PriceStep?: number | null;
  PricePrecision?: number | null;
};

function specNum(spec: any, ...keys: string[]): number {
  if (!spec) return 0;
  for (const k of keys) {
    const v = Number(spec[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** 0 合法（价格小数位）；缺省为 NaN */
function specPrec(spec: any, ...keys: string[]): number {
  if (!spec) return NaN;
  for (const k of keys) {
    if (spec[k] == null || spec[k] === '') continue;
    const v = Number(spec[k]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

/** 兼容中间件 camelCase / PascalCase */
export function readQtySpec(spec?: SymbolQtySpec | null): {
  minAmt: number;
  minSize: number;
  boardLotSize: number;
  priceStep: number;
  pricePrecision: number;
} {
  return {
    minAmt: specNum(spec, 'minAmt', 'MinAmt'),
    minSize: specNum(spec, 'minSize', 'MinSize'),
    boardLotSize: specNum(spec, 'boardLotSize', 'BoardLotSize'),
    priceStep: specNum(spec, 'priceStep', 'PriceStep'),
    pricePrecision: specPrec(spec, 'pricePrecision', 'PricePrecision'),
  };
}

/** 每手/一张对应的币数量（与 PlaceOrder.coinAmt 同单位） */
export function oneContractCoinAmt(spec?: SymbolQtySpec | null): number {
  const q = readQtySpec(spec);
  if (q.boardLotSize > 0) return q.boardLotSize;
  return q.minAmt > 0 ? q.minAmt : 0;
}

/** 步进小数位，去掉 0.03-0.024 → 0.005999… 这类浮点渣 */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 8;
  const s = step.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(12, s.length - i - 1);
}

function alignDown(raw: number, step: number): number {
  if (!(raw > 0) || !(step > 0)) return 0;
  const n = Math.floor(raw / step + 1e-12);
  if (n <= 0) return 0;
  return Number((n * step).toFixed(stepDecimals(step)));
}

/**
 * 下单量：按 MinAmt（QtyStep）整数倍下取整，再按一张（BoardLotSize，为 0 则 MinAmt）下取整。
 * 跟单/平仓偏保守，多出来的零头丢掉，不向上凑。
 */
export function snapCoinAmt(amount: number, spec?: SymbolQtySpec | null): number {
  const raw = Number(amount) || 0;
  if (!(raw > 0)) return 0;
  const step = readQtySpec(spec).minAmt;
  const face = oneContractCoinAmt(spec);
  let qty = raw;
  if (step > 0) qty = alignDown(qty, step);
  else if (face > 0) qty = alignDown(qty, face);
  if (face > 0 && face - step > 1e-12) qty = alignDown(qty, face);
  return qty;
}

/**
 * 只按 PricePrecision 收口：展示、以及信号/限价这种「已有委托价」不自己算价。
 */
export function formatDisplayPrice(price: number, spec?: SymbolQtySpec | null): string {
  const p = Number(price);
  if (!(p > 0) || !Number.isFinite(p)) return '';
  const prec = specPrec(spec, 'pricePrecision', 'PricePrecision');
  if (Number.isFinite(prec) && prec >= 0 && prec <= 12) {
    return p.toFixed(prec);
  }
  return String(Math.round(p * 1e8) / 1e8);
}

/**
 * 自己算出来的价用的 tick。
 * 价 ≥ PriceStep：用步进；价 < PriceStep：改用 10^(-PricePrecision)。
 */
export function effectivePriceStep(price: number, spec?: SymbolQtySpec | null): number {
  const p = Number(price) || 0;
  const q = readQtySpec(spec);
  if (q.priceStep > 0 && p + 1e-12 >= q.priceStep) return q.priceStep;
  const prec = q.pricePrecision;
  if (Number.isFinite(prec) && prec >= 0 && prec <= 12) {
    return Number((10 ** -prec).toFixed(prec));
  }
  return 0;
}

/**
 * 自己算价（市价平/市价折张）：先按 Precision 收口，再按有效 tick 对齐。
 * 100.037 / step 0.01 / prec 4 → 100.04；
 * 0.5518 / step 1 / prec 4 → 0.5518，不收成 1。
 */
export function snapPrice(price: number, spec?: SymbolQtySpec | null): number {
  const shown = formatDisplayPrice(price, spec);
  const p = Number(shown) || 0;
  if (!(p > 0)) return 0;
  const step = effectivePriceStep(p, spec);
  if (!(step > 0)) return p;
  const n = Math.round(p / step);
  if (n <= 0) return 0;
  return Number((n * step).toFixed(stepDecimals(step)));
}

/** 币数量是否够一手/一张 */
export function isAtLeastOneContract(coinAmt: number, spec?: SymbolQtySpec | null): boolean {
  const face = oneContractCoinAmt(spec);
  if (!(face > 0)) return true;
  return Number(coinAmt) + 1e-12 >= face;
}
