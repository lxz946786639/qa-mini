"use strict";
// 第三方通用协议（移植 asr_live/generic_qa.py）：
// 请求体 = 用户 JSON 对象模板；{question}/{context} 占位符在字符串值内递归替换，
// 之后顶层注入 question（恒注入）/ context（非空才注入）；最小模板 {} 即可工作。
// 回答自动识别：SSE（content-type 或首行特征）/ 单个 JSON 文档 / 纯文本。

const { QaError, postJSONStream } = require("../sse");

function subPlaceholders(value, question, context) {
  if (typeof value === "string") {
    return value.split("{question}").join(question).split("{context}").join(context);
  }
  if (Array.isArray(value)) return value.map((v) => subPlaceholders(v, question, context));
  if (typeof value === "object" && value !== null) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = subPlaceholders(v, question, context);
    return out;
  }
  return value;
}

function buildGenericBody(bodyJson, question, context = "") {
  // 模板必须是合法 JSON 对象，否则抛 QaError（发送前拦截）
  const raw = (bodyJson || "").trim() || "{}";
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new QaError(0, "请求体不是合法 JSON: " + e.message);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new QaError(0, "请求体必须是 JSON 对象（顶层为 {}）");
  }
  const ctx = (context || "").trim();
  data = subPlaceholders(data, question, ctx);
  data.question = question;
  if (ctx) data.context = ctx;
  return data;
}

// 答案字段优先级：choices[0].delta.content → choices[0].text →
// data.content/answer/text → 顶层 content/answer/text/output；JSON 字符串载荷直接作为文本。
function extractAnswer(obj) {
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object" || obj === null) return "";
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length && typeof choices[0] === "object" && choices[0] !== null) {
    const c0 = choices[0];
    const delta = c0.delta;
    if (typeof delta === "object" && delta !== null && typeof delta.content === "string") return delta.content;
    if (typeof c0.text === "string") return c0.text;
  }
  const data = obj.data;
  if (typeof data === "object" && data !== null) {
    for (const key of ["content", "answer", "text"]) {
      if (typeof data[key] === "string") return data[key];
    }
  }
  for (const key of ["content", "answer", "text", "output"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  return "";
}

function ssePayloadText(payload) {
  try {
    return extractAnswer(JSON.parse(payload));
  } catch {
    return payload; // 非 JSON 载荷：纯文本原样流出
  }
}

/**
 * @param cfg  { url(完整地址), api_key(可空), body(模板) }
 * @param opts { context, signal }
 */
async function* streamGeneric(cfg, question, { context = "", signal } = {}) {
  const url = (cfg.url || "").trim();
  if (!url) throw new QaError(0, "未配置接口地址");
  let payload;
  try {
    payload = buildGenericBody(cfg.body, question, context);
  } catch (e) {
    throw e instanceof QaError ? e : new QaError(0, String(e.message || e));
  }
  const headers = { "Content-Type": "application/json" };
  const key = (cfg.api_key || "").trim();
  if (key) headers.Authorization = "Bearer " + key;

  const r = await postJSONStream(url, payload, headers, signal);
  try {
    if (!(r.status >= 200 && r.status < 300)) {
      const body = await r.errorBody();
      throw new QaError(r.status, body || `HTTP ${r.status}`);
    }
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let sawSse = ct.includes("text/event-stream");
    const plainLines = [];
    for await (const raw of r.lines) {
      const s = raw.trim();
      if (sawSse) {
        if (!s || s.startsWith(":")) continue;
        if (s.startsWith("data:")) {
          const p = s.slice(5).trim();
          if (p === "[DONE]") return;
          const chunk = ssePayloadText(p);
          if (chunk) yield chunk;
        }
        // 其他 SSE 字段（event:/id:/retry:）忽略
        continue;
      }
      if (!s) continue;
      if (s.startsWith("data:") || s.startsWith("event:") || s.startsWith("id:") || s.startsWith("retry:")) {
        sawSse = true;
        if (s.startsWith("data:")) {
          const p = s.slice(5).trim();
          if (p === "[DONE]") return;
          const chunk = ssePayloadText(p);
          if (chunk) yield chunk;
        }
      } else {
        plainLines.push(raw.replace(/\r$/, ""));
      }
    }
    if (!sawSse) {
      // 非 SSE 响应：整体读完后按 JSON 文档 / 纯文本处理
      const body = plainLines.join("\n").trim();
      if (!body) return;
      try {
        const chunk = extractAnswer(JSON.parse(body));
        if (chunk) yield chunk;
      } catch {
        yield body;
      }
    }
  } finally {
    r.done();
  }
}

module.exports = { buildGenericBody, extractAnswer, streamGeneric };
