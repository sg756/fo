import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  symbol: string;
  color: string;
  amount: string;
  usdt?: string;
  hint?: string;
  name?: string;
  onPress?: () => void;
};

export function AssetRow({ symbol, color, amount, usdt, hint, name, onPress }: Props) {
  const { theme } = useTheme();
  const Comp = onPress ? Pressable : View;

  return (
    <Comp onPress={onPress} style={[styles.row, { borderBottomColor: theme.border }]}>
      <View style={[styles.icon, { backgroundColor: color }]}>
        <Text style={styles.iconText}>{symbol.slice(0, 1)}</Text>
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ color: theme.text, fontWeight: '700', fontSize: 15 }}>{symbol}</Text>
        {name ? <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>{name}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: theme.text, fontWeight: '600' }}>{amount}</Text>
        {hint ? (
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>{hint}</Text>
        ) : usdt ? (
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>≈ {usdt} USDT</Text>
        ) : null}
      </View>
    </Comp>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: '#fff', fontWeight: '800' },
});
