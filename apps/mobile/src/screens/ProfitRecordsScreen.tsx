import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { ScreenHeader } from '../components/ScreenHeader';
import { DatePickerField } from '../components/DatePickerField';
import { ProfitItem, TradeApi } from '../api/endpoints';
import { EXCHANGES } from '../api/exchanges';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';
import { fmtDateTimeOrDash, fmtProfitSigned, fmtSigned } from '../utils/format';
import { exchangeLabel } from '../utils/positionFilter';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEB_INPUT =
  Platform.OS === 'web'
    ? ({
        outlineWidth: 0,
        outlineStyle: 'none',
        outlineColor: 'transparent',
        boxShadow: 'none',
        borderWidth: 0,
      } as const)
    : {};

const EX_OPTIONS = [{ code: '', name: '全部交易所' }, ...EXCHANGES.map((e) => ({ code: e.exchange, name: e.name }))];

function normalizeDayInput(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (DAY_RE.test(s)) return s;
  return s;
}

function parseProfitList(raw: ProfitItem[] | { items?: ProfitItem[]; total?: number; sum?: number } | null | undefined): {
  items: ProfitItem[];
  total: number;
  sum: number;
} {
  if (Array.isArray(raw)) {
    const items = raw;
    const sum = items.reduce((s, i) => s + Number(i.pnlNum || 0), 0);
    return { items, total: items.length, sum };
  }
  const items = raw?.items || [];
  return {
    items,
    total: Number(raw?.total ?? items.length),
    sum: Number(raw?.sum ?? 0),
  };
}

