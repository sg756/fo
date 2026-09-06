import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';
import { fmtDateTimeOrDash, fmtProfitSigned } from '../utils/format';

function sideText(side?: string | null) {
  const s = String(side || '').toLowerCase();
  if (s === 'long') return '多';
  if (s === 'short') return '空';
  return side || '—';
}

export function OrderDetailScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'OrderDetail'>>();
  const { item, kind } = route.params;

  const rows: [string, string][] =
    kind === 'profit'
      ? [
          ['状态', '已平仓'],
          ['记录编号', item.id],
          ['交易对', item.pair],
          ['交易所', item.exchange],
          ['平仓时间', fmtDateTimeOrDash(item.closeTime)],
          ['已实现盈亏', fmtProfitSigned(item.pnlNum ?? item.pnl)],
        ]
      : [
          ['类型', item.kindLabel || (item.isOpen === false ? '平仓' : item.isOpen ? '开仓' : '操作')],
          ['状态', item.statusLabel || (item.success ? '跟单成功' : '跟单失败')],
          ['交易对', item.pair],
          ['方向', sideText(item.positionSide)],
          ['交易所', item.exchange],
          ['本次数量', item.amount],
          ...(item.signalAmount ? [['信号数量', item.signalAmount] as [string, string]] : []),
          ...(item.avgPrice ? [['成交均价', item.avgPrice] as [string, string]] : []),
          ['提交时间', fmtDateTimeOrDash(item.openTime)],
          ...(item.orderId ? [['交易所订单号', item.orderId] as [string, string]] : []),
          ...(item.failReason || item.errorMsg || item.cancelMsg
            ? [
                [
                  item.status === 'CANCELLED' || item.status === 'CANCEL_FAILED' ? '撤单说明' : '原因',
                  item.failReason || item.errorMsg || item.cancelMsg || '',
                ] as [string, string],
              ]
            : [['结果', item.closeTime] as [string, string]]),
          ['记录编号', item.id],
        ];

  const partialHint =
    kind === 'follow' &&
    item.kind === 'close' &&
    item.signalAmount &&
    item.amount &&
    Number(item.amount) > 0 &&
    Number(item.signalAmount) > 0 &&
    Number(item.amount) + 1e-12 < Number(item.signalAmount);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="订单详情" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {item.status === 'CANCEL_FAILED' ? (
          <Text style={{ color: theme.warning, fontSize: 12, marginBottom: 12, lineHeight: 18 }}>
            撤单未成功，委托可能仍挂在交易所。可在「委托」中查看或联系运营重试撤单。
          </Text>
        ) : null}
        {partialHint ? (
          <Text style={{ color: theme.textMuted, fontSize: 12, marginBottom: 12, lineHeight: 18 }}>
            本次数量小于信号数量，可能为部分平仓。
          </Text>
        ) : null}
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {rows.map(([label, value], idx) => (
            <View
              key={`${label}-${idx}`}
              style={[
                styles.row,
                idx < rows.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: theme.border,
                },
              ]}
            >
              <Text style={{ color: theme.textSecondary }}>{label}</Text>
              <Text
                style={{
                  color:
                    label.includes('盈亏') || label.includes('结果') || label.includes('失败') || label.includes('撤单')
                      ? item.positive && !label.includes('失败') && !label.includes('撤单')
                        ? theme.success
                        : theme.danger
                      : theme.text,
                  fontWeight: '600',
                  maxWidth: '62%',
                  textAlign: 'right',
                }}
              >
                {value}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14 },
});
