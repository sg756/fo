import { StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { PrimaryButton } from '../components/StatTile';
import { fmtAmount, fmtDateTime } from '../utils/format';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';

const CHAIN_LABEL: Record<string, string> = {
  ARB: 'Arbitrum',
  BASE: 'Base',
  ETH: 'Ethereum',
};

export function RechargeSuccessScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'RechargeSuccess'>>();
  const order = route.params.order;

  const shortTx =
    order.txHash.length > 18
      ? `${order.txHash.slice(0, 10)}…${order.txHash.slice(-8)}`
      : order.txHash;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: 24, justifyContent: 'center' }}>
      <View style={[styles.badge, { backgroundColor: theme.success }]}>
        <Text style={{ color: '#fff', fontSize: 36, fontWeight: '800' }}>✓</Text>
      </View>
      <Text style={{ color: theme.text, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 18 }}>
        充值成功
      </Text>
      <Text style={{ color: theme.success, fontSize: 28, fontWeight: '800', textAlign: 'center', marginTop: 10 }}>
        +{fmtAmount(order.amount)} {order.tokenSymbol}
      </Text>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Row label="网络" value={`${order.tokenSymbol} · ${CHAIN_LABEL[order.chain] || order.chain}`} theme={theme} />
        <Row label="时间" value={fmtDateTime(order.updatedAt || order.createdAt)} theme={theme} />
        <Row label="TXID" value={shortTx} theme={theme} last />
      </View>

      <PrimaryButton
        title="完成"
        onPress={() => {
          navigation.reset({ index: 0, routes: [{ name: 'Main' as never }] });
        }}
      />
    </View>
  );
}

function Row({
  label,
  value,
  theme,
  last,
}: {
  label: string;
  value: string;
  theme: ReturnType<typeof useTheme>['theme'];
  last?: boolean;
}) {
  return (
    <View style={[styles.row, !last && { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <Text style={{ color: theme.textSecondary }}>{label}</Text>
      <Text style={{ color: theme.text, fontWeight: '600', maxWidth: '65%', textAlign: 'right' }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: { marginVertical: 24, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14 },
});
