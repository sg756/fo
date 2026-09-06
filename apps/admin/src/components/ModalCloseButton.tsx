type Props = {
  onClick: () => void;
  disabled?: boolean;
};

/** 对话框右上角圆形 × 关闭按钮 */
export function ModalCloseButton({ onClick, disabled }: Props) {
  return (
    <button
      type="button"
      className="modal-close"
      aria-label="关闭"
      title="关闭"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="modal-close-x" aria-hidden="true">
        ×
      </span>
    </button>
  );
}
