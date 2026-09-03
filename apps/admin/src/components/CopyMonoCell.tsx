import { toast } from './Toast';
import { copyToClipboard } from '../utils/clipboard';

type Props = {
  value?: string | null;
  /** 提示与 toast 中的名称，如「流水编号」 */
  label?: string;
  /** 展示完整值（可换行），适合交易哈希 */
  full?: boolean;
};

/** 等宽短显 + 点击复制完整编号 */
export function CopyMonoCell({ value, label = '编号', full }: Props) {
  const id = String(value || '').trim();
  if (!id) return <span className="mono">—</span>;

  const display = full
    ? id
    : id.length > 18
      ? `${id.slice(0, 10)}…${id.slice(-6)}`
      : id;

  return (
    <button
      type="button"
      className="ghost mono cell-link"
      title={`${label}: ${id}\n点击复制完整内容`}
      style={{
        fontSize: 12,
        padding: 0,
        maxWidth: full ? 360 : 168,
        overflow: 'hidden',
        textOverflow: full ? 'clip' : 'ellipsis',
        whiteSpace: full ? 'normal' : 'nowrap',
        wordBreak: full ? 'break-all' : undefined,
        textAlign: 'left',
        lineHeight: 1.4,
      }}
      onClick={(e) => {
        e.stopPropagation();
        void copyToClipboard(id).then((ok) =>
          toast(ok ? `已复制${label}` : '复制失败，请手动选中', ok ? 'ok' : 'err'),
        );
      }}
    >
      {display}
    </button>
  );
}
