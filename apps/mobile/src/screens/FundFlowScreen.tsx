import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type View as RNView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { DatePickerField } from '../components/DatePickerField';
import { AccountApi, PointTx } from '../api/endpoints';
import {
  fmtDateTime,
  fmtFundSigned,
  pointTxLabel,
  pointTxRemark,
  POINT_TX_FILTERS,
} from '../utils/format';
import { useSafeRefresh } from '../hooks/useSafeRefresh';
import { useTheme } from '../theme/ThemeContext';

type TimePreset = '' | 'today' | '7d' | '30d' | 'month';
type MenuKind = 'type' | 'time' | null;

type AnchorRect = { x: number; y: number; width: number; height: number };

const TIME_PRESETS: { value: TimePreset; label: string }[] = [
  { value: '', label: '不限时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'month', label: '本月' },
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fmtDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rangeForPreset(preset: TimePreset): { from: string; to: string } {
  if (!preset) return { from: '', to: '' };
  const today = new Date();
  const to = fmtDay(today);
  if (preset === 'today') return { from: to, to };
  if (preset === '7d') {
    const d = new Date(today);
    d.setDate(d.getDate() - 6);
    return { from: fmtDay(d), to };
  }
  if (preset === '30d') {
    const d = new Date(today);
    d.setDate(d.getDate() - 29);
    return { from: fmtDay(d), to };
  }
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  return { from: fmtDay(first), to };
}

function presetForRange(from: string, to: string): TimePreset | null {
  for (const p of TIME_PRESETS) {
    const r = rangeForPreset(p.value);
    if (r.from === from && r.to === to) return p.value;
  }
  return null;
}

function normalizeDayInput(raw: string): string {
  return raw.trim().replace(/\//g, '-').slice(0, 10);
}

function FilterSelectTrigger({
  label,
  valueLabel,
  open,
  onToggle,
  anchorRef,
}: {
  label: string;
  valueLabel: string;
  open: boolean;
  onToggle: () => void;
  anchorRef: RefObject<RNView | null>;
}) {
  const { theme } = useTheme();
  return (
    <View ref={anchorRef} collapsable={false} style={{ flex: 1 }}>
      <Pressable
        onPress={onToggle}
        style={[styles.select, { backgroundColor: theme.bg, borderColor: theme.border }]}
      >
        <Text style={{ color: theme.textMuted, fontSize: 12 }}>{label}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }} numberOfLines={1}>
            {valueLabel}
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: 11 }}>{open ? '▴' : '▾'}</Text>
        </View>
      </Pressable>
    </View>
  );
}

