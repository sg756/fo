import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  label: string;
  value: string;
  suffix?: string;
  accent?: boolean;
  onPress?: () => void;
};

function parseAmount(raw: string): number {
  const n = Number(String(raw || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function StatTile({ label, value, suffix = 'USDT', accent, onPress }: Props) {
  const { theme } = useTheme();
  const n = parseAmount(value);
  const valueColor = n < 0 ? theme.danger : accent ? theme.success : theme.text;
  const body = (
    <>
      <Text style={{ color: theme.textSecondary, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: valueColor, fontSize: 16, fontWeight: '700', marginTop: 4 }}>
        {value}
        <Text style={{ fontSize: 11, color: theme.textSecondary, fontWeight: '500' }}> {suffix}</Text>
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={[styles.tile, { backgroundColor: theme.card, borderColor: theme.border }]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View style={[styles.tile, { backgroundColor: theme.card, borderColor: theme.border }]}>
      {body}
    </View>
  );
}

export function PrimaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.btn,
        { backgroundColor: theme.primary, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <Text style={styles.btnText}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: '48%',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    marginBottom: 6,
  },
  btn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
