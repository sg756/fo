import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { AssetRow } from '../components/AssetRow';
import { ScreenHeader } from '../components/ScreenHeader';
import { BalanceSummary, TradeApi } from '../api/endpoints';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';

export function HoldingsScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [data, setData] = useState<BalanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    setHint(null);
    try {
      const res = await TradeApi.balances();
      setData(res);
      if (res.errors?.length) {
        setHint(res.errors.map((e) => `${e.exchange}: ${e.message}`).join('\n'));
      }
    } catch (e: any) {
      setData(null);
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

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="持仓明细" onBack={() => navigation.goBack()} />
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
        <View style={[styles.hero, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary }}>持仓总额 (USDT)</Text>
          <Text style={{ color: theme.text, fontSize: 28, fontWeight: '800', marginTop: 8 }}>
            {data?.totalAssets ?? '0.00'}
          </Text>
        </View>
        {hint ? (
          <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 12 }}>{hint}</Text>
        ) : null}
        {loading && !data ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
        ) : (
          <View style={[styles.list, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {(data?.assets || []).length === 0 ? (
              <Text style={{ color: theme.textSecondary, paddingVertical: 20, textAlign: 'center' }}>
                暂无资产
              </Text>
            ) : (
              (data?.assets || []).map((a) => (
                <AssetRow
                  key={a.symbol}
                  symbol={a.symbol}
                  name={a.name}
                  color={a.color}
                  amount={a.amount}
                  usdt={a.usdt}
                />
              ))
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: 12, borderWidth: 1, padding: 18, marginBottom: 14 },
  list: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
});
