import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenHeader } from '../components/ScreenHeader';
import { PrimaryButton } from '../components/StatTile';
import { FollowConfigSection } from '../components/FollowConfigSection';
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
      label: '账号已审核通过',
      tip: check?.status && check.status !== 'ACTIVE' ? `当前状态: ${check.status}` : '',
    },
    { ok: !!check?.apiKey, label: '交易所 API Key', tip: check ? `${check.apiKeyCount} 所已配置` : '' },
    { ok: !!check?.ipWhitelist, label: 'IP 白名单已配置', tip: check ? `${check.ipCount} 个公网 IP` : '' },
    {
      ok: !!check?.followConfigReady,
      label: '投入本金与跟单模板',
      tip: check?.followConfigHint || '每所选择 1 个模板并填写声明本金（不算余额）',
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

  const toggle = async () => {
    if (needSetup) {
      if (!check?.apiKey) {
        navigation.navigate('TradeSettings');
        return;
      }
      // Key 已有但缺本金/模板：留在本页配置
      if (!check?.followConfigReady) {
        notify('请先配置', check?.followConfigHint || '请选择模板并填写投入总本金');
        return;
      }
      navigation.navigate('TradeSettings');
      return;
    }
    setBusy(true);
    try {
      if (following) {
        await TradeApi.stop();
        notify('已停止', '已关闭自动跟单，后台将不再为你跟单');
      } else {
        await TradeApi.start();
        const tip =
          minPoint > 0 && !check?.pointEnough
            ? `已开启自动跟单。当前点卡 ${pointBal} 低于开仓门槛 ${minPoint}，暂不会跟开仓信号，平仓信号仍会跟；充值达标后自动可接开仓。`
            : '已开启自动跟单。后台采集信号后将为你自动开/平仓，App 仅作状态展示。';
        notify('已开启', tip);
      }
      await load();
    } catch (e) {
      notify('操作失败', e instanceof ApiError ? e.message : '请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="开始交易" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }}>
        <View style={[styles.hero, { backgroundColor: theme.primarySoft }]}>
          <View style={[styles.rocket, { backgroundColor: following ? theme.success : theme.primary }]} />
          <View style={[styles.flame, { backgroundColor: theme.warning }]} />
        </View>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 8 }}>
          {following ? '自动跟单已开启' : '准备开启自动跟单？'}
        </Text>
        <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 20 }}>
          {following
            ? 'App 仅展示状态；开仓/平仓由后台按模板比例自动执行（开仓需点卡达标）'
            : '开启前请声明投入总本金并选择模板；后台按比例跟单，不校验交易所余额。'}
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

        <View style={{ marginTop: 20 }}>
          <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700', marginBottom: 10 }}>
            配置投入本金与模板
          </Text>
          <FollowConfigSection compact onChanged={load} />
        </View>

        {following && check?.followStartedAt ? (
          <Text style={{ color: theme.success, fontSize: 12, marginTop: 12, textAlign: 'center' }}>
            开启时间：{new Date(check.followStartedAt).toLocaleString()}
          </Text>
        ) : null}

        {check?.proxyEgress ? (
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 8, textAlign: 'center' }}>
            当前调度公网 IP：{check.proxyEgress}
          </Text>
        ) : null}

        <View style={{ marginTop: 24 }}>
          {busy ? (
            <ActivityIndicator color={theme.primary} />
          ) : (
            <PrimaryButton
              title={
                following
                  ? '关闭自动跟单'
                  : ready
                    ? '开启自动跟单'
                    : !check?.apiKey
                      ? '去完善交易设置'
                      : '请先保存本金与模板'
              }
              onPress={toggle}
            />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: 140, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rocket: { width: 36, height: 56, borderRadius: 18 },
  flame: { width: 16, height: 16, borderRadius: 8, marginTop: -6 },
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14 },
});
