import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { EXCHANGES } from '../api/exchanges';
import type { AppTheme } from '../theme/themes';

const WEB_INPUT =
  Platform.OS === 'web'
    ? ({
        outlineWidth: 0,
        outlineStyle: 'none',
        outlineColor: 'transparent',
        boxShadow: 'none',
        borderWidth: 0,
      } as const)
    : {};

function ensureNoOutlineCss() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  if (document.getElementById('fo-pos-filter-css')) return;
  const el = document.createElement('style');
  el.id = 'fo-pos-filter-css';
  el.textContent = `
    input.fo-pos-search-input,
    input.fo-pos-search-input:hover,
    input.fo-pos-search-input:focus,
    input.fo-pos-search-input:focus-visible {
      outline: none !important;
      border: none !important;
      box-shadow: none !important;
      background: transparent !important;
    }
  `;
  document.head.appendChild(el);
}

type Props = {
  theme: AppTheme;
  coinQ: string;
  onCoinQ: (v: string) => void;
  exchange: string;
  onExchange: (v: string) => void;
};

export function PositionFilterBar({ theme, coinQ, onCoinQ, exchange, onExchange }: Props) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    ensureNoOutlineCss();
  }, []);

  const chips = [{ code: '', name: '全部' }, ...EXCHANGES.map((e) => ({ code: e.exchange, name: e.name }))];
  const active = hovered || focused;

  return (
    <View style={styles.wrap}>
      <View
        {...(Platform.OS === 'web'
          ? {
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
            }
          : {})}
        style={[
          styles.search,
          {
            backgroundColor: theme.card,
            borderColor: active ? theme.primary : theme.border,
          },
        ]}
      >
        <Ionicons name="search-outline" size={16} color={theme.textMuted} />
        <TextInput
          value={coinQ}
          onChangeText={onCoinQ}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="币种，如 BTC"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
          underlineColorAndroid="transparent"
          selectionColor={theme.primary}
          {...(Platform.OS === 'web' ? { className: 'fo-pos-search-input' } : {})}
          style={[styles.searchInput, { color: theme.text }, WEB_INPUT]}
        />
        {coinQ ? (
          <Pressable onPress={() => onCoinQ('')} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Ionicons name="close-circle" size={16} color={theme.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.chips}>
        {chips.map((ex) => {
          const on = exchange === ex.code;
          return (
            <Pressable
              key={ex.code || 'all'}
              onPress={() => onExchange(ex.code)}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: on ? theme.primarySoft : theme.chip,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text
                style={{
                  color: on ? theme.primary : theme.textSecondary,
                  fontWeight: on ? '800' : '600',
                  fontSize: 12,
                }}
              >
                {ex.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 2, gap: 8 },
  search: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    overflow: 'hidden',
  },
  searchInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 0,
  },
});
