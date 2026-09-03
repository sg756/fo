import { useCallback, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

/**
 * 页面在前台且 App 处于 active 时按间隔刷新；切后台停表，回到前台立刻拉一次。
 * 避免 iOS 后台后 setInterval 失效、以及后台失败请求把列表清空后不再自动恢复。
 */
export function useFocusPoll(load: () => void | Promise<void>, intervalMs: number) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const inflight = useRef(false);
  const gen = useRef(0);

  const run = useCallback(async () => {
    if (inflight.current) return;
    const g = gen.current;
    inflight.current = true;
    try {
      await loadRef.current();
    } finally {
      if (g === gen.current) inflight.current = false;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setInterval> | null = null;

      const stop = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      };

      const start = () => {
        if (timer) return;
        timer = setInterval(() => {
          if (AppState.currentState === 'active') void run();
        }, intervalMs);
      };

      const onChange = (next: AppStateStatus) => {
        gen.current += 1;
        inflight.current = false;
        if (next === 'active') {
          void run();
          start();
        } else {
          stop();
        }
      };

      void run();
      if (AppState.currentState === 'active') start();
      const sub = AppState.addEventListener('change', onChange);
      return () => {
        gen.current += 1;
        inflight.current = false;
        stop();
        sub.remove();
      };
    }, [intervalMs, run]),
  );
}
