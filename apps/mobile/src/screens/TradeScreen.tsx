import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TradeApi, TradeOrder, TradePosition } from '../api/endpoints';
import { useFocusPoll } from '../hooks/useFocusPoll';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';
import { fmtDateTimeOrDash, fmtPriceOrDash } from '../utils/format';
import { filterPositions } from '../utils/positionFilter';
import { PositionFilterBar } from '../components/PositionFilterBar';

type Tab = 'positions' | 'orders';

export function TradeScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [tab, setTab] = useState<Tab>('positions');
  const [positions, setPositions] = useState<TradePosition[]>([]);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [coinQ, setCoinQ] = useState('');
  const [exchangeEx, setExchangeEx] = useState('');
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const reqId = useRef(0);
  const filteredPositions = useMemo(
    () => filterPositions(positions, { coinQ, exchange: exchangeEx }),
    [positions, coinQ, exchangeEx],
  );
  const posFilterOn = !!coinQ.trim() || !!exchangeEx;

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const [p, o] = await Promise.all([TradeApi.positions(), TradeApi.orders()]);
      if (id !== reqId.current) return;
      setPositions(p.items || []);
      setOrders(o.items || []);
      const errs = [...(p.errors || []), ...(o.errors || [])];
      setHint(errs.length ? errs.map((e) => `${e.exchange}: ${e.message}`).join('\n') : null);
    } catch (e: any) {
      if (id !== reqId.current) return;
      // 切后台/网络抖动时保留已有列表，避免被空数据覆盖
      setHint(e?.message || '加载失败（请确认已配置交易所 API Key）');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(load);
  useFocusPoll(load, 2000);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }}>
      <View style={styles.top}>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: '800', lineHeight: 24 }}>交易</Text>
        <View style={styles.topActions}>
          <Pressable
            onPress={() => navigation.navigate('TradeSettings')}
            style={[styles.marketBtn, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Ionicons name="settings-outline" size={15} color={theme.primary} />
            <Text style={{ color: theme.primary, fontWeight: '600', marginLeft: 6, fontSize: 13 }}>
              交易设置
            </Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('Market')}
            style={[styles.marketBtn, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Ionicons name="stats-chart-outline" size={15} color={theme.primary} />
            <Text style={{ color: theme.primary, fontWeight: '600', marginLeft: 6, fontSize: 13 }}>行情</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.segmentWrap}>
        {(
          [
            ['positions', '持仓', posFilterOn ? filteredPositions.length : positions.length],
            ['orders', '委托', orders.length],
          ] as const
        ).map(([key, label, count]) => {
          const active = tab === key;
          return (
            <Pressable key={key} onPress={() => setTab(key)} style={styles.segment}>
              <View style={styles.segmentLabel}>
                <Text
                  style={{
                    color: active ? theme.text : theme.textSecondary,
                    fontWeight: active ? '800' : '500',
                    fontSize: 15,
                  }}
                >
                  {label}
                </Text>
                <Text
                  style={{
                    color: active ? theme.primary : theme.textMuted,
                    fontWeight: '800',
                    fontSize: 13,
                    marginLeft: 6,
                  }}
                >
                  {count}
                </Text>
              </View>
              {active ? <View style={[styles.segmentBar, { backgroundColor: theme.primary }]} /> : null}
            </Pressable>
          );
        })}
      </View>

      {tab === 'positions' ? (
        <PositionFilterBar
          theme={theme}
          coinQ={coinQ}
          onCoinQ={setCoinQ}
          exchange={exchangeEx}
          onExchange={setExchangeEx}
        />
      ) : null}

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.primary}
            onRefresh={onRefresh}
          />
        }
      >
        {hint ? (
          <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 12, lineHeight: 18 }}>{hint}</Text>
        ) : null}

        {loading && positions.length === 0 && orders.length === 0 ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 40 }} />
        ) : tab === 'positions' ? (
          positions.length === 0 ? (
            <Empty theme={theme} text="暂无持仓" />
          ) : filteredPositions.length === 0 ? (
            <Empty theme={theme} text="没有匹配的持仓" />
          ) : (
            filteredPositions.map((p) => (
              <View key={p.id} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <View style={styles.cardTop}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <Text style={{ color: theme.text, fontWeight: '800', fontSize: 16 }}>{p.pair}</Text>
                    <View
                      style={[
                        styles.tag,
                        {
                          backgroundColor:
                            p.side === 'long' ? 'rgba(0,192,135,0.15)' : 'rgba(246,70,93,0.15)',
                        },
                      ]}
                    >
                      <Text
                        style={{
                          color: p.side === 'long' ? theme.success : theme.danger,
                          fontWeight: '800',
                          fontSize: 11,
                        }}
                      >
                        {p.side === 'long' ? '多' : '空'}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ color: theme.textMuted, fontSize: 12 }}>
                    {p.exchange} · {p.mode}
                  </Text>
                </View>
                <View style={styles.grid}>
                  <Cell theme={theme} label="数量" value={p.amount} />
                  <Cell theme={theme} label="开仓价格" value={fmtPriceOrDash(p.entryPrice)} />
                  <Cell theme={theme} label="开仓时间" value={fmtDateTimeOrDash(p.openTime)} />
                </View>
              </View>
            ))
          )
        ) : orders.length === 0 ? (
          <Empty theme={theme} text="暂无委托" />
        ) : (
          orders.map((o) => (
            <View key={o.id} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <View style={styles.cardTop}>
                <View>
                  <Text style={{ color: theme.text, fontWeight: '800' }}>{o.pair}</Text>
                  <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>
                    {o.exchange} · {o.mode} · {o.type}
                  </Text>
                </View>
                <Text style={{ color: theme.primary, fontWeight: '700' }}>{o.status}</Text>
              </View>
              <Text style={{ color: theme.text, marginBottom: 6 }}>{o.side}</Text>
              <Line theme={theme} k="委托价" v={o.price} />
              <Line theme={theme} k="委托量 / 已成交" v={`${o.amount} / ${o.filled}`} />
              <Line theme={theme} k="时间" v={fmtDateTimeOrDash(o.time)} last />
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function Cell({
  theme,
  label,
  value,
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  label: string;
  value: string;
}) {
  return (
    <View style={styles.cell}>
      <Text style={{ color: theme.textSecondary, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: theme.text, fontWeight: '700', marginTop: 4, fontSize: 13 }}>{value}</Text>
    </View>
  );
}

function Line({
  theme,
  k,
  v,
  last,
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  k: string;
  v: string;
  last?: boolean;
}) {
  return (
    <View
      style={[styles.line, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }]}
    >
      <Text style={{ color: theme.textSecondary }}>{k}</Text>
      <Text style={{ color: theme.text, fontWeight: '600' }}>{v}</Text>
    </View>
  );
}

function Empty({ theme, text }: { theme: ReturnType<typeof useTheme>['theme']; text: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 60 }}>
      <Ionicons name="documents-outline" size={40} color={theme.textMuted} />
      <Text style={{ color: theme.textMuted, marginTop: 12 }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  marketBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  segmentWrap: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 2 },
  segment: { marginRight: 28, alignItems: 'center', paddingTop: 4, paddingBottom: 2 },
  segmentLabel: { flexDirection: 'row', alignItems: 'center' },
  segmentBar: { marginTop: 3, height: 2, width: 22, borderRadius: 1 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 12 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginLeft: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '50%', marginBottom: 12 },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
});
