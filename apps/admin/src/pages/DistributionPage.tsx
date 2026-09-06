import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminApi } from '../api';
import { UserDetailModal } from '../components/UserDetailModal';

type TreeNode = {
  id: string;
  userNo?: number | null;
  email: string;
  nickname?: string | null;
  role?: string;
  status: string;
  inviteCode: string;
  parentId?: string | null;
  followEnabled?: boolean;
  directCount: number;
  downlineCount: number;
  rebateAmount?: number;
  rebateCount?: number;
  rebateDirect?: number;
  rebateIndirect?: number;
  children: TreeNode[];
};

function nodeLabel(n: TreeNode) {
  return n.nickname || n.email.split('@')[0] || n.email;
}

function fmtAmt(n?: number | null) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return '0';
  return v.toFixed(4);
}

function matchKeyword(n: TreeNode, q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return false;
  return (
    n.email.toLowerCase().includes(s) ||
    (n.nickname || '').toLowerCase().includes(s) ||
    n.inviteCode.toLowerCase().includes(s) ||
    String(n.userNo ?? '') === s ||
    nodeLabel(n).toLowerCase().includes(s)
  );
}

type DistFilters = {
  status: string;
  follow: string; // '' | '1' | '0'
  downline: string; // '' | '1' | '0'
};

function matchFilters(n: TreeNode, f: DistFilters) {
  if (f.status && n.status !== f.status) return false;
  if (f.follow === '1' && !n.followEnabled) return false;
  if (f.follow === '0' && n.followEnabled) return false;
  if (f.downline === '1' && (n.downlineCount ?? 0) <= 0) return false;
  if (f.downline === '0' && (n.downlineCount ?? 0) > 0) return false;
  return true;
}

function hasActiveFilters(f: DistFilters) {
  return !!(f.status || f.follow || f.downline);
}

/** 保留命中节点及其祖先；子树只留筛后分支 */
function filterTree(nodes: TreeNode[], f: DistFilters): TreeNode[] {
  if (!hasActiveFilters(f)) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const kids = filterTree(n.children || [], f);
    if (matchFilters(n, f) || kids.length) {
      out.push({ ...n, children: kids });
    }
  }
  return out;
}

function countNodes(nodes: TreeNode[]): number {
  let c = 0;
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      c += 1;
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return c;
}

/** 收集匹配节点 id，以及为显示它们需要展开的祖先 id */
function locateInTree(roots: TreeNode[], q: string, f: DistFilters) {
  const matchedIds: string[] = [];
  const expandIds: Record<string, boolean> = {};
  const needFilter = hasActiveFilters(f);

  const walk = (nodes: TreeNode[], ancestors: string[]) => {
    for (const n of nodes) {
      const okKw = !q.trim() || matchKeyword(n, q);
      const okF = !needFilter || matchFilters(n, f);
      if (okKw && okF && q.trim()) {
        matchedIds.push(n.id);
        for (const a of ancestors) expandIds[a] = true;
      }
      if (n.children?.length) {
        walk(n.children, [...ancestors, n.id]);
      }
    }
  };
  walk(roots, []);
  return { matchedIds, expandIds };
}

