import { useCallback, useRef, useState } from 'react';

/**
 * 下拉刷新：进行中忽略第二次，避免叠请求卡死/闪退；无论成功失败都会收起转圈。
 */
export function useSafeRefresh(load: () => void | Promise<void>) {
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  const onRefresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    void Promise.resolve()
      .then(() => load())
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
        setRefreshing(false);
      });
  }, [load]);

  return { refreshing, onRefresh };
}
