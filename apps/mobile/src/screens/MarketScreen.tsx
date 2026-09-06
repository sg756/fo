import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sparkline } from '../components/Sparkline';
import { MarketApi, MarketTicker } from '../api/endpoints';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';

type MarketTab = 'favorites' | 'hot' | 'gainers' | 'losers';

const TABS: { key: MarketTab; label: string }[] = [
  { key: 'favorites', label: '自选' },
  { key: 'hot', label: '热门' },
  { key: 'gainers', label: '涨幅榜' },
  { key: 'losers', label: '跌幅榜' },
];

export function MarketScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [tab, setTab] = useState<MarketTab>('hot');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MarketTicker[]>([]);
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(async (t: MarketTab, query: string) => {
    setHint(null);
    try {
      const res = await MarketApi.tickers(t, query || undefined);
      setItems(res.items || []);
      if (res.error) setHint(`行情源: ${res.error}`);
    } catch (e: any) {
      setItems([]);
      setHint(e?.message || '行情加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(
    useCallback(() => load(tab, q), [load, tab, q]),
  );

  useEffect(() => {
    setLoading(true);
    load(tab, q);
    const id = setInterval(() => load(tab, q), 30000);
    return () => clearInterval(id);
  }, [tab, q, load]);

  const list = useMemo(() => items, [items]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }}>
      <View style={styles.top}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {navigation.canGoBack() ? (
            <Pressable
              onPress={() => navigation.goBack()}
              hitSlop={12}
              style={{ marginRight: 4, marginLeft: -4 }}
            >
              <Ionicons name="chevron-back" size={28} color={theme.text} />
            </Pressable>
          ) : null}
          <Text style={{ color: theme.text, fontSize: 22, fontWeight: '800' }}>行情</Text>
        </View>
        <Pressable onPress={() => navigation.navigate('AddCoin')}>
          <Text style={{ color: theme.primary, fontWeight: '600' }}>添加币种</Text>
        </Pressable>
      </View>

      <View style={[styles.search, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={{ color: theme.textMuted, marginRight: 8 }}>⌕</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="搜索交易对"
          placeholderTextColor={theme.textMuted}
          style={{ flex: 1, color: theme.text, paddingVertical: 10 }}
        />
      </View>

      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable key={t.key} onPress={() => setTab(t.key)} style={styles.tab}>
            <Text
              style={{
                color: tab === t.key ? theme.primary : theme.textSecondary,
                fontWeight: tab === t.key ? '700' : '500',
              }}
            >
              {t.label}
            </Text>
            {tab === t.key ? <View style={[styles.underline, { backgroundColor: theme.primary }]} /> : null}
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.primary}
            onRefresh={onRefresh}
          />
        }
      >
        {hint ? (
          <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 10 }}>{hint}</Text>
        ) : null}
        {loading && list.length === 0 ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 40 }} />
        ) : list.length === 0 ? (
          <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>暂无行情</Text>
        ) : (
          list.map((row) => {
            const positive = row.change >= 0;
            return (
              <View key={row.pair} style={[styles.row, { borderBottomColor: theme.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: '700' }}>{row.pair}</Text>
                  <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>24H</Text>
                </View>
                <Sparkline data={row.spark?.length ? row.spark : [40, 42, 45, 48]} positive={positive} />
                <View style={{ width: 88, alignItems: 'flex-end', marginLeft: 10 }}>
                  <Text style={{ color: theme.text, fontWeight: '600' }}>{row.price}</Text>
                  <Text
                    style={{
                      color: positive ? theme.success : theme.danger,
                      marginTop: 4,
                      fontWeight: '600',
                    }}
                  >
                    {positive ? '+' : ''}
                    {row.change.toFixed(2)}%
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  search: {
    marginHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tabs: { flexDirection: 'row', paddingHorizontal: 8, marginTop: 8 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  underline: { marginTop: 6, height: 2, width: 22, borderRadius: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