function FilterDropdownOverlay({
  visible,
  anchor,
  onClose,
  children,
}: {
  visible: boolean;
  anchor: AnchorRect | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const { theme } = useTheme();
  if (!visible || !anchor) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlayRoot}>
        <Pressable style={styles.overlayMask} onPress={onClose} />
        <View
          style={[
            styles.overlayMenu,
            {
              top: anchor.y + anchor.height + 4,
              left: anchor.x,
              width: anchor.width,
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 280 }}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function FundFlowScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [txs, setTxs] = useState<PointTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState('');
  const [timePreset, setTimePreset] = useState<TimePreset>('');
  const [openMenu, setOpenMenu] = useState<MenuKind>(null);
  const [menuAnchor, setMenuAnchor] = useState<AnchorRect | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [applied, setApplied] = useState({ type: '', from: '', to: '' });

  const typeAnchorRef = useRef<RNView>(null);
  const timeAnchorRef = useRef<RNView>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await AccountApi.txs(0, 100, {
        type: applied.type || undefined,
        from: applied.from || undefined,
        to: applied.to || undefined,
      });
      setTxs(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setTxs([]);
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [applied]);

  const { refreshing, onRefresh } = useSafeRefresh(load);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const filterHint = useMemo(() => {
    const parts: string[] = [];
    if (applied.type) parts.push(pointTxLabel(applied.type));
    const preset = presetForRange(applied.from, applied.to);
    const presetLabel = TIME_PRESETS.find((p) => p.value === preset)?.label;
    if (presetLabel && presetLabel !== '不限时间') parts.push(presetLabel);
    else if (applied.from || applied.to) {
      parts.push(`${applied.from || '…'} ~ ${applied.to || '…'}`);
    }
    return parts.length ? parts.join(' · ') : '全部 · 不限时间';
  }, [applied]);

  function closeMenu() {
    setOpenMenu(null);
    setMenuAnchor(null);
  }

  function openMenuAt(kind: MenuKind, ref: RefObject<RNView | null>) {
    if (openMenu === kind) {
      closeMenu();
      return;
    }
    ref.current?.measureInWindow((x, y, width, height) => {
      setMenuAnchor({ x, y, width, height });
      setOpenMenu(kind);
    });
  }

  function applyPreset(preset: TimePreset) {
    const range = rangeForPreset(preset);
    setTimePreset(preset);
    setFromDate(range.from);
    setToDate(range.to);
    closeMenu();
  }

  function search() {
    const from = normalizeDayInput(fromDate);
    const to = normalizeDayInput(toDate);
    if (from && !DAY_RE.test(from)) {
      setError('开始日期格式不正确');
      return;
    }
    if (to && !DAY_RE.test(to)) {
      setError('结束日期格式不正确');
      return;
    }
    if (from && to && from > to) {
      setError('开始日期不能晚于结束日期');
      return;
    }
    closeMenu();
    setApplied({ type, from, to });
  }

  function resetFilters() {
    setType('');
    setTimePreset('');
    closeMenu();
    setFromDate('');
    setToDate('');
    setApplied({ type: '', from: '', to: '' });
    setError(null);
  }

  function onFromDateChange(next: string) {
    setFromDate(next);
    setTimePreset(presetForRange(next, toDate) ?? ('' as TimePreset));
  }

  function onToDateChange(next: string) {
    setToDate(next);
    setTimePreset(presetForRange(fromDate, next) ?? ('' as TimePreset));
  }

  const typeLabel = POINT_TX_FILTERS.find((o) => o.value === type)?.label || '全部';
  const quickLabel = TIME_PRESETS.find((p) => p.value === timePreset)?.label || '不限时间';

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="资金流水" onBack={() => navigation.goBack()} />

      <FilterDropdownOverlay visible={openMenu === 'type'} anchor={menuAnchor} onClose={closeMenu}>
        {POINT_TX_FILTERS.map((opt) => {
          const active = type === opt.value;
          return (
            <Pressable
              key={opt.value || 'all'}
              onPress={() => {
                setType(opt.value);
                closeMenu();
              }}
              style={[styles.dropItem, active && { backgroundColor: theme.primarySoft }]}
            >
              <Text
                style={{
                  color: active ? theme.primary : theme.text,
                  fontWeight: active ? '700' : '500',
                  fontSize: 13,
                }}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </FilterDropdownOverlay>

      <FilterDropdownOverlay visible={openMenu === 'time'} anchor={menuAnchor} onClose={closeMenu}>
        {TIME_PRESETS.map((opt) => {
          const active = timePreset === opt.value;
          return (
            <Pressable
              key={opt.value || 'all'}
              onPress={() => applyPreset(opt.value)}
              style={[styles.dropItem, active && { backgroundColor: theme.primarySoft }]}
            >
              <Text
                style={{
                  color: active ? theme.primary : theme.text,
                  fontWeight: active ? '700' : '500',
                  fontSize: 13,
                }}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </FilterDropdownOverlay>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.primary}
            onRefresh={onRefresh}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.filterCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.selectRow}>
            <FilterSelectTrigger
              label="类型"
              valueLabel={typeLabel}
              open={openMenu === 'type'}
              anchorRef={typeAnchorRef}
              onToggle={() => openMenuAt('type', typeAnchorRef)}
            />
            <FilterSelectTrigger
              label="快捷"
              valueLabel={quickLabel}
              open={openMenu === 'time'}
              anchorRef={timeAnchorRef}
              onToggle={() => openMenuAt('time', timeAnchorRef)}
            />
          </View>

          <View style={styles.rangeRow}>
            <View style={{ flex: 1 }}>
              <DatePickerField
                value={fromDate}
                onChange={onFromDateChange}
                placeholder="开始"
                style={styles.compactDate}
              />
            </View>
            <Text style={{ color: theme.textMuted, fontSize: 12, paddingHorizontal: 2 }}>至</Text>
            <View style={{ flex: 1 }}>
              <DatePickerField
                value={toDate}
                onChange={onToDateChange}
                placeholder="结束"
                style={styles.compactDate}
              />
            </View>
          </View>

          <View style={styles.actionRow}>
            <Pressable
              onPress={search}
              style={[styles.actionBtn, { backgroundColor: theme.primary, flex: 1 }]}
            >
              <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center', fontSize: 14 }}>
                查询
              </Text>
            </Pressable>
            <Pressable
              onPress={resetFilters}
              style={[
                styles.actionBtn,
                { backgroundColor: theme.bg, borderColor: theme.border, borderWidth: 1, flex: 1 },
              ]}
            >
              <Text style={{ color: theme.text, fontWeight: '600', textAlign: 'center', fontSize: 14 }}>
                重置
              </Text>
            </Pressable>
          </View>

          <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 8 }} numberOfLines={1}>
            {filterHint}
          </Text>
        </View>

        {loading ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
        ) : error ? (
          <Text style={{ color: theme.danger, marginTop: 12 }}>{error}</Text>
        ) : txs.length === 0 ? (
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 40 }}>暂无流水</Text>
        ) : (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {txs.map((f, idx) => {
              const positive = Number(f.amount) >= 0;
              const subRemark = pointTxRemark(f.type, f.remark);
              return (
                <View
                  key={f.id}
                  style={[
                    styles.row,
                    idx < txs.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: theme.border,
                    },
                  ]}
                >
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={{ color: theme.text, fontWeight: '600' }}>{pointTxLabel(f.type)}</Text>
                    {subRemark ? (
                      <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>
                        {subRemark}
                      </Text>
                    ) : null}
                    <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
                      {fmtDateTime(f.createdAt)}
                    </Text>
                  </View>
                  <Text style={{ color: positive ? theme.success : theme.danger, fontWeight: '700' }}>
                    {fmtFundSigned(f.amount)}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  filterCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
  },
  selectRow: {
    flexDirection: 'row',
    gap: 8,
  },
  select: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  overlayRoot: {
    flex: 1,
  },
  overlayMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  overlayMenu: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  dropItem: { paddingHorizontal: 12, paddingVertical: 10 },
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 4,
  },
  compactDate: {
    minHeight: 40,
    paddingVertical: 8,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  actionBtn: {
    borderRadius: 10,
    paddingVertical: 10,
  },
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, marginTop: 4 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
});
