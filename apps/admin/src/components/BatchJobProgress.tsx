type Props = {
  running?: boolean;
  phase?: string | null;
  /** 待发送合计 */
  total: number;
  /** 成功数 */
  done: number;
  failed: number;
  remaining: number;
  scanned?: number;
  totalWallets?: number;
};

function pct(n: number) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, Math.max(0, n));
}

export function BatchJobProgress({
  running,
  phase,
  total,
  done,
  failed,
  remaining,
  scanned = 0,
  totalWallets = 0,
}: Props) {
  const scanning = phase === 'scan';
  const denom = scanning ? totalWallets : total;
  const donePct = pct(denom > 0 ? (scanning ? 0 : (done / denom) * 100) : 0);
  const failPct = pct(denom > 0 ? (scanning ? 0 : (failed / denom) * 100) : 0);
  const scanPct = pct(totalWallets > 0 ? (scanned / totalWallets) * 100 : running ? 8 : 0);
  const barTotal = scanning ? scanPct : Math.min(100, donePct + failPct);
  const phaseText =
    phase === 'scan'
      ? `扫描 ${scanned}/${totalWallets || '…'}`
      : phase === 'send'
        ? `发送 ${done + failed}/${total || '…'}`
        : phase === 'done'
          ? '已完成'
          : running
            ? '进行中'
            : '';

  const sum = scanning ? totalWallets : total;
  const finished = scanning ? scanned : done;
  const left = scanning ? Math.max(0, (totalWallets || 0) - scanned) : remaining;
  const failShow = scanning ? 0 : failed;

  return (
    <div style={{ fontSize: 12, lineHeight: 1.35, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ whiteSpace: 'nowrap' }}>
          合计 <b>{sum}</b>
          <span style={{ opacity: 0.35, margin: '0 6px' }}>|</span>
          完成 <b>{finished}</b>
          <span style={{ opacity: 0.35, margin: '0 6px' }}>|</span>
          剩余 <b>{left}</b>
          <span style={{ opacity: 0.35, margin: '0 6px' }}>|</span>
          失败{' '}
          <b style={{ color: failShow ? 'var(--danger, #dc2626)' : undefined }}>{failShow}</b>
        </span>
        <div
          style={{
            flex: 1,
            height: 6,
            minWidth: 36,
            borderRadius: 99,
            background: 'rgba(0,0,0,0.08)',
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          {scanning ? (
            <div
              style={{
                width: `${scanPct}%`,
                height: '100%',
                background: 'var(--primary, #2b7de9)',
                transition: 'width 0.3s ease',
              }}
            />
          ) : (
            <>
              <div
                style={{
                  width: `${donePct}%`,
                  height: '100%',
                  background: 'var(--ok, #16a34a)',
                  transition: 'width 0.3s ease',
                }}
              />
              <div
                style={{
                  width: `${failPct}%`,
                  height: '100%',
                  background: 'var(--danger, #dc2626)',
                  transition: 'width 0.3s ease',
                }}
              />
            </>
          )}
        </div>
        <span className="hint" style={{ margin: 0, whiteSpace: 'nowrap' }}>
          {phaseText}
          {!scanning && denom > 0 ? ` ${Math.round(barTotal)}%` : ''}
        </span>
      </div>
    </div>
  );
}
