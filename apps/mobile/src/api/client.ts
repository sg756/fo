import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from './config';

const TOKEN_KEY = 'flow_token';

let inMemoryToken: string | null = null;

export async function setToken(token: string | null) {
  inMemoryToken = token;
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

export async function loadToken(): Promise<string | null> {
  if (inMemoryToken) return inMemoryToken;
  const t = await AsyncStorage.getItem(TOKEN_KEY);
  inMemoryToken = t;
  return t;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Options = {
  method?: string;
  body?: any;
  auth?: boolean;
};

const API_TIMEOUT_MS = 60_000;

function friendlyNetError(e: any): string {
  const raw = String(e?.message || e || '').trim();
  if (/abort|timeout|timed out|Timeout/i.test(raw)) return '请求超时，请下拉重试';
  if (/java\.|SocketTimeout|UnknownHost|ConnectException|SSLHandshake|NetworkOnMainThread/i.test(raw)) {
    return '网络异常，请检查网络后下拉重试';
  }
  const short = raw.replace(/\s+/g, ' ').slice(0, 80);
  return short ? `网络错误：${short}` : '网络错误，无法连接服务器';
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''))) {
      throw new ApiError('请求超时，请下拉重试', 0);
    }
    throw new ApiError(friendlyNetError(e), 0);
  } finally {
    clearTimeout(timer);
  }
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (auth) {
    const token = await loadToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_BASE}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(friendlyNetError(e), 0);
  }

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const msg =
      (data && (data.message || data.error)) ||
      (typeof data === 'string' ? data : `请求失败 (${res.status})`);
    const textMsg = Array.isArray(msg) ? msg.join('、') : String(msg);
    throw new ApiError(
      /java\.|SocketTimeout|Exception:/i.test(textMsg) ? friendlyNetError(textMsg) : textMsg,
      res.status,
    );
  }

  return data as T;
}
