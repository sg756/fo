import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import {
  bindDialogListener,
  type DialogButton,
  type DialogRequest,
  type DialogTone,
} from '../utils/notify';

const TONE_ICON: Record<DialogTone, keyof typeof Ionicons.glyphMap> = {
  info: 'information-circle',
  success: 'checkmark-circle',
  danger: 'close-circle',
  warning: 'alert-circle',
};

export function AppDialogHost() {
  const { theme } = useTheme();
  const [req, setReq] = useState<DialogRequest | null>(null);

  useEffect(() => {
    bindDialogListener(setReq);
    return () => bindDialogListener(null);
  }, []);

  const close = () => setReq(null);

  const run = (btn: DialogButton) => {
    close();
    // 等关闭动画后再回调，避免叠层
    setTimeout(() => btn.onPress?.(), 16);
  };

  if (!req) return null;

  const tone = req.tone || 'info';
  const toneColor =
    tone === 'success'
      ? theme.success
      : tone === 'danger'
        ? theme.danger
        : tone === 'warning'
          ? theme.warning
          : theme.primary;
  const toneSoft =
    tone === 'success'
      ? 'rgba(0,192,135,0.14)'
      : tone === 'danger'
        ? 'rgba(246,70,93,0.14)'
        : tone === 'warning'
          ? 'rgba(240,185,11,0.16)'
          : theme.primarySoft;

  const buttons = req.buttons;
  const dual = buttons.length === 2;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
              shadowColor: '#0F172A',
            },
          ]}
        >
          <View style={[styles.iconWrap, { backgroundColor: toneSoft }]}>
            <Ionicons name={TONE_ICON[tone]} size={28} color={toneColor} />
          </View>

          <Text style={[styles.title, { color: theme.text }]}>{req.title}</Text>
          {req.message ? (
            <Text style={[styles.message, { color: theme.textSecondary }]}>{req.message}</Text>
          ) : null}

          <View style={[styles.actions, dual && styles.actionsRow]}>
            {buttons.map((btn, idx) => {
              const isCancel = btn.style === 'cancel';
              const isDanger = btn.style === 'destructive';
              const primary = !isCancel && (btn.style === 'default' || !btn.style || isDanger);
              const bg = isCancel
                ? theme.chip
                : isDanger
                  ? theme.danger
                  : theme.primary;
              const color = isCancel ? theme.text : '#fff';

              return (
                <Pressable
                  key={`${btn.text}-${idx}`}
                  onPress={() => run(btn)}
                  style={[
                    styles.btn,
                    dual && styles.btnHalf,
                    { backgroundColor: bg },
                    primary && !isCancel ? styles.btnPrimary : null,
                  ]}
                >
                  <Text style={{ color, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
                    {btn.text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
    alignItems: 'center',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 10,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  message: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  actions: {
    marginTop: 20,
    width: '100%',
    gap: 10,
  },
  actionsRow: {
    flexDirection: 'row',
  },
  btn: {
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  btnHalf: {
    flex: 1,
  },
  btnPrimary: {},
});
