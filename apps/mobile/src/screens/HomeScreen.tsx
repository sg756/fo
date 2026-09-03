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

function parseAmount(raw?: string): number {
  const n = Number(String(raw || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSignedMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (n > 0) return `+${abs}`;
  if (n < 0) return `-${abs}`;
  return abs;
}

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
  const followPnl = parseAmount(data?.totalIncome);
  const commissionAmt = parseAmount(data?.commission);
  const earningsAmt = followPnl + commissionAmt;
  const pointAmt = parseAmount(data?.pointCard ?? String(data?.pointBalance ?? 0));
  const totalAssetsAmt = earningsAmt + pointAmt;
  const pendingCommissionAmt = parseAmount(data?.commissionPending);
  const claimableCommissionAmt = parseAmount(data?.commissionClaimable);
  const claimedCommissionAmt = parseAmount(
    data?.commissionClaimed ??
      String(Math.max(0, commissionAmt - claimableCommissionAmt - pendingCommissionAmt)),
  );

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
            {followOn ? '跟单运行中' : '智能跟单已就绪'}
          </Text>
        </View>
        {user?.role === 'ADMIN' ? (
          <View style={[styles.vip, { backgroundColor: theme.warning }]}>
            <Text style={{ color: '#111', fontWeight: '800', fontSize: 11 }}>管理员</Text>
          </View>
        ) : null}
      </View>

      <LinearGradientLike style={styles.banner} from={theme.bannerFrom} to={theme.bannerTo}>
        <View style={styles.bannerRow}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Text style={styles.bannerTitle}>智能跟单</Text>
            <Text style={styles.bannerSub} numberOfLines={1}>
              多平台 · 信号自动同步
            </Text>
          </View>
          <Pressable
            onPress={() => navigation.navigate('StartTrading')}
            style={styles.bannerBtn}
          >
            <Text style={{ color: theme.primary, fontWeight: '700', fontSize: 13 }}>
              {followOn ? '跟单状态' : '开启跟单'}
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
              label="累计跟单收益"
              value={data?.totalIncome ?? '0.00'}
              accent
              onPress={() => navigation.navigate('ProfitRecords')}
            />
            <StatTile
              label="收益"
              value={fmtSignedMoney(earningsAmt)}
              accent
            />
          </View>

          <View style={[styles.pointCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>点卡余额</Text>
              <Text
                style={{
                  color:
                    Number(data?.pointBalance ?? 0) < 0 ? theme.danger : theme.text,
                  fontSize: 22,
                  fontWeight: '800',
                  marginTop: 4,
                }}
              >
                {data?.pointCard ?? '0.00'}
              </Text>
            </View>
            <Pressable
              onPress={() => navigation.navigate('Recharge')}
              style={[styles.rechargeBtn, { backgroundColor: theme.primary }]}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>充值</Text>
            </Pressable>
          </View>

          <View style={styles.subStats}>
            <Pressable
              onPress={() => navigation.navigate('MyWallet')}
              style={[styles.subCard, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>总资产</Text>
              <Text
                style={{
                  color: totalAssetsAmt < 0 ? theme.danger : theme.text,
                  fontWeight: '700',
                  marginTop: 4,
                }}
              >
                {fmtMoney(totalAssetsAmt)} USDT
              </Text>
            </Pressable>
          </View>

          <View style={styles.subStats}>
            <Pressable
              onPress={() => navigation.navigate('Commission')}
              style={[styles.subCard, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>待审佣金</Text>
              <Text
                style={{
                  color: pendingCommissionAmt < 0 ? theme.danger : theme.text,
                  fontWeight: '700',
                  marginTop: 4,
                }}
              >
                {fmtMoney(pendingCommissionAmt)} USDT
              </Text>
            </Pressable>
            <Pressable
              onPress={() => navigation.navigate('Withdraw')}
              style={[styles.subCard, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>可领佣金</Text>
              <Text
                style={{
                  color: claimableCommissionAmt < 0 ? theme.danger : theme.success,
                  fontWeight: '700',
                  marginTop: 4,
                }}
              >
                {fmtMoney(claimableCommissionAmt)} USDT
              </Text>
            </Pressable>
            <Pressable
              onPress={() => navigation.navigate('Commission')}
              style={[styles.subCard, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>已领佣金</Text>
              <Text
                style={{
                  color: claimedCommissionAmt < 0 ? theme.danger : theme.text,
                  fontWeight: '700',
                  marginTop: 4,
                }}
              >
                {fmtMoney(claimedCommissionAmt)} USDT
              </Text>
            </Pressable>
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
                  symbol={`${p.pair || p.symbol}${sideLabel(p.side) ? ` · ${sideLabel(p.side)}` : ''}`}
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
  banner: { marginHorizontal: 16, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 10 },
  bannerRow: { flexDirection: 'row', alignItems: 'center' },
  bannerTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bannerSub: { color: 'rgba(255,255,255,0.85)', marginTop: 2, fontSize: 12, lineHeight: 16 },
  bannerBtn: {
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  stats: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', paddingHorizontal: 16 },
  pointCard: {
    marginHorizontal: 16,
    marginTop: 0,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rechargeBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  subStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, marginTop: 6 },
  subCard: { flex: 1, minWidth: 0, borderRadius: 12, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12 },
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
