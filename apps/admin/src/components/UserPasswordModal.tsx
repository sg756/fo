import { useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { ModalCloseButton } from './ModalCloseButton';

/** 单独改登录密码：仅新密码 + 确认 */
export function UserPasswordModal({
  userId,
  onClose,
  onSaved,
}: {
  userId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPassword('');
    setPassword2('');
    setErr('');
    setSaving(false);
  }, [userId]);

  if (!userId) return null;
  const uid = userId;

  async function save() {
    const p1 = password.trim();
    const p2 = password2.trim();
    if (p1.length < 6) {
      setErr('密码至少 6 位');
      return;
    }
    if (p1 !== p2) {
      setErr('两次输入的密码不一致');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await AdminApi.updateUser(uid, { password: p1 });
      onSaved?.();
      onClose();
      alert('改密成功');
    } catch (e: any) {
      setErr(e.message || '改密失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>改密码</h3>
          <ModalCloseButton onClick={onClose} />
        </div>
        {err ? <p className="err">{err}</p> : null}
        <div className="user-edit-fields">
          <label>
            新密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位"
              autoComplete="new-password"
            />
          </label>
          <label>
            确认新密码
            <input
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="再输入一次"
              autoComplete="new-password"
            />
          </label>
        </div>
        <div className="row" style={{ marginTop: 20, marginBottom: 0 }}>
          <button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '确认改密'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
