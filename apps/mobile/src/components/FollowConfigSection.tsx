import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { TradeApi, UserFollowConfigItem } from '../api/endpoints';
import { exchangeName, type ExchangeCode } from '../api/exchanges';
import { ApiError } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { confirm, notify } from '../utils/notify';

type Draft = {
  templateId: string;
};

type Props = {
  /** 紧凑模式：用于开始交易页 */
  compact?: boolean;
  onChanged?: () => void;
};

export function FollowConfigSection({ compact, onChanged }: Props) {
  const { theme } = useTheme();
  const [items, setItems] = useState<UserFollowConfigItem[]>([]);
  const [hint, setHint] = useState('');
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingEx, setSavingEx] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pickerEx, setPickerEx] = useState<ExchangeCode | null>(null);
  const [templateMode, setTemplateMode] = useState<'global' | 'custom'>('custom');

  const load = useCallback(async () => {
    try {
      const r = await TradeApi.followConfigs();
      setItems(r.items || []);
      setHint(r.hint || '');
      setReady(!!r.ready);
      setTemplateMode(r.templateMode === 'global' ? 'global' : 'custom');
      const next: Record<string, Draft> = {};
      for (const it of r.items || []) {
        next[it.exchange] = { templateId: it.templateId || '' };
      }
      setDrafts(next);
    } catch {
      setItems([]);
      setHint('加载合约配置失败');
      setReady(false);
      setTemplateMode('custom');
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

  const pickerItem = useMemo(
    () => (pickerEx ? items.find((i) => i.exchange === pickerEx) : null),
    [pickerEx, items],
  );

  const saveOne = async (exchange: ExchangeCode) => {
    const d = drafts[exchange];
    if (!d?.templateId) {
      notify('请选择合约模板', `请先为 ${exchangeName(exchange)} 选择合约模板，选择后才能跟随合约`);
      return;
    }
    setSavingEx(exchange);
    try {
      await TradeApi.saveFollowConfig({
        exchange,
        templateId: d.templateId,
      });
      await load();
      onChanged?.();
      notify('已保存', `${exchangeName(exchange)} 合约比例已更新`);
    } catch (e) {
      notify('保存失败', e instanceof ApiError ? e.message : '请重试');
    } finally {
      setSavingEx('');
    }
  };

  const clearOne = (exchange: ExchangeCode) => {
    confirm('清除配置', `确定清除 ${exchangeName(exchange)} 的合约模板？`, {
      confirmText: '清除',
      destructive: true,
      onConfirm: async () => {
        setSavingEx(exchange);
        try {
          await TradeApi.deleteFollowConfig(exchange);
          await load();
          onChanged?.();
        } catch (e) {
          notify('清除失败', e instanceof ApiError ? e.message : '请重试');
        } finally {
          setSavingEx('');
        }
      },
    });
  };

  if (loading) {
    return <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} />;
  }

  if (items.length === 0) {
    return (
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border, padding: 14 }]}>
        <Text style={{ color: theme.textMuted, textAlign: 'center' }}>
          请先绑定至少一个交易所 API Key，再选择合约模板
        </Text>
      </View>
    );
  }

  return (
    <View>
      {hint && (templateMode === 'global' || !ready) ? (
        <Text
          style={{
            color: ready ? theme.textMuted : theme.warning,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          {hint}
        </Text>
      ) : null}

      {items.map((it) => {
        const d = drafts[it.exchange] || { templateId: '' };
        const selected = it.templates.find((t) => t.id === d.templateId);
        const tpl = selected || it.template;
        const minInvest = tpl ? Number(tpl.minInvestAmount) : 0;
        const base = tpl ? Number(tpl.maxPrincipal) : 0;
        const ratioPreview = minInvest > 0 && base > 0 ? minInvest / base : null;
        const busy = savingEx === it.exchange;

        return (
          <View
            key={it.exchange}
            style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border, marginBottom: 12 }]}
          >
            <View style={styles.head}>
              <Text style={{ color: theme.text, fontWeight: '700' }}>{exchangeName(it.exchange)}</Text>
              {templateMode === 'global' && it.templateId ? (
                <Text style={{ color: theme.success, fontSize: 12, fontWeight: '700' }}>使用中</Text>
              ) : it.templateId ? (
                <Text style={{ color: theme.success, fontSize: 12, fontWeight: '700' }}>已配置</Text>
              ) : (
                <Text style={{ color: theme.textMuted, fontSize: 12 }}>未配置</Text>
              )}
            </View>

            <Text style={[styles.label, { color: theme.textSecondary }]}>合约模板</Text>
            <Pressable
              disabled={templateMode === 'global'}
              onPress={() => {
                if (templateMode === 'global') return;
                setPickerEx(it.exchange);
              }}
              style={[styles.select, { backgroundColor: theme.input, borderColor: theme.border }]}
            >
              <Text style={{ color: selected || it.template ? theme.text : theme.textMuted, flex: 1 }}>
                {selected?.name || it.template?.name || '请选择模板（单选）'}
                {(selected || it.template)?.accountStale ? '（账户已失效）' : ''}
              </Text>
              <Text style={{ color: theme.textSecondary }}>›</Text>
            </Pressable>
            {(selected || it.template)?.accountStale ? (
              <Text style={{ color: theme.warning, fontSize: 11, marginTop: 6 }}>
                该模板绑定的交易账户已失效，请重新选择
              </Text>
            ) : null}
            {tpl ? (
              <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 6 }}>
                最少投入总本金 {minInvest > 0 ? minInvest : '未设置'}
                {' · '}基准本金 {base}
                {tpl.unitAmount > 0 ? ` · 单笔最小 ${tpl.unitAmount}` : ''}
              </Text>
            ) : null}
            {ratioPreview != null ? (
              <Text style={{ color: theme.primary, fontSize: 11, marginTop: 6 }}>
                预估开仓比例 ×{ratioPreview.toFixed(4)}
              </Text>
            ) : null}

            {templateMode === 'global' ? null : (
            <View style={[styles.actions, compact && { marginTop: 10 }]}>
              <Pressable
                disabled={busy}
                onPress={() => saveOne(it.exchange)}
                style={[styles.btn, { backgroundColor: theme.primary, opacity: busy ? 0.6 : 1 }]}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>{busy ? '保存中…' : '保存'}</Text>
              </Pressable>
              {it.templateId ? (
                <Pressable
                  disabled={busy}
                  onPress={() => clearOne(it.exchange)}
                  style={[styles.btnGhost, { borderColor: theme.border }]}
                >
                  <Text style={{ color: theme.textSecondary, fontWeight: '600' }}>清除</Text>
                </Pressable>
              ) : null}
            </View>
            )}
          </View>
        );
      })}

      <Modal visible={!!pickerEx} transparent animationType="fade" onRequestClose={() => setPickerEx(null)}>
        <Pressable style={styles.mask} onPress={() => setPickerEx(null)}>
          <View style={[styles.sheet, { backgroundColor: theme.card }]}>
            <Text style={{ color: theme.text, fontWeight: '800', fontSize: 16, marginBottom: 12 }}>
              选择模板 · {pickerEx ? exchangeName(pickerEx) : ''}
            </Text>
            {(pickerItem?.templates || []).length === 0 ? (
              <Text style={{ color: theme.textMuted, marginBottom: 12 }}>该交易所暂无可用模板</Text>
            ) : (
              (pickerItem?.templates || []).map((t) => {
                const cur = pickerEx ? drafts[pickerEx]?.templateId : '';
                const on = cur === t.id;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => {
                      if (!pickerEx) return;
                      setDrafts((prev) => ({
                        ...prev,
                        [pickerEx]: { templateId: t.id },
                      }));
                      setPickerEx(null);
                    }}
                    style={[
                      styles.sheetItem,
                      {
                        borderColor: on ? theme.primary : theme.border,
                        backgroundColor: on ? theme.primarySoft : 'transparent',
                      },
                    ]}
                  >
                    <Text style={{ color: t.accountStale ? theme.warning : theme.text, fontWeight: '700' }}>
                      {t.name}
                      {t.accountStale ? '（账户已失效）' : ''}
                    </Text>
                    <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
                      最少投入 {Number(t.minInvestAmount) > 0 ? t.minInvestAmount : '未设置'}
                      {' · '}基准 {t.maxPrincipal}
                      {t.accountName ? ` · ${t.accountName}` : ''}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 6 },
  select: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  btnGhost: {
    paddingHorizontal: 16,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    borderWidth: 1,
  },
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 18, paddingBottom: 28 },
  sheetItem: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
});
