import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { confirmDialog } from '../components/ConfirmDialog';
import { Pagination } from '../components/Pagination';
import { usePager } from '../hooks/usePager';

/** 改为 true 可重新显示「已实现盈亏公式试算」 */
const SHOW_PNL_PREVIEW = false;

export function CommissionPage() {
  const [rules, setRules] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const rulesPager = usePager(20);

  const [l1, setL1] = useState('25');
  const [l2, setL2] = useState('50');
  const [platform, setPlatform] = useState('25');
  const [extract, setExtract] = useState('10');
  const [name, setName] = useState('default');

  // 手动录入平仓利润 (补录)
  const [mpQuery, setMpQuery] = useState('');
  const [mpUserId, setMpUserId] = useState('');
  const [mpExchange, setMpExchange] = useState('BINANCE');
  const [mpSymbol, setMpSymbol] = useState('BTCUSDT');
  const [mpProfit, setMpProfit] = useState('');
  const [mpLooking, setMpLooking] = useState(false);
  /** 仅查找后展示：成功显示用户属性，失败显示错误 */
  const [mpLookupHint, setMpLookupHint] = useState<{ ok: boolean; text: string } | null>(null);

  // 盈亏公式试算
  const [pnlSide, setPnlSide] = useState('long');
  const [pnlOpen, setPnlOpen] = useState('100');
  const [pnlClose, setPnlClose] = useState('105');
  const [pnlQty, setPnlQty] = useState('1');
  const [pnlOpenFee, setPnlOpenFee] = useState('-0.1');
  const [pnlCloseFee, setPnlCloseFee] = useState('-0.1');
  const [pnlMult, setPnlMult] = useState('1');
  const [pnlResult, setPnlResult] = useState<{
    side: string;
    gross: number;
    fee: number;
    profit: number;
    multiplier: number;
  } | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const r = await AdminApi.commissionRules();
      setRules(Array.isArray(r) ? r : []);
      const active = (r || []).find((x: any) => x.active) || r?.[0];
      if (active) {
        setName(active.name || 'default');
        setExtract(String(Number(active.extractRate ?? 1) * 100));
        setL1(String(Number(active.l1Rate) * 100));
        setL2(String(Number(active.l2Rate) * 100));
        setPlatform(String(Number(active.platformRate) * 100));
      }
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveRule() {
    setMsg('');
    const extractRate = Number(extract) / 100;
    const l1Rate = Number(l1) / 100;
    const l2Rate = Number(l2) / 100;
    const platformRate = Number(platform) / 100;
    if (!Number.isFinite(extractRate) || extractRate < 0 || extractRate > 1) {
      setErr('每单抽成比例须在 0～100%');
      return;
    }
    if (l1Rate + l2Rate + platformRate > 1) {
      setErr('抽成池内三级比例之和不能超过 100%');
      return;
    }
    try {
      await AdminApi.saveCommissionRule({
        name,
        extractRate,
        l1Rate,
        l2Rate,
        platformRate,
        active: true,
      });
      setMsg('佣金规则已保存并启用');
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function settle() {
    setMsg('');
    if (!(await confirmDialog('立即结算所有未结算的获利利润，按当前规则分润？'))) return;
    try {
      const res = await AdminApi.settleCommission();
      setMsg(`结算完成${typeof res === 'object' ? '：' + JSON.stringify(res) : ''}`);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function activateRule(r: any) {
    setMsg('');
    setErr('');
    try {
      await AdminApi.saveCommissionRule({
        id: r.id,
        name: r.name,
        extractRate: Number(r.extractRate ?? 1),
        l1Rate: Number(r.l1Rate),
        l2Rate: Number(r.l2Rate),
        platformRate: Number(r.platformRate),
        active: true,
      });
      setName(r.name || 'default');
      setExtract(String(Number(r.extractRate ?? 1) * 100));
      setL1(String(Number(r.l1Rate) * 100));
      setL2(String(Number(r.l2Rate) * 100));
      setPlatform(String(Number(r.platformRate) * 100));
      setMsg(`已重新启用规则「${r.name || r.id}」`);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function deleteRule(r: any) {
    setMsg('');
    setErr('');
    if (r.active) {
      setErr('启用中的规则不能删除');
      return;
    }
    const label = r.name || r.id;
    if (!(await confirmDialog(`确认删除停用规则「${label}」？此操作不可恢复。`))) return;
    try {
      await AdminApi.deleteCommissionRule(r.id);
      setMsg(`已删除规则「${label}」`);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function lookupMpUser() {
    const q = mpQuery.trim();
    if (!q) {
      setMpUserId('');
      setMpLookupHint({ ok: false, text: '请输入用户ID或昵称' });
      return;
    }
    setMpLooking(true);
    setMpLookupHint(null);
    try {
      const r = await AdminApi.users({ q });
      const hit =
        (r.items || []).find(
          (u: any) =>
            String(u.userNo) === q ||
            u.email?.toLowerCase() === q.toLowerCase() ||
            u.inviteCode?.toLowerCase() === q.toLowerCase() ||
            u.id === q,
        ) || r.items?.[0];
      if (!hit) {
        setMpUserId('');
        setMpLookupHint({ ok: false, text: '未找到用户，请核对用户ID或昵称' });
        return;
      }
      setMpUserId(hit.id);
      const label = `${hit.nickname || hit.email}${hit.userNo != null ? ` #${hit.userNo}` : ''}`;
      setMpLookupHint({
        ok: true,
        text: `已选：${label}（${hit.email || '—'} · ID ${hit.userNo ?? '—'}）`,
      });
    } catch (e: any) {
      setMpUserId('');
      setMpLookupHint({ ok: false, text: e.message || '查找失败' });
    } finally {
      setMpLooking(false);
    }
  }

  async function recordProfit() {
    setMsg('');
    setErr('');
    const profit = Number(mpProfit);
    if (!mpUserId.trim()) {
      setErr('请先查找并选中用户');
      return;
    }
    if (!Number.isFinite(profit) || profit === 0) {
      setErr('请填写有效的利润金额（可负）');
      return;
    }
    try {
      const res = await AdminApi.manualProfit({
        userId: mpUserId.trim(),
        exchange: mpExchange,
        symbol: mpSymbol.trim() || '—',
        profit,
      });
      setMsg(`利润已入库并结算：${JSON.stringify(res)}`);
      setMpProfit('');
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function previewPnl() {
    setErr('');
    try {
      const res = await AdminApi.previewPnl({
        positionSide: pnlSide,
        openAvg: Number(pnlOpen),
        closeAvg: Number(pnlClose),
        qty: Number(pnlQty),
        openFee: Number(pnlOpenFee) || 0,
        closeFee: Number(pnlCloseFee) || 0,
        multiplier: Number(pnlMult) || 1,
      });
      setPnlResult(res);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div className="page-list commission-page">
      <div className="page-title-with-help" style={{ marginBottom: 8 }}>
        <span
          className="help-tip"
          tabIndex={0}
          aria-label="规则说明"
          data-tip="级差分销：正利润先按「每单抽成」抽出一部分（点卡只扣抽成），抽成池内再按直推 / 间推 / 平台分配；缺档或未分完归平台。余下利润归用户（交易所）。亏损不结算。开仓最低点卡在「跟单配置」设置。"
        >
          ?
        </span>
      </div>
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      <div className="card">
        <h3>分润比例（%）</h3>
        <div className="row">
          <label>规则名</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
          <label>每单抽成%</label>
          <input
            value={extract}
            onChange={(e) => setExtract(e.target.value)}
            style={{ width: 80 }}
            title="从正利润中抽取的比例，点卡只扣这一部分"
          />
          <label>直推%</label>
          <input
            value={l1}
            onChange={(e) => setL1(e.target.value)}
            style={{ width: 80 }}
            title="相对抽成池"
          />
          <label>间推%</label>
          <input
            value={l2}
            onChange={(e) => setL2(e.target.value)}
            style={{ width: 80 }}
            title="相对抽成池"
          />
          <label>平台%</label>
          <input
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            style={{ width: 80 }}
            title="相对抽成池"
          />
          <button onClick={saveRule}>保存并启用</button>
          <button className="ghost" onClick={settle}>
            立即结算
          </button>
        </div>
        <p className="hint">
          例：盈利 100、抽成 {Number(extract) || 0}% → 扣点卡{' '}
          {((100 * (Number(extract) || 0)) / 100).toFixed(2)}；再在抽成池内按直推/间推/平台分润。
          池内合计 {(Number(l1) + Number(l2) + Number(platform)).toFixed(2)}%
          {Number(l1) + Number(l2) + Number(platform) < 100
            ? `（未分完 ${Math.max(0, 100 - (Number(l1) + Number(l2) + Number(platform))).toFixed(2)}% 归平台）`
            : ''}
          ；用户留利润 {(100 - (Number(extract) || 0)).toFixed(2)}%。
        </p>
      </div>

      {SHOW_PNL_PREVIEW ? (
        <div className="card">
          <h3>已实现盈亏公式试算</h3>
          <p className="hint">
            多: (平仓均价 − 开仓均价) × 数量 × 乘数 + 开仓手续费 + 平仓手续费；空: (开仓均价 −
            平仓均价) × 数量 × 乘数 + 开/平手续费。「负数为支付」直接加减（例 −0.1 表示支付
            0.1）。
          </p>
          <div className="row">
            <label>方向</label>
            <select value={pnlSide} onChange={(e) => setPnlSide(e.target.value)}>
              <option value="long">多 long</option>
              <option value="short">空 short</option>
            </select>
            <label>开仓均价</label>
            <input value={pnlOpen} onChange={(e) => setPnlOpen(e.target.value)} style={{ width: 90 }} />
            <label>平仓均价</label>
            <input value={pnlClose} onChange={(e) => setPnlClose(e.target.value)} style={{ width: 90 }} />
            <label>数量</label>
            <input value={pnlQty} onChange={(e) => setPnlQty(e.target.value)} style={{ width: 70 }} />
            <label>开仓费</label>
            <input value={pnlOpenFee} onChange={(e) => setPnlOpenFee(e.target.value)} style={{ width: 70 }} />
            <label>平仓费</label>
            <input value={pnlCloseFee} onChange={(e) => setPnlCloseFee(e.target.value)} style={{ width: 70 }} />
            <label>乘数</label>
            <input value={pnlMult} onChange={(e) => setPnlMult(e.target.value)} style={{ width: 60 }} />
            <button onClick={previewPnl}>试算</button>
          </div>
          {pnlResult ? (
            <p className="hint">
              {pnlResult.side === 'short' ? '空' : '多'} · 毛利 {pnlResult.gross} · 手续费合计{' '}
              {pnlResult.fee} · 乘数 {pnlResult.multiplier} →{' '}
              <span style={{ color: pnlResult.profit >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                净盈亏 {pnlResult.profit}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <h3>手动录入平仓利润（补录）</h3>
        <div className="row">
          <label>用户</label>
          <input
            value={mpQuery}
            onChange={(e) => {
              setMpQuery(e.target.value);
              setMpLookupHint(null);
              setMpUserId('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') lookupMpUser();
            }}
            style={{ width: 200 }}
            placeholder="用户ID或昵称"
          />
          <button className="ghost" onClick={lookupMpUser} disabled={mpLooking}>
            {mpLooking ? '查找中…' : '查找'}
          </button>
          {mpLookupHint ? (
            <span className={mpLookupHint.ok ? 'ok-msg' : 'err'} style={{ margin: 0 }}>
              {mpLookupHint.text}
            </span>
          ) : null}
        </div>
        <div className="row">
          <label>交易所</label>
          <select value={mpExchange} onChange={(e) => setMpExchange(e.target.value)}>
            {['BINANCE', 'OKX', 'BITGET', 'BYBIT', 'GATE'].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <label>交易对</label>
          <input value={mpSymbol} onChange={(e) => setMpSymbol(e.target.value)} style={{ width: 120 }} />
          <label>利润</label>
          <input value={mpProfit} onChange={(e) => setMpProfit(e.target.value)} style={{ width: 100 }} placeholder="可负" />
          <button onClick={recordProfit} disabled={!mpUserId}>
            入库并结算
          </button>
        </div>
        <p className="hint">
          利润 &gt; 0：只扣用户点卡分润并分佣（不入账获利）；≤ 0 只入库、标记已结算。
        </p>
      </div>

      <div className="card list-body">
        <h3>规则历史</h3>
        <p className="hint">停用中的旧规则可点「启用」恢复；同时只会有一条启用中的规则。</p>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>每单抽成</th>
              <th>直推(池内)</th>
              <th>间推(池内)</th>
              <th>平台(池内)</th>
              <th>启用</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules
              .slice((rulesPager.page - 1) * rulesPager.pageSize, rulesPager.page * rulesPager.pageSize)
              .map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{(Number(r.extractRate ?? 1) * 100).toFixed(2)}%</td>
                <td>{(Number(r.l1Rate) * 100).toFixed(2)}%</td>
                <td>{(Number(r.l2Rate) * 100).toFixed(2)}%</td>
                <td>{(Number(r.platformRate) * 100).toFixed(2)}%</td>
                <td>{r.active ? <span className="badge ok">启用</span> : <span className="badge">停用</span>}</td>
                <td>{new Date(r.updatedAt || r.createdAt).toLocaleString()}</td>
                <td className="ops">
                  {r.active ? (
                    '—'
                  ) : (
                    <span className="ops-btns">
                      <button type="button" className="btn-text" onClick={() => activateRule(r)}>
                        启用
                      </button>
                      <button
                        type="button"
                        className="btn-text danger"
                        onClick={() => void deleteRule(r)}
                      >
                        删除
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rules.length === 0 ? <p className="hint list-empty">暂无规则</p> : null}
        <Pagination
          total={rules.length}
          page={rulesPager.page}
          pageSize={rulesPager.pageSize}
          pageSizes={[10, 20, 50, 100]}
          onChange={rulesPager.onPageChange}
        />
      </div>
    </div>
  );
}
