import { useCallback, useRef, useState } from 'react';
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
import { TradeApi, TradeOrder } from '../api/endpoints';
import { useFocusPoll } from '../hooks/useFocusPoll';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import { fmtDateTimeOrDash } from '../utils/format';

function statusLabel(o: TradeOrder): string {
  if (o.status === 'FAILED') {
    if (o.isOpen === true) return '开仓失败';
    if (o.isOpen === false) return '平仓失败';
    return '下单失败';
  }
  const map: Record<string, string> = {
    PLACED: '挂单中',
    CANCEL_FAILED: '撤单失败',
    PENDING: '准备中',
    FILLED: '已成交',
    CANCELLED: '已撤单',
  };
  return map[o.status] || o.status;
}

function reasonOf(o: TradeOrder): string | null {
  const r = String(o.failReason || o.errorMsg || o.cancelMsg || '').trim();
  return r || null;
}

/** 委托只读展示；失败项展示具体原因 */
export function OpenOrdersScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [items, setItems] = useState<TradeOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const res = await TradeApi.orders();
      if (id !== reqId.current) return;
      setItems(res.items || []);
      const failHint = (res.items || [])
        .map((o) => {
          const reason = reasonOf(o);
          if (!reason) return null;
          if (o.status !== 'CANCEL_FAILED' && o.status !== 'FAILED') return null;
          return `${o.pair}: ${reason}`;
        })
        .filter(Boolean)
        .slice(0, 3)
        .join('\n');
      const errHint = res.errors?.length
        ? res.errors.map((e) => `${e.exchange}: ${e.message}`).join('\n')
        : '';
      setHint([failHint, errHint].filter(Boolean).join('\n') || null);
    } catch (e: any) {
      if (id !== reqId.current) return;
      setHint(e?.message || '加载失败');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(load);
  useFocusPoll(load, 2000);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="委托列表" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.primary}
            onRefresh={onRefresh}
          />
        }
      >
        <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 12 }}>
          委托由系统自动管理；开仓/下单失败仅后台可见，此处展示挂单中与撤单失败。
        </Text>
        {hint ? (
          <Text style={{ color: theme.danger, fontSize: 12, marginBottom: 12 }}>{hint}</Text>
        ) : null}
        {loading && items.length === 0 ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
        ) : items.length === 0 ? (
          <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>
            暂无委托
          </Text>
        ) : (
          items.map((o) => {
            const oid = o.orderId || o.id;
            const failed = o.status === 'CANCEL_FAILED' || o.status === 'FAILED';
            const reason = reasonOf(o);
            return (
              <View
                key={`${o.exchange}-${oid}-${o.status}-${o.time}`}
                style={[
                  styles.card,
                  { backgroundColor: theme.card, borderColor: failed ? theme.danger : theme.border },
                ]}
              >
                <View style={styles.top}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={{ color: theme.text, fontWeight: '800' }}>{o.pair}</Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>
                      {o.exchange} · {o.mode} · {o.type}
                    </Text>
                  </View>
                  <Text style={{ color: failed ? theme.danger : theme.primary, fontWeight: '700' }}>
                    {statusLabel(o)}
                  </Text>
                </View>
                <Text style={{ color: theme.text, marginBottom: 8 }}>{o.side}</Text>
                <Row theme={theme} k="委托价" v={o.price} />
                <Row theme={theme} k="委托量 / 已成交" v={`${o.amount} / ${o.filled}`} />
                <Row theme={theme} k="时间" v={fmtDateTimeOrDash(o.time)} last={!reason} />
                {reason ? (
                  <View style={{ marginTop: 10 }}>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 4 }}>
                      原因
                    </Text>
                    <Text style={{ color: theme.danger, fontSize: 13, fontWeight: '600', lineHeight: 18 }}>
                      {reason}
                    </Text>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

function Row({
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
      style={[
        styles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
      ]}
    >
      <Text style={{ color: theme.textSecondary }}>{k}</Text>
      <Text style={{ color: theme.text, fontWeight: '600' }}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 12 },
  top: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
});
