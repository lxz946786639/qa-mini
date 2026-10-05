"use strict";
// ASR（语音识别）转发客户端（零依赖，语义对齐 EchoScribe echoscribe/asr_client.py）：
//  - 主路径:  POST {base}/audio/transcriptions（multipart WAV：file/model/language）
//  - 回退:    POST {base}/chat/completions（base64 audio_url；主路径 404/405/400 触发）
//  - 探测:    GET {root}/health + GET {base}/models（「测试连接」用）
// ASR 服务 = OpenAI 兼容端点（如 qwen3-asr-1.7b），管理端「设置 → 语音输入」配置。

const crypto = require("crypto");

class AsrError extends Error {
  constructor(msg) { super(msg); this.name = "AsrError"; }
}

// EchoScribe 语义：url 不以 /v1 结尾则补（api_base）；root_base = 截掉 /v1
function apiBase(url) {
  const u = String(url || "").trim().replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : u + "/v1";
}
function rootBase(url) {
  const u = String(url || "").trim().replace(/\/+$/, "");
  return u.endsWith("/v1") ? u.slice(0, -3) : u;
}

// fetch + 连接超时（connectMs）/ 读超时（readMs）两阶段 AbortController
// externalSignal（可选）：客户端断开信号（server.js 传 req.signal），一旦 abort 立即
// 中止对 ASR 的上游请求（partial 识别被停止/跳过时不再白烧推理）
async function fetchWithTimeouts(url, opts, connectMs, readMs, externalSignal) {
  const ac = new AbortController();
  let phase = "connect";
  const t1 = setTimeout(() => {
    if (phase === "connect") ac.abort(new Error("连接超时"));
  }, connectMs);
  const sig = externalSignal && externalSignal.aborted ? externalSignal
    : (externalSignal ? AbortSignal.any([ac.signal, externalSignal]) : ac.signal);
  try {
    const res = await fetch(url, { ...opts, signal: sig });
    phase = "read";
    clearTimeout(t1);
    const t2 = setTimeout(() => ac.abort(new Error("读取超时")), readMs);
    try {
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
    } finally {
      clearTimeout(t2);
    }
  } catch (e) {
    clearTimeout(t1);
    if (externalSignal && externalSignal.aborted) throw new AsrError("请求已中止");
    const cause = e && e.cause ? e.cause : e;
    throw new AsrError("无法连接 ASR 服务: " + (cause && cause.code ? cause.code : (e && e.message || e)));
  }
}

function authHeaders(cfg) {
  const h = {};
  if (String(cfg.api_key || "").trim()) h["Authorization"] = "Bearer " + String(cfg.api_key).trim();
  return h;
}

async function transcribeViaChat(wav, cfg, base, headers, timeoutS, signal) {
  if (signal && signal.aborted) throw new AsrError("请求已中止");
  const body = JSON.stringify({
    model: cfg.model,
    messages: [{
      role: "user",
      content: [{ type: "audio_url", audio_url: { url: "data:audio/wav;base64," + wav.toString("base64") } }]
    }],
    temperature: 0.01,
    max_tokens: 512
  });
  const r = await fetchWithTimeouts(base + "/chat/completions",
    { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body },
    5000, timeoutS * 1000, signal);
  if (r.status >= 400) {
    throw new AsrError("ASR 服务返回 HTTP " + r.status + ": " + r.buf.toString("utf8").slice(0, 200));
  }
  let data;
  try { data = JSON.parse(r.buf.toString("utf8")); }
  catch { throw new AsrError("ASR 响应不是合法 JSON"); }
  let content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  if (Array.isArray(content)) {
    content = content.map((p) => (p && typeof p === "object" ? (p.text || "") : String(p == null ? "" : p))).join("");
  }
  return String(content == null ? "" : content).trim();
}

// 主路径 + 5xx/网络错误一次重试（对齐 EchoScribe 的非致命重试）+ 404/405/400 回退 chat
// signal（可选）：客户端断开信号；已中止则不发起/不重试上游请求
async function transcribe(wav, cfg, signal) {
  if (signal && signal.aborted) throw new AsrError("请求已中止");
  const base = apiBase(cfg.url);
  const headers = authHeaders(cfg);
  const timeoutS = Math.max(1, Number(cfg.timeout) || 60);
  const boundary = "----qamini" + crypto.randomBytes(8).toString("hex");
  const field = (name, value) => (value == null || value === "") ? null
    : Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n', "utf8");
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="segment.wav"\r\nContent-Type: audio/wav\r\n\r\n', "utf8"),
    wav,
    field("model", cfg.model),
    field("language", cfg.language),
    Buffer.from('\r\n--' + boundary + '--\r\n', "utf8")
  ].filter(Boolean));
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal && signal.aborted) throw new AsrError("请求已中止"); // 已中止不重试
    if (attempt) await new Promise((r) => setTimeout(r, 800));
    if (signal && signal.aborted) throw new AsrError("请求已中止");
    let r;
    try {
      r = await fetchWithTimeouts(base + "/audio/transcriptions",
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "multipart/form-data; boundary=" + boundary },
          body
        },
        5000, timeoutS * 1000, signal);
    } catch (e) {
      if (signal && signal.aborted) throw new AsrError("请求已中止");
      lastErr = e; // 网络错误：重试
      continue;
    }
    if (r.status === 404 || r.status === 405 || r.status === 400) {
      return await transcribeViaChat(wav, cfg, base, headers, timeoutS, signal); // 端点不可用 → chat 路径（不重试）
    }
    if (r.status >= 500) {
      lastErr = new AsrError("ASR 服务返回 HTTP " + r.status + ": " + r.buf.toString("utf8").slice(0, 200));
      continue;
    }
    if (r.status >= 400) {
      throw new AsrError("ASR 服务返回 HTTP " + r.status + ": " + r.buf.toString("utf8").slice(0, 200));
    }
    let payload;
    try { payload = JSON.parse(r.buf.toString("utf8")); }
    catch { throw new AsrError("ASR 响应不是合法 JSON"); }
    const t = payload && typeof payload === "object" ? payload.text : payload;
    return String(t == null ? "" : t).trim();
  }
  throw lastErr instanceof AsrError ? lastErr : new AsrError("ASR 请求失败: " + (lastErr && lastErr.message || lastErr));
}

// 「测试连接」探测：/models 为门槛（网络失败抛错），/health 附加报告
async function asrProbe(cfg) {
  const base = apiBase(cfg.url);
  const root = rootBase(cfg.url);
  const headers = authHeaders(cfg);
  let health = false;
  try {
    const r = await fetchWithTimeouts(root + "/health", { method: "GET", headers }, 3000, 3000);
    health = r.status === 200;
  } catch { /* health 失败不致命 */ }
  let models = [];
  try {
    const r = await fetchWithTimeouts(base + "/models", { method: "GET", headers }, 3000, 3000);
    if (r.status >= 400) throw new Error("HTTP " + r.status);
    const j = JSON.parse(r.buf.toString("utf8"));
    if (j && Array.isArray(j.data)) models = j.data.map((m) => (m && m.id) || "").filter(Boolean);
  } catch (e) {
    throw new AsrError("无法访问 ASR 服务（模型列表请求失败: " + (e && e.message || e) + "）");
  }
  return { health, models };
}

module.exports = { AsrError, transcribe, asrProbe, apiBase, rootBase };
