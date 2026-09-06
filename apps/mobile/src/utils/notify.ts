export type DialogTone = 'info' | 'success' | 'danger' | 'warning';

export type DialogButton = {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

export type DialogRequest = {
  id: number;
  title: string;
  message?: string;
  tone?: DialogTone;
  buttons: DialogButton[];
};

type Listener = (req: DialogRequest | null) => void;

let listener: Listener | null = null;
let seq = 0;
let pending: DialogRequest | null = null;

export function bindDialogListener(fn: Listener | null) {
  listener = fn;
  if (fn && pending) {
    fn(pending);
    pending = null;
  }
}

function present(req: Omit<DialogRequest, 'id'>) {
  const full: DialogRequest = { ...req, id: ++seq };
  if (listener) listener(full);
  else pending = full;
}

function guessTone(title: string, buttons?: DialogButton[]): DialogTone {
  const t = title || '';
  if (/失败|错误|无法|拒绝/.test(t)) return 'danger';
  if (/成功|已保存|已清除|已开启|已停止|已提交|已复制|已更新/.test(t)) return 'success';
  if (/重要|确认|警告|注意/.test(t)) return 'warning';
  if (buttons?.some((b) => b.style === 'destructive')) return 'warning';
  return 'info';
}

/** 应用内对话框（替代原生 Alert，Web/App 样式一致） */
export function appAlert(
  title: string,
  message?: string,
  buttons?: DialogButton[],
  tone?: DialogTone,
) {
  const btns =
    buttons && buttons.length > 0
      ? buttons
      : [{ text: '确定', style: 'default' as const }];
  present({
    title,
    message,
    tone: tone || guessTone(title, btns),
    buttons: btns,
  });
}

export function notify(
  title: string,
  message?: string,
  onOkOrOpts?: (() => void) | { onOk?: () => void; tone?: DialogTone },
) {
  const onOk = typeof onOkOrOpts === 'function' ? onOkOrOpts : onOkOrOpts?.onOk;
  const tone = typeof onOkOrOpts === 'function' ? undefined : onOkOrOpts?.tone;
  appAlert(title, message, [{ text: '确定', onPress: onOk }], tone);
}

export function confirm(
  title: string,
  message: string,
  opts: {
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    onConfirm: () => void;
    onCancel?: () => void;
    tone?: DialogTone;
  },
) {
  appAlert(
    title,
    message,
    [
      { text: opts.cancelText || '取消', style: 'cancel', onPress: opts.onCancel },
      {
        text: opts.confirmText || '确定',
        style: opts.destructive ? 'destructive' : 'default',
        onPress: opts.onConfirm,
      },
    ],
    opts.tone || (opts.destructive ? 'warning' : 'info'),
  );
}
