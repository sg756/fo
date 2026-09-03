import { existsSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
import type { MapiOffloadJob, MapiOffloadReply } from './mapi-offload-lib';

export type MapiOffloadRequest = Omit<MapiOffloadJob, 'id'>;

/** heavy=盘口/交易对/账户/代理大包；signal=LastOrderRecords，互不排队 */
export type MapiOffloadLane = 'heavy' | 'signal';

type Pending = {
  resolve: (v: MapiOffloadReply) => void;
  reject: (e: Error) => void;
};

type LaneState = {
  worker: Worker | null;
  pending: Map<number, Pending>;
};

const lanes: Record<MapiOffloadLane, LaneState> = {
  heavy: { worker: null, pending: new Map() },
  signal: { worker: null, pending: new Map() },
};

let seq = 1;

export function isMapiOffloadEnabled(): boolean {
  const v = String(process.env.MAPI_OFFLOAD_WORKER || 'true').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

export function offloadLaneForPath(path: string): MapiOffloadLane {
  const ep = String(path || '')
    .replace(/^\//, '')
    .split('?')[0];
  return ep === 'mapi/LastOrderRecords' ? 'signal' : 'heavy';
}

export function shouldOffloadMapiPath(
  path: string,
  opts?: { offload?: boolean },
): boolean {
  if (opts?.offload === false) return false;
  if (!isMapiOffloadEnabled()) return false;
  if (opts?.offload === true) return true;
  const ep = String(path || '')
    .replace(/^\//, '')
    .split('?')[0];
  return (
    ep === 'mapi/GetDepth' ||
    ep === 'mapi/CryptoSymbolList' ||
    ep === 'mapi/MultiAccountList' ||
    ep === 'mapi/PublicHttpProxyList' ||
    ep === 'mapi/LastOrderRecords'
  );
}

function workerFile(): string {
  const js = join(__dirname, 'mapi-offload.worker.js');
  if (existsSync(js)) return js;
  throw new Error(`找不到工作线程脚本: ${js}`);
}

function rejectLane(lane: MapiOffloadLane, err: Error) {
  const state = lanes[lane];
  for (const [, p] of state.pending) p.reject(err);
  state.pending.clear();
}

function attach(lane: MapiOffloadLane, w: Worker) {
  const state = lanes[lane];
  w.on('message', (msg: MapiOffloadReply) => {
    const p = state.pending.get(msg.id);
    if (!p) return;
    state.pending.delete(msg.id);
    p.resolve(msg);
  });
  w.on('error', (err) => {
    if (state.worker === w) state.worker = null;
    rejectLane(lane, err instanceof Error ? err : new Error(String(err)));
  });
  w.on('exit', (code) => {
    if (state.worker === w) state.worker = null;
    if (state.pending.size) {
      rejectLane(lane, new Error(`mapi ${lane} 工作线程退出 code=${code}`));
    }
  });
}

function ensureWorker(lane: MapiOffloadLane): Worker {
  const state = lanes[lane];
  if (state.worker) return state.worker;
  const w = new Worker(workerFile());
  state.worker = w;
  attach(lane, w);
  return w;
}

function laneOfJob(job: MapiOffloadRequest): MapiOffloadLane {
  return String(job.url || '').includes('LastOrderRecords') ? 'signal' : 'heavy';
}

export async function runMapiOffload(
  job: MapiOffloadRequest,
): Promise<MapiOffloadReply> {
  const lane = laneOfJob(job);
  const w = ensureWorker(lane);
  const state = lanes[lane];
  const id = seq++;
  const payload: MapiOffloadJob = { ...job, id };
  const waitMs = Math.max(1000, Number(job.timeoutMs) || 15_000) + 8_000;
  return new Promise<MapiOffloadReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      resolve({
        id,
        ok: false,
        statusCode: 0,
        bytes: 0,
        parsed: null,
        error: `工作线程排队超时 (${waitMs}ms)`,
      });
    }, waitMs);
    state.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.postMessage(payload);
  });
}

export async function stopMapiOffload(): Promise<void> {
  const err = new Error('mapi 工作线程已停止');
  const workers = (['heavy', 'signal'] as const).map((lane) => {
    const w = lanes[lane].worker;
    lanes[lane].worker = null;
    rejectLane(lane, err);
    return w;
  });
  await Promise.all(workers.map((w) => (w ? w.terminate().catch(() => undefined) : Promise.resolve())));
}
