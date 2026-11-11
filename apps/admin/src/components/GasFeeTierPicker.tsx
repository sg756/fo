import { useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { toast } from './Toast';

export type GasFeeTier = 'standard' | 'fast';

const TIERS: { id: GasFeeTier; label: string; hint: string }[] = [
  { id: 'standard', label: '标准', hint: '链上建议' },
  { id: 'fast', label: '快', hint: '优先' },
];

function gasSymbolOf(chain?: string): string {
  return String(chain || '').toUpperCase() === 'BSC' ? 'BNB' : 'ETH';
}

function fmtNativePerTx(n: number | undefined, symbol: string): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n <= 0) return `0 ${symbol}`;
  if (n < 0.0000001) return `${n.toExponential(3)} ${symbol}`;
  if (n < 0.001) return `${n.toFixed(8).replace(/\.?0+$/, '')} ${symbol}`;
  return `${n.toFixed(6)} ${symbol}`;
}

export function GasFeeTierPicker(props: {
  value: GasFeeTier;
  chain?: string;
  /** 多条链时，每个档位同时标出 ETH 和 BNB 的单笔预估 */
  chains?: string[];
  disabled?: boolean;
  onChange: (tier: GasFeeTier) => void;
  saving?: boolean;
  onSaving?: (v: boolean) => void;
}) {
  const chains = (props.chains?.length ? props.chains : [props.chain || 'ARB']).map((c) =>
    String(c || 'ARB').toUpperCase(),
  );
  const chainsKey = chains.join(',');
  const [labelByTier, setLabelByTier] = useState<Partial<Record<GasFeeTier, string>>>({});

  useEffect(() => {
    let cancelled = false;
    const list = chainsKey.split(',').filter(Boolean);
    const acc: Record<string, { tiers?: Record<GasFeeTier, { ethPerTx?: number }> } | null> = {};
    const publish = () => {
      if (cancelled) return;
      const next: Partial<Record<GasFeeTier, string>> = {};
      for (const tier of ['standard', 'fast'] as GasFeeTier[]) {
        next[tier] = list
          .map((c) => {
            if (!(c in acc)) return `${gasSymbolOf(c)} …`;
            const tiers = acc[c]?.tiers;
            if (!tiers) return `${gasSymbolOf(c)} —`;
            return fmtNativePerTx(tiers[tier]?.ethPerTx, gasSymbolOf(c));
          })
          .join(' · ');
      }
      setLabelByTier(next);
    };
    publish();
    for (const c of list) {
      AdminApi.collectionGasFeePreview(c)
        .then((res) => {
          acc[c] = res;
          publish();
        })
        .catch(() => {
          acc[c] = null;
          publish();
        });
    }
    return () => {
      cancelled = true;
    };
  }, [chainsKey]);

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
      title="下方为各链单笔原生币转账预估手续费。标准=链上建议价。同一档位会用在这次补的每一条链上。"
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
            title={`${t.label}：${t.hint}，约 ${labelByTier[t.id] || '—'}/笔`}
            onClick={() => pick(t.id)}
          >
            <span className="gas-fee-opt-top">
              <b>{t.label}</b>
              <small>{t.hint}</small>
            </span>
            <span className="gas-fee-opt-eth">{labelByTier[t.id] || '—'}</span>
          </button>
        ))}
      </span>
    </span>
  );
}
