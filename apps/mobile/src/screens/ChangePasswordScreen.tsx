import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenHeader } from '../components/ScreenHeader';
import { PrimaryButton } from '../components/StatTile';
import { AuthApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { notify } from '../utils/notify';
import type { RootStackParamList } from '../navigation/types';

export function ChangePasswordScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('请填写完整');
      return;
    }
    if (newPassword.length < 6) {
      setError('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setLoading(true);
    try {
      const resp = await AuthApi.changePassword({ currentPassword, newPassword, confirmPassword });
      notify('成功', resp.message || '登录密码已更新', () => navigation.goBack());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '修改失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="修改登录密码" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: theme.textSecondary, marginBottom: 16, lineHeight: 20 }}>
          修改成功后，请使用新密码登录。当前登录状态不受影响。
        </Text>

        <Field
          theme={theme}
          value={currentPassword}
          onChangeText={setCurrentPassword}
          placeholder="当前密码"
          secureTextEntry
        />
        <Field
          theme={theme}
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="新密码（至少 6 位）"
          secureTextEntry
        />
        <Field
          theme={theme}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="确认新密码"
          secureTextEntry
        />

        {error ? (
          <Text style={{ color: theme.danger, marginBottom: 12, fontSize: 13 }}>{error}</Text>
        ) : null}

        {loading ? (
          <View style={[styles.loadingBtn, { backgroundColor: theme.primary }]}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : (
          <PrimaryButton title="确认修改" onPress={submit} />
        )}
      </ScrollView>
    </View>
  );
}

function Field({
  theme,
  ...props
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
}) {
  return (
    <TextInput
      {...props}
      placeholderTextColor={theme.textMuted}
      autoCapitalize="none"
      autoCorrect={false}
      style={[
        styles.input,
        { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  loadingBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
});
