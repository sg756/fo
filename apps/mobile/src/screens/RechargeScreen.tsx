import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenHeader } from '../components/ScreenHeader';
import { AccountApi, RechargeOrder } from '../api/endpoints';
import { fmtAmount, fmtDateTime } from '../utils/format';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';
import { notify } from '../utils/notify';
import type { RootStackParamList } from '../navigation/types';

const STATUS_LABEL: Record<string, string> = {
  PENDING: '确认中',
  CONFIRMED: '确认中',
  CREDITED: '已得点卡',
  FAILED: '失败',
};

type NetworkOpt = { chain: string; name: string; label: string; token: string };

export function RechargeScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [networks, setNetworks] = useState<NetworkOpt[]>([]);
  const [netIdx, setNetIdx] = useState(0);
  const [openNet, setOpenNet] = useState(false);
  const [address, setAddress] = useState('');
  const [networkName, setNetworkName] = useState('');
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<RechargeOrder[]>([]);

  const network = networks[netIdx];
  const singleNetwork = networks.length <= 1;

  const loadOrders = useCallback(async () => {
    try {
      const list = await AccountApi.recharges(0, 20);
      setOrders(list);
    } catch {
      // ignore
    }
  }, []);

  const { refreshing, onRefresh } = useSafeRefresh(loadOrders);

  useEffect(() => {
    AccountApi.depositNetworks()
      .then((r) => {
        setNetworks(r.networks || []);
        setNetIdx(0);
      })
      .catch(() => {
        // 兼容旧后端：仅 ARB
        setNetworks([{ chain: 'ARB', name: 'Arbitrum One', label: 'USDT · Arbitrum One', token: 'USDT' }]);
      });
  }, []);

  useEffect(() => {
    if (!network?.chain) return;
    let alive = true;
    setLoading(true);
    setAddress('');
    AccountApi.depositAddress(network.chain)
      .then((r) => {
        if (!alive) return;
        setAddress(r.address);
        setNetworkName(r.networkName || network.name || r.chain);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [network?.chain, network?.name]);

  useFocusEffect(
    useCallback(() => {
      loadOrders();
    }, [loadOrders]),
  );

  const copyAddress = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    notify('已复制', '充值地址已复制到剪贴板');
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="充值" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.primary}
            onRefresh={onRefresh}
          />
        }
      >
        {singleNetwork ? (
          <View style={[styles.netBadge, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>充值网络</Text>
            <Text style={{ color: theme.text, fontWeight: '700', marginTop: 4 }}>
              {network?.label || networkName || 'USDT · Arbitrum'}
            </Text>
          </View>
        ) : (
          <>
            <Text style={{ color: theme.textSecondary, marginBottom: 8 }}>选择网络</Text>
            <Pressable
              onPress={() => setOpenNet((v) => !v)}
              style={[styles.select, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={{ color: theme.text, fontWeight: '600' }}>{network?.label || '选择网络'}</Text>
              <Text style={{ color: theme.textSecondary }}>{openNet ? '▴' : '▾'}</Text>
            </Pressable>
            {openNet ? (
              <View style={[styles.dropdown, { backgroundColor: theme.card, borderColor: theme.border }]}>
                {networks.map((n, i) => (
                  <Pressable
                    key={n.chain}
                    onPress={() => {
                      setNetIdx(i);
                      setOpenNet(false);
                    }}
                    style={styles.dropItem}
                  >
                    <Text style={{ color: theme.text }}>{n.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        )}

        <View style={[styles.qrBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.qrInner}>
            {loading || !address ? (
              <View style={{ width: 180, height: 180, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color={theme.primary} />
              </View>
            ) : (
              <QRCode value={address} size={180} backgroundColor="#fff" color="#111" />
            )}
          </View>
          <Text style={{ color: theme.textSecondary, marginTop: 14, fontSize: 12 }}>
            扫描二维码或复制地址充值
          </Text>
        </View>

        <View style={[styles.addrCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 8 }}>钱包地址</Text>
          <Text style={{ color: theme.text, lineHeight: 20 }}>{loading ? '生成中…' : address}</Text>
          <Pressable onPress={copyAddress} style={[styles.copyBtn, { backgroundColor: theme.primarySoft }]}>
            <Text style={{ color: theme.primary, fontWeight: '700' }}>复制地址</Text>
          </Pressable>
        </View>

        <Text style={{ color: theme.textMuted, fontSize: 12, marginVertical: 14, lineHeight: 18 }}>
          请向该地址转入 USDT（网络：{networkName || network?.name || 'Arbitrum'}
          ），到账后获得等额点卡。请按交易所该网络的最小提币额转出。
        </Text>

        <Text style={{ color: theme.text, fontWeight: '700', marginBottom: 10 }}>充值记录</Text>
        {orders.length === 0 ? (
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 8 }}>暂无充值记录</Text>
        ) : (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {orders.map((o, idx) => (
              <Pressable
                key={o.id}
                disabled={o.status !== 'CREDITED'}
                onPress={() => navigation.navigate('RechargeSuccess', { order: o })}
                style={[
                  styles.row,
                  idx < orders.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.border,
                  },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: '600' }}>
                    +{fmtAmount(o.amount)} {o.tokenSymbol}
                  </Text>
                  <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 4 }}>
                    {fmtDateTime(o.createdAt)} · {o.chain || '—'}
                  </Text>
                </View>
                <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                  {STATUS_LABEL[o.status] || o.status}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  netBadge: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  select: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  dropdown: {
    borderWidth: 1,
    borderRadius: 12,
    marginBottom: 12,
    overflow: 'hidden',
  },
  dropItem: { paddingHorizontal: 14, paddingVertical: 12 },
  qrBox: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    marginTop: 6,
  },
  qrInner: {
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
  },
  addrCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 14,
  },
  copyBtn: {
    marginTop: 12,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
});
