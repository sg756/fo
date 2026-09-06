import { useEffect, useMemo, useRef, useState } from 'react';

export type SearchSelectOption = {
  value: string;
  label: string;
  sub?: string;
};

type Props = {
  /** 当前输入/展示文案 */
  text: string;
  onTextChange: (text: string) => void;
  /** 选中项的 value；未选中为空 */
  value: string;
  onSelect: (opt: SearchSelectOption | null) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  width?: number | string;
  loading?: boolean;
  /** 有远程搜索时由父组件过滤 options，本地不再二次过滤 */
  remote?: boolean;
  emptyHint?: string;
  disabled?: boolean;
};

/** 可输入筛选、可点选的查询框 */
export function SearchSelect({
  text,
  onTextChange,
  value,
  onSelect,
  options,
  placeholder,
  width = 180,
  loading,
  remote,
  emptyHint = '无匹配项',
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    if (remote) return options.slice(0, 40);
    const kw = text.trim().toLowerCase();
    const list = !kw
      ? options
      : options.filter(
          (o) =>
            o.label.toLowerCase().includes(kw) ||
            o.value.toLowerCase().includes(kw) ||
            (o.sub && o.sub.toLowerCase().includes(kw)),
        );
    return list.slice(0, 40);
  }, [options, text, remote]);

  return (
    <div className="search-select" ref={wrapRef} style={{ width }}>
      <input
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          const v = e.target.value;
          onTextChange(v);
          if (value) onSelect(null);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {value ? (
        <button
          type="button"
          className="search-select-clear"
          title="清除"
          disabled={disabled}
          onClick={() => {
            onTextChange('');
            onSelect(null);
          }}
        >
          ×
        </button>
      ) : null}
      {open ? (
        <div className="search-select-menu" role="listbox">
          {loading ? <div className="search-select-empty">加载中…</div> : null}
          {!loading && filtered.length === 0 ? (
            <div className="search-select-empty">{emptyHint}</div>
          ) : null}
          {!loading
            ? filtered.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  className={`search-select-item${o.value === value ? ' active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onSelect(o);
                    onTextChange(o.label);
                    setOpen(false);
                  }}
                >
                  <span className="search-select-label">{o.label}</span>
                  {o.sub ? <span className="search-select-sub">{o.sub}</span> : null}
                </button>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}
