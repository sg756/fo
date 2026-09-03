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
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { PrimaryButton } from '../components/StatTile';
import { ExchangeKeyApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { confirm, notify } from '../utils/notify';
import type { RootStackParamList } from '../navigation/types';

export function ExchangeApiScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'ExchangeApi'>>();
  const { exchange, name, needPass, configured, keyId, apiKeyMasked } = route.params;

  const [apiKey, setApiKey] = useState(configured && apiKeyMasked ? apiKeyMasked : '');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const keyUnchanged = !!(apiKeyMasked && apiKey.trim() === apiKeyMasked);
  const canSave =
    apiKey.trim().length > 0 &&
    !keyUnchanged &&
    apiSecret.trim().length > 0 &&
    (!needPass || passphrase.trim().length > 0);

  const missingHint = () => {
    if (!apiKey.trim() || keyUnchanged) return '请填写完整的 API Key';
    if (!apiSecret.trim()) return '请填写 API Secret';
    if (needPass && !passphrase.trim()) return '请填写 Passphrase（口令）';
    return '请完整填写后再保存';
  };

  const save = async () => {
    setFeedback(null);
    if (!canSave) {
      const tip = missingHint();
      setFeedback({ ok: false, text: tip });
      notify('无法保存', tip);
      return;
    }
    setSaving(true);
    try {
      await ExchangeKeyApi.upsert({
        exchange,
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        passphrase: needPass ? passphrase.trim() : undefined,
      });
      const okText = `${name} 的 API 配置已加密保存`;
      setFeedback({ ok: true, text: okText });
      notify('已保存', okText, () => navigation.goBack());
    } catch (e) {
      const errText = e instanceof ApiError ? e.message : '保存失败，请重试';
      setFeedback({ ok: false, text: errText });
      notify('保存失败', errText);
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!keyId) return;
    confirm('确认清除', `确定清除 ${name} 的 API 凭证吗？清除后需重新填写。`, {
      confirmText: '清除',
      destructive: true,
      onConfirm: async () => {
        setRemoving(true);
        setFeedback(null);
        try {
          await ExchangeKeyApi.remove(keyId);
          const okText = `${name} 的 API 凭证已删除`;
          setFeedback({ ok: true, text: okText });
          notify('已清除', okText, () => navigation.goBack());
        } catch (e) {
          const errText = e instanceof ApiError ? e.message : '清除失败，请重试';
          setFeedback({ ok: false, text: errText });
          notify('清除失败', errText);
        } finally {
          setRemoving(false);
        }
      },
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title={`${name} API`} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={[styles.statusCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={[styles.exIcon, { backgroundColor: theme.primarySoft }]}>
            <Text style={{ color: theme.primary, fontWeight: '800' }}>{name.slice(0, 1)}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: 16 }}>{name}</Text>
            <Text
              style={{
                color: configured ? theme.success : theme.textSecondary,
                fontSize: 12,
                marginTop: 4,
              }}
            >
              {configured
                ? '已设置'
                : needPass && keyId
                  ? '未设置（缺 Passphrase）'
                  : '未设置'}
            </Text>
          </View>
        </View>

        {configured || keyId ? (
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 12, lineHeight: 18 }}>
            {needPass && !configured
              ? 'OKX/Bitget 必须填写 Passphrase 后才算配置完成。'
              : '重新填写并保存将覆盖已有凭证。'}
          </Text>
        ) : null}

        {feedback ? (
          <View
            style={[
              styles.feedback,
              {
                backgroundColor: feedback.ok ? 'rgba(0,192,135,0.12)' : 'rgba(246,70,93,0.12)',
                borderColor: feedback.ok ? theme.success : theme.danger,
              },
            ]}
          >
            <Text style={{ color: feedback.ok ? theme.success : theme.danger, fontWeight: '600' }}>
              {feedback.text}
            </Text>
          </View>
        ) : null}

        <Label theme={theme} text="API Key" />
        <TextInput
          value={apiKey}
          onChangeText={(t) => {
            setApiKey(t);
            if (feedback) setFeedback(null);
          }}
          onFocus={() => {
            if (keyUnchanged) setApiKey('');
          }}
          placeholder={configured ? '输入新的 API Key 以更新' : '请输入 API Key'}
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { backgroundColor: theme.card, borderColor: theme.border, color: theme.text }]}
        />

        <Label theme={theme} text="API Secret" />
        <View style={[styles.secretWrap, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <TextInput
            value={apiSecret}
            onChangeText={(t) => {
              setApiSecret(t);
              if (feedback) setFeedback(null);
            }}
            placeholder="请输入 API Secret"
            placeholderTextColor={theme.textMuted}
            secureTextEntry={!showSecret}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, color: theme.text, paddingVertical: 12 }}
          />
          <Pressable onPress={() => setShowSecret((v) => !v)} hitSlop={10}>
            <Ionicons
              name={showSecret ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={theme.textSecondary}
            />
          </Pressable>
        </View>

        {needPass ? (
          <>
            <Label theme={theme} text="Passphrase（口令）" />
            <TextInput
              value={passphrase}
              onChangeText={(t) => {
                setPassphrase(t);
                if (feedback) setFeedback(null);
              }}
              placeholder="请输入交易所口令"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
              ]}
            />
          </>
        ) : null}

        <View style={[styles.tip, { backgroundColor: theme.primarySoft }]}>
          <Ionicons name="shield-checkmark-outline" size={16} color={theme.primary} />
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginLeft: 8, flex: 1, lineHeight: 18 }}>
            凭证将加密存储，仅用于跟单下单，平台不会展示明文 Secret。请提前在交易所把下单 IP 加入白名单。
          </Text>
        </View>

        {!canSave ? (
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 12 }}>{missingHint()}</Text>
        ) : null}

        <View style={{ marginTop: 20 }}>
          {saving ? (
            <View style={[styles.loadingBtn, { backgroundColor: theme.primary }]}>
              <ActivityIndicator color="#fff" />
              <Text style={{ color: '#fff', marginLeft: 8, fontWeight: '700' }}>保存中…</Text>
            </View>
          ) : (
            <PrimaryButton title={configured ? '更新配置' : '保存配置'} onPress={save} />
          )}
        </View>

        {keyId ? (
          <Pressable onPress={remove} disabled={removing} style={styles.removeBtn}>
            <Text style={{ color: theme.danger, fontWeight: '600' }}>
              {removing ? '清除中…' : '清除凭证'}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Label({ theme, text }: { theme: ReturnType<typeof useTheme>['theme']; text: string }) {
  return (
    <Text style={{ color: theme.textSecondary, marginTop: 16, marginBottom: 8, fontWeight: '600' }}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  exIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  secretWrap: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 10,
    padding: 12,
    marginTop: 20,
  },
  feedback: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  removeBtn: { alignItems: 'center', paddingVertical: 16, marginTop: 4 },
  loadingBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});
