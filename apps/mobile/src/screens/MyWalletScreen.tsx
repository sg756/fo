import { useCallback, useState } from 'react';
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
import { PrimaryButton } from '../components/StatTile';
import { AccountApi, PointCard, PointTx } from '../api/endpoints';
import { fmtAmount, fmtFundSigned, fmtDateTime, pointTxLabel } from '../utils/format';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';

export function MyWalletScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [card, setCard] = useState<PointCard | null>(null);
  const [txs, setTxs] = useState<PointTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, t] = await Promise.all([AccountApi.pointCard(), AccountApi.txs(0, 50)]);
      setCard(c);
      setTxs(t);
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(load);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const totalDeposit = txs
    .filter((t) => t.type === 'RECHARGE')
    .reduce((s, t) => s + Number(t.amount), 0);
  const totalCommission = txs
    .filter((t) => t.type === 'COMMISSION')
    .reduce((s, t) => s + Number(t.amount), 0);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="我的点卡" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
          />
        }
      >
        <View style={[styles.hero, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary }}>点卡余额</Text>
          <Text style={{ color: theme.text, fontSize: 30, fontWeight: '800', marginTop: 8 }}>
            {loading ? '—' : fmtAmount(card?.balance)}
          </Text>
          {Number(card?.frozen) > 0 ? (
            <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
              冻结中 {fmtAmount(card?.frozen)}
            </Text>
          ) : null}
          <Text style={{ color: theme.textSecondary, marginTop: 14 }}>可提佣金</Text>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700', marginTop: 4 }}>
            {loading ? '—' : fmtAmount(card?.withdrawable ?? card?.commissionBalance)}
          </Text>
          {Number(card?.commissionFrozen) > 0 ? (
            <Text style={{ color: theme.warning, fontSize: 12, marginTop: 4 }}>
              提现锁定 {fmtAmount(card?.commissionFrozen)}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <View style={{ flex: 1 }}>
              <PrimaryButton title="充值" onPress={() => navigation.navigate('Recharge')} />
            </View>
            <View style={{ flex: 1 }}>
              <PrimaryButton title="提现" onPress={() => navigation.navigate('Withdraw')} />
            </View>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <Stat theme={theme} label="累计佣金" value={fmtAmount(totalCommission)} />
          <Stat theme={theme} label="累计充值" value={fmtAmount(totalDeposit)} />
        </View>

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 20,
            marginBottom: 10,
          }}
        >
          <Text style={{ color: theme.text, fontWeight: '700' }}>最近流水</Text>
          <Pressable onPress={() => navigation.navigate('FundFlow')}>
            <Text style={{ color: theme.primary, fontWeight: '600', fontSize: 13 }}>全部流水</Text>
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 20 }} />
        ) : error ? (
          <Text style={{ color: theme.danger }}>{error}</Text>
        ) : txs.length === 0 ? (
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 20 }}>暂无流水</Text>
        ) : (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {txs.slice(0, 8).map((f, idx, arr) => {
              const positive = Number(f.amount) >= 0;
              return (
                <View
                  key={f.id}
                  style={[
                    styles.row,
                    idx < arr.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.border,
                    },
                  ]}
                >
                  <View>
                    <Text style={{ color: theme.text, fontWeight: '600' }}>{pointTxLabel(f.type)}</Text>
                    <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
                      {fmtDateTime(f.createdAt)}
                    </Text>
                  </View>
                  <Text style={{ color: positive ? theme.success : theme.danger, fontWeight: '700' }}>
                    {fmtFundSigned(f.amount)}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ theme, label, value }: { theme: ReturnType<typeof useTheme>['theme']; label: string; value: string }) {
  return (
    <View style={[styles.stat, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={{ color: theme.textSecondary, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: theme.text, fontWeight: '700', marginTop: 6 }}>{value} USDT</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: 14, borderWidth: 1, padding: 18 },
  stat: { flex: 1, borderRadius: 12, borderWidth: 1, padding: 14 },
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14 },
});
