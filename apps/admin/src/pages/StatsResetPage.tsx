import { useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';

const ACTIONS = [
  {
    range: '1m' as const,
    label: '清理 1 个月前',
    confirm: '删除 1 个月前的已结束挂单日志、平仓利润和佣金记录？最近 1 个月保留。',
  },
  {
    range: '3m' as const,
    label: '清理 3 个月前',
    confirm: '删除 3 个月前的已结束挂单日志、平仓利润和佣金记录？最近 3 个月保留。',
  },
  {
    range: 'all' as const,
    label: '全部清理',
    confirm:
      '清空全部已结束挂单日志、平仓利润和佣金记录？总览上的累计成交和累计利润、佣金会从 0 重新计。此操作不可恢复。',
  },
];

export function StatsResetPage() {
  const [busy, setBusy] = useState('');
  const [last, setLast] = useState('');

  async function run(item: (typeof ACTIONS)[number]) {
    if (!(await confirmDialog(item.confirm))) return;
    setBusy(item.range);
    try {
      const res = await AdminApi.resetTrackingStats(item.range);
      const text = `已删除挂单日志 ${res.deleted.logs} 条，平仓利润 ${res.deleted.profits} 条，佣金记录 ${res.deleted.commissions} 条`;
      setLast(text);
      toast(text, 'ok');
    } catch (e: any) {
      toast(e.message || '清理失败', 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page-list">
      <div className="card" style={{ maxWidth: 720 }}>
        <h3 style={{ marginTop: 0 }}>数据清理</h3>
        <p className="hint">
          用来把总览「合约」里的累计成交、失败，以及「利润与佣金」清回可跟踪的起点。1 个月、3 个月只删那个时间点之前的记录；全部清理后，累计数字从 0 开始算。
        </p>
        <p className="hint">
          准备下单、已挂单、撤单失败这些还没结束的单会留下。点卡余额、充值、提现和用户不会改。已经进点卡的佣金不会扣回。
        </p>
        <div className="row" style={{ marginTop: 16 }}>
          {ACTIONS.map((item) => (
            <button key={item.range} onClick={() => void run(item)} disabled={!!busy}>
              {busy === item.range ? '清理中…' : item.label}
            </button>
          ))}
        </div>
        {last ? <p className="hint">{last}</p> : null}
      </div>
    </div>
  );
}

const FLOW_ACTIONS = [
  {
    range: '1m' as const,
    label: '清理 1 个月前',
    confirm: '删除 1 个月前的资金流水？点卡余额、充值单和提现不改。',
  },
  {
    range: '3m' as const,
    label: '清理 3 个月前',
    confirm: '删除 3 个月前的资金流水？点卡余额、充值单和提现不改。',
  },
  {
    range: 'all' as const,
    label: '全部清理',
    confirm: '清空全部资金流水？手机和管理端的流水记录会空，点卡余额不变。此操作不可恢复。',
  },
];

export function FundFlowResetPage() {
  const [busy, setBusy] = useState('');
  const [last, setLast] = useState('');

  async function run(item: (typeof FLOW_ACTIONS)[number]) {
    if (!(await confirmDialog(item.confirm))) return;
    setBusy(item.range);
    try {
      const res = await AdminApi.resetFundFlow(item.range);
      const text = `已删除资金流水 ${res.deleted} 条`;
      setLast(text);
      toast(text, 'ok');
    } catch (e: any) {
      toast(e.message || '清理失败', 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page-list">
      <div className="card" style={{ maxWidth: 720 }}>
        <h3 style={{ marginTop: 0 }}>资金流水</h3>
        <p className="hint">
          删除手机「资金流水」和管理端点卡流水记录。1 个月、3 个月只删那个时间点之前的记录；全部清理后流水列表为空。
        </p>
        <p className="hint">点卡余额不改。充值单、提现和用户保留。已经入账的金额不会扣回。</p>
        <div className="row" style={{ marginTop: 16 }}>
          {FLOW_ACTIONS.map((item) => (
            <button key={item.range} onClick={() => void run(item)} disabled={!!busy}>
              {busy === item.range ? '清理中…' : item.label}
            </button>
          ))}
        </div>
        {last ? <p className="hint">{last}</p> : null}
      </div>
    </div>
  );
}
