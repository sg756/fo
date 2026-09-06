import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApi } from '../api';
import { Pagination } from '../components/Pagination';
import { ListLoading } from '../components/ListLoading';
import { usePager } from '../hooks/usePager';

export function SymbolListPage() {
  const [items, setItems] = useState<any[]>([]);
  const [refreshMs, setRefreshMs] = useState(30 * 60 * 1000);
  const [apiCode, setApiCode] = useState('');
  const [coin, setCoin] = useState('');
  const [equalCoin, setEqualCoin] = useState('');
  const [keyword, setKeyword] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const pager = usePager(50);

  const load = useCallback(async (force = false) => {
    setErr('');
    setMsg('');
    setLoading(true);
    try {
      const r = await AdminApi.middlewareSymbols(force);
      const list = Array.isArray(r.items) ? r.items : [];
      setItems(list);
      setRefreshMs(r.refreshMs ?? r.ttlMs ?? 30 * 60 * 1000);
      const n = r.count ?? list.length;
      if (force) {
        if (r.refreshed) {
          setMsg(`缓存刷新成功：${n} 条`);
        } else {
          setMsg(`刷新失败，仍显示旧缓存（${n} 条）`);
          if (r.error) setErr(String(r.error));
        }
      } else {
        setMsg(`缓存 ${n} 条`);
        if (r.error && !list.length) setErr(String(r.error));
      }
      pager.goFirst();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [pager.goFirst]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const filtered = useMemo(() => {
    const ac = apiCode.trim().toLowerCase();
    const c = coin.trim().toUpperCase();
    const eq = equalCoin.trim().toUpperCase();
    const kw = keyword.trim().toLowerCase();
    return items.filter((s) => {
      if (ac && String(s.apiCode || '').toLowerCase() !== ac) return false;
      if (c && String(s.coinName || '').toUpperCase() !== c) return false;
      if (eq && String(s.equalCoinName || '').toUpperCase() !== eq) return false;
      if (kw) {
        const blob =
          `${s.apiCode} ${s.apiName} ${s.coinName} ${s.equalCoinName} ${s.symbol} ${s.symbolKey}`.toLowerCase();
        if (!blob.includes(kw)) return false;
      }
      return true;
    });
  }, [items, apiCode, coin, equalCoin, keyword]);

  useEffect(() => {
    pager.setTotal(filtered.length);
    pager.goFirst();
  }, [filtered.length, pager.setTotal, pager.goFirst]);

  const pageItems = filtered.slice(
    (pager.page - 1) * pager.pageSize,
    pager.page * pager.pageSize,
  );

  return (
    <div className="page-list">
      <div className="page-toolbar">
        <span className="hint" style={{ margin: 0 }} title={`默认每 ${Math.round(refreshMs / 60000)} 分钟自动刷新；未命中时会强制补拉`}>
          {msg || (loading ? '加载中…' : `缓存 ${items.length} 条 · ${Math.round(refreshMs / 60000)} 分钟自动刷新`)}
        </span>
        {err ? <span className="err">{err}</span> : null}
        <button className="ghost" onClick={() => load(false)} disabled={loading} style={{ marginLeft: 'auto' }}>
          重新加载
        </button>
        <button onClick={() => load(true)} disabled={loading}>
          {loading ? '刷新中…' : '强制刷新'}
        </button>
      </div>

      <div className="card list-loading-wrap list-body">
        <ListLoading show={loading} text="加载中…" />
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            placeholder="产品代码"
            value={apiCode}
            onChange={(e) => setApiCode(e.target.value)}
            style={{ width: 100 }}
          />
          <input
            placeholder="币种"
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
            style={{ width: 100 }}
          />
          <input
            placeholder="计价/周期"
            value={equalCoin}
            onChange={(e) => setEqualCoin(e.target.value)}
            style={{ width: 120 }}
          />
          <input
            placeholder="关键字（名称/交易对…）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ minWidth: 180, flex: 1 }}
          />
          <button
            className="ghost"
            onClick={() => {
              setApiCode('');
              setCoin('');
              setEqualCoin('');
              setKeyword('');
            }}
          >
            重置筛选
          </button>
        </div>

        <table>
          <thead>
            <tr>
              <th>产品代码</th>
              <th>交易所</th>
              <th>币种</th>
              <th>计价/周期</th>
              <th>交易对</th>
              <th>规范键</th>
              <th>最小数量(MinAmt/QtyStep)</th>
              <th>最小张数(MinSize)</th>
              <th>价格精度(展示)</th>
              <th>价格步进(tick)</th>
              <th>每手(BoardLotSize)</th>
              <th>结算币</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((s, i) => (
              <tr key={`${s.apiCode}-${s.coinName}-${s.equalCoinName}-${i}`}>
                <td>{s.apiCode}</td>
                <td>{s.apiName}</td>
                <td>{s.coinName}</td>
                <td>{s.equalCoinName}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.symbol || '—'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.symbolKey || '—'}</td>
                <td>{s.minAmt}</td>
                <td>{s.minSize}</td>
                <td>{s.pricePrecision}</td>
                <td>{s.priceStep}</td>
                <td>{s.boardLotSize ?? 0}</td>
                <td>{s.settleCoin || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 ? <p className="hint list-empty">无匹配项（可点强制刷新或检查中间件）</p> : null}
        <Pagination
          total={filtered.length}
          page={pager.page}
          pageSize={pager.pageSize}
          pageSizes={[20, 50, 100, 200]}
          onChange={pager.onPageChange}
        />
      </div>
    </div>
  );
}