export function DistributionPage() {
  const navigate = useNavigate();
  const [treeQ, setTreeQ] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterFollow, setFilterFollow] = useState('');
  const [filterDownline, setFilterDownline] = useState('');
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [locateIndex, setLocateIndex] = useState(0);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const scrollPending = useRef<string | null>(null);

  const filters = useMemo<DistFilters>(
    () => ({ status: filterStatus, follow: filterFollow, downline: filterDownline }),
    [filterStatus, filterFollow, filterDownline],
  );

  const loadTree = useCallback(() => {
    setErr('');
    AdminApi.distributionTree()
      .then((r) => {
        setRoots(r.roots || []);
        setSummary(r.summary || null);
        const open: Record<string, boolean> = {};
        for (const n of r.roots || []) {
          if ((n.children?.length ?? 0) > 0) open[n.id] = true;
        }
        setExpanded(open);
        setHighlightIds([]);
        setLocateIndex(0);
      })
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const scrollToId = useCallback((id: string) => {
    scrollPending.current = id;
    requestAnimationFrame(() => {
      const el = document.getElementById(`tree-node-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        scrollPending.current = null;
      }
    });
  }, []);

  useEffect(() => {
    if (!scrollPending.current) return;
    const id = scrollPending.current;
    const t = window.setTimeout(() => {
      const el = document.getElementById(`tree-node-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        scrollPending.current = null;
      }
    }, 50);
    return () => window.clearTimeout(t);
  }, [expanded, highlightIds]);

  function locate(next = false) {
    setErr('');
    setMsg('');
    const q = treeQ.trim();
    if (!q) {
      setHighlightIds([]);
      setLocateIndex(0);
      setMsg('请输入用户ID或昵称后再搜索');
      return;
    }
    const { matchedIds, expandIds } = locateInTree(roots, q, filters);
    if (!matchedIds.length) {
      setHighlightIds([]);
      setLocateIndex(0);
      setErr(`未找到「${q}」${hasActiveFilters(filters) ? '（当前筛选下）' : ''}`);
      return;
    }

    let idx = 0;
    if (next && highlightIds.length) {
      idx = (locateIndex + 1) % matchedIds.length;
    }
    setHighlightIds(matchedIds);
    setLocateIndex(idx);
    setExpanded((prev) => ({ ...prev, ...expandIds }));
    scrollToId(matchedIds[idx]);
    setMsg(
      matchedIds.length === 1
        ? `已定位到 ${matchedIds.length} 个匹配`
        : `已定位 ${idx + 1}/${matchedIds.length}，可点「下一个」切换`,
    );
  }

  function resetFilters() {
    setFilterStatus('');
    setFilterFollow('');
    setFilterDownline('');
    setTreeQ('');
    setHighlightIds([]);
    setLocateIndex(0);
    setErr('');
    setMsg('');
  }

  async function rebind(u: TreeNode) {
    if ((u.directCount ?? 0) > 0 || (u.downlineCount ?? 0) > 0) {
      setErr('该用户已有下级，不能换绑上级');
      return;
    }
    const code = prompt(`换绑上级 — ${u.nickname || u.email}\n输入目标上级（普通用户）的邀请码`);
    if (!code?.trim()) return;
    setBusy(u.id);
    setMsg('');
    setErr('');
    try {
      await AdminApi.rebindUser(u.id, code.trim());
      setMsg('换绑成功');
      loadTree();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  function openRebate(n: TreeNode) {
    navigate(`/distribution/rebate/${n.id}`);
  }

  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));
  const expandAll = () => {
    const open: Record<string, boolean> = {};
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children?.length) {
          open[n.id] = true;
          walk(n.children);
        }
      }
    };
    walk(roots);
    setExpanded(open);
  };
  const collapseAll = () => {
    setExpanded({});
    setHighlightIds([]);
  };

  const treeStats = useMemo(() => summary, [summary]);
  const displayRoots = useMemo(() => filterTree(roots, filters), [roots, filters]);
  const filteredCount = useMemo(
    () => (hasActiveFilters(filters) ? countNodes(displayRoots) : null),
    [displayRoots, filters],
  );
  const highlightSet = useMemo(() => new Set(highlightIds), [highlightIds]);
  const focusId = highlightIds[locateIndex] || null;

  useEffect(() => {
    setHighlightIds([]);
    setLocateIndex(0);
    const f: DistFilters = {
      status: filterStatus,
      follow: filterFollow,
      downline: filterDownline,
    };
    if (!hasActiveFilters(f)) return;
    const filtered = filterTree(roots, f);
    const open: Record<string, boolean> = {};
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children?.length) {
          open[n.id] = true;
          walk(n.children);
        }
      }
    };
    walk(filtered);
    setExpanded((prev) => ({ ...prev, ...open }));
  }, [filterStatus, filterFollow, filterDownline, roots]);

  return (
    <div className="page-list">
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}

      {treeStats ? (
        <div
          className="row"
          style={{ marginBottom: 8, flexWrap: 'wrap', gap: '8px 20px', alignItems: 'baseline' }}
        >
          <span style={{ color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
            用户数{' '}
            <strong style={{ color: 'var(--ok)', fontSize: 16, fontWeight: 800, fontFamily: 'monospace' }}>
              {treeStats.total}
            </strong>
          </span>
          <span style={{ color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
            树根{' '}
            <strong style={{ color: 'var(--ok)', fontSize: 16, fontWeight: 800, fontFamily: 'monospace' }}>
              {treeStats.roots}
            </strong>
          </span>
          <span style={{ color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
            无上级{' '}
            <strong style={{ color: 'var(--ok)', fontSize: 16, fontWeight: 800, fontFamily: 'monospace' }}>
              {treeStats.noParent ?? '—'}
            </strong>
          </span>
          {filteredCount != null ? (
            <span style={{ color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
              筛选后{' '}
              <strong style={{ color: 'var(--accent, #2563eb)', fontSize: 16, fontWeight: 800, fontFamily: 'monospace' }}>
                {filteredCount}
              </strong>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="PENDING">待审核</option>
          <option value="ACTIVE">已通过</option>
          <option value="REJECTED">已拒绝</option>
          <option value="DISABLED">已禁用</option>
        </select>
        <select value={filterFollow} onChange={(e) => setFilterFollow(e.target.value)}>
          <option value="">全部跟单</option>
          <option value="1">跟单中</option>
          <option value="0">未跟单</option>
        </select>
        <select value={filterDownline} onChange={(e) => setFilterDownline(e.target.value)}>
          <option value="">全部下级</option>
          <option value="1">有下级</option>
          <option value="0">无下级</option>
        </select>
        <input
          placeholder="用户ID或昵称 / 邀请码"
          value={treeQ}
          onChange={(e) => setTreeQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') locate(false);
          }}
          style={{ width: 220 }}
        />
        <button onClick={() => locate(false)}>搜索</button>
        {highlightIds.length > 1 ? (
          <button className="ghost" onClick={() => locate(true)}>
            下一个
          </button>
        ) : null}
        <button className="ghost" onClick={resetFilters}>
          重置
        </button>
        <button className="ghost" onClick={loadTree}>
          刷新
        </button>
        <button className="ghost" onClick={expandAll}>
          全部展开
        </button>
        <button className="ghost" onClick={collapseAll}>
          全部折叠
        </button>
      </div>

      <div className="card dist-tree">
        {displayRoots.length === 0 ? (
          <p className="hint list-empty">
            {roots.length === 0 ? '暂无分销数据' : '当前筛选无匹配用户'}
          </p>
        ) : (
          <ul className="tree-root">
            {displayRoots.map((n) => (
              <TreeNodeView
                key={n.id}
                node={n}
                expanded={expanded}
                busy={busy}
                highlightSet={highlightSet}
                focusId={focusId}
                onToggle={toggle}
                onRebind={rebind}
                onDetail={setDetailId}
                onRebate={openRebate}
              />
            ))}
          </ul>
        )}
      </div>

      <UserDetailModal userId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function TreeNodeView({
  node,
  expanded,
  busy,
  highlightSet,
  focusId,
  onToggle,
  onRebind,
  onDetail,
  onRebate,
}: {
  node: TreeNode;
  expanded: Record<string, boolean>;
  busy: string;
  highlightSet: Set<string>;
  focusId: string | null;
  onToggle: (id: string) => void;
  onRebind: (u: TreeNode) => void;
  onDetail: (id: string) => void;
  onRebate: (u: TreeNode) => void;
}) {
  const hasKids = (node.children?.length ?? 0) > 0;
  const open = !!expanded[node.id];
  const name = nodeLabel(node);
  const hit = highlightSet.has(node.id);
  const focused = focusId === node.id;
  const rebate = Number(node.rebateAmount ?? 0);

  return (
    <li className="tree-node">
      <div
        id={`tree-node-${node.id}`}
        className={`tree-row${hit ? ' tree-hit' : ''}${focused ? ' tree-focus' : ''}`}
      >
        <button
          type="button"
          className={`tree-caret ${hasKids ? '' : 'empty'}`}
          onClick={() => hasKids && onToggle(node.id)}
          aria-label={open ? '折叠' : '展开'}
        >
          {hasKids ? (open ? '▾' : '▸') : '·'}
        </button>
        <span className="tree-name" title={node.email}>
          {name}
          {node.userNo != null ? (
            <span className="tree-meta" style={{ marginLeft: 6 }}>
              #{node.userNo}
            </span>
          ) : null}
        </span>
        <span className="tree-code" title="邀请码">
          {node.inviteCode}
        </span>
        <span className={`badge ${node.status === 'ACTIVE' ? 'ok' : ''}`}>{node.status}</span>
        {node.followEnabled ? <span className="badge ok">跟单中</span> : null}
        <span className="tree-meta">
          直属 {node.directCount} · 下级 {node.downlineCount}
        </span>
        <button
          type="button"
          className="ghost tree-meta"
          style={{
            color: rebate > 0 ? 'var(--ok)' : undefined,
            fontFamily: 'monospace',
            padding: '2px 6px',
          }}
          title="查看下级创造的返利流水 / 日汇总"
          onClick={() => onRebate(node)}
        >
          返利 {fmtAmt(rebate)}
          {node.rebateCount ? ` (${node.rebateCount})` : ''}
        </button>
        <span className="tree-actions">
          <button className="ghost" onClick={() => onDetail(node.id)}>
            详情
          </button>
          <button
            className="ghost"
            disabled={busy === node.id || node.directCount > 0 || node.downlineCount > 0}
            title={
              node.directCount > 0 || node.downlineCount > 0 ? '已有下级，不能换绑' : undefined
            }
            onClick={() => onRebind(node)}
          >
            换绑
          </button>
        </span>
      </div>
      {hasKids && open ? (
        <ul className="tree-children">
          {node.children.map((ch) => (
            <TreeNodeView
              key={ch.id}
              node={ch}
              expanded={expanded}
              busy={busy}
              highlightSet={highlightSet}
              focusId={focusId}
              onToggle={onToggle}
              onRebind={onRebind}
              onDetail={onDetail}
              onRebate={onRebate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
