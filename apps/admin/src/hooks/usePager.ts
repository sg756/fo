import { useCallback, useState } from 'react';

/** 服务端分页状态 */
export function usePager(defaultSize = 20) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultSize);
  const [total, setTotal] = useState(0);

  const skip = (page - 1) * pageSize;

  const onPageChange = useCallback((p: number, size: number) => {
    setPage(p);
    setPageSize(size);
  }, []);

  const goFirst = useCallback(() => setPage(1), []);

  return {
    page,
    pageSize,
    total,
    setTotal,
    skip,
    take: pageSize,
    setPage,
    setPageSize,
    onPageChange,
    goFirst,
  };
}

/** 统一解析列表接口：兼容 {items,total} / summary.count / 纯数组 */
export function normalizePaged(r: unknown): { items: any[]; total: number } {
  if (Array.isArray(r)) return { items: r, total: r.length };
  const o = r as Record<string, any> | null;
  if (!o) return { items: [], total: 0 };
  const items = Array.isArray(o.items) ? o.items : [];
  const total = Number(o.total ?? o.summary?.count ?? items.length) || 0;
  return { items, total };
}
