import { ReactNode } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';

/** Lightweight gradient substitute (no expo-linear-gradient required). */
export function LinearGradientLike({
  children,
  from,
  to,
  style,
}: {
  children: ReactNode;
  from: string;
  to: string;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.wrap, style, { backgroundColor: to }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: from, opacity: 0.55 }]} />
      <View style={{ zIndex: 1 }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
});
