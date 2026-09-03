import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminApi } from '../api';

function money(n: any) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Stat({
  label,
  value,
  accent,
  to,
}: {
  label: string;
  value: any;
  accent?: 'green' | 'red' | 'orange';
  to?: string;
}) {
  const color = accent === 'green' ? '#16a34a' : accent === 'red' ? '#dc2626' : accent === 'orange' ? '#d97706' : undefined;
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>
        {value ?? '—'}
      </div>
    </>
  );
  if (to) {
    return (
      <Link to={to} className="stat stat-link">
        {body}
      </Link>
    );
  }
  return <div className="stat">{body}</div>;
}

export function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');

  const load = () => {
    AdminApi.summary()
      .then(setData)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const n = data?.notifications || {};
  const u = data?.users || {};
  const f = data?.follow || {};
  const funds = data?.funds || {};
  const p = data?.profit || {};

  return (
    <div className="dashboard-page">
      {err ? <p className="err">{err}</p> : null}

      <h3>待办提醒</h3>
      <div className="grid">
        <Stat label="待审核用户" value={n.pendingUsers} accent={n.pendingUsers ? 'orange' : undefined} />
        <Stat label="今日新注册" value={n.todayRegistrations} />
        <Stat
          label="待审提现"
          value={n.pendingWithdraws}
          accent={n.pendingWithdraws ? 'orange' : undefined}
          to="/withdraws?status=PENDING"
        />
        <Stat label="待处理充值" value={n.pendingRecharges} accent={n.pendingRecharges ? 'orange' : undefined} />
        <Stat
          label="待结算利润"
          value={n.unsettledProfits}
          accent={n.unsettledProfits ? 'orange' : undefined}
          to="/reconcile?issues=1"
        />
        <Stat label="撤单失败" value={n.cancelFailed} accent={n.cancelFailed ? 'red' : undefined} to="/trade/order-logs?status=CANCEL_FAILED" />
      </div>

      <h3>用户</h3>
      <div className="grid">
        <Stat label="用户总数" value={u.total} />
        <Stat label="活跃用户" value={u.active} accent="green" />
        <Stat label="待审核" value={u.pending} />
        <Stat label="已禁用" value={u.disabled} />
        <Stat label="今日新增" value={u.todayNew} />
      </div>

      <h3>跟单</h3>
      <div className="grid">
        <Stat label="开启跟单用户" value={f.enabled} accent="green" to="/trade/followers?readyOnly=0" />
        <Stat label="今日跟单笔数" value={f.todayFollows} />
        <Stat label="累计成交" value={f.filled} accent="green" to="/trade/order-logs?status=FILLED" />
        <Stat label="累计失败" value={f.failed} accent={f.failed ? 'red' : undefined} to="/trade/order-logs?status=FAILED" />
        <Stat label="撤单失败" value={f.cancelFailed} accent={f.cancelFailed ? 'red' : undefined} to="/trade/order-logs?status=CANCEL_FAILED" />
        <Stat label="成交成功率" value={f.successRate != null ? `${f.successRate}%` : '—'} />
      </div>

      <h3>资金 (USDT)</h3>
      <div className="grid">
        <Stat label="点卡总余额" value={money(funds.pointBalance)} />
        <Stat label="点卡冻结" value={money(funds.pointFrozen)} />
        <Stat label="今日充值入账" value={money(funds.rechargeToday)} accent="green" />
        <Stat label="累计充值入账" value={money(funds.rechargeTotal)} />
        <Stat label="累计已结算提现" value={money(funds.withdrawSettled)} />
      </div>

      <h3>利润与佣金 (USDT)</h3>
      <div className="grid">
        <Stat label="今日平仓利润" value={money(p.today)} accent={Number(p.today) >= 0 ? 'green' : 'red'} />
        <Stat label="累计平仓利润" value={money(p.total)} accent={Number(p.total) >= 0 ? 'green' : 'red'} />
        <Stat label="累计佣金合计" value={money(p.commissionTotal)} />
        <Stat label="累计用户佣金" value={money(p.commissionUserTotal)} />
        <Stat label="累计平台佣金" value={money(p.commissionPlatformTotal)} />
        <Stat label="待结算利润笔数" value={p.unsettledCount} />
        <Stat label="待结算利润金额" value={money(p.unsettledAmount)} accent={p.unsettledAmount ? 'orange' : undefined} />
      </div>
    </div>
  );
}
