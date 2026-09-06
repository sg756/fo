import { useRef, type CSSProperties } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
};

/** 类 Element UI：整框可点开选择器；有值悬停显示 × 清空 */
export function DateField({ value, onChange, title, className, style }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    const el = inputRef.current;
    if (!el) return;
    try {
      (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      el.focus();
      el.click();
    }
  }

  return (
    <span
      className={`date-field${value ? ' has-value' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <input
        ref={inputRef}
        type="date"
        title={title}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={0}
      />
      {/* 全覆盖热区：空白处也能打开（原生 date 空白点击无效） */}
      <button
        type="button"
        className="date-field-hit"
        title={title || '选择日期'}
        aria-label="选择日期"
        tabIndex={-1}
        onClick={(e) => {
          e.preventDefault();
          openPicker();
        }}
      />
      {value ? (
        <button
          type="button"
          className="date-field-clear"
          title="清空"
          aria-label="清空日期"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
