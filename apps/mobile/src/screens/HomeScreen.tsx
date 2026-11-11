import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradientLike } from '../components/Banner';
import { AssetRow } from '../components/AssetRow';
import { StatTile } from '../components/StatTile';
import { HomeSummary, TradeApi, TradePosition } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';
import { positionCoin, positionProductLabel } from '../utils/positionQuote';

function sideLabel(side?: string) {
  const s = String(side || '').toLowerCase();
  if (s === 'long') return '多';
  if (s === 'short') return '空';
  return side || '';
}

export function HomeScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [data, setData] = useState<HomeSummary | null>(null);
  const [positions, setPositions] = useState<TradePosition[]>([]);
  const [posLoading, setPosLoading] = useState(false);
  const [posHint, setPosHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);

  const loadPositions = useCallback(async () => {
    setPosHint(null);
    setPosLoading(true);
    try {
      const res = await TradeApi.positions();
      setPositions(res.items || []);
      if (res.errors?.length) {
        setPosHint(res.errors.map((e) => `${e.exchange}: ${e.message}`).join('\n'));
      }
    } catch (e: any) {
      setPositions([]);
      setPosHint(e?.message || '持仓加载失败');
    } finally {
      setPosLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setHint(null);
    try {
      const s = await TradeApi.homeSummary();
      setData(s);
      if (s.balanceErrors?.length) {
        setHint(s.balanceErrors.map((e) => `${e.exchange}: ${e.message}`).join('\n'));
      }
    } catch (e: any) {
      setHint(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
    // 持仓单独拉，失败不影响收益/点卡展示
    void loadPositions();
  }, [loadPositions]);

  const { refreshing, onRefresh } = useSafeRefresh(load);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  const name = data?.user?.name || user?.nickname || user?.email?.split('@')[0] || '用户';
  const initial = name.slice(0, 1).toUpperCase();
  const followOn = data?.user?.followEnabled ?? user?.followEnabled;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingBottom: 28, paddingTop: insets.top + 8 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={theme.primary}
            onRefresh={onRefresh}
        />
      }
    >
      <View style={styles.header}>
        <View style={[styles.avatar, { backgroundColor: theme.primary }]}>
          <Text style={{ color: '#fff', fontWeight: '800' }}>{initial}</Text>
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ color: theme.text, fontWeight: '700', fontSize: 16 }}>{name}</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>
            {followOn ? '合约运行中' : '智能合约已就绪'}
          </Text>
        </View>
        {user?.role === 'ADMIN' ? (
          <View style={[styles.vip, { backgroundColor: theme.warning }]}>
            <Text style={{ color: '#111', fontWeight: '800', fontSize: 11 }}>管理员</Text>
          </View>
        ) : null}
      </View>

      <LinearGradientLike style={styles.banner} from={theme.bannerFrom} to={theme.bannerTo}>
        <Text style={styles.bannerTitle}>智能合约</Text>
        <Text style={styles.bannerSub}>多平台 · 信号自动同步</Text>
        <View style={styles.bannerActions}>
          <Pressable
            onPress={() => navigation.navigate('StartTrading')}
            style={styles.bannerBtn}
          >
            <Text style={[styles.bannerBtnText, { color: theme.primary }]}>合约状态</Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('TradeSettings')}
            style={styles.bannerBtn}
          >
            <Text style={[styles.bannerBtnText, { color: theme.primary }]}>
              {followOn ? '合约设置' : '开启合约'}
            </Text>
          </Pressable>
        </View>
      </LinearGradientLike>

      {hint ? (
        <Text style={{ color: theme.warning, fontSize: 12, marginHorizontal: 16, marginBottom: 8 }}>
          {hint}
        </Text>
      ) : null}

      {loading && !data ? (
        <ActivityIndicator color={theme.primary} style={{ marginVertical: 24 }} />
      ) : (
        <>
          <View style={styles.stats}>
            <StatTile label="今日收益" value={data?.today ?? '0.00'} accent />
            <StatTile label="7日收益" value={data?.week ?? '0.00'} accent />
            <StatTile
              label="累计合约收益"
              value={data?.totalIncome ?? '0.00'}
              accent
              onPress={() => navigation.navigate('ProfitRecords')}
            />
            <View style={[styles.pointCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>点卡余额</Text>
              <View style={styles.pointRow}>
                <Text
                  style={{
                    flex: 1,
                    color: Number(data?.pointBalance ?? 0) < 0 ? theme.danger : theme.text,
                    fontSize: 16,
                    fontWeight: '700',
                  }}
                  numberOfLines={1}
                >
                  {data?.pointCard ?? '0.00'}
                </Text>
                <Pressable
                  onPress={() => navigation.navigate('Recharge')}
                  style={[styles.rechargeBtn, { backgroundColor: theme.primary }]}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>充值</Text>
                </Pressable>
              </View>
            </View>
          </View>

          <View style={styles.sectionHead}>
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: 16 }}>持仓汇总</Text>
            <Pressable onPress={() => navigation.navigate('Main', { screen: 'Trade' })}>
              <Text style={{ color: theme.primary, fontSize: 13 }}>全部 ›</Text>
            </Pressable>
          </View>

          {posHint ? (
            <Text
              style={{ color: theme.warning, fontSize: 12, marginHorizontal: 16, marginBottom: 8 }}
            >
              {posHint}
            </Text>
          ) : null}

          <View style={[styles.listCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {posLoading && positions.length === 0 ? (
              <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} />
            ) : positions.length === 0 ? (
              <Text style={{ color: theme.textSecondary, paddingVertical: 16, textAlign: 'center' }}>
                {data?.hasApiKey ? '暂无持仓' : '暂无持仓（请先配置交易所 API Key）'}
              </Text>
            ) : (
              positions.slice(0, 10).map((p) => (
                <AssetRow
                  key={p.id}
                  symbol={[positionCoin(p), positionProductLabel(p), sideLabel(p.side)]
                    .filter(Boolean)
                    .join(' · ')}
                  color={theme.primary}
                  amount={p.amount}
                  hint={p.entryPrice ? `开仓 ${p.entryPrice}` : undefined}
                  onPress={() => navigation.navigate('Main', { screen: 'Trade' })}
                />
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 16 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  vip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  banner: { marginHorizontal: 16, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 14, marginBottom: 10 },
  bannerTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bannerSub: { color: 'rgba(255,255,255,0.85)', marginTop: 2, fontSize: 12, lineHeight: 16 },
  bannerActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  bannerBtn: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 8,
  },
  bannerBtnText: { fontWeight: '700', fontSize: 13 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', paddingHorizontal: 16 },
  pointCard: {
    width: '48%',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    marginBottom: 6,
  },
  pointRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  rechargeBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  sectionHead: {
    paddingHorizontal: 16,
    marginTop: 14,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  listCard: { marginHorizontal: 16, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
});
