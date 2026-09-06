import { useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { toast } from './Toast';

export type GasFeeTier = 'standard' | 'fast';

const TIERS: { id: GasFeeTier; label: string; hint: string }[] = [
  { id: 'standard', label: '标准', hint: '链上建议' },
  { id: 'fast', label: '快', hint: '优先' },
];

function fmtEthPerTx(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n <= 0) return '0 ETH';
  if (n < 0.0000001) return `${n.toExponential(3)} ETH`;
  if (n < 0.001) return `${n.toFixed(8).replace(/\.?0+$/, '')} ETH`;
  return `${n.toFixed(6)} ETH`;
}

export function GasFeeTierPicker(props: {
  value: GasFeeTier;
  chain?: string;
  disabled?: boolean;
  onChange: (tier: GasFeeTier) => void;
  saving?: boolean;
  onSaving?: (v: boolean) => void;
}) {
  const [ethByTier, setEthByTier] = useState<Partial<Record<GasFeeTier, number>>>({});

  useEffect(() => {
    let cancelled = false;
    AdminApi.collectionGasFeePreview(props.chain)
      .then((res) => {
        if (cancelled || !res?.tiers) return;
        setEthByTier({
          standard: res.tiers.standard?.ethPerTx,
          fast: res.tiers.fast?.ethPerTx,
        });
      })
      .catch(() => {
        if (!cancelled) setEthByTier({});
      });
    return () => {
      cancelled = true;
    };
  }, [props.chain]);

  function pick(tier: GasFeeTier) {
    if (props.disabled || props.saving || tier === props.value) return;
    props.onSaving?.(true);
    AdminApi.saveCollectionGasFeeTier(tier)
      .then((res) => {
        props.onChange(res?.gasFeeTier === 'fast' ? 'fast' : 'standard');
        toast('已保存补 Gas 档位', 'ok');
      })
      .catch((err: any) => toast(err.message || '保存失败', 'err'))
      .finally(() => props.onSaving?.(false));
  }

  return (
    <span
      className="gas-fee-picker"
      title="下方为单笔 ETH 转账预估手续费（含 L2 执行 + L1 数据费缓冲）。标准=链上建议价。"
    >
      <span className="gas-fee-picker-label">补 Gas 速度</span>
      <span className="gas-fee-segmented" role="radiogroup" aria-label="补 Gas 速度">
        {TIERS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={props.value === t.id}
            className={`gas-fee-opt${props.value === t.id ? ' active' : ''}`}
            disabled={props.disabled || props.saving}
            title={`${t.label}：${t.hint}，约 ${fmtEthPerTx(ethByTier[t.id])}/笔`}
            onClick={() => pick(t.id)}
          >
            <span className="gas-fee-opt-top">
              <b>{t.label}</b>
              <small>{t.hint}</small>
            </span>
            <span className="gas-fee-opt-eth">{fmtEthPerTx(ethByTier[t.id])}</span>
          </button>
        ))}
      </span>
    </span>
  );
}