/** 收益记录：仅历史持仓（平仓盈亏） */
export function ProfitRecordsScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<ProfitItem[]>([]);
  const [total, setTotal] = useState(0);
  const [sum, setSum] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const [exOpen, setExOpen] = useState(false);

  const [exchange, setExchange] = useState('');
  const [coinQ, setCoinQ] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [applied, setApplied] = useState({ exchange: '', coin: '', from: '', to: '' });

  const load = useCallback(async () => {
    setHint(null);
    try {
      const rec = parseProfitList(
        await TradeApi.profits(0, 200, {
          exchange: applied.exchange || undefined,
          coin: applied.coin || undefined,
          from: applied.from || undefined,
          to: applied.to || undefined,
        }),
      );
      setItems(rec.items);
      setTotal(rec.total);
      setSum(rec.sum);
    } catch (e: any) {
      setItems([]);
      setTotal(0);
      setSum(0);
      setHint(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [applied]);

  const { refreshing, onRefresh } = useSafeRefresh(load);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load]),
  );

  function search() {
    const from = normalizeDayInput(fromDate);
    const to = normalizeDayInput(toDate);
    if (from && !DAY_RE.test(from)) {
      setHint('开始日期格式不正确');
      return;
    }
    if (to && !DAY_RE.test(to)) {
      setHint('结束日期格式不正确');
      return;
    }
    if (from && to && from > to) {
      setHint('开始日期不能晚于结束日期');
      return;
    }
    setApplied({ exchange, coin: coinQ.trim(), from, to });
  }

  function resetFilters() {
    setExchange('');
    setCoinQ('');
    setFromDate('');
    setToDate('');
    setApplied({ exchange: '', coin: '', from: '', to: '' });
    setHint(null);
  }

  const exLabel = exchange ? exchangeLabel(exchange) : '全部交易所';

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="收益记录" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.primary}
            onRefresh={onRefresh}
          />
        }
      >
        <View style={[styles.filterCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.rangeRow}>
            <Pressable
              onPress={() => setExOpen(true)}
              style={[styles.select, { backgroundColor: theme.input, borderColor: theme.border }]}
            >
              <Text style={{ color: theme.text, fontSize: 12, flex: 1 }} numberOfLines={1}>
                {exLabel}
              </Text>
              <Text style={{ color: theme.textMuted, fontSize: 11 }}>{exOpen ? '▴' : '▾'}</Text>
            </Pressable>
            <View style={[styles.search, { backgroundColor: theme.input, borderColor: theme.border, flex: 1 }]}>
              <TextInput
                value={coinQ}
                onChangeText={setCoinQ}
                placeholder="币种，如 BTC"
                placeholderTextColor={theme.textMuted}
                style={[styles.searchInput, { color: theme.text }, WEB_INPUT]}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={search}
              />
            </View>
          </View>

          <View style={styles.rangeRow}>
            <View style={{ flex: 1 }}>
              <DatePickerField compact value={fromDate} onChange={setFromDate} placeholder="开始" />
            </View>
            <Text style={{ color: theme.textMuted, fontSize: 11, paddingHorizontal: 2 }}>至</Text>
            <View style={{ flex: 1 }}>
              <DatePickerField compact value={toDate} onChange={setToDate} placeholder="结束" />
            </View>
            <Pressable
              onPress={search}
              hitSlop={4}
              accessibilityLabel="查询"
              style={[styles.iconBtn, { backgroundColor: theme.primary }]}
            >
              <Ionicons name="search" size={16} color="#fff" />
            </Pressable>
            <Pressable
              onPress={resetFilters}
              hitSlop={4}
              accessibilityLabel="重置"
              style={[styles.iconBtn, { backgroundColor: theme.bg, borderColor: theme.border, borderWidth: 1 }]}
            >
              <Ionicons name="refresh-outline" size={16} color={theme.text} />
            </Pressable>
          </View>
        </View>

        <View style={[styles.summary, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
            收益汇总{loading ? '' : `  ${total} 笔`}
          </Text>
          <Text
            style={{
              color: sum < 0 ? theme.danger : theme.success,
              fontWeight: '700',
              fontSize: 13,
            }}
          >
            {loading ? '—' : `${fmtSigned(sum, 4)} USDT`}
          </Text>
        </View>

        {hint ? (
          <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 8 }}>{hint}</Text>
        ) : null}
        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
        ) : items.length === 0 ? (
          <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>
            暂无平仓收益记录
          </Text>
        ) : (
          items.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => navigation.navigate('OrderDetail', { item, kind: 'profit' })}
              style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <View style={styles.row}>
                <Text style={{ color: theme.text, fontWeight: '700', flex: 1 }} numberOfLines={1}>
                  {item.pair}
                </Text>
                <Text
                  style={{
                    color: item.positive ? theme.success : theme.danger,
                    fontWeight: '800',
                    fontSize: 13,
                  }}
                >
                  {fmtProfitSigned(item.pnlNum ?? item.pnl)} USDT
                </Text>
              </View>
              <Text style={{ color: theme.textMuted, marginTop: 4, fontSize: 11 }}>
                {exchangeLabel(item.exchange)} · 平仓 {fmtDateTimeOrDash(item.closeTime)}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>

      <Modal visible={exOpen} transparent animationType="fade" onRequestClose={() => setExOpen(false)}>
        <Pressable style={styles.mask} onPress={() => setExOpen(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {EX_OPTIONS.map((opt) => {
              const on = exchange === opt.code;
              return (
                <Pressable
                  key={opt.code || 'all'}
                  onPress={() => {
                    setExchange(opt.code);
                    setExOpen(false);
                  }}
                  style={[styles.sheetItem, on && { backgroundColor: theme.primarySoft }]}
                >
                  <Text style={{ color: on ? theme.primary : theme.text, fontWeight: on ? '700' : '500', fontSize: 14 }}>
                    {opt.name}
                  </Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  filterCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
    marginBottom: 8,
    gap: 6,
  },
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  select: {
    width: 118,
    minHeight: 32,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  search: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    minHeight: 32,
    justifyContent: 'center',
  },
  searchInput: {
    fontSize: 13,
    paddingVertical: 4,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summary: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  card: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  sheet: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sheetItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});
