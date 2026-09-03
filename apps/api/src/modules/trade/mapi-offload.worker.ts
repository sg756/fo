import { parentPort } from 'worker_threads';
import {
  compactDepthToMids,
  parseJsonPreservingLargeIds,
  stripEnvelopeKeepMeta,
  type MapiOffloadJob,
  type MapiOffloadReply,
} from './mapi-offload-lib';

if (!parentPort) {
  throw new Error('mapi-offload.worker 必须由 worker_threads 启动');
}

parentPort.on('message', (job: MapiOffloadJob) => {
  void handle(job);
});

async function handle(job: MapiOffloadJob) {
  const id = job?.id;
  try {
    const timeoutMs = Math.max(1000, Number(job.timeoutMs) || 15_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let statusCode = 0;
    let bytes = 0;
    try {
      const res = await fetch(job.url, {
        method: job.method || 'GET',
        headers: job.headers || {},
        body: job.method === 'POST' && job.body != null ? job.body : undefined,
        signal: controller.signal,
      });
      statusCode = res.status;
      const text = await res.text();
      bytes = text ? Buffer.byteLength(text) : 0;
      let parsed = parseJsonPreservingLargeIds(text);
      if (parsed == null || parsed === '') {
        parsed = { message: `HTTP ${res.status} (empty body)`, url: job.url };
      }
      const httpOk = res.ok;
      const envelope =
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'success' in parsed;
      const bizOk = envelope ? parsed.success === true : httpOk;
      if (job.compact === 'depth-mids' && httpOk && bizOk) {
        const payload = envelope ? parsed.data : parsed;
        const mids = compactDepthToMids(payload);
        parsed = stripEnvelopeKeepMeta(parsed, mids);
      }
      parentPort!.postMessage({
        id,
        ok: true,
        statusCode,
        bytes,
        parsed,
      } satisfies MapiOffloadReply);
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    parentPort!.postMessage({
      id,
      ok: false,
      statusCode: 0,
      bytes: 0,
      parsed: null,
      error: aborted
        ? `请求超时 (${Math.max(1000, Number(job.timeoutMs) || 15_000)}ms)`
        : e?.message || String(e),
    } satisfies MapiOffloadReply);
  }
}
