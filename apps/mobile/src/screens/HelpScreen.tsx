import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { useTheme } from '../theme/ThemeContext';

const FAQS = [
  {
    q: '如何开始跟单？',
    a: '在「交易设置」配置 API Key 后，打开「开始交易」开关即可。App 只做展示与开关；开仓/平仓由后台按信号自动执行。开仓还需点卡达到平台最低额度。',
  },
  { q: '为什么下单被交易所拒绝？', a: '通常是 API 白名单未配置。请在交易设置复制平台下单 IP，添加到交易所 API 白名单。' },
  {
    q: '佣金如何计算？',
    a: '下级平仓盈利留在其交易所账户。平台按分润比例从其点卡扣除（点卡可为负），再按邀请上级链返佣：直推、间推各一档，另加平台；更深上级不参与该笔分润。开仓需点卡达到平台设定的最低额度。',
  },
  { q: '充值多久到账？', a: '链上确认达标后自动增加点卡余额，通常几分钟内到账。' },
];

export function HelpScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="帮助中心" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        {FAQS.map((f) => (
          <View key={f.q} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={{ color: theme.text, fontWeight: '700', marginBottom: 8 }}>{f.q}</Text>
            <Text style={{ color: theme.textSecondary, lineHeight: 20 }}>{f.a}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
});
