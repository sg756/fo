import { useEffect, useState } from 'react';
import { ModalCloseButton } from './ModalCloseButton';

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮用危险色，默认 true */
  danger?: boolean;
};

type Pending = {
  opts: Required<Pick<ConfirmOptions, 'title' | 'message' | 'confirmText' | 'cancelText' | 'danger'>>;
  resolve: (ok: boolean) => void;
};

type Listener = (item: Pending | null) => void;

const listeners = new Set<Listener>();
const queue: Pending[] = [];

function emit() {
  const current = queue[0] ?? null;
  for (const l of listeners) l(current);
}

function finish(ok: boolean) {
  const cur = queue.shift();
  cur?.resolve(ok);
  emit();
}

/** 自定义确认弹框，替代 window.confirm。返回 true 表示用户点了确认。 */
export function confirmDialog(messageOrOptions: string | ConfirmOptions): Promise<boolean> {
  const raw =
    typeof messageOrOptions === 'string'
      ? { message: messageOrOptions }
      : messageOrOptions;
  const opts: Pending['opts'] = {
    title: raw.title ?? '确认操作',
    message: raw.message,
    confirmText: raw.confirmText ?? '确定',
    cancelText: raw.cancelText ?? '取消',
    danger: raw.danger ?? true,
  };
  return new Promise((resolve) => {
    queue.push({ opts, resolve });
    emit();
  });
}

export function ConfirmHost() {
  const [current, setCurrent] = useState<Pending | null>(queue[0] ?? null);

  useEffect(() => {
    const onChange: Listener = (next) => setCurrent(next);
    listeners.add(onChange);
    setCurrent(queue[0] ?? null);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  if (!current) return null;

  const { opts } = current;

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      onClick={() => finish(false)}
    >
      <div
        className="modal-panel confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">
          <h3 id="confirm-title">{opts.title}</h3>
          <ModalCloseButton onClick={() => finish(false)} />
        </div>
        <p id="confirm-message" className="confirm-message">
          {opts.message}
        </p>
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={() => finish(false)}>
            {opts.cancelText}
          </button>
          <button
            type="button"
            className={opts.danger ? 'danger' : undefined}
            autoFocus
            onClick={() => finish(true)}
          >
            {opts.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
