import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenHeader } from '../components/ScreenHeader';
import { useTheme } from '../theme/ThemeContext';
import type { RootStackParamList } from '../navigation/types';

type IoniconName = keyof typeof Ionicons.glyphMap;

export function SecurityScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const items: { title: string; icon: IoniconName; onPress: () => void; hint?: string }[] = [
    { title: '交易所 API 配置', icon: 'key-outline', onPress: () => navigation.navigate('TradeSettings'), hint: '前往' },
    { title: '修改登录密码', icon: 'shield-outline', onPress: () => navigation.navigate('ChangePassword') },
  ];
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="安全中心" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {items.map((item, idx) => (
            <Pressable
              key={item.title}
              onPress={item.onPress}
              style={[
                styles.row,
                idx < items.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: theme.border,
                },
              ]}
            >
              <Ionicons name={item.icon} size={20} color={theme.textSecondary} />
              <Text style={{ color: theme.text, fontWeight: '600', marginLeft: 12, flex: 1 }}>{item.title}</Text>
              {item.hint ? (
                <Text style={{ color: theme.textMuted, fontSize: 12, marginRight: 6 }}>{item.hint}</Text>
              ) : null}
              <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 15 },
});
