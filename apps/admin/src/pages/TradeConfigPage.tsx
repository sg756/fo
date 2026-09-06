import { useCallback, useEffect, useState } from 'react';
import { AdminApi } from '../api';
import { toast } from '../components/Toast';

export function TradeConfigPage() {
  const [cfg, setCfg] = useState<any>(null);
  const [signalMs, setSignalMs] = useState('60000');
  const [pollMs, setPollMs] = useState('500');
  const [orderExpire, setOrderExpire] = useState('60');
  const [openMinPoint, setOpenMinPoint] = useState('0');
  const [qpIntervalMin, setQpIntervalMin] = useState('5');
  const [chaseOnExpire, setChaseOnExpire] = useState(false);
  const [followHalted, setFollowHalted] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const c = await AdminApi.followerConfig();
      setCfg(c);
      setSignalMs(String(c.signalTimeoutMs ?? Math.round((c.signalTimeoutSec ?? 60) * 1000)));
      setPollMs(String(c.pollMs ?? 500));
      setOrderExpire(String(c.orderExpireSec ?? 60));
      setOpenMinPoint(String(c.openMinPointBalance ?? 0));
      setQpIntervalMin(String(c.queryPositionIntervalMin ?? 5));
      setChaseOnExpire(!!c.chaseOnExpire);
      setFollowHalted(!!c.followHalted);
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setErr('');
    try {
      await AdminApi.setSignalTimeout(Number(signalMs));
      await AdminApi.setPollMs(Number(pollMs));
      await AdminApi.setOrderExpire(Number(orderExpire));
      await AdminApi.setOpenMinPoint(Number(openMinPoint));
      const qpMin = Math.max(2, Math.floor(Number(qpIntervalMin) || 5));
      await AdminApi.setQueryPositionInterval(qpMin);
      await AdminApi.setChaseOnExpire(chaseOnExpire);
      await AdminApi.setFollowHalted(followHalted);
      toast('配置已保存', 'ok');
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div>
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <h3>采集参数</h3>
        <div className="row">
          <label>信号超时(ms)</label>
          <input value={signalMs} onChange={(e) => setSignalMs(e.target.value)} style={{ width: 120 }} />
          <label>轮询(ms)</label>
          <input value={pollMs} onChange={(e) => setPollMs(e.target.value)} style={{ width: 100 }} />
          <label>挂单过期(秒)</label>
          <input value={orderExpire} onChange={(e) => setOrderExpire(e.target.value)} style={{ width: 100 }} />
          <label>开仓最低点卡</label>
          <input value={openMinPoint} onChange={(e) => setOpenMinPoint(e.target.value)} style={{ width: 100 }} />
          <button onClick={save}>保存</button>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: '12px 14px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--hover)',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              cursor: 'pointer',
              margin: 0,
            }}
          >
            <input
              type="checkbox"
              checked={followHalted}
              onChange={(e) => setFollowHalted(e.target.checked)}
              style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0 }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 650, fontSize: 14, color: 'var(--text)' }}>
                关闭跟单
              </span>
              <span className="hint" style={{ display: 'block', marginTop: 4 }}>
                勾选后全站自动跟单不再开任何新单（含开仓/平仓信号、过期市价追入）。
                保存后立即生效，默认不勾选。
              </span>
            </span>
          </label>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: '12px 14px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--hover)',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              cursor: 'pointer',
              margin: 0,
            }}
          >
            <input
              type="checkbox"
              checked={chaseOnExpire}
              onChange={(e) => setChaseOnExpire(e.target.checked)}
              style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0 }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 650, fontSize: 14, color: 'var(--text)' }}>
                价未到则现价追入
              </span>
              <span className="hint" style={{ display: 'block', marginTop: 4 }}>
                仅系统因「挂单过期」自动撤单且未成交时，若开启则按原方向立刻市价追一笔。
                用户手动撤、运营后台撤均不追。全站开关，默认关闭。
              </span>
            </span>
          </label>
        </div>

        <p className="hint">
          信号超时按毫秒判断（如 60000 = 60 秒）。自动跟单：账号列表内信号 × 用户模板绑定该信号账户 ×
          已开跟单；开仓另检点卡与模板单笔最小金额，不足记失败流水。挂单超过「挂单过期」秒数由系统自动撤。0 =
          不限制开仓点卡。
        </p>
        {cfg ? (
          <p className="hint">
            当前生效：轮询 {cfg.pollMs}ms · 信号超时{' '}
            {cfg.signalTimeoutMs ?? Math.round((cfg.signalTimeoutSec ?? 60) * 1000)}ms · 挂单过期{' '}
            {cfg.orderExpireSec}s · 开仓最低点卡 {cfg.openMinPointBalance ?? 0} · 关闭跟单{' '}
            {cfg.followHalted ? '是' : '否'} · 现价追入 {cfg.chaseOnExpire ? '开' : '关'} · Worker{' '}
            {String(cfg.enabled)}
            {cfg.queryPositionIntervalMin != null
              ? ` · 持仓对齐 ${cfg.queryPositionIntervalMin}分钟`
              : ''}
          </p>
        ) : null}
      </div>

      <div className="card">
        <h3>交易所持仓对齐</h3>
        <p className="hint">
          定时用 QueryPosition 把本地 OPEN 合约仓与交易所对齐。按代理串行，每个用户间隔 5
          秒；列表刷新不查交易所。保存后线程按新间隔执行。
        </p>
        <div className="row">
          <label>对齐间隔(分钟)</label>
          <input
            value={qpIntervalMin}
            onChange={(e) => setQpIntervalMin(e.target.value)}
            style={{ width: 100 }}
            title="最少 2 分钟"
          />
          <button onClick={save}>保存</button>
        </div>
        <p className="hint">最少 2 分钟，默认 5 分钟。手动对齐走同一条队列，同一用户冷却 2 分钟。</p>
        {cfg ? (
          <p className="hint">
            当前生效：{cfg.queryPositionIntervalMin ?? 5} 分钟 · 同代理间隔{' '}
            {cfg.queryPositionGapSec ?? 5} 秒 · 冷却 {cfg.queryPositionCooldownMin ?? 2} 分钟
            {cfg.queryPositionQueueSize != null ? ` · 队列 ${cfg.queryPositionQueueSize}` : ''}
          </p>
        ) : null}
      </div>

      <MiddlewareSection onErr={setErr} />
    </div>
  );
}

