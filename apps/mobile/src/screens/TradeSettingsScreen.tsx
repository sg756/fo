import * as Clipboard from 'expo-clipboard';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenHeader } from '../components/ScreenHeader';
import { PrimaryButton } from '../components/StatTile';
import { FollowConfigSection } from '../components/FollowConfigSection';
import { ExchangeKeyApi, ExchangeKeyItem, IpWhitelist, IpWhitelistApi } from '../api/endpoints';
import { EXCHANGES } from '../api/exchanges';
import { useTheme } from '../theme/ThemeContext';
import { notify } from '../utils/notify';
import type { RootStackParamList } from '../navigation/types';

type CopyFormat = 'comma' | 'space' | 'newline';

export function TradeSettingsScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [copyOpen, setCopyOpen] = useState(false);

  const [keys, setKeys] = useState<ExchangeKeyItem[]>([]);
  const [whitelist, setWhitelist] = useState<IpWhitelist | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [k, w] = await Promise.all([ExchangeKeyApi.list(), IpWhitelistApi.get()]);
      setKeys(k);
      setWhitelist(w);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const keyByExchange = keys.reduce<Record<string, ExchangeKeyItem>>((acc, k) => {
    acc[k.exchange] = k;
    return acc;
  }, {});

  const ips = whitelist?.ips ?? [];

  const copyAll = async (format: CopyFormat) => {
    if (!whitelist) return;
    const text = whitelist[format];
    await Clipboard.setStringAsync(text);
    setCopyOpen(false);
    notify('已复制', format === 'comma' ? '逗号分隔' : format === 'space' ? '空格分隔' : '换行分隔');
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="交易设置" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>交易所 API Key</Text>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {EXCHANGES.map((ex, idx) => {
            const item = keyByExchange[ex.exchange];
            const configured = !!(item?.configured ?? (item && (!ex.needPass || item.hasPassphrase)));
            const statusText = configured
              ? '已设置'
              : item
                ? '缺 Passphrase'
                : '未设置';
            return (
              <Pressable
                key={ex.exchange}
                onPress={() =>
                  navigation.navigate('ExchangeApi', {
                    exchange: ex.exchange,
                    name: ex.name,
                    needPass: ex.needPass,
                    configured,
                    keyId: item?.id,
                    apiKeyMasked: item?.apiKeyMasked,
                  })
                }
                style={[
                  styles.exRow,
                  idx < EXCHANGES.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.border,
                  },
                ]}
              >
                <Text style={{ color: theme.text, fontWeight: '600' }}>{ex.name}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View
                    style={[
                      styles.badge,
                      { backgroundColor: configured ? 'rgba(0,192,135,0.15)' : theme.chip },
                    ]}
                  >
                    <Text style={{ color: configured ? theme.success : theme.textSecondary, fontSize: 12, fontWeight: '700' }}>
                      {statusText}
                    </Text>
                  </View>
                  <Text style={{ color: theme.textSecondary }}>›</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 20 }]}>交易 IP 白名单</Text>
        <Text style={{ color: theme.textMuted, fontSize: 12, marginBottom: 10, lineHeight: 18 }}>
          以下为公网 IP（只读）。请复制到各交易所 API 白名单；币安常用逗号，部分交易所用空格。
        </Text>

        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} />
        ) : ips.length === 0 ? (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border, padding: 16 }]}>
            <Text style={{ color: theme.textMuted, textAlign: 'center' }}>暂无可用公网 IP，请联系管理员配置</Text>
          </View>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              {ips.map((ip, idx) => (
                <View
                  key={ip}
                  style={[
                    styles.ipRow,
                    idx < ips.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.border,
                    },
                  ]}
                >
                  <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }}>{ip}</Text>
                  <Pressable
                    onPress={async () => {
                      await Clipboard.setStringAsync(ip);
                      notify('已复制', ip);
                    }}
                    style={[styles.miniBtn, { backgroundColor: theme.primarySoft }]}
                  >
                    <Text style={{ color: theme.primary, fontWeight: '700', fontSize: 12 }}>复制</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            <Pressable
              onPress={() => setCopyOpen(true)}
              style={[styles.copyAll, { borderColor: theme.primary }]}
            >
              <Text style={{ color: theme.primary, fontWeight: '700' }}>复制全部 IP（选格式）</Text>
            </Pressable>
          </>
        )}

        <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 20 }]}>跟单本金与模板</Text>
        <FollowConfigSection />

        <View style={{ marginTop: 24 }}>
          <PrimaryButton title="前往开始交易" onPress={() => navigation.navigate('StartTrading')} />
        </View>
      </ScrollView>

      <Modal visible={copyOpen} transparent animationType="fade" onRequestClose={() => setCopyOpen(false)}>
        <Pressable style={styles.mask} onPress={() => setCopyOpen(false)}>
          <View style={[styles.sheet, { backgroundColor: theme.card }]}>
            <Text style={{ color: theme.text, fontWeight: '800', fontSize: 16, marginBottom: 12 }}>选择复制格式</Text>
            {(
              [
                ['comma', '逗号分隔（币安等）'],
                ['space', '空格分隔'],
                ['newline', '换行分隔'],
              ] as const
            ).map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => copyAll(key)}
                style={[styles.sheetItem, { borderColor: theme.border }]}
              >
                <Text style={{ color: theme.text }}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 10 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  exRow: { paddingHorizontal: 14, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between' },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  ipRow: { paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center' },
  miniBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  copyAll: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 18, paddingBottom: 28 },
  sheetItem: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
});
