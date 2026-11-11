import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { AccountApi } from '../api/endpoints';
import { ScreenHeader } from '../components/ScreenHeader';
import { useTheme } from '../theme/ThemeContext';

type NoticeItem = {
  id: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function NoticesScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [items, setItems] = useState<NoticeItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await AccountApi.notices();
      setItems(r.items || []);
    } catch {
      setItems([]);
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

  const open = async (item: NoticeItem) => {
    if (item.read) return;
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, read: true } : it)));
    try {
      await AccountApi.noticeRead(item.id);
    } catch {
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, read: false } : it)));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="消息通知" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        {!loading && items.length === 0 ? (
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 40 }}>暂无消息</Text>
        ) : null}
        {items.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => open(item)}
            style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <View style={styles.head}>
              {!item.read ? <View style={[styles.dot, { backgroundColor: theme.danger }]} /> : <View style={styles.dot} />}
              <Text style={{ color: theme.text, fontWeight: '700', flex: 1 }}>{item.title}</Text>
              <Text style={{ color: theme.textMuted, fontSize: 12 }}>{fmtTime(item.createdAt)}</Text>
            </View>
            <Text style={{ color: theme.textSecondary, lineHeight: 20, marginTop: 8 }}>{item.body}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  head: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
});