function MiddlewareSection({ onErr }: { onErr: (s: string) => void }) {
  const [base, setBase] = useState('http://127.0.0.1:1820');
  const [serviceKey, setServiceKey] = useState('');
  const [serviceKeyMasked, setServiceKeyMasked] = useState('');
  const [serviceKeyConfigured, setServiceKeyConfigured] = useState(false);
  const [accounts, setAccounts] = useState<any[] | null>(null);
  const [pulling, setPulling] = useState(false);

  const applyConfig = useCallback((c: Awaited<ReturnType<typeof AdminApi.middlewareConfig>>) => {
    setBase(c.base);
    setServiceKeyMasked(c.serviceKeyMasked || '');
    setServiceKeyConfigured(!!c.serviceKeyConfigured);
    setServiceKey('');
  }, []);

  const loadBase = useCallback(() => {
    AdminApi.middlewareConfig()
      .then(applyConfig)
      .catch((e) => onErr(e.message));
  }, [applyConfig, onErr]);

  const loadAccountOptions = useCallback(() => {
    setPulling(true);
    onErr('');
    AdminApi.middlewareAccounts(true)
      .then((r) => {
        setAccounts(r.items || []);
        toast(
          `中间件连通正常，已拉取并刷新账号缓存 ${r.items?.length ?? 0} 个（信号源；跟单按模板绑定账户匹配）`,
          'ok',
        );
      })
      .catch((e) => {
        setAccounts(null);
        onErr(e.message || '拉取账户失败，中间件可能未连通');
      })
      .finally(() => setPulling(false));
  }, [onErr]);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  async function saveBase() {
    try {
      const body: { base: string; serviceKey?: string } = {
        base: base.trim(),
      };
      if (serviceKey.trim()) body.serviceKey = serviceKey.trim();
      const c = await AdminApi.setMiddlewareConfig(body);
      applyConfig(c);
      toast('中间件配置已保存', 'ok');
    } catch (e: any) {
      onErr(e.message);
    }
  }

  return (
    <div className="card">
      <h3>交易中间件</h3>
      <p className="hint">
        地址形如 <code>http://域名或公网IP:1820/</code>。用「拉取账户列表」验证连通并刷新服务端账号缓存；账号均可作信号源，用户是否跟单取决于模板是否绑定该账户。代理请到「代理IP」菜单管理。
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <label style={{ margin: 0 }}>请求 API 地址</label>
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="http://your-host:1820"
          style={{ minWidth: 280, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
        />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <label style={{ margin: 0 }}>ServiceKey</label>
        <input
          type="password"
          value={serviceKey}
          onChange={(e) => setServiceKey(e.target.value)}
          placeholder={
            serviceKeyConfigured
              ? `已配置 ${serviceKeyMasked || '****'}（留空不改）`
              : '中间件管理密钥'
          }
          style={{ minWidth: 280, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
          autoComplete="off"
        />
        <button onClick={saveBase}>保存配置</button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="ghost" disabled={pulling} onClick={loadAccountOptions}>
          {pulling ? '拉取中…' : '拉取账户列表'}
        </button>
      </div>

      {accounts ? (
        <table>
          <thead>
            <tr>
              <th>账户 GID</th>
              <th>名称</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a, i) => {
              const gid = String(a.value ?? a.gid ?? '');
              return (
                <tr key={i}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{gid}</td>
                  <td>{a.name}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {accounts && accounts.length === 0 ? <p className="hint">账号列表为空</p> : null}
    </div>
  );
}
