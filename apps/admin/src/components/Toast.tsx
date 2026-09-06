import { useEffect, useState } from 'react';

export type ToastType = 'ok' | 'err' | 'info';

type ToastItem = {
  id: number;
  message: string;
  type: ToastType;
};

type Listener = (items: ToastItem[]) => void;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

/** 右上角浮框提示，默认约 2.8 秒后淡出消失 */
export function toast(message: string, type: ToastType = 'ok', durationMs = 2800) {
  const id = ++seq;
  items = [...items, { id, message, type }];
  emit();
  window.setTimeout(() => {
    items = items.filter((x) => x.id !== id);
    emit();
  }, durationMs);
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    const onChange: Listener = (next) => setList(next);
    listeners.add(onChange);
    setList(items);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="toast-host" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
