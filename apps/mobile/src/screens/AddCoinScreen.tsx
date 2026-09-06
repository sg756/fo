import { useCallback, useMemo, useState } from 'react';
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
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { MarketApi, MarketTicker } from '../api/endpoints';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import { ScreenHeader } from '../components/ScreenHeader';

export function AddCoinScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MarketTicker[]>([]);
  const [loading, setLoading] = useState(true);
  const [added, setAdded] = useState<Record<string, boolean>>({
    'BTC/USDT': true,
    'ETH/USDT': true,
  });

  const load = useCallback(async () => {
    try {
      const res = await MarketApi.tickers('hot');
      setItems(res.items || []);
    } catch {
      setItems([]);
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

  const list = useMemo(
    () => items.filter((r) => r.pair.toLowerCase().includes(q.trim().toLowerCase())),
    [items, q],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="添加币种" onBack={() => navigation.goBack()} />
      <View style={[styles.search, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="搜索币种"
          placeholderTextColor={theme.textMuted}
          style={{ color: theme.text, paddingVertical: 10 }}
        />
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
        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
        ) : (
          list.map((row) => (
            <View key={row.pair} style={[styles.row, { borderBottomColor: theme.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontWeight: '700' }}>{row.pair}</Text>
                <Text style={{ color: theme.textSecondary, marginTop: 4 }}>{row.price}</Text>
              </View>
              <Pressable
                onPress={() => setAdded((s) => ({ ...s, [row.pair]: !s[row.pair] }))}
                style={[
                  styles.add,
                  { backgroundColor: added[row.pair] ? theme.chip : theme.primary },
                ]}
              >
                <Text
                  style={{
                    color: added[row.pair] ? theme.textSecondary : '#fff',
                    fontWeight: '800',
                  }}
                >
                  {added[row.pair] ? '✓' : '+'}
                </Text>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  search: { margin: 16, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  add: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
