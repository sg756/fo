import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 初始位置（视口坐标） */
  initialX?: number;
  initialY?: number;
  width?: number;
};

/**
 * 非模态可拖拽浮层：无遮罩，不阻断页面操作；标题栏拖拽；右上角关闭。
 */
export function DraggableFloatPanel({
  open,
  title,
  onClose,
  children,
  initialX = 80,
  initialY = 100,
  width = 360,
}: Props) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  useEffect(() => {
    if (open) setPos({ x: initialX, y: initialY });
  }, [open, initialX, initialY]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const nx = d.origX + (e.clientX - d.startX);
    const ny = d.origY + (e.clientY - d.startY);
    const maxX = Math.max(8, window.innerWidth - width - 8);
    const maxY = Math.max(8, window.innerHeight - 80);
    setPos({
      x: Math.min(maxX, Math.max(8, nx)),
      y: Math.min(maxY, Math.max(8, ny)),
    });
  }, [width]);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }, [onPointerMove]);

  function startDrag(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  useEffect(() => () => endDrag(), [endDrag]);

  if (!open) return null;

  return (
    <div
      className="float-panel"
      style={{ left: pos.x, top: pos.y, width }}
      role="dialog"
      aria-modal="false"
      aria-label={title}
    >
      <div className="float-panel-head" onPointerDown={startDrag}>
        <h3>{title}</h3>
        <button
          type="button"
          className="modal-close"
          title="关闭"
          aria-label="关闭"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <span className="modal-close-x" aria-hidden>
            ×
          </span>
        </button>
      </div>
      <div className="float-panel-body">{children}</div>
    </div>
  );
}
