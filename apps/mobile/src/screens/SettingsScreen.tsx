import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { useTheme } from '../theme/ThemeContext';

export function SettingsScreen() {
  const { theme, themeName, setThemeName } = useTheme();
  const navigation = useNavigation();

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="设置" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={[styles.section, { color: theme.textSecondary }]}>主题</Text>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {(
            [
              ['light', '白底浅蓝'],
              ['dark', '深色'],
            ] as const
          ).map(([key, label], idx) => (
            <Pressable
              key={key}
              onPress={() => setThemeName(key)}
              style={[
                styles.row,
                idx === 0 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
              ]}
            >
              <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }}>{label}</Text>
              {themeName === key ? <Ionicons name="checkmark" size={20} color={theme.primary} /> : null}
            </Pressable>
          ))}
        </View>

        <Text style={[styles.section, { color: theme.textSecondary }]}>通用</Text>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Row theme={theme} label="语言" value="简体中文" first />
          <Row theme={theme} label="推送通知" value="已开启" />
        </View>
      </ScrollView>
    </View>
  );
}

function Row({
  theme,
  label,
  value,
  first,
}: {
  theme: ReturnType<typeof useTheme>['theme'];
  label: string;
  value: string;
  first?: boolean;
}) {
  return (
    <View
      style={[
        styles.row,
        first && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
      ]}
    >
      <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }}>{label}</Text>
      <Text style={{ color: theme.textSecondary }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 8, marginBottom: 10, fontSize: 13 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 15 },
});
