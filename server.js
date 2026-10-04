"use strict";
// QA Mini 服务器（零依赖 · 多会话版）：
//  - 静态 UI（public/）
//  - 会话：/api/sessions 增删改查 + 重置；每会话独立 token / 会话ID / 协议 / 历史
//  - asr-tool 推送：POST /api/push { token, session_id?, text }（token 定位会话，
//    带 session_id 时校验一致性）
//  - 网页提问：POST /api/chat { session_id, question }
//  - /api/events：SSE 广播（全部事件带 session_id；连接即推 sessions 列表）

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  loadConfig, saveConfig, validateConfig, deepMerge, PROTOCOLS,
  loadSessions, saveSessions, sessionView, resolveProtocolConfig
} = require("./lib/config");
const { SessionManager } = require("./lib/qa_runner");
const { QaError } = require("./lib/sse");
const { testProtocol } = require("./lib/protocol_test");
const { AsrError, transcribe: asrTranscribe, asrProbe } = require("./lib/asr");
const { AudioStreamManager, createFrameParser } = require("./lib/audio_stream");

const PUBLIC_DIR = path.join(__dirname, "public");

// ---- 配置与会话 ----
const { config: initialConfig, file: configFile } = loadConfig();
let config = initialConfig;
const { sessions, file: sessionsFile } = loadSessions(config);

// ---- SSE 广播 ----
const sseClients = new Set();
function broadcast(event, payload) {
  const line = "event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

const manager = new SessionManager({
  getConfig: () => config,
  getSessions: () => sessions,
  saveAll: () => saveSessions(sessionsFile, sessions),
  broadcast
});

// ---- 电脑输出音频流（asr-tool 持续推流 → 环形缓冲 → 按需识别提问）----
const audioStreams = new AudioStreamManager({
  getConfig: () => config,
  broadcast
});

// ---- 访问控制（管理密码 + 访问码）----
// 管理：admin_password 为空 = 管理未启用（保持旧行为）；设置后管理接口强制鉴权。
// 访问：allow_anonymous=false 时，查看/提问/推送需有效访问码签发的 token（或管理 token）。
// token 仅存内存（重启后需重新登录）；登录失败限流 10 次/10 分钟/IP。
const ADMIN_TOKEN_TTL = 12 * 3600e3;   // 管理 token 12h
const ACCESS_TOKEN_TTL = 24 * 3600e3;  // 访问 token 24h（不超过码自身有效期）
const DEFAULT_CODE_HOURS = 8;          // 访问码默认有效时长
const adminTokens = new Map();   // token -> { expires_at: ms }
const accessTokens = new Map();  // token -> { code, expires_at: ms }
const loginFails = new Map();    // ip -> { count, reset_at: ms }

function secCfg() { return (config && config.security) || {}; }
function adminEnabled() { return String(secCfg().admin_password || "") !== ""; }
function ipOf(req) { return req.socket ? (req.socket.remoteAddress || "?") : "?"; }
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function throttleExceeded(ip) {
  const n = loginFails.get(ip) || { count: 0, reset_at: 0 };
  if (Date.now() > n.reset_at) { n.count = 0; n.reset_at = Date.now() + 10 * 60e3; }
  if (n.count >= 10) return true;
  loginFails.set(ip, n);
  return false;
}
function recordFail(ip) {
  const n = loginFails.get(ip) || { count: 0, reset_at: Date.now() + 10 * 60e3 };
  n.count += 1;
  loginFails.set(ip, n);
}
function validAdminToken(t) {
  const e = adminTokens.get(t);
  if (!e) return false;
  if (Date.now() > e.expires_at) { adminTokens.delete(t); return false; }
  return true;
}
function isAdmin(req, urlObj) {
  if (!adminEnabled()) return true; // 未设密码 = 未启用管理鉴权（兼容旧行为）
  const t = req.headers["x-admin-token"] || (urlObj && urlObj.searchParams.get("admin")) || "";
  return typeof t === "string" && t !== "" && validAdminToken(t);
}
function accessCodeList() {
  const c = secCfg().access_codes;
  return Array.isArray(c) ? c : [];
}
function findValidCode(code) {
  const now = Date.now();
  for (const c of accessCodeList()) {
    if (typeof c.code === "string" && c.code === code && Date.parse(c.expires_at) > now) return c;
  }
  return null;
}
function validAccessToken(t) {
  const e = accessTokens.get(t);
  if (!e) return false;
  if (Date.now() > e.expires_at) { accessTokens.delete(t); return false; }
  if (!findValidCode(e.code)) { accessTokens.delete(t); return false; } // 码已失效/过期
  return true;
}
// 查看级鉴权：匿名开放 → 放行；否则 管理 token 或 有效访问 token 放行
function viewerOk(req, urlObj, extraAccess) {
  if (secCfg().allow_anonymous !== false) return true;
  if (adminEnabled() && isAdmin(req, urlObj)) return true;
  const t = extraAccess || (urlObj && urlObj.searchParams.get("access")) || req.headers["x-access-token"] || "";
  if (typeof t !== "string" || t === "") return false;
  // 管理 token 亦可走 ?access= 通道：/admin 页的 SSE（EventSource 无法自定义请求头）
  // 与查看级 XHR 都靠它携带管理凭证
  return validAccessToken(t) || (adminEnabled() && validAdminToken(t));
}
function issueAdminToken() {
  const t = crypto.randomBytes(16).toString("hex");
  adminTokens.set(t, { expires_at: Date.now() + ADMIN_TOKEN_TTL });
  return { token: t, expires_at: new Date(Date.now() + ADMIN_TOKEN_TTL).toISOString() };
}
function issueAccessToken(code) {
  const c = findValidCode(code);
  const exp = Math.min(Date.parse(c.expires_at), Date.now() + ACCESS_TOKEN_TTL);
  const t = crypto.randomBytes(16).toString("hex");
  accessTokens.set(t, { code, expires_at: exp });
  return { token: t, expires_at: new Date(exp).toISOString() };
}
// 广播用脱敏配置：api_key/管理密码不出现在 SSE（管理端用 GET /api/config 取全量）
function maskConfigForBroadcast(c) {
  const m = JSON.parse(JSON.stringify(c));
  for (const k of Object.keys(m.protocols || {})) {
    if (m.protocols[k] && m.protocols[k].api_key) m.protocols[k].api_key = "…已设置";
  }
  if (m.asr && m.asr.api_key) m.asr.api_key = "…已设置";
  if (m.security) {
    m.security.admin_password = "";
    m.security.access_codes = (m.security.access_codes || []).map((x) => ({ ...x }));
  }
  return m;
}
function saveSecurity() {
  saveConfig(configFile, config);
}

// ---- 工具 ----
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 原始字节请求体（WAV 音频上传用）；超过 limit 时读完丢弃，end 后 reject「请求体过大」
// （不立即 destroy：让客户端能收到 413 响应而非断连）
function readRawBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (!overflow) {
        if (size > limit) {
          overflow = true;
          chunks.length = 0; // 丢弃已缓存数据，继续消费流
        } else {
          chunks.push(c);
        }
      }
    });
    req.on("end", () => {
      if (overflow) {
        const e = new Error("请求体过大");
        e.tooLarge = true;
        reject(e);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

function parseJSONBody(req) {
  return readBody(req).then(
    (raw) => JSON.parse(raw || "{}"),
    (e) => {
      throw Object.assign(new Error("请求体不是合法 JSON: " + (e.message || "")), { __badBody: true });
    }
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

function serveStatic(res, rel) {
  const fp = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!fp.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(fp, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(buf);
  });
}

// 带超时上限的 Promise（?sync=true 推送用，上限 28s，留 2s 给 asr-tool 的 30s 超时）
function withTimeout(promise, ms, onExpire) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onExpire()), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        resolve({ __error: e });
      }
    );
  });
}

// ---- /api/events：SSE 广播 ----
function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");
  res.write("event: sessions\ndata: " + JSON.stringify({ sessions: manager.list() }) + "\n\n");
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      sseClients.delete(res);
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// ---- 会话 CRUD ----
async function handleCreateSession(req, res) {
  let body;
  try {
    body = await parseJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
  }
  const s = manager.create({
    name: typeof body.name === "string" ? body.name : "",
    protocol: typeof body.protocol === "string" ? body.protocol : "ragflow",
    continue_session: typeof body.continue_session === "boolean" ? body.continue_session : true
  });
  return sendJSON(res, 201, { ok: true, session: sessionView(s, 0, true) });
}

function handleGetSession(res, id, includeToken) {
  const full = manager.full(id, includeToken);
  if (!full) return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + id });
  return sendJSON(res, 200, full);
}

async function handleUpdateSession(req, res, id) {
  let body;
  try {
    body = await parseJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
  }
  if (body.protocol_config !== undefined &&
      (typeof body.protocol_config !== "object" || body.protocol_config === null || Array.isArray(body.protocol_config))) {
    return sendJSON(res, 400, { ok: false, detail: "protocol_config 必须是对象（按协议分组：{ 协议: { 字段: 值 } }）" });
  }
  const s = manager.update(id, body);
  if (!s) return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + id });
  return sendJSON(res, 200, { ok: true, session: sessionView(s, 0, true) });
}

// ---- /api/sessions/:id/protocol-test：会话级协议配置「测试连接」 ----
// body { protocol?, config? }：config = 表单当前草稿（含空串，空 = 回退全局）。
// 用 全局×草稿 合并值探测后端（与提问前置校验同值）；返回 { ok, detail }（HTTP 恒 200，
// ok=false 时 detail = 失败原因）；非法输入 400 / 会话不存在 404。
async function handleProtocolTest(req, res, id) {
  let body;
  try {
    body = await parseJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
  }
  if (body.config !== undefined &&
      (typeof body.config !== "object" || body.config === null || Array.isArray(body.config))) {
    return sendJSON(res, 400, { ok: false, detail: "config 必须是对象（{ 字段: 值 }）" });
  }
  const s = manager.sessionById(id);
  if (!s) return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + id });
  const proto = typeof body.protocol === "string" ? body.protocol.trim() : s.protocol;
  if (!PROTOCOLS.includes(proto)) return sendJSON(res, 400, { ok: false, detail: "未知协议: " + proto });
  const r = await testProtocol(proto, config, body.config || {});
  return sendJSON(res, 200, { ok: r.ok, detail: r.detail });
}

// ---- /api/asr：Web 端语音输入（浏览器录 WAV → 服务端转发 ASR 服务 → 返回文字） ----
// 请求体 = 原始 WAV 字节（16-bit PCM，建议 16kHz 单声道；上限 10MB）；
// 信任模型与 /api/chat 一致（viewer 级鉴权在路由处）；asr.url 未配置 → 400。
const ASR_MAX_BYTES = 10 * 1024 * 1024;
function asrSection() {
  const a = config && config.asr;
  return a && typeof a === "object" && !Array.isArray(a) ? a : {};
}
async function handleAsr(req, res) {
  const a = asrSection();
  const url = String(a.url || "").trim();
  if (!url) return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（设置 → 语音输入）" });
  let wav;
  try {
    wav = await readRawBody(req, ASR_MAX_BYTES);
  } catch (e) {
    return sendJSON(res, /过大/.test(e.message || "") ? 413 : 400, { ok: false, detail: e.message || String(e) });
  }
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 WAV 音频（16-bit PCM）" });
  }
  const t0 = Date.now();
  // 客户端断开检测（Node 惯用法：res "close" 且尚未写完 → 断开；req.signal 在
  // 请求体读完后即 aborted，不能用作断开检测）→ 中止对 ASR 的上游推理
  const ac = new AbortController();
  const onClientClose = () => { if (!res.writableFinished) ac.abort(); };
  res.on("close", onClientClose);
  try {
    const text = await asrTranscribe(wav, a, ac.signal);
    return sendJSON(res, 200, {
      ok: true,
      text,
      detail: text ? "" : "（无声/无法识别）",
      duration_s: Math.round((Date.now() - t0) / 100) / 10
    });
  } catch (e) {
    const msg = e instanceof AsrError ? e.message : ("识别请求异常: " + (e && e.message || e));
    return sendJSON(res, 502, { ok: false, detail: "语音识别失败: " + msg });
  } finally {
    res.off("close", onClientClose);
  }
}

// ---- /api/asr/test：ASR 服务「测试连接」（管理） ----
// body 可带 { asr: {...} } 表单草稿（用草稿值探测，未传用已存配置）；
// /models 为门槛（网络失败 502）；model 非空且不在服务列表 → ok=false。
async function handleAsrTest(req, res) {
  let body = {};
  try { body = await parseJSONBody(req); } catch { body = {}; }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
  }
  const draft = body.asr;
  const a = { ...asrSection() };
  if (draft && typeof draft === "object" && !Array.isArray(draft)) {
    for (const k of ["url", "api_key", "model", "language"]) {
      if (typeof draft[k] === "string") a[k] = draft[k].trim();
    }
    if (draft.timeout !== undefined && draft.timeout !== "") a.timeout = draft.timeout;
  }
  const url = String(a.url || "").trim();
  if (!url) return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（请填写接口基址）" });
  let probe;
  try {
    probe = await asrProbe(a);
  } catch (e) {
    return sendJSON(res, 502, { ok: false, detail: e instanceof AsrError ? e.message : String(e && e.message || e) });
  }
  const model = String(a.model || "").trim();
  if (model && !probe.models.includes(model)) {
    return sendJSON(res, 200, {
      ok: false,
      detail: "模型不在服务列表（服务提供: " + (probe.models.length ? probe.models.join(", ") : "无") + "）",
      models: probe.models
    });
  }
  return sendJSON(res, 200, {
    ok: true,
    detail: "已连接" + (probe.models.length ? "（模型: " + probe.models.join(", ") + "）" : ""),
    health: probe.health,
    models: probe.models
  });
}

// ---- /api/audio/stream：电脑输出音频推流（长连接 · chunked POST）----
// 头：X-Audio-Token（会话推送 token，与 /api/push 同源鉴权）+ X-Device-Name（URL 编码输出设备名）
// 体：[u32BE len][Deflate(PCM16LE 16kHz 单声道)] 帧流（asr-tool 每 200ms 一帧）
// 响应语义（关键）：前置校验错误（401/403/409）仅凭请求头即时响应；
// 成功路径必须在收完整体后回 200——nginx（proxy_request_buffering off）在上游
// 响应完成时会截断客户端未发完的 body（实测：提前 200 导致后续帧全部丢失，
// 详见 doc/03 §8），因此 200 携带流结束时的统计摘要 {bytes, frames}。
// 流进行中的实时反馈走 SSE audio_stream 事件（started/data/stopped，均带 session_id）。
// 客户端正常停止 = 结束 chunked 体（req "end"）；断网/崩溃 = socket "close" → 自动清理。
// 协议违例（单帧超限 / 解压失败）→ 400，仅断开该设备流，不影响同会话其他流。
async function handleAudioStream(req, res) {
  const token = String(req.headers["x-audio-token"] || "").trim();
  if (!token) return sendJSON(res, 401, { ok: false, detail: "缺少 X-Audio-Token 头" });
  const session = manager.byToken(token);
  if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
  if (!(session.audio_remote && session.audio_remote.enabled === true)) {
    return sendJSON(res, 403, { ok: false, detail: "该会话未启用输出音频接收（会话设置 → 电脑输出音频 → 启用）" });
  }
  let device = String(req.headers["x-device-name"] || "").trim();
  try {
    device = decodeURIComponent(device);
  } catch {
    device = String(req.headers["x-device-name"] || "").trim();
  }
  if (!device) device = "unknown-device";
  if (device.length > 128) device = device.slice(0, 128);

  const started = audioStreams.startStream(session.id, device);
  if (!started.ok) return sendJSON(res, 409, { ok: false, detail: started.error });

  const parser = createFrameParser((pcm) => {
    if (!audioStreams.feed(session.id, device, pcm)) {
      // 流已被空闲清理/会话删除：停止继续读体
      req.destroy();
    }
  });
  let finished = false;
  let protoErr = null;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (err) protoErr = err;
    const entry = (audioStreams.listStreams(session.id) || []).find((s) => s.device === device);
    const bytes = entry ? entry.bytes : 0;
    const frames = entry ? entry.frames : 0;
    audioStreams.stopStream(session.id, device); // SSE audio_stream stopped（幂等）
    if (!res.headersSent) {
      try {
        sendJSON(res, protoErr ? 400 : 200, protoErr
          ? { ok: false, detail: "帧格式错误: " + protoErr }
          : { ok: true, stream: "stopped", session_id: session.id, device, bytes, frames });
      } catch {
        // 连接已断开，响应不可达——不影响清理
      }
    }
    if (!req.readableEnded) {
      try { req.destroy(); } catch {}
    }
  };
  req.on("end", () => finish());
  req.on("error", (e) => {
    console.error("[audio-stream] 读取异常 " + session.id + "/" + device + ": " + (e && e.message || e));
    finish();
  });
  req.on("close", () => { if (!req.readableEnded) finish(); });
  try {
    for await (const chunk of req) {
      if (finished) break;
      try {
        parser.push(chunk);
      } catch (e) {
        if (e && e.protocol) {
          console.error("[audio-stream] 协议违例，断开 " + session.id + "/" + device + ": " + e.message);
          finish(e.message);
        } else {
          console.error("[audio-stream] 读取异常 " + session.id + "/" + device + ": " + (e && e.message || e));
          finish();
        }
        break;
      }
    }
  } catch {
    // 连接已断开（req.destroy 等）——按结束处理
  }
  finish();
}

// ---- /api/audio/capture：截取最近 N 秒推流 → ASR → 自动提问（source=remote_audio）----
// body { token, device?, seconds? }；device 缺省 = 会话 audio_remote.preferred_device（唯一设备流时自动用之）
async function handleAudioCapture(req, res) {
  let body;
  try {
    body = await parseJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
  const session = manager.byToken(token);
  if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });

  const scfg = audioStreams.cfg();
  let seconds = Number(body.seconds);
  if (!Number.isFinite(seconds)) seconds = scfg.default_capture_s;
  if (!Number.isFinite(seconds) || seconds < scfg.min_capture_s || seconds > scfg.max_capture_s) {
    return sendJSON(res, 400, {
      ok: false,
      detail: "seconds 须在 " + scfg.min_capture_s + "-" + scfg.max_capture_s + " 之间（当前 " + seconds + "）"
    });
  }
  const ar = session.audio_remote || {};
  let device = typeof body.device === "string" ? body.device.trim() : "";
  if (!device && typeof ar.preferred_device === "string") device = ar.preferred_device.trim();
  if (!device) {
    const list = audioStreams.listStreams(session.id);
    if (list.length === 1) device = list[0].device;
    else if (!list.length) return sendJSON(res, 409, { ok: false, detail: "该会话没有正在接收的音频设备（请先开始推流）" });
    else return sendJSON(res, 400, { ok: false, detail: "该会话有多个推流设备，请指定 device（" + list.map((x) => x.device).join(" / ") + "）" });
  }
  if (!audioStreams.isLive(session.id, device, 5000)) {
    return sendJSON(res, 409, { ok: false, detail: "设备未在接收音频（最近 5s 无数据帧）: " + device });
  }
  const a = asrSection();
  if (!String(a.url || "").trim()) {
    return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（设置 → 语音输入）" });
  }
  const wav = audioStreams.captureWav(session.id, device, seconds);
  if (!wav) return sendJSON(res, 409, { ok: false, detail: "环形缓冲中无音频数据" });

  const t0 = Date.now();
  let text;
  try {
    text = await asrTranscribe(wav, a, new AbortController().signal);
  } catch (e2) {
    const msg = e2 instanceof AsrError ? e2.message : ("识别请求异常: " + (e2 && e2.message || e2));
    return sendJSON(res, 502, { ok: false, detail: "语音识别失败: " + msg });
  }
  if (!text || !text.trim()) {
    return sendJSON(res, 422, { ok: false, detail: "（无声/无法识别）", text: "" });
  }
  text = text.trim();
  let started;
  try {
    started = manager.runnerFor(session).start({
      question: text,
      source: "remote_audio",
      newSession: !session.continue_session
    });
  } catch (e3) {
    return sendJSON(res, 400, { ok: false, detail: e3 instanceof QaError ? e3.detail : String(e3.message || e3) });
  }
  return sendJSON(res, 200, {
    ok: true,
    text,
    qa_id: started.id,
    session_id: session.id,
    device,
    duration_s: Math.round((Date.now() - t0) / 100) / 10
  });
}

// ---- /api/audio/listen（+/stop /+cancel）：推流音频「实时识别」（对齐 asr-tool 交互）----
// start：body { token, device? } → 建立监听任务，每 LISTEN_POLL_MS 把「开始→当前」全段
//        重提一次（对齐 asr-tool「段进行中」中间识别语义），SSE audio_listen
//        {session_id, device, state:"partial", text, elapsed_s} 广播定稿前预览；
// stop：  停止并做最后一次全段识别，返回定稿 {ok, text, elapsed_s}；
// cancel：丢弃（不做最终识别），广播 state:"cancelled"；
// 自动结束：设备流断开/无帧（state:"stream_stopped"）或满 LISTEN_MAX_S（state:"stopped"）。
const LISTEN_POLL_MS = 2500;
const LISTEN_MAX_S = 120;
const listenJobs = new Map(); // key: sid|device → { sid, device, startTs, text, timer, busy, errors, ac }
function listenKey(sid, device) { return sid + "|" + device; }
function stopListenJob(job, state, text) {
  if (!listenJobs.has(listenKey(job.sid, job.device)) || job.stopped) return;
  job.stopped = true;
  if (job.timer) { clearInterval(job.timer); job.timer = null; }
  if (job.ac) { try { job.ac.abort(); } catch {} job.ac = null; }
  listenJobs.delete(listenKey(job.sid, job.device));
  broadcast("audio_listen", {
    session_id: job.sid, device: job.device, state,
    text: text == null ? "" : text,
    elapsed_s: Math.round((Date.now() - job.startTs) / 100) / 10
  });
}
async function listenTick(job) {
  if (job.busy) return; // 上一段在途：跳过本 tick（不排队，对齐前端 partialBusy 语义）
  if (!audioStreams.isLive(job.sid, job.device, 8000)) {
    stopListenJob(job, "stream_stopped", job.text); // 推流断开 → 自动结束（携带已识别文本）
    return;
  }
  const secs = (Date.now() - job.startTs) / 1000;
  if (secs >= LISTEN_MAX_S) { // 硬上限：停任务，定稿走 stopped 事件（前端用最后 partial）
    stopListenJob(job, "stopped", job.text);
    return;
  }
  if (secs < 0.5) return;
  job.busy = true;
  job.ac = new AbortController();
  try {
    const wav = audioStreams.captureWav(job.sid, job.device, Math.min(LISTEN_MAX_S, secs));
    if (!wav) return;
    const text = await asrTranscribe(wav, asrSection(), job.ac.signal);
    if (text && text.trim()) {
      job.text = text.trim();
      job.errors = 0;
      broadcast("audio_listen", {
        session_id: job.sid, device: job.device, state: "partial",
        text: job.text, elapsed_s: Math.round((Date.now() - job.startTs) / 100) / 10
      });
    } else {
      job.errors++;
      if (job.errors >= 3) stopListenJob(job, "stream_stopped", job.text);
    }
  } catch (e) {
    if (job.ac && !job.ac.signal.aborted) {
      job.errors++;
      if (job.errors >= 3) stopListenJob(job, "stream_stopped", job.text);
    }
  } finally {
    job.busy = false;
    job.ac = null;
  }
}
async function resolveListenDevice(token, body) {
  // 鉴权 + 设备解析（与 capture 同语义：缺省 = preferred_device，唯一流自动用之）
  const session = manager.byToken(token);
  if (!session) return { err: [401, { ok: false, detail: "token 未知" }] };
  const ar = session.audio_remote || {};
  let device = typeof body.device === "string" ? body.device.trim() : "";
  if (!device && typeof ar.preferred_device === "string") device = ar.preferred_device.trim();
  if (!device) {
    const list = audioStreams.listStreams(session.id);
    if (list.length === 1) device = list[0].device;
    else if (!list.length) return { err: [409, { ok: false, detail: "该会话没有正在接收的音频设备（请先在 asr-tool 开始推流）" }] };
    else return { err: [400, { ok: false, detail: "该会话有多个推流设备，请指定 device（" + list.map((x) => x.device).join(" / ") + "）" }] };
  }
  if (!audioStreams.isLive(session.id, device, 5000)) {
    return { err: [409, { ok: false, detail: "设备未在接收音频（最近 5s 无数据帧）: " + device }] };
  }
  return { session, device };
}
async function handleAudioListen(req, res) {
  let body;
  try { body = await parseJSONBody(req); } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
  const r = await resolveListenDevice(token, body);
  if (r.err) return sendJSON(res, r.err[0], r.err[1]);
  const { session, device } = r;
  const a = asrSection();
  if (!String(a.url || "").trim()) return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（设置 → 语音输入）" });
  const key = listenKey(session.id, device);
  if (listenJobs.has(key)) return sendJSON(res, 409, { ok: false, detail: "该设备已有进行中的识别（先停止/取消）" });
  const job = { sid: session.id, device, startTs: Date.now(), text: "", timer: null, busy: false, errors: 0, ac: null };
  listenJobs.set(key, job);
  job.timer = setInterval(() => { listenTick(job); }, LISTEN_POLL_MS);
  listenTick(job); // 立即来一段（0.5s 音频即可出预览）
  return sendJSON(res, 200, { ok: true, session_id: session.id, device, state: "listening" });
}
async function handleAudioListenStop(req, res, cancel) {
  let body;
  try { body = await parseJSONBody(req); } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
  const session = manager.byToken(token);
  if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
  const ar = session.audio_remote || {};
  let device = typeof body.device === "string" ? body.device.trim() : "";
  if (!device && typeof ar.preferred_device === "string") device = ar.preferred_device.trim();
  if (!device) {
    const list = audioStreams.listStreams(session.id);
    if (list.length === 1) device = list[0].device;
    else return sendJSON(res, 400, { ok: false, detail: "请指定 device" });
  }
  const key = listenKey(session.id, device);
  const job = listenJobs.get(key);
  if (!job) return sendJSON(res, 409, { ok: false, detail: "该设备没有进行中的识别" });
  let text = job.text || "";
  if (!cancel) {
    // 定稿：全段最后一次识别（比最后一次 partial 更完整/准确）
    try {
      const secs = (Date.now() - job.startTs) / 1000;
      const wav = secs >= 0.5 ? audioStreams.captureWav(session.id, device, Math.min(LISTEN_MAX_S, secs)) : null;
      if (wav) {
        const t = await asrTranscribe(wav, asrSection(), new AbortController().signal);
        if (t && t.trim()) text = t.trim();
      }
    } catch { /* 最终识别失败 → 用最后一段 partial 文本 */ }
  }
  stopListenJob(job, cancel ? "cancelled" : "stopped", text);
  return sendJSON(res, 200, {
    ok: true, session_id: session.id, device,
    state: cancel ? "cancelled" : "stopped",
    text: cancel ? "" : text,
    elapsed_s: Math.round((Date.now() - job.startTs) / 100) / 10
  });
}

// ---- GET /api/audio/stream?token=：该会话正在接收的设备列表（抽屉实时刷新用）----
function handleGetAudioStreams(req, res, urlObj) {
  const token = (urlObj.searchParams.get("token") || "").trim();
  if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
  const session = manager.byToken(token);
  if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
  return sendJSON(res, 200, {
    ok: true,
    session_id: session.id,
    enabled: Boolean(session.audio_remote && session.audio_remote.enabled),
    streams: audioStreams.listStreams(session.id)
  });
}

function handleDeleteSession(res, id) {
  const ok = manager.remove(id);
  if (ok) {
    for (const [k, job] of [...listenJobs]) if (job.sid === id) stopListenJob(job, "cancelled"); // 会话删除 → 监听任务全清
    audioStreams.removeSession(id); // 会话删除 → 音频流全清
  }
  return sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "已删除" : "会话不存在: " + id });
}

function handleResetSession(res, id) {
  const ok = manager.reset(id);
  return sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "会话已重置" : "会话不存在: " + id });
}

// ---- /api/push：asr-tool 推送接口 ----
// 请求体 = { token, session_id?, text }（可携带 asr-tool body 的其他字段）。
// token 定位会话；带 session_id 时校验一致。默认 202 异步；?sync=true 阻塞（上限 28s）。
async function handlePush(req, res, urlObj) {
  let body;
  try {
    body = await parseJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
  }
  // 推送鉴权 = 会话推送 token 本身（48 位随机高熵凭证，持有即授权），
  // 无需再叠加访问码：asr-tool 请求体已配好 token，访问码失效/换码不影响推送。
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
  const session = manager.byToken(token);
  if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
  const sidIn = typeof body.session_id === "string" ? body.session_id.trim() : "";
  if (sidIn && sidIn !== session.id) {
    return sendJSON(res, 400, { ok: false, detail: "session_id 与 token 不匹配" });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return sendJSON(res, 400, { ok: false, detail: "text 为空" });
  const protocol = session.protocol;

  let started;
  try {
    started = manager.runnerFor(session).start({
      question: text,
      source: "push",
      context: typeof body.context === "string" ? body.context : "",
      newSession: !session.continue_session
    });
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e instanceof QaError ? e.detail : String(e.message || e) });
  }

  if (urlObj.searchParams.get("sync") !== "true") {
    return sendJSON(res, 202, { ok: true, accepted: true, qa_id: started.id, session_id: session.id, protocol });
  }

  const result = await withTimeout(started.promise, 28000, () => null);
  if (result === null) {
    return sendJSON(res, 200, {
      ok: false, detail: "等待超时（28s）", answer: "", qa_id: started.id, session_id: session.id
    });
  }
  if (result.__error) {
    return sendJSON(res, 500, { ok: false, detail: String(result.__error.message || result.__error) });
  }
  return sendJSON(res, 200, {
    ok: result.ok, detail: result.detail, answer: result.answer,
    qa_id: result.id, session_id: session.id
  });
}

// ---- /api/chat：网页提问（session_id 必填） ----
async function handleChat(req, res) {
  let body;
  try {
    body = await parseJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  const sid = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const session = sid ? manager.sessionById(sid) : null;
  if (!session) return sendJSON(res, 400, { ok: false, detail: "session_id 必填且为有效会话" });
  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim()) return sendJSON(res, 400, { ok: false, detail: "question 为空" });
  let started;
  try {
    started = manager.runnerFor(session).start({
      question,
      source: "web",
      context: typeof body.context === "string" ? body.context : "",
      newSession: body.newSession === true
    });
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e instanceof QaError ? e.detail : String(e.message || e) });
  }
  return sendJSON(res, 202, {
    ok: true, qa_id: started.id, session_id: session.id, protocol: session.protocol
  });
}

// ---- /api/cancel ----
async function handleCancel(req, res) {
  let body;
  try {
    body = await parseJSONBody(req);
  } catch {
    return sendJSON(res, 400, { ok: false, detail: "请求体不是合法 JSON" });
  }
  if (!body.id) return sendJSON(res, 400, { ok: false, detail: "id 必填" });
  const ok = manager.cancelAny(String(body.id));
  return sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "已请求取消" : "无此在途问答" });
}

// ---- /api/config PUT ----
async function handlePutConfig(req, res) {
  let patch;
  try {
    patch = await parseJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
  }
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
  }
  const next = deepMerge(config, patch);
  const problems = validateConfig(next);
  if (problems.length) {
    return sendJSON(res, 400, { ok: false, detail: "配置无效: " + problems.join("；") });
  }
  try {
    saveConfig(configFile, next);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, detail: "配置保存失败: " + e.message });
  }
  const prev = config;
  config = next;
  // 全局协议配置变化 → 回退全局的会话（对应字段留空）后端上下文失效：
  // ragflow 的 url/api_key/chat_id、dify 的 url/api_key 变化时清空会话后端会话 ID，
  // 下次提问按新配置重建（否则旧会话不属于新 chat → RAGFlow 报错/空回答）
  let invalidated = 0;
  for (const s of manager.getSessions()) {
    const p = s.protocol;
    if (p !== "ragflow" && p !== "dify") continue;
    const a = resolveProtocolConfig(s, prev, p);
    const b = resolveProtocolConfig(s, next, p);
    const sameStr = (x, y) => String(x || "") === String(y || "");
    if (p === "ragflow" &&
        (!sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key) || !sameStr(a.chat_id, b.chat_id))) {
      if (s.ragflow_session_id) { s.ragflow_session_id = ""; invalidated++; }
    }
    if (p === "dify" && (!sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key))) {
      if (s.dify_conversation_id) { s.dify_conversation_id = ""; invalidated++; }
    }
  }
  if (invalidated) manager.save();
  broadcast("config", { ok: true, config: maskConfigForBroadcast(next) });
  return sendJSON(res, 200, { ok: true, config: next, invalidated_sessions: invalidated });
}

// ---- /api/status（公开，无敏感信息）----
function handleStatus(res) {
  return sendJSON(res, 200, {
    ok: true,
    allow_anonymous: secCfg().allow_anonymous !== false,
    admin_set: adminEnabled()
  });
}

// ---- /api/admin/login：未设密码时输入即初始化；已设密码时校验 ----
async function handleAdminLogin(req, res) {
  const ip = ipOf(req);
  if (throttleExceeded(ip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
  let body;
  try { body = await parseJSONBody(req); }
  catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
  const pw = typeof body.password === "string" ? body.password : "";
  if (!adminEnabled()) {
    // 初始化：首次设置管理密码（4-64 位）
    if (pw.length < 4 || pw.length > 64) {
      return sendJSON(res, 400, { ok: false, detail: "管理密码需 4-64 位字符" });
    }
    config.security = Object.assign({}, secCfg(), { admin_password: pw });
    saveSecurity();
    const t = issueAdminToken();
    return sendJSON(res, 200, { ok: true, initialized: true, ...t, detail: "已初始化并登录" });
  }
  if (safeEqual(pw, String(secCfg().admin_password))) {
    const t = issueAdminToken();
    return sendJSON(res, 200, { ok: true, initialized: false, ...t });
  }
  recordFail(ip);
  return sendJSON(res, 401, { ok: false, detail: "管理密码错误" });
}

// ---- /api/access/login：访问码 → 访问 token ----
async function handleAccessLogin(req, res) {
  if (secCfg().allow_anonymous !== false) {
    return sendJSON(res, 200, { ok: true, anonymous: true });
  }
  const ip = ipOf(req);
  if (throttleExceeded(ip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
  let body;
  try { body = await parseJSONBody(req); }
  catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "访问码为 6 位数字" });
  const valid = findValidCode(code);
  if (!valid) {
    recordFail(ip);
    return sendJSON(res, 401, { ok: false, detail: "访问码无效或已过期" });
  }
  const t = issueAccessToken(code);
  return sendJSON(res, 200, { ok: true, anonymous: false, ...t, expires_at_code: valid.expires_at });
}

// ---- /api/admin/access-codes：生成访问码（管理）----
// body {code?, hours?, count?}：count 1-10 批量随机；code 指定时 count 忽略（单个）
function clampCodeHours(h) {
  let hours = typeof h === "number" && isFinite(h) ? h : DEFAULT_CODE_HOURS;
  if (!(hours > 0)) hours = DEFAULT_CODE_HOURS;
  return Math.min(hours, 720); // 上限 30 天
}
function makeCodeEntry(code, hours) {
  return {
    code,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + hours * 3600e3).toISOString()
  };
}
async function handleAddAccessCode(req, res) {
  let body;
  try { body = await parseJSONBody(req); }
  catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
  const hours = clampCodeHours(body.hours);
  const list = accessCodeList();
  const entries = [];
  if (typeof body.code === "string" && body.code.trim() !== "") {
    const code = body.code.trim();
    if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "自定义访问码必须为 6 位数字" });
    if (list.some((c) => c.code === code)) return sendJSON(res, 409, { ok: false, detail: "该访问码已存在（未过期）" });
    entries.push(makeCodeEntry(code, hours));
  } else {
    let count = typeof body.count === "number" ? Math.floor(body.count) : 1;
    count = Math.max(1, Math.min(count, 10));
    const taken = new Set(list.map((c) => c.code));
    while (entries.length < count) {
      const code = String(100000 + Math.floor(Math.random() * 900000));
      if (taken.has(code)) continue;
      taken.add(code);
      entries.push(makeCodeEntry(code, hours));
    }
  }
  config.security = Object.assign({}, secCfg(), {
    access_codes: list.concat(entries)
  });
  saveSecurity();
  return sendJSON(res, 201, { ok: true, entries, entry: entries[0] });
}

// ---- /api/admin/access-codes/:code/renew：延期（管理）----
// 新到期 = max(当前到期, 现在) + hours
async function handleRenewAccessCode(req, res, code) {
  let body = {};
  try { body = await parseJSONBody(req); } catch { body = {}; }
  const hours = clampCodeHours(body.hours);
  const list = accessCodeList();
  const c = list.find((x) => x.code === code);
  if (!c) return sendJSON(res, 404, { ok: false, detail: "访问码不存在" });
  const base = Math.max(Date.parse(c.expires_at), Date.now());
  const entry = Object.assign({}, c, { expires_at: new Date(base + hours * 3600e3).toISOString() });
  config.security = Object.assign({}, secCfg(), {
    access_codes: list.map((x) => (x.code === code ? entry : x))
  });
  saveSecurity();
  return sendJSON(res, 200, { ok: true, entry, detail: "已延期" });
}

// ---- /api/admin/access-codes/expired：清理全部过期码（管理）----
function handleCleanupExpiredCodes(res) {
  const now = Date.now();
  const list = accessCodeList();
  const next = list.filter((c) => Date.parse(c.expires_at) > now);
  const removed = list.length - next.length;
  if (removed > 0) {
    config.security = Object.assign({}, secCfg(), { access_codes: next });
    saveSecurity();
  }
  return sendJSON(res, 200, { ok: true, removed });
}

// ---- /api/admin/access-codes/:code：一键失效（管理）----
function handleInvalidateAccessCode(res, code) {
  const list = accessCodeList();
  const next = list.filter((c) => c.code !== code);
  if (next.length === list.length) {
    return sendJSON(res, 404, { ok: false, detail: "访问码不存在" });
  }
  config.security = Object.assign({}, secCfg(), { access_codes: next });
  saveSecurity();
  for (const [t, e] of accessTokens) if (e.code === code) accessTokens.delete(t); // 同步吊销已发 token
  return sendJSON(res, 200, { ok: true, detail: "已失效" });
}

// ---- 服务器 ----
const server = http.createServer(async (req, res) => {
  let urlObj;
  try {
    urlObj = new URL(req.url, "http://localhost");
  } catch {
    return sendJSON(res, 400, { ok: false, detail: "非法 URL" });
  }
  const p = urlObj.pathname;
  try {
    // 公开：健康检查（docker healthcheck 依赖）/ 状态 / 登录
    if (req.method === "GET" && p === "/api/health") {
      return sendJSON(res, 200, {
        ok: true,
        uptime_s: Math.round(process.uptime()),
        sessions: manager.list().length,
        active_qa: manager.activeIds(),
        sse_clients: sseClients.size,
        protocols: PROTOCOLS,
        asr_configured: Boolean(String(((config || {}).asr || {}).url || "").trim())
      });
    }
    if (req.method === "GET" && p === "/api/status") return handleStatus(res);
    if (req.method === "POST" && p === "/api/admin/login") return await handleAdminLogin(req, res);
    if (req.method === "POST" && p === "/api/access/login") return await handleAccessLogin(req, res);

    // 管理：访问码生成/失效
    if (req.method === "POST" && p === "/api/admin/access-codes") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return await handleAddAccessCode(req, res);
    }
    if (req.method === "DELETE" && p === "/api/admin/access-codes/expired") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return handleCleanupExpiredCodes(res);
    }
    const mRenew = p.match(/^\/api\/admin\/access-codes\/([A-Za-z0-9]+)\/renew$/);
    if (mRenew && req.method === "POST") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return await handleRenewAccessCode(req, res, mRenew[1]);
    }
    const mCode = p.match(/^\/api\/admin\/access-codes\/([A-Za-z0-9]+)$/);
    if (mCode && req.method === "DELETE") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return handleInvalidateAccessCode(res, mCode[1]);
    }

    // 查看级（匿名开放时直接通过；否则需访问 token 或管理 token）
    if (req.method === "GET" && p === "/api/events") {
      if (!viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return handleEvents(req, res);
    }
    if (p === "/api/sessions" && req.method === "GET") {
      if (!viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return sendJSON(res, 200, { sessions: manager.list(isAdmin(req, urlObj)) });
    }
    if (req.method === "GET" && p === "/api/history") {
      if (!viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return sendJSON(res, 200, { items: manager.mergedHistory() });
    }
    if (req.method === "POST" && p === "/api/chat") {
      if (!viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return await handleChat(req, res);
    }
    if (req.method === "POST" && p === "/api/asr") {
      if (!viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return await handleAsr(req, res);
    }
    if (req.method === "POST" && p === "/api/audio/stream") return await handleAudioStream(req, res); // 长连接推流；凭据 = X-Audio-Token（handler 内校验）
    if (req.method === "POST" && p === "/api/audio/capture") return await handleAudioCapture(req, res);   // 凭据 = body.token
if (req.method === "POST" && p === "/api/audio/listen") return await handleAudioListen(req, res);         // 实时识别：开始
if (req.method === "POST" && p === "/api/audio/listen/stop") return await handleAudioListenStop(req, res, false); // 停止（定稿）
if (req.method === "POST" && p === "/api/audio/listen/cancel") return await handleAudioListenStop(req, res, true);  // 取消（丢弃）（handler 内校验）
    if (req.method === "GET" && p === "/api/audio/stream") return handleGetAudioStreams(req, res, urlObj); // 凭据 = ?token=（handler 内校验）
    if (req.method === "POST" && p === "/api/push") return await handlePush(req, res, urlObj); // 凭据 = 会话推送 token（handler 内校验），与访问码无关
    if (req.method === "POST" && p === "/api/cancel") {
      if (!viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return await handleCancel(req, res);
    }

    // 管理：会话 CRUD / 重置 / 删记录 / 全局重置
    if (p === "/api/sessions" && req.method === "POST") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return await handleCreateSession(req, res);
    }
    const mReset = p.match(/^\/api\/sessions\/([a-zA-Z0-9]+)\/reset$/);
    if (mReset && req.method === "POST") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return handleResetSession(res, mReset[1]);
    }
    const mTest = p.match(/^\/api\/sessions\/([a-zA-Z0-9]+)\/protocol-test$/);
    if (mTest && req.method === "POST") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return await handleProtocolTest(req, res, mTest[1]);
    }
    const mRec = p.match(/^\/api\/sessions\/([a-zA-Z0-9]+)\/history\/([a-zA-Z0-9]+)$/);
    if (mRec && req.method === "DELETE") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      const ok = manager.removeRecord(mRec[1], mRec[2]);
      return sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "已删除" : "记录不存在" });
    }
    if (req.method === "POST" && p === "/api/session/reset") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      manager.resetAll();
      manager.broadcastSessions();
      return sendJSON(res, 200, { ok: true });
    }
    const mSess = p.match(/^\/api\/sessions\/([a-zA-Z0-9]+)$/);
    if (mSess) {
      if (req.method === "GET") {
        if (!viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
        return handleGetSession(res, mSess[1], isAdmin(req, urlObj));
      }
      if (req.method === "PUT") {
        if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
        return await handleUpdateSession(req, res, mSess[1]);
      }
      if (req.method === "DELETE") {
        if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
        return handleDeleteSession(res, mSess[1]);
      }
    }

    // 管理：ASR 测试连接（草稿值探测；已存配置兜底）
    if (req.method === "POST" && p === "/api/asr/test") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return await handleAsrTest(req, res);
    }

    // 管理：协议配置
    if (req.method === "GET" && p === "/api/config") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return sendJSON(res, 200, config);
    }
    if (req.method === "PUT" && p === "/api/config") {
      if (!isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return await handlePutConfig(req, res);
    }

    if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/admin")) {
      return serveStatic(res, "index.html");
    }
    // 其余 GET 一律按 public/ 静态文件提供（app.js / style.css / manifest / sw.js / icons/…）；
    // serveStatic 已做路径穿越防护（403）与存在性检查（404）
    if (req.method === "GET") return serveStatic(res, p.slice(1));
    return sendJSON(res, 404, { ok: false, detail: "not found" });
  } catch (e) {
    console.error("[server] 处理异常:", e);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, detail: String(e.message || e) });
    else {
      try {
        res.end();
      } catch {}
    }
  }
});

const port = Number(process.env.PORT) || Number(config.port) || 8787;
const host = process.env.HOST || config.host || "0.0.0.0";
server.listen(port, host, () => {
  const def = sessions[0];
  console.log("==================================================");
  console.log("  QA Mini 已启动（多会话）");
  console.log("  Web 界面:   http://" + (host === "0.0.0.0" ? "127.0.0.1" : host) + ":" + port + "/");
  console.log("  推送接口:   POST http://<本机IP>:" + port + "/api/push");
  console.log("              请求体需同时携带 token 与 session_id（在网页「会话设置」中复制 asr-tool 片段）");
  console.log("  音频推流:   POST /api/audio/stream（asr-tool 持续推流；会话需启用「输出音频接收」）");
  console.log("  会话存储:   " + sessionsFile + "（SQLite）");
  console.log("  默认会话:   " + def.name + "（会话ID " + def.id + "）");
  console.log("  配置:       " + configFile);
  console.log("==================================================");
});

module.exports = server;
