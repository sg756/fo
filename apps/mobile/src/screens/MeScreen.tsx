import { useCallback, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AccountApi, PointCard } from '../api/endpoints';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../auth/AuthContext';
import { fmtAmount } from '../utils/format';
import { notify } from '../utils/notify';
import type { RootStackParamList } from '../navigation/types';

type IoniconName = keyof typeof Ionicons.glyphMap;

type MenuRoute =
  | 'MyWallet'
  | 'FundFlow'
  | 'ProfitRecords'
  | 'TradeLog'
  | 'Invite'
  | 'Security'
  | 'Settings'
  | 'Notices';

const MENUS: {
  title: string;
  icon: IoniconName;
  route: MenuRoute;
  badge?: string;
}[] = [
  { title: '消息通知', icon: 'notifications-outline', route: 'Notices' },
  { title: '我的点卡', icon: 'wallet-outline', route: 'MyWallet' },
  { title: '资金流水', icon: 'swap-horizontal-outline', route: 'FundFlow' },
  { title: '收益记录', icon: 'receipt-outline', route: 'ProfitRecords' },
  { title: '交易日志', icon: 'list-outline', route: 'TradeLog' },
  { title: '邀请好友', icon: 'people-outline', route: 'Invite', badge: '返佣奖励' },
  { title: '安全中心', icon: 'shield-checkmark-outline', route: 'Security' },
  { title: '设置', icon: 'settings-outline', route: 'Settings' },
];

export function MeScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { logout, user } = useAuth();
  const [card, setCard] = useState<PointCard | null>(null);
  const [unread, setUnread] = useState(0);

  const loadCard = useCallback(async () => {
    try {
      setCard(await AccountApi.pointCard());
    } catch {
      // 金额保持上次结果
    }
    try {
      const r = await AccountApi.noticeUnread();
      setUnread(Number(r.unread) || 0);
    } catch {
      setUnread(0);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadCard();
    }, [loadCard]),
  );

  const pending = Number(card?.commissionPending ?? 0);
  const claimable = Number(card?.withdrawable ?? card?.commissionBalance ?? 0);
  const claimed = Number(card?.commissionClaimed ?? 0);

  const displayName = user?.nickname || user?.email?.split('@')[0] || '用户';
  const initial = displayName.slice(0, 1).toUpperCase();
  const roleLabel =
    user?.role === 'ADMIN' ? '管理员' : '用户';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 28 }}
    >
      <View style={styles.profile}>
        <View style={[styles.avatar, { backgroundColor: theme.primary }]}>
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 22 }}>{initial}</Text>
        </View>
        <View style={{ marginLeft: 14, flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ color: theme.text, fontSize: 20, fontWeight: '800' }}>{displayName}</Text>
            <View style={[styles.vip, { backgroundColor: theme.primarySoft }]}>
              <Text style={{ color: theme.primary, fontWeight: '800', fontSize: 11 }}>{roleLabel}</Text>
            </View>
          </View>
          {user?.inviteCode ? (
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(user.inviteCode);
                notify('已复制', `邀请码 ${user.inviteCode}`);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}
            >
              <Text style={{ color: theme.textSecondary }}>邀请码 {user.inviteCode}</Text>
              <Ionicons
                name="copy-outline"
                size={16}
                color={theme.primary}
                style={{ marginLeft: 8 }}
              />
            </Pressable>
          ) : (
            <Text style={{ color: theme.textMuted, marginTop: 6 }}>暂无邀请码</Text>
          )}
        </View>
      </View>

      <View style={styles.stats}>
        <Pressable
          onPress={() => navigation.navigate('Commission')}
          style={[styles.stat, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>待审佣金</Text>
          <Text style={{ color: pending < 0 ? theme.danger : theme.text, fontWeight: '700', marginTop: 4 }}>
            {fmtAmount(pending)} USDT
          </Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('Withdraw')}
          style={[styles.stat, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>可领佣金</Text>
          <Text style={{ color: claimable < 0 ? theme.danger : theme.success, fontWeight: '700', marginTop: 4 }}>
            {fmtAmount(claimable)} USDT
          </Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('Commission')}
          style={[styles.stat, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>已领佣金</Text>
          <Text style={{ color: claimed < 0 ? theme.danger : theme.text, fontWeight: '700', marginTop: 4 }}>
            {fmtAmount(claimed)} USDT
          </Text>
        </Pressable>
      </View>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        {MENUS.map((item, idx) => (
          <Pressable
            key={item.route}
            onPress={() => navigation.navigate(item.route)}
            style={[
              styles.row,
              idx < MENUS.length - 1 && {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: theme.border,
              },
            ]}
          >
            <Ionicons name={item.icon} size={20} color={theme.textSecondary} />
            <Text style={{ color: theme.text, fontWeight: '600', marginLeft: 12, flex: 1 }}>{item.title}</Text>
            {item.route === 'Notices' && unread > 0 ? (
              <View style={[styles.dot, { backgroundColor: theme.danger }]} />
            ) : null}
            {item.badge ? (
              <Text style={{ color: theme.warning, fontSize: 12, marginRight: 6 }}>{item.badge}</Text>
            ) : null}
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </Pressable>
        ))}
      </View>

      <Pressable
        onPress={logout}
        style={[styles.logout, { backgroundColor: theme.card, borderColor: theme.border }]}
      >
        <Text style={{ color: theme.text, fontWeight: '700' }}>退出登录</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 16 },
  avatar: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center' },
  vip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginLeft: 8,
  },
  stats: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 16 },
  stat: { flex: 1, borderRadius: 12, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 10 },
  card: { marginHorizontal: 16, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 15 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  logout: {
    marginHorizontal: 16,
    marginTop: 20,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 16,
    alignItems: 'center',
  },
});
