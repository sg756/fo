import { useEffect, useMemo, useState, type ViewStyle } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useTheme } from '../theme/ThemeContext';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fmtDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDay(value: string): Date {
  if (DAY_RE.test(value)) {
    const d = new Date(`${value}T12:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

type Props = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  style?: ViewStyle;
  clearable?: boolean;
  compact?: boolean;
};

export function DatePickerField({
  value,
  onChange,
  placeholder = '选择日期',
  style,
  clearable = true,
  compact = false,
}: Props) {
  const { theme, themeName } = useTheme();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => parseDay(value));
  const pickerDate = useMemo(() => parseDay(value), [value]);
  const showClear = clearable && !!value;

  useEffect(() => {
    if (open) setDraft(parseDay(value));
  }, [open, value]);

  function onPickerChange(event: DateTimePickerEvent, selected?: Date) {
    if (Platform.OS === 'android') {
      setOpen(false);
      if (event.type === 'dismissed') return;
      if (selected) onChange(fmtDay(selected));
    }
  }

  function clearValue() {
    onChange('');
  }

  if (Platform.OS === 'web') {
    return (
      <View
        style={[
          styles.field,
          styles.fieldRow,
          compact ? styles.fieldCompact : null,
          { backgroundColor: theme.card, borderColor: theme.border },
          style,
        ]}
      >
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            padding: 0,
            fontSize: compact ? 12 : 14,
            backgroundColor: 'transparent',
            color: theme.text,
            fontFamily: 'inherit',
          }}
        />
        {showClear ? (
          <Pressable
            onPress={clearValue}
            hitSlop={8}
            accessibilityLabel="清除日期"
            style={styles.clearBtn}
          >
            <Ionicons name="close-circle" size={16} color={theme.textMuted} />
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <>
      <View
        style={[
          styles.field,
          styles.fieldRow,
          compact ? styles.fieldCompact : null,
          { backgroundColor: theme.card, borderColor: theme.border },
          style,
        ]}
      >
        <Pressable onPress={() => setOpen(true)} style={styles.fieldMain}>
          <Text
            style={{ color: value ? theme.text : theme.textMuted, fontSize: compact ? 12 : 14 }}
            numberOfLines={1}
          >
            {value || placeholder}
          </Text>
        </Pressable>
        {showClear ? (
          <Pressable
            onPress={clearValue}
            hitSlop={8}
            accessibilityLabel="清除日期"
            style={styles.clearBtn}
          >
            <Ionicons name="close-circle" size={16} color={theme.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {Platform.OS === 'android' && open ? (
        <DateTimePicker
          value={pickerDate}
          mode="date"
          display="default"
          onChange={onPickerChange}
        />
      ) : null}

      {Platform.OS === 'ios' ? (
        <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
          <Pressable style={styles.mask} onPress={() => setOpen(false)}>
            <Pressable style={[styles.sheet, { backgroundColor: theme.card }]} onPress={() => undefined}>
              <View style={[styles.sheetBar, { borderBottomColor: theme.border }]}>
                <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                  <Text style={{ color: theme.textMuted, fontSize: 15 }}>取消</Text>
                </Pressable>
                <Text style={{ color: theme.text, fontWeight: '700' }}>{placeholder}</Text>
                <Pressable
                  onPress={() => {
                    onChange(fmtDay(draft));
                    setOpen(false);
                  }}
                  hitSlop={8}
                >
                  <Text style={{ color: theme.primary, fontWeight: '700', fontSize: 15 }}>确定</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={draft}
                mode="date"
                display="spinner"
                themeVariant={themeName === 'dark' ? 'dark' : 'light'}
                onChange={(_, selected) => {
                  if (selected) setDraft(selected);
                }}
                style={{ height: 220 }}
              />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 46,
  },
  fieldCompact: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 32,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fieldMain: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  clearBtn: {
    padding: 2,
  },
  mask: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 24,
  },
  sheetBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
