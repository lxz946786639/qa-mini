"use strict";
// 本地 mock 协议服务（对齐 asr-tool tests/ 的 mock 思路）：
//  18701 openai   — SSE delta 流 / text 兼容 / 500 / 非法 SSE / slow(keepalive) / stall(无 keepalive)
//  18702 dify     — 全事件流 / conversation_id / error 事件 / 401 / 空 answer / slow
//  18703 ragflow  — 新路径 delta / 思考区 / 引用 / data:true；legacy 404 回退 + cumulative + ##0$$；
//                   两步建会话 / no-sessions(404) / cumulative(新路径 legacy:true) / 500 / 401
//  18704 generic  — SSE JSON / OpenAI 风格 / 纯文本 data / 单 JSON 文档 / 纯文本 / 500

const http = require("http");

const MOCKS = { openai: {}, dify: {}, ragflow: {}, generic: {} };
const PORTS = { openai: 18701, dify: 18702, ragflow: 18703, generic: 18704 };
const servers = [];
const keepalives = new Map(); // req -> interval

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size < 4 * 1024 * 1024) chunks.push(c); });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

// 写 SSE 头 + 行序列（行间隔 delayMs）
function sse(res, lines, delayMs) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let i = 0;
  (function next() {
    if (i >= lines.length) { res.end(); return; }
    res.write(lines[i++] + "\n\n");
    if (delayMs > 0) setTimeout(next, delayMs);
    else setImmediate(next);
  })();
}

// 写 SSE 头 + 首块，之后每 keepMs 发 keepalive 注释（模拟长流；客户端断开即清理）
function sseForever(req, res, firstLines, keepMs) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const l of firstLines) res.write(l + "\n\n");
  const iv = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, keepMs);
  keepalives.set(req, iv);
  req.on("close", () => { clearInterval(iv); keepalives.delete(req); });
}

// ---------- openai mock ----------
function openaiServer() {
  const srv = http.createServer(async (req, res) => {
    const body = await readJson(req);
    MOCKS.openai.last = { path: req.url, headers: req.headers, body };
    const q = JSON.stringify(body.messages || []);
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (q.includes("error500")) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "openai boom" } }));
    }
    if (q.includes("badjson")) {
      return sse(res, ["data: {oops-not-json", "data: [DONE]"], 5);
    }
    if (q.includes("stall")) {
      // 响应头 + 1 块之后完全静默（触发块间空闲超时）
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "第一段。" } }] }) + "\n\n");
    }
    if (q.includes("slow")) {
      return sseForever(req, res, ["data: " + JSON.stringify({ choices: [{ delta: { content: "第一段。" } }] })], 100);
    }
    if (q.includes("textfield")) {
      return sse(res, [
        "data: " + JSON.stringify({ choices: [{ text: "你好，" }] }),
        "data: " + JSON.stringify({ choices: [{ text: "我是助手。" }] }),
        "data: [DONE]"
      ], 5);
    }
    // 默认：keepalive 注释 + 正常 delta 流
    return sse(res, [
      ": keepalive",
      "data: " + JSON.stringify({ choices: [{ delta: { content: "你好，" } }] }),
      "",
      "data: " + JSON.stringify({ choices: [{ delta: { content: "我是助手。" } }] }),
      "data: [DONE]"
    ], 5);
  });
  return srv;
}

// ---------- dify mock ----------
function difyServer() {
  const srv = http.createServer(async (req, res) => {
    const body = await readJson(req);
    MOCKS.dify.last = { path: req.url, headers: req.headers, body };
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer dify-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: "unauthorized", message: "API key is invalid" }));
    }
    if (!req.url.endsWith("/chat-messages")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "not found" }));
    }
    const q = String(body.query || "");
    if (q.includes("slow")) {
      return sseForever(req, res, ["data: " + JSON.stringify({ event: "message", answer: "你好，", conversation_id: "conv-123" })], 100);
    }
    if (q.includes("error")) {
      return sse(res, [
        "data: " + JSON.stringify({ event: "message", answer: "前半、", conversation_id: "conv-123" }),
        "data: " + JSON.stringify({ event: "error", status: 500, message: "dify boom" })
      ], 5);
    }
    if (q.includes("empty")) {
      return sse(res, [
        "data: " + JSON.stringify({ event: "message", answer: "", conversation_id: "conv-123" }),
        "data: " + JSON.stringify({ event: "message_end", conversation_id: "conv-123" })
      ], 5);
    }
    // 默认：全事件流
    return sse(res, [
      "event: ping",
      "data: " + JSON.stringify({ event: "workflow_started", workflow_run_id: "w1" }),
      "data: " + JSON.stringify({ event: "node_started", node_id: "n1" }),
      "data: " + JSON.stringify({ event: "message", answer: "你好，", conversation_id: "conv-123" }),
      "data: " + JSON.stringify({ event: "message", answer: "我是助手。", conversation_id: "conv-123" }),
      "data: " + JSON.stringify({ event: "node_finished", node_id: "n1" }),
      "data: " + JSON.stringify({ event: "message_end", conversation_id: "conv-123", metadata: {} })
    ], 5);
  });
  return srv;
}

