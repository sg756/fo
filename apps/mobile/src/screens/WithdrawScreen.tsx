import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { ScreenHeader } from '../components/ScreenHeader';
import { PrimaryButton } from '../components/StatTile';
import { AccountApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { fmtAmount } from '../utils/format';
import { useTheme } from '../theme/ThemeContext';
import { appAlert, confirm, notify } from '../utils/notify';

const CHAINS = [{ label: 'USDT · Arbitrum', chain: 'ARB' }];

export function WithdrawScreen() {
  const { theme } = useTheme();
  const navigation = useNavigation();
  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState('0');
  const [frozen, setFrozen] = useState('0');
  const [addr, setAddr] = useState<{
    address: string | null;
    chain: string;
    label: string | null;
    configured: boolean;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [draftAddress, setDraftAddress] = useState('');
  const [draftChain, setDraftChain] = useState('ARB');
  const [draftLabel, setDraftLabel] = useState('');
  const [savingAddr, setSavingAddr] = useState(false);
  const [minWithdraw, setMinWithdraw] = useState(0);

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([AccountApi.pointCard(), AccountApi.withdrawAddress()]);
      setBalance(c.withdrawable ?? c.commissionBalance ?? '0');
      setFrozen(c.commissionFrozen ?? '0');
      setAddr(a);
      setMinWithdraw(Number(a.minWithdrawAmount ?? 0) || 0);
      if (!a.configured) setShowSetup(true);
    } catch {
      // ignore
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const openSetup = () => {
    setDraftAddress(addr?.address || '');
    setDraftChain(addr?.chain || 'ARB');
    setDraftLabel(addr?.label || '');
    setShowSetup(true);
  };

  const saveAddress = async () => {
    const a = draftAddress.trim();
    if (!a) {
      notify('提示', '请填写提现收款地址');
      return;
    }
    confirm(
      '重要提示',
      '请务必核对提现地址无误。地址错误将导致资产无法找回，平台无法追回。确认保存该地址？',
      {
        cancelText: '再检查',
        confirmText: '确认无误并保存',
        destructive: true,
        onConfirm: async () => {
          setSavingAddr(true);
          try {
            const saved = await AccountApi.setWithdrawAddress({
              address: a,
              chain: draftChain,
              label: draftLabel.trim() || undefined,
            });
            setAddr(saved);
            setShowSetup(false);
            notify('已保存', '提现地址已保存，可用于提交提现申请');
          } catch (e) {
            notify('保存失败', e instanceof ApiError ? e.message : '请检查地址格式');
          } finally {
            setSavingAddr(false);
          }
        },
      },
    );
  };

  const submit = async () => {
    if (!addr?.configured) {
      appAlert('请先设置提现地址', '提现前需保存钱包或交易所收款地址', [
        { text: '取消', style: 'cancel' },
        { text: '去设置', onPress: openSetup },
      ]);
      return;
    }
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      notify('提示', '请输入有效的提现数量');
      return;
    }
    if (minWithdraw > 0 && amt < minWithdraw) {
      notify('提示', `最低提现金额为 ${minWithdraw} USDT`);
      return;
    }
    if (amt > Number(balance)) {
      notify('提示', '可提佣金不足');
      return;
    }
    confirm(
      '确认提现',
      `将锁定 ${amt} USDT 至审核完成。\n收款地址：\n${addr.address}\n网络：${addr.chain}\n\n请再次确认地址无误。`,
      {
        confirmText: '提交申请',
        onConfirm: async () => {
          setSubmitting(true);
          try {
            await AccountApi.createWithdraw({ amount: amt });
            notify('已提交', '提现金额已锁定，等待管理员审核打款', () => navigation.goBack());
          } catch (e) {
            const msg = e instanceof ApiError ? e.message : '提交失败，请重试';
            if (msg.includes('提现收款地址') || msg.includes('设置提现')) {
              appAlert('未设置地址', msg, [{ text: '去设置', onPress: openSetup }]);
            } else {
              notify('提交失败', msg);
            }
          } finally {
            setSubmitting(false);
          }
        },
      },
    );
  };

  const chainLabel = CHAINS.find((c) => c.chain === (addr?.chain || draftChain))?.label || addr?.chain;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="提现" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={[styles.balance, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary }}>可提佣金</Text>
          <Text style={{ color: theme.text, fontSize: 22, fontWeight: '800', marginTop: 6 }}>
            {fmtAmount(balance)} USDT
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>
            仅佣金可提现，点卡不可提
          </Text>
          {Number(frozen) > 0 ? (
            <Text style={{ color: theme.warning, fontSize: 12, marginTop: 6 }}>
              已锁定（审核中）{fmtAmount(frozen)} USDT
            </Text>
          ) : null}
        </View>

        <View style={[styles.addrBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.text, fontWeight: '700' }}>收款地址</Text>
            <Pressable onPress={openSetup}>
              <Text style={{ color: theme.primary, fontWeight: '600' }}>
                {addr?.configured ? '修改' : '去设置'}
              </Text>
            </Pressable>
          </View>
          {addr?.configured ? (
            <>
              <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 8 }}>{chainLabel}</Text>
              <Text style={{ color: theme.text, marginTop: 6, lineHeight: 20 }}>{addr.address}</Text>
              {addr.label ? (
                <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>{addr.label}</Text>
              ) : null}
            </>
          ) : (
            <Text style={{ color: theme.warning, marginTop: 10, lineHeight: 18 }}>
              尚未设置提现地址。请先填写钱包或交易所充值地址。
            </Text>
          )}
        </View>

        <Text style={[styles.label, { color: theme.textSecondary }]}>提现数量</Text>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor={theme.textMuted}
          style={[styles.input, { backgroundColor: theme.card, borderColor: theme.border, color: theme.text }]}
        />
        {minWithdraw > 0 ? (
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 8 }}>
            最低提现金额 {fmtAmount(minWithdraw)} USDT
          </Text>
        ) : null}

        <Text style={{ color: theme.danger, fontSize: 12, marginVertical: 14, lineHeight: 18 }}>
          重要：请确保收款地址与网络正确。地址错误将导致资产丢失且无法追回。提交后金额立即锁定，经管理员审核并打款后状态变为已结算。
        </Text>

        {submitting ? (
          <View style={[styles.loadingBtn, { backgroundColor: theme.primary }]}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : (
          <PrimaryButton title="提交提现申请" onPress={submit} />
        )}
      </ScrollView>

      <Modal visible={showSetup} animationType="slide" transparent>
        <View style={styles.modalMask}>
          <View style={[styles.modalCard, { backgroundColor: theme.card }]}>
            <Text style={{ color: theme.text, fontSize: 18, fontWeight: '800' }}>设置提现地址</Text>
            <Text style={{ color: theme.danger, fontSize: 12, marginTop: 10, lineHeight: 18 }}>
              请认真核对：填写您的钱包地址或交易所充值地址。填错将无法到账且无法找回。
            </Text>

            <Text style={[styles.label, { color: theme.textSecondary }]}>网络</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {CHAINS.map((c) => (
                <Pressable
                  key={c.chain}
                  onPress={() => setDraftChain(c.chain)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: draftChain === c.chain ? theme.primary : theme.bg,
                      borderColor: theme.border,
                    },
                  ]}
                >
                  <Text style={{ color: draftChain === c.chain ? '#fff' : theme.text, fontSize: 12 }}>
                    {c.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.label, { color: theme.textSecondary }]}>收款地址</Text>
            <TextInput
              value={draftAddress}
              onChangeText={setDraftAddress}
              placeholder="0x… 或交易所充值地址"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { backgroundColor: theme.bg, borderColor: theme.border, color: theme.text }]}
            />

            <Text style={[styles.label, { color: theme.textSecondary }]}>备注（可选）</Text>
            <TextInput
              value={draftLabel}
              onChangeText={setDraftLabel}
              placeholder="如：币安现货 / 我的 Arb 钱包"
              placeholderTextColor={theme.textMuted}
              style={[styles.input, { backgroundColor: theme.bg, borderColor: theme.border, color: theme.text }]}
            />

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <Pressable
                style={[styles.modalBtn, { backgroundColor: theme.chip, flex: 1 }]}
                onPress={() => {
                  if (!addr?.configured) {
                    notify('提示', '未设置地址将无法提现');
                  }
                  setShowSetup(false);
                }}
              >
                <Text style={{ color: theme.text, textAlign: 'center', fontWeight: '600' }}>取消</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, { backgroundColor: theme.primary, flex: 1, opacity: savingAddr ? 0.6 : 1 }]}
                disabled={savingAddr}
                onPress={saveAddress}
              >
                <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>
                  {savingAddr ? '保存中…' : '确认保存'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  balance: { borderRadius: 12, borderWidth: 1, padding: 16, marginBottom: 12 },
  addrBox: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 8 },
  label: { marginTop: 16, marginBottom: 8, fontWeight: '600' },
  input: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  loadingBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 32,
  },
  chip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  modalBtn: { borderRadius: 10, paddingVertical: 12 },
});
