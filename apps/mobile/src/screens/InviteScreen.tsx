import * as Clipboard from 'expo-clipboard';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenHeader } from '../components/ScreenHeader';
import { AccountApi, InviteInfo, InviteMember } from '../api/endpoints';
import { fmtAmount, fmtDateTime } from '../utils/format';
import { useTheme } from '../theme/ThemeContext';
import { notify } from '../utils/notify';
import type { RootStackParamList } from '../navigation/types';

export function memberDisplayName(m: InviteMember) {
  const name = String(m.nickname || '').trim();
  if (name) return name;
  if (m.userNo != null) return `用户#${m.userNo}`;
  return '—';
}

export function InviteScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const inv = await AccountApi.invite();
      setInvite(inv);
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

  const copy = async (value: string, label: string) => {
    await Clipboard.setStringAsync(value);
    notify('已复制', label);
  };

  const members = (invite?.members || []).slice(0, 10);
  const memberCount = invite?.memberCount ?? members.length;
  const totalCommission = Number(invite?.totalCommission || 0);
  const todayCommission = Number(invite?.todayCommission || 0);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader
        title="邀请好友"
        onBack={() => navigation.goBack()}
        right={
          <Pressable onPress={() => navigation.navigate('Commission')}>
            <Text style={{ color: theme.primary, fontSize: 13 }}>佣金记录</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stat theme={theme} label="邀请人数" value={String(memberCount)} unit="人" />
          <Stat theme={theme} label="今日佣金" value={fmtAmount(todayCommission)} unit="USDT" accent />
          <Stat theme={theme} label="累计佣金" value={fmtAmount(totalCommission)} unit="USDT" accent />
        </View>

        <View style={[styles.codeCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>我的邀请码</Text>
          <Text style={{ color: theme.text, fontSize: 26, fontWeight: '800', letterSpacing: 2, marginTop: 6 }}>
            {loading ? '—' : invite?.inviteCode}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <Pressable
              onPress={() => invite && copy(invite.inviteCode, '邀请码已复制')}
              style={[styles.btn, { backgroundColor: theme.primary, flex: 1 }]}
            >
              <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center' }}>复制邀请码</Text>
            </Pressable>
          </View>
        </View>

        <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 14, lineHeight: 18 }}>
          好友用你的邀请码注册即为直推下级；其再发展的下级对你为间推。平仓分润按直推 / 间推 /
          平台比例返佣，更深层级不参与该笔分润。
        </Text>

        <View style={styles.sectionBar}>
          <Text style={{ color: theme.text, fontWeight: '700' }}>我的下级</Text>
          <Pressable onPress={() => navigation.navigate('Downlines')} hitSlop={8}>
            <Text style={{ color: theme.primary, fontSize: 13, fontWeight: '600' }}>全部</Text>
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 20 }} />
        ) : members.length === 0 ? (
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 20 }}>暂无已审核下级</Text>
        ) : (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {members.map((m, idx) => (
              <View
                key={m.id}
                style={[
                  styles.row,
                  idx < members.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.border,
                  },
                ]}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ color: theme.text, fontWeight: '600' }} numberOfLines={1}>
                    {memberDisplayName(m)}
                  </Text>
                  <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
                    加入 {fmtDateTime(m.createdAt)}
                  </Text>
                </View>
                <Text style={{ color: theme.success, fontWeight: '700' }}>
                  +{fmtAmount(m.commission)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({
  theme,
  label,
  value,
  unit,
  accent,
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  label: string;
  value: string;
  unit: string;
  accent?: boolean;
}) {
  return (
    <View style={[styles.stat, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={{ color: theme.textSecondary, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: accent ? theme.success : theme.text, fontWeight: '800', marginTop: 6 }}>{value}</Text>
      <Text style={{ color: theme.textMuted, fontSize: 10, marginTop: 2 }}>{unit}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stat: { flex: 1, borderRadius: 12, borderWidth: 1, padding: 12 },
  codeCard: { borderRadius: 14, borderWidth: 1, padding: 18, marginTop: 12 },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
  sectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    marginBottom: 10,
  },
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14 },
});
