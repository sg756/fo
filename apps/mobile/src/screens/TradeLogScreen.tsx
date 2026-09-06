import { useCallback, useMemo, useState } from 'react';
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
import { ScreenHeader } from '../components/ScreenHeader';
import { ProfitItem, TradeApi } from '../api/endpoints';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';
import { fmtDateTimeOrDash } from '../utils/format';

type Filter = 'all' | 'open_ok' | 'close_ok';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'open_ok', label: '开仓成功' },
  { key: 'close_ok', label: '平仓成功' },
];

function sideText(side?: string | null) {
  const s = String(side || '').toLowerCase();
  if (s === 'long') return '多';
  if (s === 'short') return '空';
  return side || '';
}

/** 交易日志：仅开仓成功 / 平仓成功 */
export function TradeLogScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<ProfitItem[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    setHint(null);
    try {
      const list = await TradeApi.followHistory(0, 100);
      setItems(list || []);
    } catch (e: any) {
      setItems([]);
      setHint(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(load);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (it.status && it.status !== 'FILLED') return false;
      if (filter === 'all') return true;
      if (filter === 'open_ok') return it.kind === 'open' || it.isOpen === true;
      if (filter === 'close_ok') return it.kind === 'close' || it.isOpen === false;
      return true;
    });
  }, [items, filter]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="交易日志" onBack={() => navigation.goBack()} />
      <Text
        style={{
          color: theme.textMuted,
          fontSize: 12,
          lineHeight: 18,
          paddingHorizontal: 16,
          marginBottom: 8,
        }}
      >
        仅展示开仓成功与平仓成功。
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginBottom: 8 }}>
        {FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[
                styles.chip,
                {
                  backgroundColor: on ? theme.primary : theme.card,
                  borderColor: on ? theme.primary : theme.border,
                },
              ]}
            >
              <Text style={{ color: on ? '#fff' : theme.textSecondary, fontWeight: '700', fontSize: 13 }}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={theme.primary}
              onRefresh={onRefresh}
            />
          }
        >
          {hint ? (
            <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 12 }}>{hint}</Text>
          ) : null}
          {filtered.length === 0 ? (
            <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>
              暂无记录
            </Text>
          ) : (
            filtered.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => navigation.navigate('OrderDetail', { item, kind: 'follow' })}
                style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
              >
                <View style={styles.row}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={{ color: theme.text, fontWeight: '800' }}>
                      {item.kindLabel || (item.isOpen === false ? '平仓' : '开仓')} · {item.pair}
                      {sideText(item.positionSide) ? ` · ${sideText(item.positionSide)}` : ''}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>
                      {item.exchange} · 数量 {item.amount}
                      {item.avgPrice ? ` · 均价 ${item.avgPrice}` : ''}
                    </Text>
                  </View>
                  <Text style={{ color: theme.primary, fontWeight: '800', fontSize: 13 }}>
                    {item.statusLabel ||
                      (item.isOpen === false ? '平仓成功' : '开仓成功')}
                  </Text>
                </View>
                <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 8 }}>
                  {fmtDateTimeOrDash(item.openTime)}
                  {item.orderId ? ` · 订单 ${String(item.orderId).slice(0, 10)}…` : ''}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
  },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
});
