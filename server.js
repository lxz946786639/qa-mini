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
  ".ico": "image/x-icon"
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
  return sendJSON(res, 201, { ok: true, session: sessionView(s, 0) });
}

function handleGetSession(res, id) {
  const full = manager.full(id);
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
  return sendJSON(res, 200, { ok: true, session: sessionView(s, 0) });
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
  broadcast("config", { config: next });
  return sendJSON(res, 200, { ok: true, config: next });
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
    if (req.method === "GET" && p === "/api/events") return handleEvents(req, res);
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
    if (p === "/api/sessions" && req.method === "GET") {
      return sendJSON(res, 200, { sessions: manager.list() });
    }
    if (p === "/api/sessions" && req.method === "POST") return await handleCreateSession(req, res);
    const mReset = p.match(/^\/api\/sessions\/([a-zA-Z0-9]+)\/reset$/);
    if (mReset && req.method === "POST") return handleResetSession(res, mReset[1]);
    const mRec = p.match(/^\/api\/sessions\/([a-zA-Z0-9]+)\/history\/([a-zA-Z0-9]+)$/);
    if (mRec && req.method === "DELETE") {
      const ok = manager.removeRecord(mRec[1], mRec[2]);
      return sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "已删除" : "记录不存在" });
    }
    const mSess = p.match(/^\/api\/sessions\/([a-zA-Z0-9]+)$/);
    if (mSess) {
      if (req.method === "GET") return handleGetSession(res, mSess[1]);
      if (req.method === "PUT") return await handleUpdateSession(req, res, mSess[1]);
      if (req.method === "DELETE") return handleDeleteSession(res, mSess[1]);
    }
    if (req.method === "POST" && p === "/api/push") return await handlePush(req, res, urlObj);
    if (req.method === "POST" && p === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && p === "/api/cancel") return await handleCancel(req, res);
    if (req.method === "POST" && p === "/api/session/reset") {
      manager.resetAll();
      manager.broadcastSessions();
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/history") {
      return sendJSON(res, 200, { items: manager.mergedHistory() });
    }
    if (req.method === "GET" && p === "/api/config") {
      return sendJSON(res, 200, config);
    }
    if (req.method === "PUT" && p === "/api/config") return await handlePutConfig(req, res);
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveStatic(res, "index.html");
    if (req.method === "GET" && (p === "/app.js" || p === "/style.css")) return serveStatic(res, p.slice(1));
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
