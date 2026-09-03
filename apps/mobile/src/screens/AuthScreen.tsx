import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { PrimaryButton } from '../components/StatTile';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { notify } from '../utils/notify';

type Mode = 'login' | 'register';

export function AuthScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingTip, setPendingTip] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setPendingTip(null);
    const acc = account.trim();
    if (!acc || !password) {
      setError('请输入账号和密码');
      return;
    }
    if (mode === 'register') {
      if (acc.length < 6) {
        setError('账号至少 6 位');
        return;
      }
      if (password.length < 6) {
        setError('密码至少 6 位');
        return;
      }
      if (!confirmPassword) {
        setError('请再次确认密码');
        return;
      }
      if (password !== confirmPassword) {
        setError('两次输入的密码不一致');
        return;
      }
    }
    setLoading(true);
    try {
      if (mode === 'register') {
        const resp = await register({
          account: acc,
          password,
          confirmPassword,
          inviteCode: inviteCode.trim() || undefined,
        });
        const tip =
          resp.message ||
          (resp.status === 'PENDING'
            ? '注册成功，请等待管理员审核通过后再登录'
            : '注册成功');
        setPendingTip(tip);
        setMode('login');
        setConfirmPassword('');
        setInviteCode('');
        setPassword('');
        notify('注册已提交', tip, { tone: 'success' });
      } else {
        await login(acc, password);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '操作失败，请重试';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.page, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
      <View style={styles.form}>
        <Text style={[styles.brand, { color: theme.text }]}>多用户管理系统</Text>
        <Text style={{ color: theme.textSecondary, marginBottom: 24 }}>
          {mode === 'login' ? '账号登录' : '账号注册'}
        </Text>

        <Field theme={theme} value={account} onChangeText={setAccount} placeholder="账号（至少 6 位）" />
        <Field
          theme={theme}
          value={password}
          onChangeText={setPassword}
          placeholder="密码（至少 6 位）"
          secureTextEntry
        />
        {mode === 'register' ? (
          <>
            <Field
              theme={theme}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="确认密码"
              secureTextEntry
            />
            <Field
              theme={theme}
              value={inviteCode}
              onChangeText={setInviteCode}
              placeholder="邀请码（选填）"
              autoCapitalizeChars
            />
          </>
        ) : null}

        {pendingTip && mode === 'login' ? (
          <Text
            style={{
              color: (theme as any).warning || '#d97706',
              marginBottom: 12,
              fontSize: 13,
              lineHeight: 18,
            }}
          >
            {pendingTip}
          </Text>
        ) : null}

        {error ? (
          <Text style={{ color: theme.danger, marginBottom: 12, fontSize: 13 }}>{error}</Text>
        ) : null}

        {loading ? (
          <View style={[styles.loadingBtn, { backgroundColor: theme.primary }]}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : (
          <PrimaryButton title={mode === 'login' ? '登录' : '注册'} onPress={submit} />
        )}

        <Pressable
          onPress={() => {
            setError(null);
            setPendingTip(null);
            setConfirmPassword('');
            setMode(mode === 'login' ? 'register' : 'login');
          }}
          style={{ marginTop: 18 }}
        >
          <Text style={{ color: theme.primary, textAlign: 'center' }}>
            {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function Field({
  theme,
  autoCapitalizeChars,
  ...props
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  autoCapitalizeChars?: boolean;
}) {
  return (
    <TextInput
      {...props}
      placeholderTextColor={theme.textMuted}
      autoCapitalize={autoCapitalizeChars ? 'characters' : 'none'}
      autoCorrect={false}
      style={[
        styles.input,
        { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  form: {
    width: '100%',
    maxWidth: 400,
  },
  brand: { fontSize: 34, fontWeight: '800' },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    width: '100%',
  },
  loadingBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
});