// ---------- ragflow mock ----------
// mode: "new"(默认,delta) | "legacy"(新路径404,旧路径cumulative) |
//       "cumulative"(新路径累积) | "no-sessions"(sessions端点404)
function ragflowServer() {
  const srv = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const m = MOCKS.ragflow;
    const auth = req.headers.authorization || "";
    m.last = { path: req.url, headers: req.headers, body, mode: m.mode || "new" };
    if (auth !== "Bearer ragflow-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: 109, message: "Unauthorized" }));
    }
    const url = req.url || "";
    // 路径需带 RAGFlow API 前缀（/api/v1）才识别，与真实部署一致；
    // 其他前缀（如 /nope/v1）一律落到末尾 404（用于「双 404」测试）
    const sessMatch = url.match(/^\/api\/v1\/chats\/[^/]+\/sessions$/);
    const legacyMatch = url.match(/^\/api\/v1\/chats\/([^/]+)\/completions$/);
    const isNew = url === "/api/v1/chat/completions";

    if (sessMatch) {
      if ((m.mode || "new") === "no-sessions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ code: 102, message: "not found" }));
      }
      m.sessionsCalls = (m.sessionsCalls || 0) + 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: 0, message: "", data: { id: "sess-1", name: body.name || "qa-mini" } }));
    }

    if (isNew) {
      if ((m.mode || "new") === "legacy") {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ code: 102, message: "route not found" }));
      }
      const q = String(body.question || "");
      const env = (data) => "data: " + JSON.stringify({ code: 0, message: "", data });
      if (q.includes("slow")) {
        return sseForever(req, res, [env({ session_id: "sess-1", answer: "第一段。" })], 100);
      }
      if (q.includes("error500")) {
        return sse(res, [env({ answer: "前半、" }), "data: " + JSON.stringify({ code: 500, message: "ragflow boom", data: "" })], 5);
      }
      if (q.includes("empty")) {
        return sse(res, [env({}), env(true)], 5);
      }
      if (q.includes("think")) {
        return sse(res, [
          env({ session_id: "sess-1", start_to_think: true }),
          env({ answer: "让我想想…" }),
          env({ end_to_think: true }),
          env({ answer: "最终答案。", reference: { doc_aggs: [{ doc_name: "文档A.pdf" }], chunks: [{ document_name: "文档B.txt" }] } }),
          env(true)
        ], 5);
      }
      if ((m.mode || "new") === "cumulative") {
        return sse(res, [
          env({ session_id: "sess-1", answer: "你好" }),
          env({ answer: "你好，" }),
          env({ answer: "你好，我是助手。" }),
          env(true)
        ], 5);
      }
      // 默认：delta 流 + 引用
      return sse(res, [
        env({ session_id: "sess-1", answer: "你好，" }),
        env({ answer: "我是助手。" }),
        env({ reference: { doc_aggs: [{ doc_name: "文档A.pdf" }] } }),
        env(true)
      ], 5);
    }

    if (legacyMatch) {
      m.legacyCalls = (m.legacyCalls || 0) + 1;
      m.legacyChatId = legacyMatch[1];
      const env = (data) => "data: " + JSON.stringify({ code: 0, message: "", data });
      // 旧路径：cumulative 流 + ##0$$ 句中插入（末块把占位符解析为 [1] 引用）
      return sse(res, [
        env({ session_id: "sess-1", answer: "你好" }),
        env({ answer: "你好，我是助手##0$$。" }),
        env({ answer: "你好，我是助手[1]。" }),
        env(true)
      ], 5);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: 102, message: "not found: " + url }));
  });
  return srv;
}

// ---------- generic mock ----------
function genericServer() {
  const srv = http.createServer(async (req, res) => {
    const body = await readJson(req);
    MOCKS.generic.last = { path: req.url, headers: req.headers, body };
    const q = String(body.question || "");
    if (q.includes("error500")) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "generic boom" }));
    }
    if (q.includes("json")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: { answer: "整段回答" }, extra: 1 }));
    }
    if (q.includes("text")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("纯文本回答");
    }
    if (q.includes("slow")) {
      return sseForever(req, res, ["data: " + JSON.stringify({ answer: "片段一、" })], 100);
    }
    if (q.includes("openai")) {
      return sse(res, [
        "data: " + JSON.stringify({ choices: [{ delta: { content: "片段一、" } }] }),
        "data: " + JSON.stringify({ choices: [{ delta: { content: "片段二。" } }] }),
        "data: [DONE]"
      ], 5);
    }
    if (q.includes("plainsse")) {
      return sse(res, ["data: 纯文本一、", "data: 纯文本二。", "data: [DONE]"], 5);
    }
    // 默认：SSE JSON 增量
    return sse(res, [
      "data: " + JSON.stringify({ answer: "片段一、" }),
      "data: " + JSON.stringify({ answer: "片段二。" }),
      "data: [DONE]"
    ], 5);
  });
  return srv;
}

async function startMocks() {
  const map = { openai: openaiServer(), dify: difyServer(), ragflow: ragflowServer(), generic: genericServer() };
  for (const [name, srv] of Object.entries(map)) {
    await new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(PORTS[name], "127.0.0.1", () => { srv.removeListener("error", reject); resolve(); });
    });
    servers.push(srv);
  }
  return MOCKS;
}

async function stopMocks() {
  for (const iv of keepalives.values()) clearInterval(iv);
  keepalives.clear();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}

module.exports = { startMocks, stopMocks, MOCKS, PORTS };
