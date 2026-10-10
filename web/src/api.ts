// 同源 API 客户端：fetch + JSON。服务器响应恒为 JSON（sendJSON）。
// P8.86：fetch 增 30s 超时（AbortController）+ 网络层失败/超时统一抛 ApiNetworkError
// （原实现 fetch reject 无人捕获 → iOS 上陈旧 keep-alive 连接挂起时登录「点了没反应」，
// 无任何可见反馈；UI 层 catch ApiNetworkError 给出提示）。
export class ApiNetworkError extends Error {
  path: string;
  constructor(path: string) {
    super("network error: " + path);
    this.name = "ApiNetworkError";
    this.path = path;
  }
}
const TIMEOUT_MS = 30000;

export interface ApiResult<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<ApiResult<T>> {
  const hasBody = opts.body !== undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method || (hasBody ? "POST" : "GET"),
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
    });
  } catch {
    throw new ApiNetworkError(path);
  } finally {
    clearTimeout(timer);
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  return { ok: res.ok, status: res.status, data };
}
