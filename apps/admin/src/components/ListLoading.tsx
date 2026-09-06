/** 列表查询 loading 遮罩 */
export function ListLoading({
  show,
  text = '加载中…',
}: {
  show: boolean;
  text?: string;
}) {
  if (!show) return null;
  return (
    <div className="list-loading" aria-busy="true" aria-live="polite">
      <div className="list-loading-spinner" />
      <span className="list-loading-text">{text}</span>
    </div>
  );
}
