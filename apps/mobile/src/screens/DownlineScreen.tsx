import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { AccountApi, InviteMember } from '../api/endpoints';
import { fmtAmount, fmtDateTime } from '../utils/format';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import { memberDisplayName } from './InviteScreen';

const PAGE = 50;

export function DownlineScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [items, setItems] = useState<InviteMember[]>([]);
  const itemsRef = useRef<InviteMember[]>([]);
  itemsRef.current = items;
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(async (reset = true) => {
    if (reset) setHint(null);
    try {
      const skip = reset ? 0 : itemsRef.current.length;
      const rec = await AccountApi.inviteMembers(skip, PAGE);
      const list = rec?.items || [];
      setTotal(Number(rec?.total || 0));
      setItems(reset ? list : [...itemsRef.current, ...list]);
    } catch (e: any) {
      if (reset) {
        setItems([]);
        setHint(e?.message || '加载失败');
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(() => load(true));

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load(true);
    }, [load]),
  );

  function loadMore() {
    if (loading || loadingMore || items.length >= total) return;
    setLoadingMore(true);
    void load(false);
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="我的下级" onBack={() => navigation.goBack()} />
      <Text style={{ color: theme.textMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 16, marginTop: 8 }}>
        仅已审核通过的直推。金额为该下级为你贡献的累计返佣（其本人平仓产生的直推分成合计，不含间推）。
      </Text>

      <View style={[styles.head, { borderBottomColor: theme.border }]}>
        <Text style={[styles.headCell, { color: theme.textSecondary, flex: 1.2 }]}>昵称</Text>
        <Text style={[styles.headCell, { color: theme.textSecondary, flex: 1.4 }]}>加入时间</Text>
        <Text style={[styles.headCell, { color: theme.textSecondary, flex: 1, textAlign: 'right' }]}>
          累计返佣
        </Text>
      </View>

      {hint ? (
        <Text style={{ color: theme.warning, fontSize: 12, paddingHorizontal: 16, marginTop: 8 }}>{hint}</Text>
      ) : null}

      {loading && items.length === 0 ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} tintColor={theme.primary} onRefresh={onRefresh} />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 40 }}>暂无已审核下级</Text>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} /> : null
          }
          renderItem={({ item, index }) => (
            <View
              style={[
                styles.row,
                { borderBottomColor: theme.border },
                index === items.length - 1 && { borderBottomWidth: 0 },
              ]}
            >
              <Text style={{ color: theme.text, fontWeight: '600', flex: 1.2 }} numberOfLines={1}>
                {memberDisplayName(item)}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1.4 }} numberOfLines={2}>
                {fmtDateTime(item.createdAt)}
              </Text>
              <Text style={{ color: theme.success, fontWeight: '700', flex: 1, textAlign: 'right' }}>
                +{fmtAmount(item.commission)}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headCell: { fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
