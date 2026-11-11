import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenHeader } from '../components/ScreenHeader';
import { PrimaryButton } from '../components/StatTile';
import { TradeApi, TradeChecklist } from '../api/endpoints';
import { ApiError } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { notify } from '../utils/notify';
import type { RootStackParamList } from '../navigation/types';

export function StartTradingScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [check, setCheck] = useState<TradeChecklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await TradeApi.checklist();
      setCheck(c);
    } catch {
      setCheck(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  const minPoint = check?.openMinPointBalance ?? 0;
  const pointBal = check?.pointBalance ?? 0;
  const items = [
    {
      ok: !!check?.approved,
      label: '账号状态正常',
      tip: check?.status && check.status !== 'ACTIVE' ? `当前状态: ${check.status}` : '',
    },
    { ok: !!check?.apiKey, label: '交易所 API Key', tip: check ? `${check.apiKeyCount} 所已配置` : '' },
    { ok: !!check?.ipWhitelist, label: 'IP 白名单已配置', tip: check ? `${check.ipCount} 个公网 IP` : '' },
    {
      ok: !!check?.followConfigReady,
      label: '合约模板',
      tip: check?.followConfigHint || '请先选择合约模板，选择后才能跟随合约',
    },
    {
      ok: minPoint <= 0 || !!check?.pointEnough,
      label: minPoint > 0 ? `开仓点卡 (需 ≥ ${minPoint})` : '开仓点卡门槛',
      tip:
        minPoint > 0
          ? `当前 ${pointBal}${check?.pointEnough ? ' · 可接开仓信号' : ' · 不足时仅跟平仓, 请充值'}`
          : `当前 ${pointBal} · 未设置最低门槛`,
    },
  ];
  const ready = !!check?.canStart;
  const following = !!check?.followEnabled;
  const needSetup = !ready && !following;
  /** 曾开启过一次后，底部大按钮不再出现，改用右上角小开关 */
  const hasToggledOnce = !!check?.followStartedAt || following;

  const toggle = async () => {
    if (needSetup) {
      navigation.navigate('TradeSettings');
      return;
    }
    setBusy(true);
    try {
      if (following) {
        await TradeApi.stop();
        notify('已停止', '已关闭自动合约，后台将不再为你合约');
      } else {
        await TradeApi.start();
        const tip =
          minPoint > 0 && !check?.pointEnough
            ? `已开启自动合约。当前点卡 ${pointBal} 低于开仓门槛 ${minPoint}，暂不会跟开仓信号，平仓信号仍会跟；充值达标后自动可接开仓。`
            : '已开启自动合约。后台采集信号后将为你自动开/平仓。';
        notify('已开启', tip);
      }
      await load();
    } catch (e) {
      notify('操作失败', e instanceof ApiError ? e.message : '请重试');
    } finally {
      setBusy(false);
    }
  };

  const headerToggle = hasToggledOnce ? (
    <Pressable
      onPress={toggle}
      disabled={busy}
      hitSlop={8}
      style={[
        styles.headerBtn,
        {
          borderColor: following ? theme.danger : theme.primary,
          opacity: busy ? 0.55 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={following ? theme.danger : theme.primary} />
      ) : (
        <Text
          style={{
            color: following ? theme.danger : theme.primary,
            fontSize: 12,
            fontWeight: '700',
          }}
        >
          {following ? '关闭' : '开启'}
        </Text>
      )}
    </Pressable>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader
        title="合约状态"
        onBack={() => navigation.goBack()}
        right={headerToggle}
      />
      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: '800', textAlign: 'center' }}>
          {following ? '自动合约已开启' : '准备开启自动合约？'}
        </Text>
        <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 20 }}>
          {following
            ? '开仓/平仓由后台按模板比例自动执行（开仓需点卡达标）'
            : '请先在首页「开启合约」里配置 API Key 和合约模板，再回到这里打开开关。'}
        </Text>

        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 32 }} />
        ) : (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border, marginTop: 24 }]}>
            {items.map((item, idx) => (
              <View
                key={item.label}
                style={[
                  styles.row,
                  idx < items.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.border,
                  },
                ]}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ color: theme.text }}>{item.label}</Text>
                  {item.tip ? (
                    <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{item.tip}</Text>
                  ) : null}
                </View>
                <Text style={{ color: item.ok ? theme.success : theme.danger, fontWeight: '800' }}>
                  {item.ok ? '已完成' : '未完成'}
                </Text>
              </View>
            ))}
          </View>
        )}

        {following && check?.followStartedAt ? (
          <Text style={{ color: theme.success, fontSize: 12, marginTop: 12, textAlign: 'center' }}>
            开启时间：{new Date(check.followStartedAt).toLocaleString()}
          </Text>
        ) : null}

        {!hasToggledOnce ? (
          <View style={{ marginTop: 24 }}>
            {busy ? (
              <ActivityIndicator color={theme.primary} />
            ) : (
              <PrimaryButton
                title={ready ? '开启自动合约' : '前往开启合约'}
                onPress={toggle}
              />
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14 },
  headerBtn: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
