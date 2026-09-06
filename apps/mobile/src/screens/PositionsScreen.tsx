import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { PositionFilterBar } from '../components/PositionFilterBar';
import { TradeApi, TradePosition } from '../api/endpoints';
import { useFocusPoll } from '../hooks/useFocusPoll';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import { fmtDateTimeOrDash, fmtPriceOrDash } from '../utils/format';
import { filterPositions } from '../utils/positionFilter';

export function PositionsScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [items, setItems] = useState<TradePosition[]>([]);
  const [coinQ, setCoinQ] = useState('');
  const [exchangeEx, setExchangeEx] = useState('');
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const res = await TradeApi.positions();
      if (id !== reqId.current) return;
      setItems(res.items || []);
      setHint(
        res.errors?.length ? res.errors.map((e) => `${e.exchange}: ${e.message}`).join('\n') : null,
      );
    } catch (e: any) {
      if (id !== reqId.current) return;
      setHint(e?.message || '加载失败');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(load);
  useFocusPoll(load, 2000);
  const list = useMemo(
    () => filterPositions(items, { coinQ, exchange: exchangeEx }),
    [items, coinQ, exchangeEx],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="持仓列表" onBack={() => navigation.goBack()} />
      <PositionFilterBar
        theme={theme}
        coinQ={coinQ}
        onCoinQ={setCoinQ}
        exchange={exchangeEx}
        onExchange={setExchangeEx}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
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
          <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 12 }}>{hint}</Text>
        ) : null}
        {loading && items.length === 0 ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
        ) : items.length === 0 ? (
          <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>暂无持仓</Text>
        ) : list.length === 0 ? (
          <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>没有匹配的持仓</Text>
        ) : (
          list.map((p) => (
            <View key={p.id} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <View style={styles.top}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: '800', fontSize: 16 }}>{p.pair}</Text>
                  <View
                    style={[
                      styles.side,
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
                      }}
                    >
                      {p.side === 'long' ? '多' : '空'}
                    </Text>
                  </View>
                </View>
                <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                  {p.exchange} · {p.mode}
                </Text>
              </View>

              <View style={styles.grid}>
                <Cell theme={theme} label="数量" value={p.amount} />
                <Cell
                  theme={theme}
                  label="开仓价格"
                  value={fmtPriceOrDash(p.entryPrice)}
                />
                <Cell
                  theme={theme}
                  label="订单号"
                  value={
                    p.orderIds && p.orderIds.length > 1
                      ? p.orderIds.join(', ')
                      : p.orderId || '—'
                  }
                />
                <Cell theme={theme} label="开仓时间" value={fmtDateTimeOrDash(p.openTime)} />
                <Cell theme={theme} label="持仓时长" value={p.holdDuration || '—'} />
                {p.pnl != null ? (
                  <Cell theme={theme} label="盈亏" value={p.pnl} valueColor={theme.success} />
                ) : null}
              </View>
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
  valueColor,
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.cell}>
      <Text style={{ color: theme.textSecondary, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: valueColor ?? theme.text, fontWeight: '700', marginTop: 4, fontSize: 13 }}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 12 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  side: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, marginLeft: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '50%', marginBottom: 12 },
});
