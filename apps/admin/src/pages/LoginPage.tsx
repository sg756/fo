import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  AuthApi,
  clearRememberedCredentials,
  getRememberedCredentials,
  setAdminMe,
  setRememberedCredentials,
  setToken,
} from '../api';

export function LoginPage() {
  const nav = useNavigate();
  const remembered = getRememberedCredentials();
  const [email, setEmail] = useState(remembered?.email || 'admin');
  const [password, setPassword] = useState(remembered?.password || '');
  const [remember, setRemember] = useState(!!remembered);
  const [captchaId, setCaptchaId] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const loadCaptcha = useCallback(async () => {
    try {
      const c = await AuthApi.captcha();
      setCaptchaId(c.id);
      setCaptchaImage(c.image);
      setCaptchaCode('');
    } catch (e: any) {
      setErr(e?.message || '验证码加载失败');
    }
  }, []);

  useEffect(() => {
    void loadCaptcha();
  }, [loadCaptcha]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (!captchaCode.trim()) {
      setErr('请填写图形验证码');
      return;
    }
    setLoading(true);
    try {
      const res = await AuthApi.login(email, password, captchaId, captchaCode.trim());
      if (res.user?.role !== 'ADMIN') {
        setErr('该账号不是管理员');
        void loadCaptcha();
        return;
      }
      setToken(res.accessToken);
      setAdminMe(res.user);
      if (remember) setRememberedCredentials(email, password);
      else clearRememberedCredentials();
      nav('/');
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : e?.message || '登录失败');
      void loadCaptcha();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <h2>多用户管理系统</h2>
        <p>使用管理员账号登录</p>
        <label>账号</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱 / 昵称 / 邮箱前缀"
          autoComplete="username"
        />
        <label>密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <label>验证码</label>
        <div className="login-captcha-row">
          <input
            value={captchaCode}
            onChange={(e) => setCaptchaCode(e.target.value)}
            placeholder="输入图中字符"
            autoComplete="off"
            maxLength={8}
          />
          <button
            type="button"
            className="login-captcha-img"
            title="点击刷新"
            onClick={() => void loadCaptcha()}
            disabled={!captchaImage || loading}
          >
            {captchaImage ? (
              <img src={captchaImage} alt="验证码" width={132} height={44} />
            ) : (
              <span>加载中</span>
            )}
          </button>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            style={{ width: 'auto', margin: 0 }}
          />
          记住账号密码（登录失效时可一键重登）
        </label>
        {err ? <div className="err">{err}</div> : null}
        <button disabled={loading}>{loading ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}
