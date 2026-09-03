type Props = {
  total: number;
  page: number;
  pageSize: number;
  pageSizes?: number[];
  disabled?: boolean;
  onChange: (page: number, pageSize: number) => void;
};

function buildPages(page: number, pageCount: number): Array<number | '…'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, pageCount, page, page - 1, page + 1, page - 2, page + 2]);
  const nums = [...set].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push('…');
    out.push(nums[i]);
  }
  return out;
}

/** 类 Element UI el-pagination：总数、每页条数、页码、跳转 */
export function Pagination({
  total,
  page,
  pageSize,
  pageSizes = [10, 20, 50, 100],
  disabled,
  onChange,
}: Props) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), pageCount);
  const pages = buildPages(safePage, pageCount);

  function go(p: number) {
    const next = Math.min(Math.max(1, p), pageCount);
    if (next !== page) onChange(next, pageSize);
  }

  return (
    <div className={`pagination${disabled ? ' is-disabled' : ''}`}>
      <span className="pagination-total">共 {total} 条</span>

      <select
        className="pagination-size"
        value={pageSize}
        disabled={disabled}
        onChange={(e) => onChange(1, Number(e.target.value))}
        title="每页条数"
      >
        {pageSizes.map((n) => (
          <option key={n} value={n}>
            {n} 条/页
          </option>
        ))}
      </select>

      <button
        type="button"
        className="pagination-btn"
        disabled={disabled || safePage <= 1}
        onClick={() => go(safePage - 1)}
        aria-label="上一页"
      >
        ‹
      </button>

      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="pagination-ellipsis">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={`pagination-btn pagination-num${p === safePage ? ' is-active' : ''}`}
            disabled={disabled}
            onClick={() => go(p)}
          >
            {p}
          </button>
        ),
      )}

      <button
        type="button"
        className="pagination-btn"
        disabled={disabled || safePage >= pageCount}
        onClick={() => go(safePage + 1)}
        aria-label="下一页"
      >
        ›
      </button>

      <span className="pagination-jumper">
        前往
        <input
          type="number"
          min={1}
          max={pageCount}
          disabled={disabled}
          defaultValue={safePage}
          key={safePage}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) go(Math.floor(v));
          }}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) go(Math.floor(v));
          }}
        />
        页
      </span>
    </div>
  );
}
