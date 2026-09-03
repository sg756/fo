import * as Clipboard from 'expo-clipboard';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradientLike } from '../components/Banner';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../auth/AuthContext';
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
  | 'Settings';

const MENUS: {
  title: string;
  icon: IoniconName;
  route: MenuRoute;
  badge?: string;
}[] = [
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

  const displayName = user?.nickname || user?.email?.split('@')[0] || '用户';
  const roleLabel =
    user?.role === 'ADMIN' ? '管理员' : '用户';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 28 }}
    >
      <View style={styles.profile}>
        <Image
          source={{ uri: 'https://i.pravatar.cc/120?img=12' }}
          style={[styles.avatar, { borderColor: theme.border }]}
        />
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

      <LinearGradientLike style={styles.promoCard} from={theme.bannerFrom} to={theme.bannerTo}>
        <View style={{ flex: 1 }}>
          <Text style={styles.promoTitle}>智能跟单 · 稳健收益</Text>
          <Text style={styles.promoSub}>多平台 · 多策略 · 自动同步下单</Text>
        </View>
        <View style={styles.promoIcon}>
          <Ionicons name="trending-up" size={26} color="#fff" />
        </View>
      </LinearGradientLike>

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
  avatar: { width: 58, height: 58, borderRadius: 29, borderWidth: 1 },
  vip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginLeft: 8,
  },
  promoCard: {
    marginHorizontal: 16,
    borderRadius: 14,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  promoTitle: { color: '#fff', fontWeight: '800', fontSize: 17 },
  promoSub: { color: 'rgba(255,255,255,0.85)', marginTop: 6, fontSize: 12 },
  promoIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: { marginHorizontal: 16, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 15 },
  logout: {
    marginHorizontal: 16,
    marginTop: 20,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 16,
    alignItems: 'center',
  },
});
