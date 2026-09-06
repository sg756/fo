import { useCallback, useEffect, useState } from 'react';
import {
  AuthApi,
  confirmSessionExpired,
  goLoginAfterSessionExpired,
  subscribeSessionExpired,
  type SessionExpiredState,
} from '../api';

export function SessionExpiredHost() {
  const [state, setState] = useState<SessionExpiredState>({
    open: false,
    hasRemembered: false,
    busy: false,
    error: '',
  });
  const [captchaId, setCaptchaId] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');

  const loadCaptcha = useCallback(async () => {
    try {
      const c = await AuthApi.captcha();
      setCaptchaId(c.id);
      setCaptchaImage(c.image);
      setCaptchaCode('');
    } catch {
      /* ignore; error shown on confirm */
    }
  }, []);

  useEffect(() => subscribeSessionExpired(setState), []);

  useEffect(() => {
    if (state.open && state.hasRemembered) {
      void loadCaptcha();
    }
  }, [state.open, state.hasRemembered, loadCaptcha]);

  useEffect(() => {
    if (state.error && state.hasRemembered) {
      void loadCaptcha();
    }
  }, [state.error, state.hasRemembered, loadCaptcha]);

  if (!state.open) return null;

  return (
    <div className="modal-backdrop" style={{ zIndex: 2000 }}>
      <div
        className="modal-panel"
        style={{ width: 'min(420px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>登录已失效</h3>
        </div>
        <p style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
          {state.hasRemembered
            ? '会话已过期。已记住账号密码，请填写验证码后确定，将自动重新登录。'
            : '会话已过期，请重新登录。点击确定后前往登录页。'}
        </p>
        {state.hasRemembered ? (
          <div className="login-captcha-row" style={{ marginBottom: 12 }}>
            <input
              value={captchaCode}
              onChange={(e) => setCaptchaCode(e.target.value)}
              placeholder="图形验证码"
              autoComplete="off"
              maxLength={8}
              disabled={state.busy}
            />
            <button
              type="button"
              className="login-captcha-img"
              title="点击刷新"
              onClick={() => void loadCaptcha()}
              disabled={state.busy}
            >
              {captchaImage ? (
                <img src={captchaImage} alt="验证码" width={132} height={44} />
              ) : (
                <span>加载中</span>
              )}
            </button>
          </div>
        ) : null}
        {state.error ? <p className="err">{state.error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          {state.error ? (
            <button type="button" className="ghost" disabled={state.busy} onClick={goLoginAfterSessionExpired}>
              前往登录页
            </button>
          ) : null}
          <button
            type="button"
            disabled={state.busy}
            onClick={() =>
              void confirmSessionExpired(
                state.hasRemembered
                  ? { captchaId, captchaCode: captchaCode.trim() }
                  : undefined,
              )
            }
          >
            {state.busy ? '登录中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
