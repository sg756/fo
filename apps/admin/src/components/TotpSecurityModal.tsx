import { useEffect, useState } from 'react';
import { AuthApi, getAdminMe, setAdminMe } from '../api';
import { ModalCloseButton } from './ModalCloseButton';
import { toast } from './Toast';

type Props = {
  open: boolean;
  onClose: () => void;
};

/** 账户菜单：绑定 / 关闭 Google Authenticator */
export function TotpSecurityModal({ open, onClose }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [setup, setSetup] = useState<{
    secret: string;
    otpauthUrl: string;
    account: string;
  } | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    setSetup(null);
    setCode('');
    setLoading(true);
    AuthApi.totpStatus()
      .then((s) => setEnabled(!!s.enabled))
      .catch((e) => setErr(e.message || '加载失败'))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  async function startSetup() {
    setErr('');
    setBusy('setup');
    try {
      const s = await AuthApi.totpSetup();
      setSetup({ secret: s.secret, otpauthUrl: s.otpauthUrl, account: s.account });
      setCode('');
    } catch (e: any) {
      setErr(e.message || '无法开始绑定');
    } finally {
      setBusy('');
    }
  }

  async function confirmBind() {
    setErr('');
    setBusy('confirm');
    try {
      await AuthApi.totpConfirm(code.trim());
      setEnabled(true);
      setSetup(null);
      setCode('');
      const me = getAdminMe();
      if (me) setAdminMe({ ...me, totpEnabled: true });
      toast('Google 验证器已绑定', 'ok');
    } catch (e: any) {
      setErr(e.message || '绑定失败');
    } finally {
      setBusy('');
    }
  }

  async function disable() {
    setErr('');
    setBusy('disable');
    try {
      await AuthApi.totpDisable(code.trim());
      setEnabled(false);
      setCode('');
      const me = getAdminMe();
      if (me) setAdminMe({ ...me, totpEnabled: false });
      toast('已关闭 Google 验证器', 'ok');
    } catch (e: any) {
      setErr(e.message || '关闭失败');
    } finally {
      setBusy('');
    }
  }

  const qrSrc = setup
    ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(setup.otpauthUrl)}`
    : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel"
        style={{ maxWidth: 420, width: 'min(420px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>安全设置 · Google 验证器</h3>
          <ModalCloseButton disabled={!!busy} onClick={onClose} />
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          热钱包转出等敏感操作必须验证 6 位动态码。请使用 Google Authenticator / 微软验证器等 App。
        </p>
        {err ? <p className="err">{err}</p> : null}
        {loading ? (
          <p className="hint">加载中…</p>
        ) : enabled && !setup ? (
          <div>
            <p style={{ margin: '8px 0' }}>
              状态：<span className="badge ok">已绑定</span>
            </p>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>验证码（关闭前必填）</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 位验证码"
              inputMode="numeric"
              style={{ width: '100%', marginBottom: 10 }}
            />
            <button
              type="button"
              className="ghost"
              disabled={!!busy || code.length !== 6}
              onClick={() => void disable()}
            >
              {busy === 'disable' ? '关闭中…' : '关闭验证器'}
            </button>
          </div>
        ) : (
          <div>
            <p style={{ margin: '8px 0' }}>
              状态：{enabled ? <span className="badge ok">已绑定</span> : <span className="badge warn">未绑定</span>}
            </p>
            {!setup ? (
              <button type="button" disabled={!!busy} onClick={() => void startSetup()}>
                {busy === 'setup' ? '生成中…' : '开始绑定'}
              </button>
            ) : (
              <div>
                <p className="hint">用验证器 App 扫描二维码，或手动输入密钥：</p>
                <div style={{ textAlign: 'center', margin: '10px 0' }}>
                  <img src={qrSrc} alt="TOTP QR" width={180} height={180} />
                </div>
                <div
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 12,
                    wordBreak: 'break-all',
                    padding: 8,
                    background: 'var(--bg-muted, #f3f4f6)',
                    borderRadius: 6,
                    marginBottom: 8,
                  }}
                >
                  {setup.secret}
                </div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>验证码</label>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="扫码后输入 6 位码"
                  inputMode="numeric"
                  style={{ width: '100%', marginBottom: 10 }}
                />
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    disabled={!!busy || code.length !== 6}
                    onClick={() => void confirmBind()}
                  >
                    {busy === 'confirm' ? '确认中…' : '确认绑定'}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={!!busy}
                    onClick={() => {
                      setSetup(null);
                      setCode('');
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
