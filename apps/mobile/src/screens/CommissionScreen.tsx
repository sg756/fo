import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
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
import { Ionicons } from '@expo/vector-icons';
import { ScreenHeader } from '../components/ScreenHeader';
import { DatePickerField } from '../components/DatePickerField';
import { AccountApi, CommissionItem, CommissionListResp } from '../api/endpoints';
import { fmtDateTime, fmtSigned } from '../utils/format';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';

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

function normalizeDayInput(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (DAY_RE.test(s)) return s;
  return s;
}

function fromUserLabel(u?: CommissionItem['fromUser']) {
  if (!u) return '—';
  const name = String(u.nickname || '').trim();
  if (name) return name;
  if (u.userNo != null) return `用户#${u.userNo}`;
  return '—';
}

function parseCommissionList(raw: CommissionItem[] | CommissionListResp | null | undefined): {
  items: CommissionItem[];
  total: number;
  sum: number;
} {
  if (Array.isArray(raw)) {
    const items = raw;
    const sum = items.reduce((s, c) => s + Number(c.amount || 0), 0);
    return { items, total: items.length, sum };
  }
  const items = raw?.items || [];
  return {
    items,
    total: Number(raw?.total ?? items.length),
    sum: Number(raw?.sum ?? 0),
  };
}

export function CommissionScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [items, setItems] = useState<CommissionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [sum, setSum] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<string | null>(null);

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [userQ, setUserQ] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '', q: '' });

  const load = useCallback(async () => {
    setHint(null);
    try {
      const rec = parseCommissionList(
        await AccountApi.commissions(0, 200, {
          from: applied.from || undefined,
          to: applied.to || undefined,
          q: applied.q || undefined,
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
    setApplied({ from, to, q: userQ.trim() });
  }

  function resetFilters() {
    setFromDate('');
    setToDate('');
    setUserQ('');
    setApplied({ from: '', to: '', q: '' });
    setHint(null);
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="佣金记录" onBack={() => navigation.goBack()} />
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
            <View style={{ flex: 1 }}>
              <DatePickerField
                compact
                value={fromDate}
                onChange={setFromDate}
                placeholder="开始"
              />
            </View>
            <Text style={{ color: theme.textMuted, fontSize: 11, paddingHorizontal: 2 }}>至</Text>
            <View style={{ flex: 1 }}>
              <DatePickerField
                compact
                value={toDate}
                onChange={setToDate}
                placeholder="结束"
              />
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

          <View
            style={[
              styles.search,
              { backgroundColor: theme.input, borderColor: theme.border },
            ]}
          >
            <TextInput
              value={userQ}
              onChangeText={setUserQ}
              placeholder="用户ID / 昵称"
              placeholderTextColor={theme.textMuted}
              style={[styles.searchInput, { color: theme.text }, WEB_INPUT]}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={search}
            />
          </View>
        </View>

        <View style={[styles.listHead, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.summary}>
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
              汇总{loading ? '' : `  ${total} 笔`}
            </Text>
            <Text style={{ color: theme.success, fontWeight: '700', fontSize: 13 }}>
              {loading ? '—' : `${fmtSigned(sum)} USDT`}
            </Text>
          </View>
          <View style={[styles.head, { borderTopColor: theme.border }]}>
            <Text style={[styles.col, { color: theme.textMuted, flex: 1.2 }]}>昵称</Text>
            <Text style={[styles.col, { color: theme.textMuted, flex: 1 }]}>返佣</Text>
            <Text style={[styles.col, { color: theme.textMuted, flex: 1.3, textAlign: 'right' }]}>
              时间
            </Text>
          </View>
        </View>
        {hint ? (
          <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 8 }}>{hint}</Text>
        ) : null}
        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
        ) : items.length === 0 ? (
          <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>暂无佣金</Text>
        ) : (
          items.map((c) => {
            const amt = Number(c.amount);
            const amtStr = `${amt >= 0 ? '+' : ''}${Number.isFinite(amt) ? amt.toFixed(2) : c.amount}`;
            return (
              <View key={c.id} style={[styles.row, { borderBottomColor: theme.border }]}>
                <View style={{ flex: 1.2, paddingRight: 8 }}>
                  <Text style={{ color: theme.text, fontWeight: '600' }} numberOfLines={1}>
                    {fromUserLabel(c.fromUser)}
                  </Text>
                  {c.fromUser?.userNo != null ? (
                    <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>
                      ID {c.fromUser.userNo}
                    </Text>
                  ) : null}
                </View>
                <Text style={{ color: theme.success, flex: 1, fontWeight: '700' }}>{amtStr}</Text>
                <Text
                  style={{
                    color: theme.textSecondary,
                    flex: 1.3,
                    textAlign: 'right',
                    fontSize: 12,
                  }}
                >
                  {c.createdAt ? fmtDateTime(c.createdAt) : '—'}
                </Text>
              </View>
            );
          })
        )}
      </ScrollView>
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
  listHead: {
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: 4,
    overflow: 'hidden',
  },
  summary: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  head: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  col: { fontSize: 11 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
