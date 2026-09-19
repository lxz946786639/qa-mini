"use strict";
// 共享 HTTP/SSE 基础设施：
//  - QaError / CancelledError（错误语义对齐 asr_live/qa.py）
//  - postJSONStream：POST JSON 并拿到「行迭代器」，含 10s 连接 / 60s 块间空闲超时
//    （对齐 httpx.Timeout(60.0, connect=10.0)；长答案不受总时长限制）
//  - postJSON：非流式 POST（RAGFlow 建会话用）

const CONNECT_TIMEOUT_MS = Number(process.env.QA_MINI_CONNECT_TIMEOUT_MS) || 10_000;
const IDLE_TIMEOUT_MS = Number(process.env.QA_MINI_IDLE_TIMEOUT_MS) || 60_000;

class QaError extends Error {
  constructor(status, detail) {
    super(status ? `HTTP ${status}: ${detail}` : detail);
    this.name = "QaError";
    this.status = status; // 未收到响应 = 0
    this.detail = detail;
  }
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

// 把底层错误翻译成 QaError / CancelledError
function translate(e, outerSignal, innerCtrl) {
  if (outerSignal && outerSignal.aborted) throw new CancelledError();
  const reason = innerCtrl ? innerCtrl.signal.reason : null;
  if (reason instanceof Error) {
    if (reason.message.startsWith("connect-timeout")) {
      throw new QaError(0, "请求失败: 连接超时（10s）");
    }
    if (reason.message.startsWith("idle-timeout")) {
      throw new QaError(0, "请求失败: 块间读取超时（60s）");
    }
  }
  if (e instanceof CancelledError) throw e;
  throw new QaError(0, "请求失败: " + errMsg(e));
}

/**
 * POST JSON，返回 { status, headers, lines, errorBody, done }。
 * - lines: async generator，逐行产出响应体（已去 \r）
 * - errorBody(limit): 非 2xx 时读取整个响应体并截断
 * - done(): 清理计时器（必须在 finally 调用）
 * 外部 signal abort（取消）→ lines 抛 CancelledError；网络/超时 → 抛 QaError(0, …)。
 */
async function postJSONStream(url, payload, headers, signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort(new CancelledError());
    else signal.addEventListener("abort", () => ctrl.abort(new CancelledError()), { once: true });
  }
  // 连接阶段超时（对齐 httpx connect=10s）：收到响应头即解除
  const connectTimer = setTimeout(
    () => ctrl.abort(new Error("connect-timeout")),
    CONNECT_TIMEOUT_MS
  );
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => ctrl.abort(new Error("idle-timeout")),
      IDLE_TIMEOUT_MS
    );
  };
  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(payload === undefined ? {} : payload),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(connectTimer);
    cleanup();
    throw translate(e, signal, ctrl);
  }

  // 收到响应头：连接阶段结束，进入块间空闲计时
  clearTimeout(connectTimer);
  armIdle();

  const lines = (async function* () {
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    try {
      for await (const chunk of resp.body) {
        armIdle();
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          yield line;
        }
      }
      buf += decoder.decode();
      if (buf.length) yield buf;
    } catch (e) {
      throw translate(e, signal, ctrl);
    } finally {
      cleanup();
    }
  })();

  return {
    status: resp.status,
    headers: resp.headers,
    lines,
    async errorBody(limit = 200) {
      const decoder = new TextDecoder("utf-8");
      let s = "";
      try {
        for await (const chunk of resp.body) {
          s += decoder.decode(chunk, { stream: true });
          if (s.length > limit + 1000) break;
        }
        s += decoder.decode();
      } catch {
        // 读取失败时返回已读部分
      }
      return s.slice(0, limit);
    },
    done() {
      cleanup();
    }
  };
}

/** 非流式 POST：返回 { status, text, text200 }（text200 = 截断 200 字符）。 */
async function postJSON(url, payload, headers, signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort(new CancelledError());
    else signal.addEventListener("abort", () => ctrl.abort(new CancelledError()), { once: true });
  }
  const connectTimer = setTimeout(
    () => ctrl.abort(new Error("connect-timeout")),
    CONNECT_TIMEOUT_MS
  );
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(payload === undefined ? {} : payload),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(connectTimer);
    throw translate(e, signal, ctrl);
  }
  clearTimeout(connectTimer);
  let text = "";
  try {
    text = (await resp.text()) || "";
  } catch (e) {
    throw translate(e, signal, ctrl);
  }
  return { status: resp.status, text, text200: text.slice(0, 200) };
}

module.exports = { QaError, CancelledError, postJSONStream, postJSON, CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS };
