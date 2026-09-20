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
  loadSessions, saveSessions, sessionView
} = require("./lib/config");
const { SessionManager } = require("./lib/qa_runner");
const { QaError } = require("./lib/sse");

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
  const s = manager.update(id, body);
  if (!s) return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + id });
  return sendJSON(res, 200, { ok: true, session: sessionView(s, 0, true) });
}

function handleDeleteSession(res, id) {
  const ok = manager.remove(id);
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
  config = next;
  broadcast("config", { ok: true, config: maskConfigForBroadcast(next) });
  return sendJSON(res, 200, { ok: true, config: next });
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
        protocols: PROTOCOLS
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
  console.log("  会话存储:   " + sessionsFile + "（SQLite）");
  console.log("  默认会话:   " + def.name + "（会话ID " + def.id + "）");
  console.log("  配置:       " + configFile);
  console.log("==================================================");
});

module.exports = server;
