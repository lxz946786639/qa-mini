"use strict";
// EchoAnswer 全量测试（零框架）：
//  [1] 四个协议客户端单测（mock 后端）
//  [2] 服务器 API 全链路（真实 server.js + mock 后端，多会话）
// 运行: node tests/run_tests.js   （或 npm test）

process.env.ECHOANSWER_IDLE_TIMEOUT_MS = "400";
process.env.ECHOANSWER_CONNECT_TIMEOUT_MS = "500";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { startMocks, stopMocks, MOCKS, PORTS } = require("./mock_backends");

const { buildMessages, streamOpenAI } = require(path.join(ROOT, "lib/protocols/openai"));
const { buildQuery, normalizeDifyUrl, streamDify } = require(path.join(ROOT, "lib/protocols/dify"));
const { buildGenericBody, streamGeneric } = require(path.join(ROOT, "lib/protocols/generic"));
const { normalizeRagflowUrls, streamRagflow } = require(path.join(ROOT, "lib/protocols/ragflow"));

const TEST_PORT = 18790;
const BASE = "http://127.0.0.1:" + TEST_PORT;

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("测试超时（20s），已跳过")), 20000);
  });
  try {
    await Promise.race([fn(), guard]);
    passed++;
    console.log("  PASS  " + name);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error("  FAIL  " + name);
    console.error("        " + String((e && e.stack) || e).split("\n").slice(0, 6).join("\n        "));
  } finally {
    clearTimeout(timer);
  }
}

// 黑洞端口：接受 TCP 连接但永不响应（用于连接超时测试）；stop 时强制断开所有连接
function blackhole(port) {
  const bh = net.createServer(() => {});
  const sockets = new Set();
  bh.on("connection", (s) => { sockets.add(s); });
  return {
    start: () => new Promise((r) => bh.listen(port, "127.0.0.1", r)),
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => bh.close(r));
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain(stream) {
  let out = "";
  for await (const d of stream) out += d;
  return out;
}

async function firstError(stream) {
  try {
    await drain(stream);
  } catch (e) {
    return e;
  }
  throw new Error("期望抛错但未抛出");
}

async function api(method, urlPath, body) {
  const resp = await fetch(BASE + urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  return { status: resp.status, data };
}

async function waitDoneWith(qaId, headers, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 8000)) {
    const resp = await fetch(BASE + "/api/history", { headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) });
    let data = null;
    try { data = await resp.json(); } catch {}
    const rec = ((data && data.items) || []).find((h) => h.id === qaId);
    if (rec && rec.status === "done") return rec;
    await sleep(50);
  }
  throw new Error("waitDoneWith 超时: " + qaId);
}

async function waitDone(qaId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 8000)) {
    const r = await api("GET", "/api/history");
    const rec = (r.data.items || []).find((h) => h.id === qaId);
    if (rec && rec.status === "done") return rec;
    await sleep(50);
  }
  throw new Error("waitDone 超时: " + qaId);
}

async function collectSse(opts) {
  const events = [];
  const ctrl = new AbortController();
  (async () => {
    const url = BASE + "/api/events" + (opts && opts.query ? opts.query : "");
    const resp = await fetch(url, { signal: ctrl.signal, headers: (opts && opts.headers) || undefined });
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = "message";
        let data = "";
        for (const l of raw.split("\n")) {
          if (l.startsWith("event:")) name = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        }
        if (data) events.push({ ev: name, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return {
    events,
    close() { ctrl.abort(); },
    wait(evName, pred, timeoutMs) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        (function poll() {
          const hit = events.find((e) => e.ev === evName && (!pred || pred(e.data)));
          if (hit) return resolve(hit);
          if (Date.now() - t0 > (timeoutMs || 8000)) return reject(new Error("等待事件超时: " + evName));
          setTimeout(poll, 50);
        })();
      });
    }
  };
}

const REF_FOOTER = "\n\n---\n**参考来源**：文档A.pdf";

(async () => {
  const t0 = Date.now();
  await startMocks();

  console.log("\n[1] 协议客户端单测");

  await test("qa_runner: countCJK 只统计中文字符", async () => {
    const { countCJK } = require(path.join(ROOT, "lib/qa_runner"));
    assert.strictEqual(countCJK("你好abc123，。 "), 2);
    assert.strictEqual(countCJK("广西华锡集团"), 6);
    assert.strictEqual(countCJK(""), 0);
    assert.strictEqual(countCJK("a b c"), 0);
  });

  // ---------- openai ----------
  const openaiCfg = { url: "http://127.0.0.1:" + PORTS.openai + "/v1/chat/completions", api_key: "k1", model: "m1" };
  await test("openai: 正常 delta 流（keepalive/[DONE]/鉴权/model）", async () => {
    const out = await drain(streamOpenAI(openaiCfg, "你好"));
    assert.strictEqual(out, "你好，我是助手。");
    assert.strictEqual(MOCKS.openai.last.headers.authorization, "Bearer k1");
    assert.strictEqual(MOCKS.openai.last.body.model, "m1");
    assert.strictEqual(MOCKS.openai.last.body.stream, true);
    assert.strictEqual(MOCKS.openai.last.body.messages.length, 1);
  });
  await test("openai: buildMessages 上下文 → system 消息", async () => {
    const msgs = buildMessages("q", "ctx");
    assert.strictEqual(msgs.length, 2);
    assert.ok(msgs[0].content.indexOf("参考上下文（最近识别内容）：\nctx") === 0);
    assert.strictEqual(msgs[1].role, "user");
    assert.strictEqual(buildMessages("q", "  ").length, 1);
  });
  await test("openai: choices[0].text 兼容", async () => {
    const out = await drain(streamOpenAI(openaiCfg, "textfield 问题"));
    assert.strictEqual(out, "你好，我是助手。");
  });
  await test("openai: 500 → 状态码 + 响应体截断", async () => {
    const e = await firstError(streamOpenAI(openaiCfg, "error500 问题"));
    assert.strictEqual(e.name, "QaError");
    assert.strictEqual(e.status, 500);
    assert.ok(e.detail.includes("openai boom"));
  });
  await test("openai: SSE 非法 JSON → SSE 解析失败", async () => {
    const e = await firstError(streamOpenAI(openaiCfg, "badjson 问题"));
    assert.strictEqual(e.name, "QaError");
    assert.strictEqual(e.status, 0);
    assert.ok(e.detail.includes("SSE 解析失败"));
  });
  await test("openai: 块间空闲超时（stall）", async () => {
    const e = await firstError(streamOpenAI(openaiCfg, "stall 问题"));
    assert.ok(e.detail.includes("块间读取超时"), e.detail);
  });
  await test("openai: 连接拒绝 → 请求失败", async () => {
    const e = await firstError(streamOpenAI({ url: "http://127.0.0.1:1/v1/chat/completions", api_key: "" }, "hi"));
    assert.strictEqual(e.name, "QaError");
    assert.ok(e.detail.startsWith("请求失败:"));
  });
  await test("openai: 连接超时（黑洞端口）", async () => {
    const bh = blackhole(18705);
    await bh.start();
    try {
      const e = await firstError(streamOpenAI({ url: "http://127.0.0.1:18705/v1/chat/completions", api_key: "" }, "hi"));
      assert.ok(e.detail.includes("连接超时"), e.detail);
    } finally {
      await bh.stop();
    }
  });
  await test("openai: 取消（保留已流出）", async () => {
    const ctrl = new AbortController();
    let out = "";
    (async () => {
      for await (const d of streamOpenAI(openaiCfg, "slow 问题")) out += d;
    })().catch(() => {});
    await sleep(250);
    ctrl.abort();
    await sleep(100);
    assert.ok(out.includes("第一段。"), out);
  });

  // ---------- dify ----------
  await test("dify: normalizeDifyUrl", async () => {
    assert.strictEqual(normalizeDifyUrl("http://h/v1/"), "http://h/v1/chat-messages");
    assert.strictEqual(normalizeDifyUrl("http://h/v1/chat-messages"), "http://h/v1/chat-messages");
  });
  await test("dify: buildQuery 上下文拼接", async () => {
    assert.strictEqual(buildQuery("q", "ctx"), "参考上下文（最近识别内容）：\nctx\n\n问题：q");
    assert.strictEqual(buildQuery("q", ""), "q");
  });
  const difyCfg = { url: "http://127.0.0.1:" + PORTS.dify + "/v1", api_key: "dify-key", user: "tester" };
  await test("dify: 全事件流 + conversation_id 回传", async () => {
    const meta = {};
    const onMeta = (m) => Object.assign(meta, m);
    const out = await drain(streamDify(difyCfg, "你好", { onMeta }));
    assert.strictEqual(out, "你好，我是助手。");
    assert.strictEqual(meta.conversation_id, "conv-123");
    assert.strictEqual(MOCKS.dify.last.path, "/v1/chat-messages");
    assert.strictEqual(MOCKS.dify.last.body.response_mode, "streaming");
    assert.strictEqual(MOCKS.dify.last.body.user, "tester");
    assert.strictEqual(MOCKS.dify.last.body.conversation_id, undefined);
  });
  await test("dify: 携带 conversation_id 续接", async () => {
    const out = await drain(streamDify(difyCfg, "追问", { conversationId: "conv-123" }));
    assert.strictEqual(out, "你好，我是助手。");
    assert.strictEqual(MOCKS.dify.last.body.conversation_id, "conv-123");
  });
  await test("dify: 401", async () => {
    const e = await firstError(streamDify({ url: difyCfg.url, api_key: "wrong" }, "hi"));
    assert.strictEqual(e.status, 401);
    assert.ok(e.detail.includes("API key is invalid"));
  });
  await test("dify: 流内 error 事件（保留已流出）", async () => {
    const ctrl = new AbortController();
    let out = "";
    let thrown = null;
    try {
      for await (const d of streamDify(difyCfg, "error 问题", { signal: ctrl.signal })) out += d;
    } catch (e) { thrown = e; }
    assert.ok(out.includes("前半、"), out);
    assert.strictEqual(thrown.status, 500);
    assert.ok(thrown.detail.includes("dify boom"));
  });
  await test("dify: 空 answer 跳过", async () => {
    const out = await drain(streamDify(difyCfg, "empty 问题"));
    assert.strictEqual(out, "");
  });
  await test("dify: 未配置 api_key 前置报错", async () => {
    const e = await firstError(streamDify({ url: difyCfg.url, api_key: "" }, "hi"));
    assert.ok(e.detail.includes("未配置 API Key"));
  });

  // ---------- generic ----------
  await test("generic: 模板构建（占位符/注入/覆盖/非法）", async () => {
    const b = buildGenericBody(JSON.stringify({ token: "t", input: "{question}", meta: { ref: "{context}" } }), "Q", "C");
    assert.strictEqual(b.input, "Q");
    assert.strictEqual(b.meta.ref, "C");
    assert.strictEqual(b.question, "Q");
    assert.strictEqual(b.context, "C");
    assert.strictEqual(b.token, "t");
    const b2 = buildGenericBody("{\"input\":\"{question}\"}", "Q2");
    assert.strictEqual(b2.context, undefined);
    assert.throws(() => buildGenericBody("[1,2]", "q"), /请求体必须是 JSON 对象/);
    assert.throws(() => buildGenericBody("{bad", "q"), /请求体不是合法 JSON/);
  });
  const genericCfg = { url: "http://127.0.0.1:" + PORTS.generic + "/ask", api_key: "", body: JSON.stringify({ token: "kaasr_x", input: "{question}" }) };
  await test("generic: SSE JSON 增量 + 请求体断言", async () => {
    const out = await drain(streamGeneric(genericCfg, "普通问题"));
    assert.strictEqual(out, "片段一、片段二。");
    assert.strictEqual(MOCKS.generic.last.body.question, "普通问题");
    assert.strictEqual(MOCKS.generic.last.body.input, "普通问题");
    assert.strictEqual(MOCKS.generic.last.body.token, "kaasr_x");
    assert.strictEqual(MOCKS.generic.last.body.context, undefined);
  });
  await test("generic: OpenAI 风格 delta", async () => {
    const out = await drain(streamGeneric(genericCfg, "openai 问题"));
    assert.strictEqual(out, "片段一、片段二。");
  });
  await test("generic: 纯文本 data 行", async () => {
    const out = await drain(streamGeneric(genericCfg, "plainsse 问题"));
    assert.strictEqual(out, "纯文本一、纯文本二。");
  });
  await test("generic: 单个 JSON 文档", async () => {
    const out = await drain(streamGeneric(genericCfg, "json 问题"));
    assert.strictEqual(out, "整段回答");
  });
  await test("generic: 纯文本响应", async () => {
    const out = await drain(streamGeneric(genericCfg, "text 问题"));
    assert.strictEqual(out, "纯文本回答");
  });
  await test("generic: 500", async () => {
    const e = await firstError(streamGeneric(genericCfg, "error500 问题"));
    assert.strictEqual(e.status, 500);
    assert.ok(e.detail.includes("generic boom"));
  });
  await test("generic: context 注入到模板占位符", async () => {
    const cfg2 = { url: genericCfg.url, api_key: "", body: "{\"ctx\":\"{context}\"}" };
    await drain(streamGeneric(cfg2, "Q3", { context: "CTX3" }));
    assert.strictEqual(MOCKS.generic.last.body.ctx, "CTX3");
    assert.strictEqual(MOCKS.generic.last.body.context, "CTX3");
  });

  // ---------- ragflow ----------
  await test("ragflow: normalizeRagflowUrls", async () => {
    const u = normalizeRagflowUrls("http://h:9380/api/v1/", "C1");
    assert.strictEqual(u.newUrl, "http://h:9380/api/v1/chat/completions");
    assert.strictEqual(u.legacyUrl, "http://h:9380/api/v1/chats/C1/completions");
  });
  const ragflowCfg = { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9", user: "tester" };
  MOCKS.ragflow.mode = "new";
  await test("ragflow: delta 流 + 两步建会话 + 引用脚注", async () => {
    const meta = {};
    const out = await drain(streamRagflow(ragflowCfg, "你好", { onMeta: (m) => Object.assign(meta, m) }));
    assert.strictEqual(out, "你好，我是助手。" + REF_FOOTER);
    assert.strictEqual(meta.session_id, "sess-1");
    assert.ok(MOCKS.ragflow.sessionsCalls >= 1);
    assert.strictEqual(MOCKS.ragflow.last.path, "/api/v1/chat/completions");
    assert.strictEqual(MOCKS.ragflow.last.body.chat_id, "C9");
    assert.strictEqual(MOCKS.ragflow.last.body.session_id, "sess-1");
    assert.strictEqual(MOCKS.ragflow.last.body.user, "tester", "user 字段透传（RAGFlow 请求 user 标识）");
    assert.strictEqual(MOCKS.ragflow.last.headers.authorization, "Bearer ragflow-key");
  });
  await test("ragflow: 会话续接（不再建会话）", async () => {
    const before = MOCKS.ragflow.sessionsCalls;
    await drain(streamRagflow(ragflowCfg, "追问", { sessionId: "sess-1" }));
    assert.strictEqual(MOCKS.ragflow.sessionsCalls, before);
    assert.strictEqual(MOCKS.ragflow.last.body.session_id, "sess-1");
  });
  await test("ragflow: stale session（不属于该 chat）纯 JSON 错误 → 报错而非空回答", async () => {
    const e = await firstError(streamRagflow(ragflowCfg, "hi", { sessionId: "stale-xyz" }));
    assert.ok(e, "stale session 应报错");
    assert.ok(String(e.detail || e.message).includes("belong"), e.detail || e.message);
    assert.ok(MOCKS.ragflow.staleCalls >= 1, "mock 收到 stale 请求");
  });
  await test("ragflow: 思考区跳过 + 多文档引用", async () => {
    const out = await drain(streamRagflow(ragflowCfg, "think 问题", {}));
    assert.strictEqual(out, "最终答案。" + "\n\n---\n**参考来源**：文档A.pdf");
  });
  MOCKS.ragflow.mode = "cumulative";
  await test("ragflow: 新路径 cumulative（legacy:true 场景）", async () => {
    const out = await drain(streamRagflow(ragflowCfg, "你好", {}));
    assert.strictEqual(out, "你好，我是助手。");
  });
  MOCKS.ragflow.mode = "legacy";
  await test("ragflow: 新路径 404 → 旧路径 + cumulative + ##0$$", async () => {
    const out = await drain(streamRagflow(ragflowCfg, "你好", {}));
    assert.strictEqual(out, "你好，我是助手##0$$。[1]。");
    assert.strictEqual(MOCKS.ragflow.legacyCalls, 1);
    assert.strictEqual(MOCKS.ragflow.legacyChatId, "C9");
    assert.strictEqual(MOCKS.ragflow.last.path, "/api/v1/chats/C9/completions");
    assert.strictEqual(MOCKS.ragflow.last.body.chat_id, undefined);
  });
  MOCKS.ragflow.mode = "no-sessions";
  await test("ragflow: sessions 端点 404 → 退化为单调用", async () => {
    const out = await drain(streamRagflow(ragflowCfg, "你好", {}));
    assert.strictEqual(out, "你好，我是助手。" + REF_FOOTER);
    assert.strictEqual(MOCKS.ragflow.last.body.session_id, undefined);
  });
  MOCKS.ragflow.mode = "new";
  await test("ragflow: 流内 code!=0 报错", async () => {
    const e = await firstError(streamRagflow(ragflowCfg, "error500 问题", {}));
    assert.strictEqual(e.status, 500);
    assert.ok(e.detail.includes("ragflow boom"));
  });
  await test("ragflow: 401", async () => {
    const e = await firstError(streamRagflow({ url: ragflowCfg.url, api_key: "wrong", chat_id: "C9" }, "hi", {}));
    assert.strictEqual(e.status, 401);
  });
  await test("ragflow: 双 404 → HTTP 404", async () => {
    const e = await firstError(streamRagflow({ url: "http://127.0.0.1:" + PORTS.ragflow + "/nope/v1", api_key: "ragflow-key", chat_id: "C9" }, "hi", {}));
    assert.strictEqual(e.status, 404);
  });
  await test("ragflow: 空回答", async () => {
    const out = await drain(streamRagflow(ragflowCfg, "empty 问题", {}));
    assert.strictEqual(out, "");
  });
  await test("ragflow: 未配置 chat_id 前置报错", async () => {
    const e = await firstError(streamRagflow({ url: ragflowCfg.url, api_key: "ragflow-key", chat_id: "" }, "hi", {}));
    assert.ok(e.detail.includes("未配置知识引擎 Chat ID"));
  });

  await test("config: 会话级协议配置合并（会话覆盖全局、空值回退全局）", async () => {
    const cfgmod = require(path.join(ROOT, "lib/config"));
    const cfg = { protocols: { openai: { url: "g-url", api_key: "g-key", model: "g-model" } } };
    const merged = cfgmod.resolveProtocolConfig({ protocol_config: { openai: { url: "s-url", api_key: "" } } }, cfg, "openai");
    assert.strictEqual(merged.url, "s-url", "非空覆盖生效");
    assert.strictEqual(merged.api_key, "g-key", "空值回退全局");
    assert.strictEqual(merged.model, "g-model", "未提交字段沿用全局");
    assert.deepStrictEqual(cfgmod.resolveProtocolConfig({}, cfg, "openai"), cfg.protocols.openai, "无覆盖 = 原样全局");
    const sc = cfgmod.sanitizeProtocolConfig({ openai: { url: "  x  ", model: "m", unknown: 1 }, bogus: {} });
    assert.strictEqual(sc.openai.url, "x", "trim");
    assert.strictEqual(sc.openai.model, "m");
    assert.ok(!("unknown" in sc.openai), "未知字段丢弃");
    assert.ok(!("bogus" in sc), "未知协议丢弃");
    assert.deepStrictEqual(cfgmod.sanitizeProtocolConfig({ openai: { url: "" } }).openai, {}, "全空 = 清除该协议覆盖");
    assert.strictEqual(cfgmod.sanitizeProtocolConfig([1]), null);
    assert.strictEqual(cfgmod.sanitizeProtocolConfig("x"), null);
  });

  await test("config: 旧库迁移补 protocol_config 列（数据保留）", async () => {
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "echoanswer-mig-"));
    const { DatabaseSync } = require("node:sqlite");
    const oldDb = new DatabaseSync(path.join(mdir, "echoanswer.db"));
    oldDb.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL, protocol TEXT NOT NULL," +
      "  continue_session INTEGER NOT NULL DEFAULT 1, dify_conversation_id TEXT NOT NULL DEFAULT ''," +
      "  ragflow_session_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0);"
    );
    oldDb.exec(
      "CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, id TEXT NOT NULL," +
      "  question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT ''," +
      "  protocol_name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT ''," +
      "  ok INTEGER NOT NULL DEFAULT 1, detail TEXT NOT NULL DEFAULT '', UNIQUE (session_id, id));"
    );
    oldDb.exec(
      "INSERT INTO sessions (id, name, token, protocol, continue_session, created_at, updated_at, pos)" +
      " VALUES ('old1', '旧会话', 'kaasr_old123', 'openai', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)"
    );
    oldDb.close();
    const prevDataDir = process.env.ECHOANSWER_DATA_DIR;
    process.env.ECHOANSWER_DATA_DIR = mdir;
    try {
      const cfgmod = require(path.join(ROOT, "lib/config"));
      const { sessions } = cfgmod.loadSessions(null);
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].id, "old1");
      assert.strictEqual(sessions[0].name, "旧会话");
      assert.strictEqual(sessions[0].token, "kaasr_old123", "旧行数据保留");
      assert.deepStrictEqual(sessions[0].protocol_config, {}, "迁移后默认空覆盖");
    } finally {
      process.env.ECHOANSWER_DATA_DIR = prevDataDir;
      try { fs.rmSync(mdir, { recursive: true, force: true }); } catch {}
    }
  });

  await test("storage: 旧库 qa-mini.db 自动重命名 echoanswer.db（数据保留）", async () => {
    const { spawnSync } = require("child_process");
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "echoanswer-legacy-"));
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(mdir, "qa-mini.db"));
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL, protocol TEXT NOT NULL," +
      "  continue_session INTEGER NOT NULL DEFAULT 1, protocol_config TEXT NOT NULL DEFAULT '{}'," +
      "  audio_remote TEXT NOT NULL DEFAULT '{}', dify_conversation_id TEXT NOT NULL DEFAULT ''," +
      "  ragflow_session_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0);"
    );
    db.exec(
      "INSERT INTO sessions (id, name, token, protocol, created_at, updated_at)" +
      " VALUES ('lg1', '旧会话', 'kaasr_legacy1', 'ragflow', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
    );
    db.close();
    const out = spawnSync(
      process.execPath,
      ["-e", "const c = require(process.env.EA_CFG); const r = c.loadSessions(null);" +
        " console.log(JSON.stringify({ n: r.sessions.length, t: r.sessions[0] && r.sessions[0].token," +
        " fresh: require('fs').existsSync(process.env.EA_FRESH), old: require('fs').existsSync(process.env.EA_OLD) }))"],
      {
        cwd: ROOT, encoding: "utf-8",
        env: Object.assign({}, process.env, {
          EA_CFG: path.join(ROOT, "lib", "config.js"),
          ECHOANSWER_DATA_DIR: mdir,
          EA_FRESH: path.join(mdir, "echoanswer.db"),
          EA_OLD: path.join(mdir, "qa-mini.db")
        })
      }
    );
    const r = JSON.parse(out.stdout.trim().split("\n").pop());
    assert.strictEqual(r.n, 1, "会话保留");
    assert.strictEqual(r.t, "kaasr_legacy1", "行数据保留");
    assert.ok(r.fresh, "echoanswer.db 已生成");
    assert.ok(!r.old, "旧库已重命名");
    try { fs.rmSync(mdir, { recursive: true, force: true }); } catch {}
  });

  await test("config: 旧环境变量 QA_MINI_DATA_DIR 兼容", async () => {
    const { spawnSync } = require("child_process");
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "echoanswer-lenv-"));
    const out = spawnSync(
      process.execPath,
      ["-e", "const c = require(process.env.EA_CFG); const r = c.loadSessions(null);" +
        " console.log(JSON.stringify({ n: r.sessions.length, f: require('fs').existsSync(process.env.EA_DB) }))"],
      {
        cwd: ROOT, encoding: "utf-8",
        env: Object.assign({}, process.env, {
          EA_CFG: path.join(ROOT, "lib", "config.js"),
          ECHOANSWER_DATA_DIR: "",
          QA_MINI_DATA_DIR: mdir,
          EA_DB: path.join(mdir, "echoanswer.db")
        })
      }
    );
    const r = JSON.parse(out.stdout.trim().split("\n").pop());
    assert.ok(r.n >= 1, "默认会话建立");
    assert.ok(r.f, "库落在旧 env 指定目录");
    try { fs.rmSync(mdir, { recursive: true, force: true }); } catch {}
  });

  // ---------- [2] 服务器 API（多会话） ----------
  console.log("\n[2] 服务器 API 全链路（多会话）");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoanswer-test-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const dataDir = path.join(tmpDir, "data");
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: TEST_PORT,
    host: "127.0.0.1",
    push: { token: "test-token", protocol: "ragflow", continue_session: true },
    protocols: {
      openai: { url: "http://127.0.0.1:" + PORTS.openai + "/v1/chat/completions", api_key: "k1", model: "" },
      dify: { url: "http://127.0.0.1:" + PORTS.dify + "/v1", api_key: "dify-key", user: "tester" },
      generic: { url: "http://127.0.0.1:" + PORTS.generic + "/ask", api_key: "", body: JSON.stringify({ token: "kaasr_x", input: "{question}" }) },
      ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9", user: "qa-mini" }
    }
  }, null, 2));

  let serverLog = "";
  const serverProc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      ECHOANSWER_CONFIG: cfgPath,
      ECHOANSWER_DATA_DIR: dataDir,
      PORT: String(TEST_PORT),
      HOST: "127.0.0.1"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProc.stdout.on("data", (d) => { serverLog += d.toString(); });
  serverProc.stderr.on("data", (d) => { serverLog += d.toString(); });

  const tStart = Date.now();
  let up = false;
  while (Date.now() - tStart < 10000) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(100);
  }
  assert.ok(up, "服务器未启动: " + serverLog);

  await test("health: 含会话数", async () => {
    const r = await api("GET", "/api/health");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.protocols.includes("ragflow"));
    assert.strictEqual(r.data.sessions, 1);
  });
  await test("config: P8.81 v8 已清全局身份字段（ragflow.chat_id/openai.model 保持空）+ 恢复 dify.api_key（早期协议客户端测试用，legacy 回退路径仍有效）", async () => {
    const r = await api("PUT", "/api/config", { protocols: { dify: { api_key: "dify-key" } } });
    assert.strictEqual(r.status, 200, r.data && r.data.detail);
    const g = await api("GET", "/api/config");
    assert.strictEqual(g.data.protocols.dify.api_key, "dify-key", "dify.api_key 恢复（legacy 回退）");
    assert.strictEqual(g.data.protocols.ragflow.chat_id, "", "v8: 全局 ragflow.chat_id 保持空（身份迁智能体层）");
    assert.strictEqual(g.data.protocols.openai.model, "", "v8: 全局 openai.model 保持空（身份迁智能体层）");
  });
  await test("根路径 = 新代前端（P7 切根：Vue 壳 + 构建产物）", async () => {
    const r = await fetch(BASE + "/");
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('<div id="app">'), "Vue 挂载点");
    assert.ok(html.includes("assets/index-"), "引用构建产物 bundle");
    assert.ok(html.includes("EchoAnswer"), "标题");
  });
  await test("未知 API → 404", async () => {
    const r = await api("GET", "/api/nope");
    assert.strictEqual(r.status, 404);
  });
  await test("PWA: manifest 合法且含 any/maskable 图标", async () => {
    const r = await fetch(BASE + "/manifest.webmanifest");
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get("content-type") || "").includes("manifest+json"));
    const mf = await r.json();
    assert.strictEqual(mf.start_url, "/");
    assert.strictEqual(mf.display, "standalone");
    assert.ok(mf.icons.some((i) => i.sizes === "192x192" && i.purpose === "any"), "192 any");
    assert.ok(mf.icons.some((i) => i.purpose === "maskable"), "maskable");
  });
  await test("PWA: sw.js 可访问且为 workbox 产物（P7：旧 CACHE 常量护栏替换）", async () => {
    const r = await fetch(BASE + "/sw.js");
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get("content-type") || "").includes("javascript"));
    const txt = await r.text();
    assert.ok(txt.includes("workbox"), "workbox generateSW 产物");
  });
  await test("前端构建产物完整性：index.html 引用 bundle + sw/manifest/registerSW/图标齐备（防缺件上线）", async () => {
    const fs2 = require("fs");
    const dist = path.join(ROOT, "web", "dist");
    const html = fs2.readFileSync(path.join(dist, "index.html"), "utf8");
    assert.ok(html.includes("assets/index-"), "index.html 引用主 bundle");
    for (const ff of ["sw.js", "registerSW.js", "manifest.webmanifest", "icons/icon-192.png"]) {
      assert.ok(fs2.existsSync(path.join(dist, ff)), "dist 含 " + ff);
    }
  });
  await test("PWA: 图标均为有效 PNG", async () => {
    for (const p of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"]) {
      const r = await fetch(BASE + p);
      assert.strictEqual(r.status, 200, p);
      assert.ok((r.headers.get("content-type") || "").includes("image/png"), p);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.deepStrictEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], p + " PNG magic");
    }
  });
  await test("静态: 路径穿越被拦截", async () => {
    const r = await fetch(BASE + "/..%2fserver.js");
    assert.ok(r.status === 403 || r.status === 404, "got " + r.status);
  });
  await test("P8: /doc 静态文档路由（首页文档入口：白名单 .md + 防穿越）", async () => {
    const r1 = await fetch(BASE + "/doc/" + encodeURIComponent("01-项目设计文档.md"));
    assert.strictEqual(r1.status, 200, "现有文档 200");
    assert.ok((r1.headers.get("content-type") || "").includes("text/markdown"), "content-type text/markdown");
    assert.ok((await r1.text()).includes("EchoAnswer"), "内容为项目文档");
    const r2 = await fetch(BASE + "/doc/" + encodeURIComponent("不存在.md"));
    assert.strictEqual(r2.status, 404, "不存在的文档 404");
    const r3 = await fetch(BASE + "/doc/..%2f..%2fAGENTS.md");
    assert.strictEqual(r3.status, 404, "目录穿越 404, got " + r3.status);
    const r4 = await fetch(BASE + "/doc/README.md");
    assert.strictEqual(r4.status, 404, "doc/ 之外文件 404, got " + r4.status);
  });

  // ---------- 会话建立 ----------
  let defId, sDifyId, sGenericId, sOpenaiId, sRag2Id, sThrowId, sRag2TokenOld, sOpenaiTokenOld;
  await test("sessions: 默认会话从 config.push 迁移", async () => {
    const r = await api("GET", "/api/sessions");
    assert.strictEqual(r.data.sessions.length, 1);
    const s = r.data.sessions[0];
    defId = s.id;
    assert.strictEqual(s.name, "默认会话");
    assert.strictEqual(s.token, "test-token");
    assert.strictEqual(s.protocol, "ragflow");
    assert.strictEqual(s.continue_session, true);
  });
  await test("sessions: 创建 4 个会话（201 + id/token 形态）", async () => {
    const mk = async (name, protocol) => {
      const r = await api("POST", "/api/sessions", { name, protocol });
      assert.strictEqual(r.status, 201);
      assert.ok(/^[a-f0-9]{8}$/.test(r.data.session.id), r.data.session.id);
      assert.ok(r.data.session.token.startsWith("kaasr_"), r.data.session.token);
      assert.strictEqual(r.data.session.protocol, protocol);
      assert.strictEqual(r.data.session.qa_count, 0);
      return r.data.session;
    };
    const s1 = await mk("dify 会话", "dify");
    const s2 = await mk("generic 会话", "generic");
    const s3 = await mk("openai 会话", "openai");
    const s4 = await mk("ragflow2 会话", "ragflow");
    sDifyId = s1.id; sGenericId = s2.id; sOpenaiId = s3.id; sRag2Id = s4.id;
    sRag2TokenOld = s4.token;
    sOpenaiTokenOld = s3.token;
    const list = await api("GET", "/api/sessions");
    assert.strictEqual(list.data.sessions.length, 5);
    const h = await api("GET", "/api/health");
    assert.strictEqual(h.data.sessions, 5);
  });
  await test("sessions: GET /api/sessions/:id 含 session + running", async () => {
    const r = await api("GET", "/api/sessions/" + sDifyId);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.session.id, sDifyId);
    assert.ok(Array.isArray(r.data.session.history));
    assert.deepStrictEqual(r.data.running, []);
  });
  await test("sessions: 未知会话 → 404", async () => {
    assert.strictEqual((await api("GET", "/api/sessions/ffffffff")).status, 404);
    assert.strictEqual((await api("PUT", "/api/sessions/ffffffff", { name: "x" })).status, 404);
    assert.strictEqual((await api("DELETE", "/api/sessions/ffffffff")).status, 404);
    assert.strictEqual((await api("POST", "/api/sessions/ffffffff/reset")).status, 404);
  });
  await test("sessions: 智能体归属 id 语义（工作区侧栏过滤契约，P7.7）", async () => {
    // 侧栏按 sessions.agent_id 过滤；会话归属键是 agent.id（播种/新建均为随机 id，≠ code）。
    // 该契约一旦破坏（如改存 code），前端「该智能体下还没有会话」恒空 + 进页面自动补建。
    const ag = await api("GET", "/api/agents/industry-brain");
    assert.strictEqual(ag.status, 200);
    assert.ok(ag.data.agent && ag.data.agent.id, "agent.id 有返回");
    assert.strictEqual(ag.data.agent.code, "industry-brain");
    const r = await api("POST", "/api/sessions", { name: "归属测试", agent_code: "industry-brain" });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.session.agent_id, ag.data.agent.id, "sessions.agent_id = agent.id（非 code）");
    const ag2 = await api("GET", "/api/agents/industry-brain");
    assert.ok(ag2.data.sessions.some((x) => x.id === r.data.session.id), "智能体上下文含新会话");
    assert.ok((await api("GET", "/api/sessions")).data.sessions.some((x) => x.id === r.data.session.id), "主列表含新会话");
    assert.strictEqual((await api("DELETE", "/api/sessions/" + r.data.session.id)).status, 200, "清理");
  });

  // ---------- push（token 定位 + session_id 校验） ----------
  await test("push: 未知 token → 401", async () => {
    const r = await api("POST", "/api/push", { token: "wrong", text: "hi" });
    assert.strictEqual(r.status, 401);
  });
  await test("push: token + 不匹配的 session_id → 400", async () => {
    const r = await api("POST", "/api/push", { token: "test-token", session_id: sDifyId, text: "hi" });
    assert.strictEqual(r.status, 400);
    assert.ok(r.data.detail.includes("session_id"), r.data.detail);
  });
  await test("push: text 为空 → 400", async () => {
    const r = await api("POST", "/api/push", { token: "test-token", text: "   " });
    assert.strictEqual(r.status, 400);
  });
  await test("push: 仅 token（兼容）→ 202 + ragflow 全链路", async () => {
    const r = await api("POST", "/api/push", { token: "test-token", text: "你好" });
    assert.strictEqual(r.status, 202);
    assert.ok(r.data.qa_id);
    assert.strictEqual(r.data.session_id, defId);
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(rec.source, "push");
    assert.strictEqual(rec.protocol, "ragflow");
    assert.strictEqual(rec.session_id, defId);
    assert.strictEqual(rec.answer, "你好，我是助手。" + REF_FOOTER);
    // 答案 = 「你好，我是助手。」+ REF_FOOTER → 中文 12 字（不含标点/字母/数字）
    assert.strictEqual(rec.detail, "完成（12 字）");
  });
  await test("push: 二次推送续接会话（不再建会话）", async () => {
    const before = MOCKS.ragflow.sessionsCalls;
    const r = await api("POST", "/api/push", { token: "test-token", session_id: defId, text: "追问一下" });
    assert.strictEqual(r.status, 202);
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(MOCKS.ragflow.sessionsCalls, before);
    assert.strictEqual(MOCKS.ragflow.last.body.session_id, "sess-1");
  });
  await test("push: 新会话 token+session_id 组合", async () => {
    const r = await api("POST", "/api/push", { token: sRag2TokenOld, session_id: sRag2Id, text: "ragflow2 问题" });
    assert.strictEqual(r.status, 202);
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(rec.session_id, sRag2Id);
    assert.strictEqual(rec.answer, "你好，我是助手。" + REF_FOOTER);
  });
  await test("push: ?sync=true 阻塞返回全文", async () => {
    const resp = await fetch(BASE + "/api/push?sync=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "test-token", session_id: defId, text: "同步问题" })
    });
    assert.strictEqual(resp.status, 200);
    const data = await resp.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.answer, "你好，我是助手。" + REF_FOOTER);
    assert.strictEqual(data.session_id, defId);
  });

  // ---------- chat（session_id 必填） ----------
  await test("chat: 缺 session_id → 400", async () => {
    const r = await api("POST", "/api/chat", { question: "hi" });
    assert.strictEqual(r.status, 400);
  });
  await test("chat: 未知 session_id → 400", async () => {
    const r = await api("POST", "/api/chat", { session_id: "ffffffff", question: "hi" });
    assert.strictEqual(r.status, 400);
  });
  await test("chat: question 为空 → 400", async () => {
    const r = await api("POST", "/api/chat", { session_id: sDifyId, question: "   " });
    assert.strictEqual(r.status, 400);
  });
  await test("chat: dify 首问（无 conversation_id）", async () => {
    const r = await api("POST", "/api/chat", { session_id: sDifyId, question: "你好" });
    assert.strictEqual(r.status, 202);
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(rec.session_id, sDifyId);
    assert.strictEqual(rec.answer, "你好，我是助手。");
    assert.strictEqual(MOCKS.dify.last.body.conversation_id, undefined);
    assert.strictEqual(MOCKS.dify.last.body.user, "tester");
  });
  await test("chat: dify 次问自动续接 conversation_id", async () => {
    const r = await api("POST", "/api/chat", { session_id: sDifyId, question: "追问" });
    await waitDone(r.data.qa_id);
    assert.strictEqual(MOCKS.dify.last.body.conversation_id, "conv-123");
  });
  await test("chat: dify 401（错误 key，经 PUT 配置切换）", async () => {
    await api("PUT", "/api/config", { protocols: { dify: { api_key: "wrong-key" } } });
    const c = await api("POST", "/api/chat", { session_id: sDifyId, question: "hi" });
    const rec = await waitDone(c.data.qa_id);
    assert.strictEqual(rec.ok, false);
    assert.ok(rec.detail.includes("401"), rec.detail);
    await api("PUT", "/api/config", { protocols: { dify: { api_key: "dify-key" } } });
  });
  await test("chat: generic 默认 SSE JSON", async () => {
    const r = await api("POST", "/api/chat", { session_id: sGenericId, question: "普通问题" });
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(rec.session_id, sGenericId);
    assert.strictEqual(rec.answer, "片段一、片段二。");
    assert.strictEqual(MOCKS.generic.last.body.input, "普通问题");
    assert.strictEqual(MOCKS.generic.last.body.token, "kaasr_x");
  });
  await test("chat: generic 单 JSON 文档 / 纯文本", async () => {
    let r = await api("POST", "/api/chat", { session_id: sGenericId, question: "json 问题" });
    let rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.answer, "整段回答");
    r = await api("POST", "/api/chat", { session_id: sGenericId, question: "text 问题" });
    rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.answer, "纯文本回答");
  });
  await test("chat: openai 正常（model 空则不发送）", async () => {
    const r = await api("POST", "/api/chat", { session_id: sOpenaiId, question: "你好" });
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(rec.session_id, sOpenaiId);
    assert.strictEqual(rec.answer, "你好，我是助手。");
    assert.strictEqual(MOCKS.openai.last.body.model, undefined);
  });
  await test("chat: P8.81 v8 清全局 chat_id 后提问行为不变（身份迁智能体层：industry-brain 回填 C9）", async () => {
    const cfg = await api("GET", "/api/config");
    assert.strictEqual(cfg.data.protocols.ragflow.chat_id, "", "全局 ragflow.chat_id 空（v8 清）");
    const r = await api("POST", "/api/chat", { session_id: defId, question: "hi" });
    assert.strictEqual(r.status, 202, r.data && r.data.detail);
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, true, rec.detail);
    assert.strictEqual(MOCKS.ragflow.last.body.chat_id, "C9", "身份来自智能体层（industry-brain 回填值）");
  });
  await test("chat: generic 非法模板 → 400 前置拦截", async () => {
    await api("PUT", "/api/config", { protocols: { generic: { body: "{bad json" } } });
    const r = await api("POST", "/api/chat", { session_id: sGenericId, question: "hi" });
    assert.strictEqual(r.status, 400);
    assert.ok(r.data.detail.includes("请求体不是合法 JSON"));
    await api("PUT", "/api/config", { protocols: { generic: { body: JSON.stringify({ token: "kaasr_x", input: "{question}" }) } } });
  });

  // ---------- cancel / 在途可见 ----------
  await test("cancel: 停止生成保留部分答案 + 会话详情含在途", async () => {
    const r = await api("POST", "/api/push", { token: "test-token", session_id: defId, text: "slow 慢速问题" });
    assert.strictEqual(r.status, 202);
    await sleep(400);
    const detail = await api("GET", "/api/sessions/" + defId);
    assert.ok(detail.data.running.some((x) => x.id === r.data.qa_id), "在途问答应出现在会话详情 running 中");
    const c = await api("POST", "/api/cancel", { id: r.data.qa_id });
    assert.strictEqual(c.status, 200);
    const rec = await waitDone(r.data.qa_id);
    assert.strictEqual(rec.ok, false);
    assert.strictEqual(rec.detail, "已取消");
    assert.ok(rec.answer.includes("第一段。"), rec.answer);
  });
  await test("cancel: 不存在的 id → 404", async () => {
    const c = await api("POST", "/api/cancel", { id: "nope" });
    assert.strictEqual(c.status, 404);
  });
  await test("history: 删除单条记录（广播 record_removed）", async () => {
    const c = await collectSse();
    await sleep(150);
    const det = await api("GET", "/api/sessions/" + defId);
    assert.ok(det.data.session.history.length >= 2);
    const rec = det.data.session.history[det.data.session.history.length - 1];
    const r = await api("DELETE", "/api/sessions/" + defId + "/history/" + rec.id);
    assert.strictEqual(r.status, 200);
    const det2 = await api("GET", "/api/sessions/" + defId);
    assert.ok(!det2.data.session.history.some((h) => h.id === rec.id));
    await c.wait("record_removed", (d) => d.id === rec.id && d.session_id === defId);
    assert.strictEqual((await api("DELETE", "/api/sessions/" + defId + "/history/nope")).status, 404);
    c.close();
  });

  // ---------- SSE 广播（多浏览器同会话） ----------
  await test("events: 连接即收 sessions 列表", async () => {
    const c = await collectSse();
    const hit = await c.wait("sessions");
    assert.ok(Array.isArray(hit.data.sessions));
    assert.ok(hit.data.sessions.length >= 5);
    c.close();
  });
  await test("events: 双客户端同收 qa_start/delta/done（含 session_id）", async () => {
    const a = await collectSse();
    const b = await collectSse();
    await sleep(200);
    const r = await api("POST", "/api/push", { token: "test-token", session_id: defId, text: "广播问题" });
    const qaId = r.data.qa_id;
    const startA = await a.wait("qa_start", (d) => d.id === qaId);
    assert.strictEqual(startA.data.session_id, defId);
    assert.ok(b.events.some((e) => e.ev === "qa_start" && e.data.id === qaId));
    await a.wait("delta", (d) => d.id === qaId);
    const doneA = await a.wait("done", (d) => d.id === qaId);
    const doneB = await b.wait("done", (d) => d.id === qaId);
    assert.ok(b.events.some((e) => e.ev === "delta" && e.data.id === qaId));
    assert.strictEqual(doneA.data.ok, true);
    assert.strictEqual(doneB.data.ok, true);
    assert.strictEqual(doneA.data.session_id, defId);
    a.close();
    b.close();
  });
  await test("events: 问答期间广播 sessions 活跃计数", async () => {
    const c = await collectSse();
    await sleep(150);
    const r = await api("POST", "/api/push", { token: "test-token", session_id: defId, text: "活跃计数问题" });
    await c.wait("done", (d) => d.id === r.data.qa_id);
    const sawActive = c.events.some((e) => e.ev === "sessions" &&
      (e.data.sessions || []).some((s) => s.id === defId && s.active >= 1));
    assert.ok(sawActive, "应有 sessions 事件显示该会话 active>=1");
    c.close();
  });

  // ---------- config ----------
  await test("config PUT 深合并 + 落盘 + 广播", async () => {
    const c = await collectSse();
    await sleep(200);
    const r = await api("PUT", "/api/config", { protocols: { dify: { user: "tester2" } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.config.protocols.dify.user, "tester2");
    assert.strictEqual(r.data.config.protocols.dify.api_key, "dify-key");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.strictEqual(cfg.protocols.dify.user, "tester2");
    await c.wait("config", (d) => d.config.protocols.dify.user === "tester2");
    await api("PUT", "/api/config", { protocols: { dify: { user: "tester" } } });
    c.close();
  });

  // ---------- ASR 语音输入（浏览器录 WAV → 服务端转发识别） ----------
  const ASR_BASE = "http://127.0.0.1:" + PORTS.asr;
  function makeWav(seconds, sampleRate) {
    const n = Math.floor(seconds * sampleRate);
    const data = new Int16Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 12000);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
    Buffer.from(data.buffer).copy(buf, 44);
    return buf;
  }
  const wav02 = makeWav(0.2, 16000);
  async function asrPost(wav) {
    const resp = await fetch(BASE + "/api/asr", {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav
    });
    const d = await resp.json().catch(() => ({}));
    return { status: resp.status, data: d };
  }
  await test("asr: /api/asr 全链路（WAV → mock transcriptions → text）", async () => {
    const put = await api("PUT", "/api/config", { asr: { url: ASR_BASE + "/v1", api_key: "", model: "mock-asr", language: "", timeout: 10 } });
    assert.strictEqual(put.status, 200);
    const r = await asrPost(wav02);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.text, "语音识别测试成功");
    assert.ok(typeof r.data.duration_s === "number" && r.data.duration_s >= 0);
    assert.strictEqual(MOCKS.asr.last.path, "/v1/audio/transcriptions");
    assert.strictEqual(MOCKS.asr.last.ok, true, "multipart 含 file/model 字段");
  });
  await test("asr: 未配置 400 / 非 WAV 400", async () => {
    assert.strictEqual((await api("PUT", "/api/config", { asr: { url: "" } })).status, 200);
    const r1 = await asrPost(wav02);
    assert.strictEqual(r1.status, 400);
    assert.ok(String(r1.data.detail).includes("未配置"));
    assert.strictEqual((await api("PUT", "/api/config", { asr: { url: ASR_BASE + "/v1" } })).status, 200);
    const r2 = await asrPost(Buffer.from("not a wav at all"));
    assert.strictEqual(r2.status, 400);
    assert.ok(String(r2.data.detail).includes("WAV"));
  });
  await test("asr: 404 回退 chat 路径 / 上游 500 → 502", async () => {
    MOCKS.asr.noTranscr = true;
    const r1 = await asrPost(wav02);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.data.ok, true);
    assert.strictEqual(r1.data.text, "语音识别测试成功");
    assert.strictEqual(MOCKS.asr.last.path, "/v1/chat/completions");
    assert.strictEqual(MOCKS.asr.last.ok, true, "base64 audio_url 请求形态");
    MOCKS.asr.noTranscr = false;
    MOCKS.asr.err500 = true;
    const r2 = await asrPost(wav02);
    MOCKS.asr.err500 = false;
    assert.strictEqual(r2.status, 502);
    assert.ok(String(r2.data.detail).includes("语音识别失败"));
  });
  await test("asr: 请求体 >10MB → 413", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024);
    big.write("RIFF", 0); big.write("WAVE", 8);
    const r = await asrPost(big);
    assert.strictEqual(r.status, 413);
  });
  await test("asr: transcribe 传入已中止信号 → 快速拒绝（不发上游请求）", async () => {
    const { AsrError, transcribe } = require("../lib/asr.js");
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    let threw = null;
    try {
      await transcribe(wav02, { url: ASR_BASE + "/v1", api_key: "", model: "mock-asr", language: "", timeout: 60 }, ac.signal);
    } catch (e) { threw = e; }
    assert.ok(threw instanceof AsrError, "应抛 AsrError");
    assert.ok(/中止/.test(threw.message), "错误信息应标明已中止");
    assert.ok(Date.now() - t0 < 500, "应快速拒绝（实测 " + (Date.now() - t0) + "ms）");
  });
  await test("asr: 客户端断开 → 服务端立即中止上游 ASR 请求", async () => {
    assert.strictEqual((await api("PUT", "/api/config", { asr: { url: ASR_BASE + "/v1", api_key: "", model: "mock-asr", language: "", timeout: 60 } })).status, 200);
    MOCKS.asr.delay_ms = 800;
    MOCKS.asr.aborts = 0;
    const ac = new AbortController();
    const p = fetch(BASE + "/api/asr", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav02, signal: ac.signal })
      .then((r) => r.json()).catch(() => null);
    await sleep(250);
    ac.abort();
    await p;
    await sleep(1500);
    assert.ok(MOCKS.asr.aborts >= 1, "mock 侧应观察到上游连接被中止（实测 " + MOCKS.asr.aborts + "）");
    MOCKS.asr.delay_ms = 0;
    const h = await api("GET", "/api/health");
    assert.strictEqual(h.status, 200, "中止后服务应继续正常");
  });
  await test("asr: SSE config 事件 asr.api_key 脱敏", async () => {
    const c = await collectSse();
    await sleep(200);
    assert.strictEqual((await api("PUT", "/api/config", { asr: { api_key: "asr-secret-123" } })).status, 200);
    const hit = await c.wait("config", (d) => d.config && d.config.asr && d.config.asr.api_key);
    assert.strictEqual(hit.data.config.asr.api_key, "…已设置");
    assert.ok(!JSON.stringify(hit.data).includes("asr-secret-123"), "明文密钥不得出现在广播");
    assert.strictEqual((await api("PUT", "/api/config", { asr: { api_key: "" } })).status, 200);
    c.close();
  });


  // ---------- 电脑输出音频流（EchoScribe 持续推流：chunked POST + Deflate 帧） ----------
  // 帧协议：[u32BE len][Deflate(PCM16LE 16kHz 单声道)]；正常帧 = 200ms = 6400B
  // 本节自建专用会话（不依赖前面会话状态），末尾删除恢复基线
  const zlib = require("zlib");
  const http = require("http");
  function makePcm(seconds) {
    const rate = 16000;
    const n = Math.floor(seconds * rate);
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000), i * 2);
    }
    return pcm;
  }
  function frameOf(pcm) {
    const payload = zlib.deflateSync(pcm);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    return Buffer.concat([head, payload]);
  }
  const FRAME = frameOf(makePcm(0.2)); // 200ms 正弦帧
  // 长连接 chunked 推流器（无 Content-Length → 自动 chunked）
  function openStream(token, device) {
    const state = { resp: null, closed: false, respBody: null, stopped: false };
    const req = http.request({
      host: "127.0.0.1", port: TEST_PORT, path: "/api/audio/stream", method: "POST",
      headers: {
        "X-Audio-Token": token,
        "X-Device-Name": encodeURIComponent(device),
        "Content-Type": "application/octet-stream"
      }
    });
    req.on("response", (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try { state.respBody = JSON.parse(b); } catch { state.respBody = b; }
        state.resp = res.statusCode;
      });
    });
    req.on("close", () => { state.closed = true; });
    req.on("error", () => {}); // 服务端 destroy 时客户端表现为 error/close
    state.writeFrame = (f) => new Promise((resolve) => {
      if (state.stopped) return resolve(false);
      const ok = req.write(f);
      if (ok) resolve(true);
      else req.once("drain", () => resolve(true));
    });
    state.stop = () => { state.stopped = true; try { req.end(); } catch {} };
    state.destroy = () => { state.stopped = true; try { req.destroy(); } catch {} };
    return state;
  }
  // 响应语义：请求头到达即建流（SSE started）；200 在 body 结束（客户端 stop）后返回，
  // 携带 {stream:"stopped", bytes, frames} 统计（nginx 截断约束，见 server.js handleAudioStream 注释）
  async function startPumping(token, device) {
    const st = openStream(token, device);
    await st.writeFrame(FRAME); // 首次 write 发出请求头 → 服务端建流
    await sleep(80);
    return st;
  }
  async function stopAndAwait(st, ms = 5000) {
    st.stop();
    const t0 = Date.now();
    while (st.resp === null && Date.now() - t0 < ms) await sleep(25);
    return st;
  }
  async function pumpStream(st, seconds) {
    const t0 = Date.now();
    while (!st.stopped && Date.now() - t0 < seconds * 1000) {
      await st.writeFrame(FRAME);
      await sleep(25); // 8× 于实时（200ms 帧 / 25ms），协议行为与实时一致
    }
  }
  const aBaseCount = (await api("GET", "/api/sessions")).data.sessions.length;
  const ac0 = await api("POST", "/api/sessions", { name: "音频测试会话", protocol: "ragflow" });
  assert.strictEqual(ac0.status, 201);
  const aSid = ac0.data.session.id;
  const aTok = ac0.data.session.token;
  await test("audio-stream: 鉴权 401（缺 token / token 未知）", async () => {
    const r1 = await fetch(BASE + "/api/audio/stream", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: FRAME });
    assert.strictEqual(r1.status, 401, "缺 X-Audio-Token");
    const r2 = await fetch(BASE + "/api/audio/stream", { method: "POST", headers: { "X-Audio-Token": "kaasr_nope", "Content-Type": "application/octet-stream" }, body: FRAME });
    assert.strictEqual(r2.status, 401, "token 未知");
  });
  await test("audio-stream: 会话未启用 → 403（响应阶段拒绝，不消费体）", async () => {
    const r = await fetch(BASE + "/api/audio/stream", {
      method: "POST",
      headers: { "X-Audio-Token": aTok, "X-Device-Name": encodeURIComponent("设备X"), "Content-Type": "application/octet-stream" },
      body: FRAME
    });
    assert.strictEqual(r.status, 403);
    const txt = await r.text();
    assert.ok(txt.includes("未启用"), "detail 提示未启用: " + txt.slice(0, 80));
  });
  await test("audio-stream: 启用 → 200 建流 + 帧入环形 + GET 列设备（含中文设备名）", async () => {
    const s = ac0.data.session;
    const en = await api("PUT", "/api/sessions/" + aSid, {
      name: s.name, protocol: s.protocol, continue_session: false,
      protocol_config: {}, audio_remote: { enabled: true, preferred_device: "测试设备A" }
    });
    assert.strictEqual(en.status, 200);
    assert.strictEqual(en.data.session.audio_remote.enabled, true);
    assert.strictEqual(en.data.session.audio_remote.preferred_device, "测试设备A");
    const st = await startPumping(aTok, "测试设备A");
    await pumpStream(st, 1.2);
    const g = await fetch(BASE + "/api/audio/stream?token=" + encodeURIComponent(aTok));
    const gd = await g.json();
    assert.strictEqual(g.status, 200);
    assert.strictEqual(gd.ok, true);
    assert.strictEqual(gd.enabled, true);
    assert.strictEqual(gd.streams.length, 1);
    assert.strictEqual(gd.streams[0].device, "测试设备A", "URL 编码设备名已还原");
    assert.ok(gd.streams[0].bytes >= 6400, "帧已入环形（bytes=" + gd.streams[0].bytes + "）");
    assert.ok(gd.streams[0].ms_since_last_frame < 500, "最近帧新鲜");
    await stopAndAwait(st);
    assert.strictEqual(st.resp, 200, "流结束回 200（实测 " + st.resp + "）");
    assert.strictEqual(st.respBody.stream, "stopped");
    assert.strictEqual(st.respBody.device, "测试设备A");
    assert.ok(st.respBody.bytes >= 6400, "200 携带统计 bytes（=" + st.respBody.bytes + "）");
    assert.ok(st.respBody.frames >= 1, "200 携带统计 frames（=" + st.respBody.frames + "）");
    await sleep(300);
    const g2 = await (await fetch(BASE + "/api/audio/stream?token=" + encodeURIComponent(aTok))).json();
    assert.strictEqual(g2.streams.length, 0, "客户端停止后流已关闭");
  });
  await test("audio-stream: SSE started / data / stopped（均带 session_id）", async () => {
    const c = await collectSse();
    await sleep(200);
    const st = await startPumping(aTok, "设备B");
    const evStart = await c.wait("audio_stream", (d) => d.state === "started" && d.device === "设备B");
    assert.strictEqual(evStart.data.session_id, aSid, "SSE 事件带 session_id");
    await pumpStream(st, 2.2);
    const evData = await c.wait("audio_stream", (d) => d.state === "data" && d.device === "设备B" && d.bytes > 0);
    assert.ok(evData.data.bytes >= 6400);
    await stopAndAwait(st);
    assert.strictEqual(st.resp, 200);
    const evStop = await c.wait("audio_stream", (d) => d.state === "stopped" && d.device === "设备B");
    assert.strictEqual(evStop.data.session_id, aSid);
    c.close();
  });
  await test("audio-capture: 推流中截取 → ASR → 自动提问（source=remote_audio）", async () => {
    assert.strictEqual((await api("PUT", "/api/config", { asr: { url: ASR_BASE + "/v1", model: "mock-asr", timeout: 15 } })).status, 200);
    const st = await startPumping(aTok, "捕获设备");
    await pumpStream(st, 1.5);
    const c = await collectSse();
    await sleep(200);
    const r = await api("POST", "/api/audio/capture", { token: aTok, device: "捕获设备", seconds: 5 });
    assert.strictEqual(r.status, 200, "capture 应成功: " + JSON.stringify(r.data));
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.text, "语音识别测试成功", "mock ASR 文本");
    assert.strictEqual(r.data.session_id, aSid);
    assert.strictEqual(r.data.device, "捕获设备");
    assert.ok(typeof r.data.duration_s === "number");
    const ev = await c.wait("qa_start", (d) => d.id === r.data.qa_id);
    assert.strictEqual(ev.data.source, "remote_audio");
    assert.strictEqual(ev.data.question, "语音识别测试成功");
    await stopAndAwait(st);
    assert.strictEqual(st.resp, 200);
    c.close();
    await sleep(300);
  });
  await test("audio-capture: 无流 409 / 设备已停 409 / seconds 越界 400 / 错 token 401", async () => {
    const r1 = await api("POST", "/api/audio/capture", { token: aTok, seconds: 5 });
    assert.strictEqual(r1.status, 409, "preferred 设备未在接收 → 409: " + JSON.stringify(r1.data));
    const st = await startPumping(aTok, "旧设备");
    await pumpStream(st, 0.5);
    await stopAndAwait(st);
    assert.strictEqual(st.resp, 200);
    await sleep(300);
    const r2 = await api("POST", "/api/audio/capture", { token: aTok, device: "旧设备", seconds: 5 });
    assert.strictEqual(r2.status, 409, "设备流已关闭 → 409");
    const r3 = await api("POST", "/api/audio/capture", { token: aTok, seconds: 1 });
    assert.strictEqual(r3.status, 400, "seconds < min");
    const r4 = await api("POST", "/api/audio/capture", { token: aTok, seconds: 999 });
    assert.strictEqual(r4.status, 400, "seconds > max");
    const r5 = await api("POST", "/api/audio/capture", { token: "kaasr_nope", seconds: 5 });
    assert.strictEqual(r5.status, 401);
  });
  await test("audio-listen: 开始 → SSE partial → 停止定稿（mock ASR）+ 重复 409/未知 401/设备未接收 409", async () => {
    const st = await startPumping(aTok, "监听设备");
    await pumpStream(st, 1.2);
    const c = await collectSse();
    await sleep(200);
    const e1 = await api("POST", "/api/audio/listen", { token: "kaasr_nope" });
    assert.strictEqual(e1.status, 401, "未知 token → 401");
    const e2 = await api("POST", "/api/audio/listen", { token: aTok, device: "无此设备" });
    assert.strictEqual(e2.status, 409, "设备未在接收 → 409");
    const s1 = await api("POST", "/api/audio/listen", { token: aTok, device: "监听设备" });
    assert.strictEqual(s1.status, 200, "listen 开始: " + JSON.stringify(s1.data));
    assert.strictEqual(s1.data.state, "listening");
    const s2 = await api("POST", "/api/audio/listen", { token: aTok, device: "监听设备" });
    assert.strictEqual(s2.status, 409, "同设备重复监听 → 409");
    // 建任务后立即来一段（0.5s 音频即可出中间识别）；SSE partial 带 session_id
    const evP = await c.wait("audio_listen", (d) => d.state === "partial" && d.device === "监听设备");
    assert.strictEqual(evP.data.session_id, aSid, "SSE 事件带 session_id");
    assert.strictEqual(evP.data.text, "语音识别测试成功", "mock ASR 中间识别文本");
    // 停止 → 定稿（全段最后一次识别）
    const s3 = await api("POST", "/api/audio/listen/stop", { token: aTok, device: "监听设备" });
    assert.strictEqual(s3.status, 200, "stop: " + JSON.stringify(s3.data));
    assert.strictEqual(s3.data.state, "stopped");
    assert.strictEqual(s3.data.text, "语音识别测试成功", "定稿文本");
    assert.ok(s3.data.elapsed_s >= 0.5, "elapsed_s 合理（=" + s3.data.elapsed_s + "）");
    const s4 = await api("POST", "/api/audio/listen/stop", { token: aTok, device: "监听设备" });
    assert.strictEqual(s4.status, 409, "无进行中任务 → 409");
    c.close();
    await stopAndAwait(st);
    await sleep(300);
  });
  await test("audio-listen: 取消丢弃 + 推流断开自动停（SSE stream_stopped）", async () => {
    const st = await startPumping(aTok, "取消设备");
    await pumpStream(st, 1.2);
    const c = await collectSse();
    await sleep(200);
    const s1 = await api("POST", "/api/audio/listen", { token: aTok, device: "取消设备" });
    assert.strictEqual(s1.status, 200);
    const s2 = await api("POST", "/api/audio/listen/cancel", { token: aTok, device: "取消设备" });
    assert.strictEqual(s2.status, 200);
    assert.strictEqual(s2.data.state, "cancelled");
    assert.strictEqual(s2.data.text, "", "取消不返回文本");
    // 再开始 → 客户端停推流 → 任务自动以 stream_stopped 结束
    const s3 = await api("POST", "/api/audio/listen", { token: aTok, device: "取消设备" });
    assert.strictEqual(s3.status, 200);
    await stopAndAwait(st);
    const evS = await c.wait("audio_listen", (d) => d.state === "stream_stopped" && d.device === "取消设备");
    assert.strictEqual(evS.data.session_id, aSid);
    c.close();
    await sleep(300);
  });
  await test("audio-stream: 同会话双设备 + 指定设备 capture 隔离 + preferred 失效 409", async () => {
    const st1 = await startPumping(aTok, "Dev-1");
    const st2 = await startPumping(aTok, "Dev-2");
    await pumpStream(st1, 1);
    await pumpStream(st2, 1);
    const g = await (await fetch(BASE + "/api/audio/stream?token=" + encodeURIComponent(aTok))).json();
    assert.strictEqual(g.streams.length, 2, "两个设备流并存");
    assert.deepStrictEqual(g.streams.map((x) => x.device).sort(), ["Dev-1", "Dev-2"]);
    const c1 = await api("POST", "/api/audio/capture", { token: aTok, device: "Dev-1", seconds: 5 });
    assert.strictEqual(c1.status, 200);
    assert.strictEqual(c1.data.device, "Dev-1");
    assert.strictEqual(c1.data.text, "语音识别测试成功");
    // preferred_device（测试设备A）不在推流 → 不指定 device 应 409（多设备无法回退）
    const c2 = await api("POST", "/api/audio/capture", { token: aTok, seconds: 5 });
    assert.strictEqual(c2.status, 409, "preferred 失效且多设备 → 409");
    await stopAndAwait(st1);
    await stopAndAwait(st2);
    assert.strictEqual(st1.resp, 200);
    assert.strictEqual(st2.resp, 200);
    await sleep(300);
  });
  await test("audio-stream: 协议违例（坏帧）→ 仅断该流，其他流不受影响", async () => {
    const good = await startPumping(aTok, "Good-Dev");
    const bad = await startPumping(aTok, "Bad-Dev");
    await good.writeFrame(FRAME);
    await bad.writeFrame(FRAME);
    // 坏帧：len 正确但 payload 不是合法 Deflate
    const badPayload = Buffer.from("this is not deflate data, definitely broken");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(badPayload.length, 0);
    await bad.writeFrame(Buffer.concat([head, badPayload]));
    const t0 = Date.now();
    while (!bad.closed && Date.now() - t0 < 5000) await sleep(50);
    assert.ok(bad.closed, "坏流应被服务端断开");
    while (bad.resp === null && Date.now() - t0 < 5000) await sleep(50);
    assert.strictEqual(bad.resp, 400, "协议违例应回 400（实测 " + bad.resp + "）");
    assert.ok(String(bad.respBody.detail || "").includes("帧格式错误"), "400 detail: " + JSON.stringify(bad.respBody));
    await good.writeFrame(FRAME);
    const g = await (await fetch(BASE + "/api/audio/stream?token=" + encodeURIComponent(aTok))).json();
    assert.deepStrictEqual(g.streams.map((x) => x.device), ["Good-Dev"], "好流仍在，坏流已移除");
    await stopAndAwait(good);
    assert.strictEqual(good.resp, 200);
    await sleep(300);
  });
  await test("audio-stream: 客户端崩溃断开（socket 断）→ 流自动清理", async () => {
    const st = await startPumping(aTok, "Crash-Dev");
    await pumpStream(st, 0.5);
    st.destroy(); // 模拟客户端进程崩溃（非正常 end）——无响应，仅自动清理
    const t0 = Date.now();
    let gone = false;
    while (Date.now() - t0 < 5000) {
      const g = await (await fetch(BASE + "/api/audio/stream?token=" + encodeURIComponent(aTok))).json();
      if (!g.streams.some((x) => x.device === "Crash-Dev")) { gone = true; break; }
      await sleep(150);
    }
    assert.ok(gone, "断连后流应被清理（req end / socket close 触发）");
  });
  await test("audio-stream: 删除会话 → 流清理 + token 失效 + 会话数恢复", async () => {
    const st = await startPumping(aTok, "待删设备");
    await pumpStream(st, 0.5);
    st.destroy();
    const del = await api("DELETE", "/api/sessions/" + aSid);
    assert.strictEqual(del.status, 200);
    const g = await fetch(BASE + "/api/audio/stream?token=" + encodeURIComponent(aTok));
    assert.strictEqual(g.status, 401, "会话删除后 token 失效");
    const list = await api("GET", "/api/sessions");
    assert.strictEqual(list.data.sessions.length, aBaseCount, "会话数恢复基线（不干扰后续用例）");
  });
  await test("config: audio_stream 非法值 → 400（min>max / max_capture>buffer / 非数字）", async () => {
    const r1 = await api("PUT", "/api/config", { audio_stream: { min_capture_s: 60, max_capture_s: 5 } });
    assert.strictEqual(r1.status, 400, "min > max 应 400");
    const r2 = await api("PUT", "/api/config", { audio_stream: { max_buffer_s: 10, max_capture_s: 60 } });
    assert.strictEqual(r2.status, 400, "max_capture > max_buffer 应 400");
    const r3 = await api("PUT", "/api/config", { audio_stream: { max_buffer_s: "abc" } });
    assert.strictEqual(r3.status, 400, "非数字应 400");
    assert.strictEqual((await api("PUT", "/api/config", { audio_stream: { max_buffer_s: 60 } })).status, 200);
    assert.strictEqual((await api("PUT", "/api/config", { audio_stream: { max_buffer_s: 120, min_capture_s: 5, default_capture_s: 30, max_capture_s: 60 } })).status, 200);
  });
  await test("audio_stream.js 单测：帧解析器 / WAV 头 / 环形淘汰", async () => {
    const am = require(path.join(ROOT, "lib/audio_stream.js"));
    const mgr = new am.AudioStreamManager({
      getConfig: () => ({ audio_stream: { max_buffer_s: 1, min_capture_s: 1, default_capture_s: 1, max_capture_s: 1 } }),
      broadcast: null
    });
    let got = 0;
    const parser = am.createFrameParser((pcm) => { got += pcm.length; });
    const twoFrames = Buffer.concat([FRAME, FRAME]);
    parser.push(twoFrames.subarray(0, FRAME.length + 3));
    parser.push(twoFrames.subarray(FRAME.length + 3));
    assert.strictEqual(got, 2 * 6400, "两帧各 6400B PCM");
    const p2 = am.createFrameParser(() => {});
    let threw = null;
    const badHead = Buffer.concat([Buffer.from([0, 0, 0x10, 0]), Buffer.from("x".repeat(65536))]);
    try { p2.push(badHead); } catch (e2) { threw = e2; }
    assert.ok(threw && threw.protocol, "超长 len 应抛协议违例");
    const p3 = am.createFrameParser(() => {});
    const h3 = Buffer.alloc(4);
    const junk = Buffer.from("junk-junk-junk");
    h3.writeUInt32BE(junk.length, 0);
    let threw3 = null;
    try { p3.push(Buffer.concat([h3, junk])); } catch (e2) { threw3 = e2; }
    assert.ok(threw3 && threw3.protocol, "坏 Deflate 应抛协议违例");
    const wav = am.buildWav(Buffer.alloc(6400, 1));
    assert.strictEqual(wav.length, 44 + 6400);
    assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
    assert.strictEqual(wav.toString("ascii", 8, 12), "WAVE");
    assert.strictEqual(wav.readUInt16LE(22), 1, "单声道");
    assert.strictEqual(wav.readUInt32LE(24), 16000, "16kHz");
    assert.strictEqual(wav.readUInt16LE(34), 16, "16bit");
    assert.strictEqual(wav.readUInt32LE(40), 6400, "data 长度");
    const r = mgr.startStream("s1", "d1");
    for (let i = 0; i < 10; i++) mgr.feed("s1", "d1", Buffer.alloc(6400, 1));
    assert.ok(r.st.ringBytes <= 32000 + 6400, "环形按字节上限淘汰（" + r.st.ringBytes + "）");
    assert.ok(r.st.ringBytes >= 32000, "仍保留最近数据");
    const pcm = mgr.capturePcm("s1", "d1", 1);
    assert.ok(pcm && pcm.length <= 32000 && pcm.length >= 25600, "capture 最近 1s（" + (pcm ? pcm.length : 0) + "）");
    assert.ok(mgr.isLive("s1", "d1", 5000), "最近帧新鲜");
    assert.strictEqual(mgr.stopStream("s1", "d1"), true);
    assert.strictEqual(mgr.stopStream("s1", "d1"), false, "幂等");
    assert.ok(!mgr.hasStream("s1", "d1"));
    mgr.close();
  });
  await test("config PUT 非法值 → 400", async () => {
    const r = await api("PUT", "/api/config", { port: "abc" });
    assert.strictEqual(r.status, 400);
  });

  // ---------- 错误路径 ----------
  await test("块间空闲超时（stall 问题）", async () => {
    const r = await api("POST", "/api/chat", { session_id: sOpenaiId, question: "stall 问题" });
    const rec = await waitDone(r.data.qa_id, 10000);
    assert.strictEqual(rec.ok, false);
    assert.ok(rec.detail.includes("块间读取超时"), rec.detail);
  });
  await test("连接超时（黑洞端口）", async () => {
    const bh = blackhole(18705);
    await bh.start();
    try {
      await api("PUT", "/api/config", { protocols: { openai: { url: "http://127.0.0.1:18705/v1/chat/completions" } } });
      const r = await api("POST", "/api/chat", { session_id: sOpenaiId, question: "hi" });
      const rec = await waitDone(r.data.qa_id, 10000);
      assert.ok(rec.detail.includes("连接超时"), rec.detail);
    } finally {
      await api("PUT", "/api/config", { protocols: { openai: { url: "http://127.0.0.1:" + PORTS.openai + "/v1/chat/completions" } } });
      await bh.stop();
    }
  });
  await test("连接拒绝（关闭端口）", async () => {
    await api("PUT", "/api/config", { protocols: { openai: { url: "http://127.0.0.1:1/v1/chat/completions" } } });
    const r = await api("POST", "/api/chat", { session_id: sOpenaiId, question: "hi" });
    const rec = await waitDone(r.data.qa_id, 10000);
    assert.strictEqual(rec.ok, false);
    assert.ok(rec.detail.startsWith("请求失败:"), rec.detail);
    await api("PUT", "/api/config", { protocols: { openai: { url: "http://127.0.0.1:" + PORTS.openai + "/v1/chat/completions" } } });
  });

  // ---------- history（跨会话合并） ----------
  await test("history: 跨会话合并、新→旧、均带 session_id", async () => {
    const r = await api("GET", "/api/history");
    const items = r.data.items;
    assert.ok(items.length >= 10);
    for (let i = 1; i < items.length; i++) {
      assert.ok(new Date(items[i - 1].started_at) >= new Date(items[i].started_at));
    }
    assert.ok(items.every((h) => h.status === "done" && typeof h.answer === "string"));
    assert.ok(items.every((h) => typeof h.session_id === "string"));
    const sids = new Set(items.map((h) => h.session_id));
    assert.ok(sids.size >= 3, "历史应来自多个会话: " + sids.size);
  });
  await test("history: 生成时长 duration_s（含 DB 加载的历史）", async () => {
    const r = await api("GET", "/api/history");
    const items = r.data.items;
    assert.ok(items.every((h) => typeof h.duration_s === "number" && h.duration_s >= 0), "完成记录均应含 duration_s");
    const sFull = await api("GET", "/api/sessions/" + defId);
    const hist = sFull.data.session.history || [];
    assert.ok(hist.length >= 1, "默认会话应有历史");
    assert.ok(hist.every((h) => typeof h.duration_s === "number" && h.duration_s >= 0), "DB 加载的历史含 duration_s");
  });
  await test("sessions: 列表按最新对话时间倒序", async () => {
    const c = await api("POST", "/api/sessions", { name: "排序测试" });
    const sX = c.data.session.id;
    await new Promise((r) => setTimeout(r, 20));
    const r = await api("POST", "/api/chat", { session_id: sX, question: "排序" });
    await waitDone(r.data.qa_id, 10000);
    const list = await api("GET", "/api/sessions");
    const ids = list.data.sessions.map((s) => s.id);
    assert.strictEqual(ids[0], sX, "刚对话的会话应排第一: " + ids.join(","));
    const arr = list.data.sessions;
    assert.ok(arr.length && arr.every((s) => typeof s.access_mode === "string"), "P8.47: 列表项含 access_mode 桶标记");
    for (let i = 1; i < arr.length; i++) {
      assert.ok(new Date(arr[i - 1].updated_at) >= new Date(arr[i].updated_at), "updated_at 应降序");
    }
    await api("DELETE", "/api/sessions/" + sX);
  });

  // ---------- 会话生命周期 ----------
  await test("sessions: PUT 改名", async () => {
    const r = await api("PUT", "/api/sessions/" + sGenericId, { name: "改名后的通用" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.session.name, "改名后的通用");
    const list = await api("GET", "/api/sessions");
    assert.ok(list.data.sessions.some((s) => s.id === sGenericId && s.name === "改名后的通用"));
  });
  await test("sessions: PUT 重新生成 token（旧 token 失效）", async () => {
    const r = await api("PUT", "/api/sessions/" + sRag2Id, { regenerate_token: true });
    assert.strictEqual(r.status, 200);
    const newTok = r.data.session.token;
    assert.notStrictEqual(newTok, sRag2TokenOld);
    const bad = await api("POST", "/api/push", { token: sRag2TokenOld, text: "hi" });
    assert.strictEqual(bad.status, 401);
    const ok = await api("POST", "/api/push", { token: newTok, session_id: sRag2Id, text: "重生成 token 后" });
    assert.strictEqual(ok.status, 202);
    await waitDone(ok.data.qa_id);
  });
  await test("sessions: 单会话重置（dify conversation 清空）", async () => {
    const r = await api("POST", "/api/sessions/" + sDifyId + "/reset");
    assert.strictEqual(r.status, 200);
    const c = await api("POST", "/api/chat", { session_id: sDifyId, question: "重置后问题" });
    await waitDone(c.data.qa_id);
    assert.strictEqual(MOCKS.dify.last.body.conversation_id, undefined);
  });
  await test("sessions: /api/session/reset 全量兼容", async () => {
    const r = await api("POST", "/api/session/reset");
    assert.strictEqual(r.status, 200);
  });
  await test("sessions: ragflow 重置（清会话ID + 取消在途 + 重置后再建会话）", async () => {
    const c1 = await api("POST", "/api/chat", { session_id: sRag2Id, question: "重置前问题" });
    await waitDone(c1.data.qa_id);
    const d1 = await api("GET", "/api/sessions/" + sRag2Id);
    assert.ok(d1.data.session.ragflow_session_id, "提问后保存了 ragflow_session_id");
    // 发起长流问题（slow → sseForever 保持流打开），待 session_id 回写
    const c2 = await api("POST", "/api/chat", { session_id: sRag2Id, question: "slow 在途问题" });
    await sleep(300);
    const inFlight = await api("GET", "/api/sessions/" + sRag2Id);
    assert.ok(inFlight.data.running.some((x) => x.id === c2.data.qa_id), "问题在途");
    const before = MOCKS.ragflow.sessionsCalls;
    const r = await api("POST", "/api/sessions/" + sRag2Id + "/reset");
    assert.strictEqual(r.status, 200);
    const rec = await waitDone(c2.data.qa_id); // 重置应取消在途问答，流随之关闭
    assert.strictEqual(rec.status, "done");
    const d2 = await api("GET", "/api/sessions/" + sRag2Id);
    assert.strictEqual(d2.data.session.ragflow_session_id, "", "重置后会话ID清空（在途流未回写旧ID）");
    assert.strictEqual(d2.data.running.length, 0, "在途问答已终止");
    // 重置后再提问：重建后端会话并保存新会话ID
    const c3 = await api("POST", "/api/chat", { session_id: sRag2Id, question: "重置后问题" });
    await waitDone(c3.data.qa_id);
    assert.ok(MOCKS.ragflow.sessionsCalls > before, "重置后提问重建后端会话");
    const d3 = await api("GET", "/api/sessions/" + sRag2Id);
    assert.strictEqual(d3.data.session.ragflow_session_id, "sess-1", "新会话ID已保存");
  });
  await test("sessions: 删除会话（在途取消 + 记录清空 + token 失效）", async () => {
    const r = await api("DELETE", "/api/sessions/" + sOpenaiId);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await api("GET", "/api/sessions/" + sOpenaiId)).status, 404);
    const bad = await api("POST", "/api/push", { token: sOpenaiTokenOld, text: "hi" });
    assert.strictEqual(bad.status, 401);
  });
  await test("sessions: 删除最后一个 → 自动补建默认会话", async () => {
    for (const id of [sRag2Id, sDifyId, sGenericId, defId]) {
      const r = await api("DELETE", "/api/sessions/" + id);
      assert.strictEqual(r.status, 200, "删除 " + id);
    }
    let list = await api("GET", "/api/sessions");
    assert.strictEqual(list.data.sessions.length, 1);
    sThrowId = list.data.sessions[0].id;
    const r2 = await api("DELETE", "/api/sessions/" + sThrowId);
    assert.strictEqual(r2.status, 200);
    list = await api("GET", "/api/sessions");
    assert.strictEqual(list.data.sessions.length, 1);
    assert.strictEqual(list.data.sessions[0].name, "默认会话");
    assert.ok(list.data.sessions[0].token.startsWith("kaasr_"));
  });

  // ---------- 安全：管理密码 + 访问码 ----------
  const adminFetch = async (method, p, body, tok) => {
    const headers = { "Content-Type": "application/json" };
    if (tok) headers["X-Admin-Token"] = tok;
    const resp = await fetch(BASE + p, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await resp.json(); } catch {}
    return { status: resp.status, data };
  };
  let adminTok = "";
  await test("security: /api/status 公开 + /admin 页面", async () => {
    const r = await api("GET", "/api/status");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.allow_anonymous, true);
    assert.strictEqual(r.data.admin_set, false);
    const adm = await fetch(BASE + "/admin");
    assert.strictEqual(adm.status, 200);
    assert.ok((adm.headers.get("content-type") || "").includes("text/html"));
  });
  await test("security: 首次登录初始化密码；错密码 401", async () => {
    const r = await api("POST", "/api/admin/login", { password: "testpw123" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.initialized, true);
    adminTok = r.data.token;
    const again = await api("POST", "/api/admin/login", { password: "testpw123" });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.data.initialized, false);
    assert.strictEqual((await api("POST", "/api/admin/login", { password: "nope9999" })).status, 401);
    assert.strictEqual((await api("POST", "/api/admin/login", { password: "ab" })).status, 401);
  });
  await test("p8.49: 全量测试期间抬高自动封禁阈值（config 实时生效；防 127.0.0.1 累计失败自封）", async () => {
    const r = await adminFetch("PUT", "/api/config", { security: { auto_ban: { enabled: true, login_fails: 100000, qa_per_min: 100000, ban_minutes: 1 } } }, adminTok);
    assert.strictEqual(r.status, 200, "config 更新: " + (r.data && r.data.detail));
    const g = await adminFetch("GET", "/api/config", undefined, adminTok);
    assert.strictEqual(g.data.security.auto_ban.login_fails, 100000, "阈值实时生效");
  });
  await test("security: 管理接口需 token（config / 会话 CRUD / 全局重置）", async () => {
    assert.strictEqual((await api("GET", "/api/config")).status, 401);
    assert.strictEqual((await api("POST", "/api/sessions", { name: "x" })).status, 401);
    assert.strictEqual((await api("POST", "/api/session/reset")).status, 401);
    assert.strictEqual((await adminFetch("GET", "/api/config", undefined, adminTok)).status, 200);
    const c = await adminFetch("POST", "/api/sessions", { name: "安全测试" }, adminTok);
    assert.strictEqual(c.status, 201);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + c.data.session.id, undefined, adminTok)).status, 200);
  });
  await test("security: 修改管理密码（旧密码失效、新密码可用）", async () => {
    const put = await adminFetch("PUT", "/api/config", { security: { admin_password: "newpw456" } }, adminTok);
    assert.strictEqual(put.status, 200);
    assert.strictEqual((await api("POST", "/api/admin/login", { password: "testpw123" })).status, 401, "旧密码应失效");
    const lg = await api("POST", "/api/admin/login", { password: "newpw456" });
    assert.strictEqual(lg.status, 200);
    adminTok = lg.data.token;
    assert.strictEqual((await adminFetch("GET", "/api/config", undefined, adminTok)).status, 200);
  });
  let accessTok = "";
  await test("security: 匿名恒放行（P8.44 移除匿名开关）；访问码登录 → 放行", async () => {
    assert.strictEqual((await adminFetch("PUT", "/api/config", { security: { allow_anonymous: false } }, adminTok)).status, 200, "allow_anonymous 字段保留兼容，可保存");
    assert.strictEqual((await api("GET", "/api/sessions")).status, 200, "P8.44：allow_anonymous=false 不再拦截匿名");
    assert.strictEqual((await api("GET", "/api/history")).status, 200, "P8.44：匿名 history 放行");
    assert.strictEqual((await api("POST", "/api/access/login", { code: "999999" })).status, 401);
    const gen = await adminFetch("POST", "/api/admin/access-codes", { code: "123456", hours: 1 }, adminTok);
    assert.strictEqual(gen.status, 201);
    assert.strictEqual(gen.data.entry.code, "123456");
    assert.deepStrictEqual(gen.data.entry.agent_scope, [], "P8.51 新码默认权限范围 = 无（最小权限）");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/access-codes/123456", { agent_scope: [] }, adminTok)).status, 200, "P8.51 显式放行全部（本段后续断言用）");
    const lg = await api("POST", "/api/access/login", { code: "123456" });
    assert.strictEqual(lg.status, 200);
    accessTok = lg.data.token;
    assert.strictEqual((await api("GET", "/api/sessions?access=" + accessTok)).status, 200);
    const admAll = (await adminFetch("GET", "/api/sessions", undefined, adminTok)).data.sessions;
    const tgt = admAll[0];
    assert.ok(tgt && typeof tgt.token === "string", "管理视图应含 token");
    const chat = await api("POST", "/api/chat?access=" + accessTok, { session_id: tgt.id, question: "sec" });
    assert.notStrictEqual(chat.status, 403, "持访问 token 不应被 403: " + chat.status);
    // 会话详情（聊天记录）持访问 token 应可取（前端按 GET+访问 token 加载）
    assert.strictEqual((await api("GET", "/api/sessions/" + tgt.id + "?access=" + accessTok)).status, 200, "会话详情?access 应 200");
    assert.strictEqual((await api("GET", "/api/events?access=bogus_token")).status, 403, "SSE 事件流显式携带的无效 token 仍 403（前端探针确认凭证失效，P8.44 语义保留）");
    // 管理 token 走 ?access= 通道（/admin 页 SSE/XHR 无法带 X-Admin-Token 头）
    assert.strictEqual((await api("GET", "/api/sessions?access=" + adminTok)).status, 200, "管理 token 经 ?access= 应放行会话列表");
    {
      const sr = await fetch(BASE + "/api/events?access=" + adminTok);
      assert.strictEqual(sr.status, 200, "管理 token 经 ?access= 应放行 SSE");
      try { await sr.body.cancel(); } catch {}
    }
    // push 只凭会话推送 token（无需访问码）
    const pushOk = await api("POST", "/api/push", { token: tgt.token, text: "推送鉴权测试" });
    assert.strictEqual(pushOk.status, 202, "有效 token 的 push 在访问码模式下应通过: " + pushOk.status);
    assert.strictEqual((await api("POST", "/api/push", { token: "kaasr_bogus", text: "x" })).status, 401, "未知 token 应 401");
  });
  await test("security: 随机码 + 一键失效（已发 token 同步吊销）", async () => {
    const gen = await adminFetch("POST", "/api/admin/access-codes", {}, adminTok);
    assert.strictEqual(gen.status, 201);
    assert.ok(/^\d{6}$/.test(gen.data.entry.code));
    assert.strictEqual((await adminFetch("DELETE", "/api/admin/access-codes/123456", undefined, adminTok)).status, 200);
    assert.strictEqual((await api("POST", "/api/access/login", { code: "123456" })).status, 401);
    assert.strictEqual((await api("GET", "/api/sessions?access=" + accessTok)).status, 403, "失效后旧 token 应 403");
  });
  let batchCodes = [];
  await test("security: 批量生成多个访问码（各自独立时长）", async () => {
    const gen = await adminFetch("POST", "/api/admin/access-codes", { hours: 2, count: 3 }, adminTok);
    assert.strictEqual(gen.status, 201);
    assert.strictEqual(gen.data.entries.length, 3);
    batchCodes = gen.data.entries.map((x) => x.code);
    assert.ok(new Set(batchCodes).size === 3, "批量码应互不相同: " + batchCodes.join(","));
    assert.ok(batchCodes.every((c) => /^\d{6}$/.test(c)));
    // 每个码各自登录通过
    for (const c of batchCodes) {
      assert.strictEqual((await api("POST", "/api/access/login", { code: c })).status, 200, "码 " + c + " 应可登录");
    }
  });
  await test("security: 单个访问码延期（renew）", async () => {
    const before = (await adminFetch("GET", "/api/config", undefined, adminTok)).data.security.access_codes.find((c) => c.code === batchCodes[0]);
    const r = await adminFetch("POST", "/api/admin/access-codes/" + batchCodes[0] + "/renew", { hours: 12 }, adminTok);
    assert.strictEqual(r.status, 200);
    const after = r.data.entry;
    assert.ok(Date.parse(after.expires_at) > Date.parse(before.expires_at) + 11 * 3600e3, "延期后到期时间应明显后移");
    assert.strictEqual((await adminFetch("POST", "/api/admin/access-codes/000000/renew", { hours: 1 }, adminTok)).status, 404, "不存在的码 404");
  });
  await test("security: 清理全部过期码（expired）", async () => {
    const put = await adminFetch("PUT", "/api/config", {
      security: { access_codes: (await adminFetch("GET", "/api/config", undefined, adminTok)).data.security.access_codes.concat([
        { code: "111111", expires_at: "2020-01-01T00:00:00.000Z", created_at: "2020-01-01T00:00:00.000Z" },
        { code: "222222", expires_at: "2020-02-02T00:00:00.000Z", created_at: "2020-02-02T00:00:00.000Z" }
      ]) }
    }, adminTok);
    assert.strictEqual(put.status, 200);
    const r = await adminFetch("DELETE", "/api/admin/access-codes/expired", undefined, adminTok);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.removed, 2);
    const cfg = (await adminFetch("GET", "/api/config", undefined, adminTok)).data.security.access_codes;
    assert.ok(!cfg.some((c) => c.code === "111111" || c.code === "222222"), "过期码应被清理");
    assert.ok(cfg.some((c) => c.code === batchCodes[0]), "未过期码保留");
    // 收尾：清掉本测试段生成的码
    for (const c of batchCodes) await adminFetch("DELETE", "/api/admin/access-codes/" + c, undefined, adminTok);
  });
  await test("security: 过期码 401；清空码（allow_anonymous 字段保留兼容）", async () => {
    const put = await adminFetch("PUT", "/api/config", {
      security: { access_codes: [{ code: "777777", expires_at: "2020-01-01T00:00:00.000Z", created_at: "2020-01-01T00:00:00.000Z" }] }
    }, adminTok);
    assert.strictEqual(put.status, 200);
    assert.strictEqual((await api("POST", "/api/access/login", { code: "777777" })).status, 401);
    const back = await adminFetch("PUT", "/api/config", { security: { allow_anonymous: true, access_codes: [] } }, adminTok);
    assert.strictEqual(back.status, 200);
    assert.strictEqual((await api("GET", "/api/sessions")).status, 200);
  });
  await test("security: 非管理视图剥离 token；管理视图可见", async () => {
    const anon = await api("GET", "/api/sessions");
    assert.ok(anon.data.sessions.every((s) => s.token === undefined), "匿名视图不应含 token");
    const adm = await adminFetch("GET", "/api/sessions", undefined, adminTok);
    assert.ok(adm.data.sessions.every((s) => typeof s.token === "string" && s.token.startsWith("kaasr_")));
    const id = anon.data.sessions[0].id;
    const f1 = await api("GET", "/api/sessions/" + id);
    assert.strictEqual(f1.data.session.token, undefined);
    const f2 = await adminFetch("GET", "/api/sessions/" + id, undefined, adminTok);
    assert.ok(String(f2.data.session.token).startsWith("kaasr_"));
  });

  await test("sessions: 会话级协议配置 保存/剥离/清除/非法 400", async () => {
    const c = await adminFetch("POST", "/api/sessions", { name: "协议配置测试", protocol: "openai" }, adminTok);
    assert.strictEqual(c.status, 201);
    const sid = c.data.session.id;
    const p1 = await adminFetch("PUT", "/api/sessions/" + sid, {
      protocol_config: { openai: { url: "http://127.0.0.1:1/c2", api_key: "   ", model: "sess-model", unknown: 9 } }
    }, adminTok);
    assert.strictEqual(p1.status, 200);
    const d1 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d1.status, 200);
    assert.strictEqual(d1.data.session.protocol_config.openai.url, "http://127.0.0.1:1/c2");
    assert.strictEqual(d1.data.session.protocol_config.openai.model, "sess-model");
    assert.ok(!("api_key" in d1.data.session.protocol_config.openai), "空值不存储（回退全局）");
    assert.ok(!("unknown" in d1.data.session.protocol_config.openai), "未知字段被清洗");
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: [1] }, adminTok)).status, 400, "数组 -> 400");
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: "x" }, adminTok)).status, 400, "字符串 -> 400");
    // P8.10：管理员私有桶会话对 anon 不可见（数据边界）；非管理视图剥离语义由
    // 「非管理视图剥离 token」用例的共享会话断言覆盖
    const anon = await api("GET", "/api/sessions/" + sid);
    assert.strictEqual(anon.status, 404, "P8.10 anon 不可见管理员私有会话");
    const p2 = await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: { openai: {} } }, adminTok);
    assert.strictEqual(p2.status, 200);
    assert.deepStrictEqual(p2.data.session.protocol_config.openai, {}, "空对象 = 清除该协议覆盖");
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
  });

  await test("sessions: P8.81 三层优先级（会话覆盖 > 智能体层 > 全局；生效值进 mock 可观测）", async () => {
    // 全局 ragflow 临时改 chat_id=C8（industry-brain 智能体层有回填值 C9）
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { chat_id: "C8" } } }, adminTok)).status, 200);
    // 会话 A（industry-brain 下、无会话覆盖）：生效 = 智能体层 C9（智能体层 > 全局）
    const cA = await adminFetch("POST", "/api/sessions", { name: "layer-a", agent_code: "industry-brain", protocol: "ragflow" }, adminTok);
    assert.strictEqual(cA.status, 201, cA.data && cA.data.detail);
    const rA = await adminFetch("POST", "/api/chat", { session_id: cA.data.session.id, question: "layer a" }, adminTok);
    assert.strictEqual(rA.status, 202, rA.data && rA.data.detail);
    const recA = await waitDoneWith(rA.data.qa_id, { "X-Admin-Token": adminTok });
    assert.strictEqual(recA.ok, true, recA.detail);
    assert.strictEqual(MOCKS.ragflow.last.body.chat_id, "C9", "无覆盖会话 = 智能体层值（优先于全局 C8）");
    // 会话 B（会话覆盖 S-RT）：会话层 > 智能体层
    const cB = await adminFetch("POST", "/api/sessions", { name: "layer-b", agent_code: "industry-brain", protocol: "ragflow" }, adminTok);
    assert.strictEqual(cB.status, 201, cB.data && cB.data.detail);
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + cB.data.session.id, {
      protocol_config: { ragflow: { chat_id: "S-RT" } }
    }, adminTok)).status, 200);
    const rB = await adminFetch("POST", "/api/chat", { session_id: cB.data.session.id, question: "layer b" }, adminTok);
    assert.strictEqual(rB.status, 202, rB.data && rB.data.detail);
    const recB = await waitDoneWith(rB.data.qa_id, { "X-Admin-Token": adminTok });
    assert.strictEqual(recB.ok, true, recB.detail);
    assert.strictEqual(MOCKS.ragflow.last.body.chat_id, "S-RT", "会话覆盖优先于智能体层");
    // 恢复全局（v8 后全局 chat_id 本就空）+ 清理会话
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { chat_id: "" } } }, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + cA.data.session.id, undefined, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + cB.data.session.id, undefined, adminTok)).status, 200);
  });


  await test("sessions: 协议配置测试连接 protocol-test（预检/合并/mock 全链路/脱敏）", async () => {
    const pt = require("../lib/protocol_test");
    // 单测：前置校验（不发请求）
    assert.strictEqual((await pt.testProtocol("ragflow", { protocols: { ragflow: { url: "http://x", api_key: "", chat_id: "C" } } }, {})).detail, "未配置 API Key（知识引擎 API 密钥）");
    assert.strictEqual((await pt.testProtocol("openai", { protocols: { openai: {} } }, {})).detail, "未配置接口地址");
    assert.strictEqual((await pt.testProtocol("dify", { protocols: { dify: { url: "http://x" } } }, {})).detail, "未配置 API Key（编排引擎应用密钥）");
    assert.strictEqual((await pt.testProtocol("ragflow", { protocols: { ragflow: { url: "http://x", api_key: "k" } } }, {})).detail, "未配置知识引擎 Chat ID");
    assert.ok((await pt.testProtocol("generic", { protocols: { generic: { url: "http://x" } } }, { body: "{bad json" })).detail.includes("合法 JSON"));
    assert.ok((await pt.testProtocol("generic", { protocols: { generic: { url: "http://x" } } }, { body: "\"str\"" })).detail.includes("JSON 对象"));
    // 单测：全局 × 草稿合并（空草稿回退全局、非空优先）
    assert.deepStrictEqual(pt.mergedForTest("ragflow", { protocols: { ragflow: { url: "http://g", api_key: "gk", chat_id: "gc" } } }, { url: "", api_key: "sk" }),
      { url: "http://g", api_key: "sk", chat_id: "gc" });
    // mock 全链路：ragflow 探测（基址 /api/v1，key 校验，chat_id 命中）
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9" } } }, adminTok)).status, 200);
    const c = await adminFetch("POST", "/api/sessions", { name: "protocol-test", protocol: "ragflow" }, adminTok);
    assert.strictEqual(c.status, 201);
    const sid = c.data.session.id;
    const t1 = await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { config: {} }, adminTok);
    assert.strictEqual(t1.status, 200);
    assert.strictEqual(t1.data.ok, true, t1.data.detail);
    assert.ok(MOCKS.ragflow.chatGetCalls >= 1, "mock 收到 /chats 探测");
    assert.strictEqual(MOCKS.ragflow.lastChatGetId, "C9");
    const t2 = await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { config: { api_key: "wrong-key" } }, adminTok);
    assert.strictEqual(t2.data.ok, false);
    assert.ok(t2.data.detail.includes("401"), t2.data.detail);
    const t3 = await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { config: { api_key: "ragflow-key", chat_id: "CX" } }, adminTok);
    assert.strictEqual(t3.data.ok, true, t3.data.detail);
    assert.strictEqual(MOCKS.ragflow.lastChatGetId, "CX", "覆盖 chat_id 生效");
    const t4 = await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { config: { url: "http://127.0.0.1:1/none" } }, adminTok);
    assert.strictEqual(t4.data.ok, false);
    assert.ok(t4.data.detail.includes("无法连接"), t4.data.detail);
    // dify：缺 key 预检（先清空全局 key）/ 探测 /parameters
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { dify: { api_key: "" } } }, adminTok)).status, 200);
    const t5 = await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { protocol: "dify", config: { url: "http://127.0.0.1:" + PORTS.dify } }, adminTok);
    assert.strictEqual(t5.data.ok, false, "dify 缺 key 预检");
    assert.ok(t5.data.detail.includes("API Key"), t5.data.detail);
    const t6 = await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { protocol: "dify", config: { url: "http://127.0.0.1:" + PORTS.dify, api_key: "dify-key" } }, adminTok);
    assert.strictEqual(t6.data.ok, true, t6.data.detail);
    assert.ok(MOCKS.dify.paramCalls >= 1, "mock 收到 /parameters 探测");
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { dify: { api_key: "dify-key" } } }, adminTok)).status, 200, "恢复全局 dify key");
    // 非法输入 / 鉴权
    assert.strictEqual((await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { config: "x" }, adminTok)).status, 400, "config 非对象 -> 400");
    assert.strictEqual((await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", { protocol: "nope" }, adminTok)).status, 400, "未知协议 -> 400");
    assert.strictEqual((await adminFetch("POST", "/api/sessions/ffffffff/protocol-test", {}, adminTok)).status, 404, "会话不存在 -> 404");
    assert.strictEqual((await adminFetch("POST", "/api/sessions/" + sid + "/protocol-test", {}, "")).status, 401, "非管理 -> 401");
    // 恢复全局 ragflow（url/key/chat_id 全量还原）+ 清理会话
    //（global 探测测试见下一块）
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9" } } }, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
  });

  await test("p8.81 续: 系统设置全局连接测试 testGlobal/mode=global（ragflow 地址+Key / dify 接口可达性 / 预检 / 端点 400/401）", async () => {
    const pt = require("../lib/protocol_test");
    const g = (proto, cfg) => pt.testGlobal(proto, cfg, {});
    // 预检
    assert.strictEqual((await g("ragflow", { protocols: { ragflow: {} } })).detail, "未配置服务地址 URL");
    assert.strictEqual((await g("ragflow", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1" } } })).detail, "未配置 API Key");
    assert.strictEqual((await g("dify", { protocols: { dify: {} } })).detail, "未配置服务地址 URL");
    // ragflow：地址 + 全局 Key
    const rg1 = await g("ragflow", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key" } } });
    assert.ok(rg1.ok, "ragflow 全局地址+Key: " + rg1.detail);
    assert.ok(rg1.detail.includes("Chat ID"), "detail 提示 Chat ID 在智能体级: " + rg1.detail);
    assert.strictEqual((await g("ragflow", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "wrong-key" } } })).detail, "地址可达但 API Key 无效");
    assert.strictEqual((await g("ragflow", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/nope/v1", api_key: "ragflow-key" } } })).detail, "地址可达但接口路径不存在（请检查服务地址）");
    assert.ok(MOCKS.ragflow.chatsListCalls >= 1, "mock 收到 GET /chats 探测");
    // dify：接口可达性（全局无 Key → 401 = 服务在线）
    const dg = await g("dify", { protocols: { dify: { url: "http://127.0.0.1:" + PORTS.dify } } });
    assert.ok(dg.ok, "dify 全局可达（401 = 在线）: " + dg.detail);
    assert.ok(dg.detail.includes("智能体"), dg.detail);
    // 端点 mode=global
    const e1 = await adminFetch("POST", "/api/admin/protocol-test", { protocol: "ragflow", mode: "global", config: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key" } }, adminTok);
    assert.strictEqual(e1.status, 200);
    assert.strictEqual(e1.data.ok, true, e1.data.detail);
    const e2 = await adminFetch("POST", "/api/admin/protocol-test", { protocol: "dify", mode: "global", config: { url: "http://127.0.0.1:" + PORTS.dify } }, adminTok);
    assert.strictEqual(e2.status, 200);
    assert.strictEqual(e2.data.ok, true, e2.data.detail);
    const e3 = await adminFetch("POST", "/api/admin/protocol-test", { protocol: "nope", mode: "global" }, adminTok);
    assert.strictEqual(e3.status, 400, "未知协议 -> 400");
    assert.strictEqual((await adminFetch("POST", "/api/admin/protocol-test", { protocol: "ragflow", mode: "global" }, "")).status, 401, "非管理 -> 401");
  });

  await test("asr: /api/asr/test 测试连接（ok/模型不在列表/未配置/不可达 502/非管理 401）", async () => {
    const t1 = await adminFetch("POST", "/api/asr/test", { asr: { url: ASR_BASE + "/v1", model: "mock-asr" } }, adminTok);
    assert.strictEqual(t1.status, 200);
    assert.strictEqual(t1.data.ok, true, t1.data.detail);
    assert.ok(t1.data.models.includes("mock-asr"));
    assert.strictEqual(t1.data.health, true, "/health 探测");
    const t2 = await adminFetch("POST", "/api/asr/test", { asr: { url: ASR_BASE + "/v1", model: "nope-model" } }, adminTok);
    assert.strictEqual(t2.status, 200);
    assert.strictEqual(t2.data.ok, false);
    assert.ok(String(t2.data.detail).includes("不在服务列表"));
    const t3 = await adminFetch("POST", "/api/asr/test", { asr: { url: "" } }, adminTok);
    assert.strictEqual(t3.status, 400, "未配置 -> 400");
    const t4 = await adminFetch("POST", "/api/asr/test", { asr: { url: ASR_BASE + "/v1" } }, "");
    assert.strictEqual(t4.status, 401, "非管理 -> 401");
    const t5 = await adminFetch("POST", "/api/asr/test", { asr: { url: "http://127.0.0.1:18999/v1" } }, adminTok);
    assert.strictEqual(t5.status, 502, "服务不可达 -> 502");
  });

  await test("sessions: 会话级 chat_id 变更自动重置 ragflow 后端会话", async () => {
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9" } } }, adminTok)).status, 200);
    const c = await adminFetch("POST", "/api/sessions", { name: "stale-reset", protocol: "ragflow" }, adminTok);
    assert.strictEqual(c.status, 201);
    const sid = c.data.session.id;
    const r1 = await adminFetch("POST", "/api/chat", { session_id: sid, question: "q1" }, adminTok);
    assert.strictEqual(r1.status, 202);
    const rec1 = await waitDoneWith(r1.data.qa_id, { "X-Admin-Token": adminTok });
    assert.strictEqual(rec1.ok, true, rec1.detail);
    const d1 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.ok(d1.data.session.ragflow_session_id, "提问后保存了 ragflow_session_id");
    // 会话级 chat_id 变更 → 后端会话重置
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: { ragflow: { chat_id: "C8" } } }, adminTok)).status, 200);
    const d2 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d2.data.session.ragflow_session_id, "", "chat_id 变更后 ragflow_session_id 被清空");
    // 新 chat 下重新提问 → 建新会话并正常
    const r2 = await adminFetch("POST", "/api/chat", { session_id: sid, question: "q2" }, adminTok);
    const rec2 = await waitDoneWith(r2.data.qa_id, { "X-Admin-Token": adminTok });
    assert.strictEqual(rec2.ok, true, rec2.detail);
    const d3 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.ok(d3.data.session.ragflow_session_id, "新 chat 会话已保存");
    // 协议切换也重置
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol: "openai" }, adminTok)).status, 200);
    const d4 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d4.data.session.ragflow_session_id, "", "协议切换后清空");
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
  });

  await test("sessions: P8.81 全局 dify url 变更重置回退全局会话的后端会话（智能体层无 url → 回退全局）", async () => {
    // dify 会话落在 industry-brain（ragflow 智能体）下：P8.81 协议匹配门控 → 智能体层不参与
    // dify 解析，url/api_key/user 全部回退全局（dify.api_key 已由启动期恢复）
    const c = await adminFetch("POST", "/api/sessions", { name: "global-reset-dify", protocol: "dify" }, adminTok);
    assert.strictEqual(c.status, 201);
    const sid = c.data.session.id;
    const r1 = await adminFetch("POST", "/api/chat", { session_id: sid, question: "q1" }, adminTok);
    const rec1 = await waitDoneWith(r1.data.qa_id, { "X-Admin-Token": adminTok });
    assert.strictEqual(rec1.ok, true, rec1.detail);
    const d1 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.ok(d1.data.session.dify_conversation_id, "提问后保存了 dify_conversation_id");
    // 改全局 dify.url（该会话回退全局 → 生效值变化）→ 重置
    const cp = await adminFetch("PUT", "/api/config", { protocols: { dify: { url: "http://127.0.0.1:" + PORTS.dify + "/v2" } } }, adminTok);
    assert.strictEqual(cp.status, 200);
    const d2 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d2.data.session.dify_conversation_id, "", "全局 url 变更后被清空");
    assert.strictEqual(typeof cp.data.invalidated_sessions, "number", "响应带 invalidated_sessions");
    // 该会话加会话覆盖（正确 url）→ 不受全局变更影响
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: { dify: { url: "http://127.0.0.1:" + PORTS.dify + "/v1" } } }, adminTok)).status, 200);
    const r2 = await adminFetch("POST", "/api/chat", { session_id: sid, question: "q2" }, adminTok);
    const rec2 = await waitDoneWith(r2.data.qa_id, { "X-Admin-Token": adminTok });
    assert.strictEqual(rec2.ok, true, rec2.detail);
    const d3 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    const cid3 = d3.data.session.dify_conversation_id;
    assert.ok(cid3, "覆盖会话提问正常");
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { dify: { url: "http://127.0.0.1:" + PORTS.dify + "/v3" } } }, adminTok)).status, 200);
    const d4 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d4.data.session.dify_conversation_id, cid3, "有覆盖的会话不受全局变更影响");
    // 恢复全局 + 清理
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { dify: { url: "http://127.0.0.1:" + PORTS.dify + "/v1" } } }, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
  });


  // ================= P3：多用户 / 会话桶隔离 / 智能体 =================
  const makeJar = () => {
    let c = "";
    return {
      set(res) {
        const list = res.headers.getSetCookie ? res.headers.getSetCookie() : ((res.headers.get("set-cookie") || "").split(", ").filter(Boolean));
        for (const h of list) { const k = (h.split(";")[0] || "").split("=")[0]; if (k === "ea_sid") c = h.split(";")[0]; }
      },
      header() { return c ? { Cookie: c } : {}; },
      raw() { return c; }
    };
  };
  const waitDoneAs = async (jar, qaId, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 8000)) {
      const r = await jarFetch(jar, "GET", "/api/history");
      const rec = (r.data.items || []).find((h) => h.id === qaId);
      if (rec && rec.status === "done") return rec;
      await sleep(50);
    }
    throw new Error("waitDoneAs 超时: " + qaId);
  };
  const jarFetch = async (jar, method, p, body) => {
    const headers = jar.header();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const resp = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    jar.set(resp);
    let data = null;
    try { data = await resp.json(); } catch {}
    return { status: resp.status, data };
  };

  await test("p3: /api/auth 登录·me·登出（cookie）", async () => {
    const bad = await jarFetch(makeJar(), "POST", "/api/auth/login", { username: "admin", password: "wrongpw9" });
    assert.strictEqual(bad.status, 401, "错密码 401");
    const jar = makeJar();
    const ok = await jarFetch(jar, "POST", "/api/auth/login", { username: "admin", password: "newpw456" });
    assert.strictEqual(ok.status, 200, ok.data && ok.data.detail);
    assert.strictEqual(ok.data.user.role, "admin");
    assert.ok(jar.raw(), "登录应下发 ea_sid cookie");
    const me = await jarFetch(jar, "GET", "/api/auth/me");
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.data.principal.kind, "admin");
    const anonMe = await api("GET", "/api/auth/me");
    assert.strictEqual(anonMe.data.anonymous, true, "匿名环境下无凭证 = anonymous");
    const out = await jarFetch(jar, "POST", "/api/auth/logout");
    assert.strictEqual(out.status, 200);
    const me2 = await jarFetch(jar, "GET", "/api/auth/me");
    assert.ok(!me2.data.principal || me2.data.anonymous, "登出后 cookie 失效");
  });

  let aliceJar = null, aliceId = "";
  await test("p3: 用户创建（仅管理）+ 登录", async () => {
    assert.strictEqual((await api("POST", "/api/admin/users", { username: "x", password: "123456" })).status, 401, "非管理 401");
    assert.strictEqual((await adminFetch("POST", "/api/admin/users", { username: "a", password: "123456" }, adminTok)).status, 400, "用户名过短");
    const u1 = await adminFetch("POST", "/api/admin/users", { username: "alice", password: "alicepw1", display_name: "爱丽丝", role: "user" }, adminTok);
    assert.strictEqual(u1.status, 201, u1.data && u1.data.detail);
    assert.strictEqual(u1.data.user.role, "user");
    assert.deepStrictEqual(u1.data.user.agent_scope, [], "P8.51 新用户默认权限范围 = 无（最小权限）");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/users/" + u1.data.user.id, { agent_scope: [] }, adminTok)).status, 200, "P8.51 alice 显式放行全部（后续私有桶断言用）");
    assert.strictEqual((await adminFetch("POST", "/api/admin/users", { username: "alice", password: "alicepw1" }, adminTok)).status, 409, "重名 409");
    const users = await adminFetch("GET", "/api/admin/users", undefined, adminTok);
    assert.ok(users.data.users.some((x) => x.username === "alice"));
    assert.ok(!users.data.users.some((x) => x.password_hash), "列表不含密码哈希");
    aliceJar = makeJar();
    const lg = await jarFetch(aliceJar, "POST", "/api/auth/login", { username: "alice", password: "alicepw1" });
    assert.strictEqual(lg.status, 200, lg.data && lg.data.detail);
    assert.strictEqual(lg.data.user.role, "user");
    aliceId = lg.data.user.id;
  });

  let aliceSid = "";
  await test("p3: 用户私有桶（user_id, agent_id）+ 跨主体不可见", async () => {
    const c = await jarFetch(aliceJar, "POST", "/api/sessions", { name: "alice私有" });
    assert.strictEqual(c.status, 201, c.data && c.data.detail);
    aliceSid = c.data.session.id;
    const adm = await adminFetch("GET", "/api/sessions/" + aliceSid, undefined, adminTok);
    assert.strictEqual(adm.status, 200, "管理可见私有会话");
    assert.strictEqual(adm.data.session.access_mode, "user");
    assert.strictEqual(adm.data.session.user_id, aliceId);
    assert.ok(adm.data.session.agent_id, "私有会话带 agent_id");
    // 访问码主体：列表不含 / 读 404 / 问 404
    const gen = await adminFetch("POST", "/api/admin/access-codes", { code: "555556", hours: 1 }, adminTok);
    assert.strictEqual(gen.status, 201);
    const acl = await api("POST", "/api/access/login", { code: "555556" });
    const codeTok = acl.data.token;
    const listCode = await api("GET", "/api/sessions?access=" + codeTok);
    assert.ok(!listCode.data.sessions.some((s) => s.id === aliceSid), "码主体列表不含用户私有会话");
    // P8.47：管理列表标注私有桶属主；非管理列表不含 user_id
    const admList = await adminFetch("GET", "/api/sessions", undefined, adminTok);
    const admIt = admList.data.sessions.find((s) => s.id === aliceSid);
    assert.ok(admIt && admIt.access_mode === "user" && admIt.user_id === aliceId, "P8.47: 管理列表含 access_mode/user_id");
    assert.strictEqual(admIt.owner_name, "alice", "P8.47: 管理列表标注私有会话属主");
    assert.ok(listCode.data.sessions.every((s) => s.user_id === undefined), "P8.47: 非管理列表不含 user_id");
    assert.strictEqual((await api("GET", "/api/sessions/" + aliceSid + "?access=" + codeTok)).status, 404, "码主体读私有会话 404");
    assert.strictEqual((await api("POST", "/api/chat", { session_id: aliceSid, question: "x" })).status, 404, "匿名问私有会话 404");
    // 属主本人可问
    const my = await jarFetch(aliceJar, "POST", "/api/chat", { session_id: aliceSid, question: "私有问题" });
    assert.strictEqual(my.status, 202, my.data && my.data.detail);
    const rec = await waitDoneAs(aliceJar, my.data.qa_id); // 属主视角历史（匿名不可见私有记录）
    assert.strictEqual(rec.ok, true, rec.detail);
  });
  await test("p3: SSE principal 作用域（私有会话事件不外泄）", async () => {
    const sseA = await collectSse({ headers: aliceJar.header() });
    // 初始 sessions 载荷应含 alice 私有会话
    await sseA.wait("sessions", (d) => (d.sessions || []).some((s) => s.id === aliceSid));
    // 共享会话提问 → alice 可见（含 agent_id 补齐）
    const list0 = await api("GET", "/api/sessions");
    const sharedSid = list0.data.sessions.find((s) => s.id !== aliceSid).id;
    const rSh = await api("POST", "/api/chat", { session_id: sharedSid, question: "共享问题" });
    assert.strictEqual(rSh.status, 202);
    const hit = await sseA.wait("qa_start", (d) => d.session_id === sharedSid, 8000);
    assert.ok(hit.data.agent_id, "QA 事件补齐 agent_id");
    // alice 私有会话提问 → alice 自己的 SSE 可见
    const rMy = await jarFetch(aliceJar, "POST", "/api/chat", { session_id: aliceSid, question: "私有SSE" });
    assert.strictEqual(rMy.status, 202);
    await sseA.wait("qa_start", (d) => d.session_id === aliceSid, 8000);
    sseA.close();
    // 换一个「非属主」匿名连接：admin 问 alice 私有会话 → 匿名 SSE 不得收到
    const sseAnon = await collectSse();
    await sseAnon.wait("sessions");
    const rPriv = await adminFetch("POST", "/api/chat", { session_id: aliceSid, question: "管理问私有" }, adminTok);
    assert.strictEqual(rPriv.status, 202);
    await waitDoneAs(aliceJar, rPriv.data.qa_id); // 记录在 alice 私有桶：属主视角等待完成（匿名历史不可见）
    await sleep(700);
    sseAnon.close();
    assert.ok(!sseAnon.events.some((e) => e.ev === "qa_start" && e.data.session_id === aliceSid), "匿名 SSE 收到私有会话 QA 事件");
    assert.ok(!sseAnon.events.some((e) => e.ev === "done" && e.data.session_id === aliceSid), "匿名 SSE 收到私有会话 done 事件");
    // 但共享会话事件匿名可见（双轨兼容）
    const list1 = await api("GET", "/api/sessions");
    const sharedSid2 = list1.data.sessions.find((s) => s.id !== aliceSid).id;
    const sseAnon2 = await collectSse();
    await sseAnon2.wait("sessions");
    const rSh2 = await api("POST", "/api/chat", { session_id: sharedSid2, question: "共享问题2" });
    assert.strictEqual(rSh2.status, 202);
    await sseAnon2.wait("qa_start", (d) => d.session_id === sharedSid2, 8000);
    sseAnon2.close();
  });

  await test("p3: 访问码私有桶（access_code_id, agent_id）", async () => {
    const gen = await adminFetch("POST", "/api/admin/access-codes", { code: "666667", hours: 1 }, adminTok);
    assert.strictEqual(gen.status, 201);
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/access-codes/666667", { agent_scope: [] }, adminTok)).status, 200, "P8.51 新码默认最小权限 → 显式放行全部");
    // P8.44：遗留 /api/access/login 无匿名捷径——统一校验码、签发访问 token + cookie；
    // 码主体 cookie 亦可走新端点 /api/auth/access-code
    const legacy = await api("POST", "/api/access/login", { code: "666667" });
    assert.strictEqual(legacy.status, 200);
    assert.ok(legacy.data.token && legacy.data.anonymous === false, "码登录应签发访问 token（P8.44）");
    const codeJar = makeJar();
    const lg = await jarFetch(codeJar, "POST", "/api/auth/access-code", { code: "666667" });
    assert.strictEqual(lg.status, 200, lg.data && lg.data.detail);
    // 码主体创建会话 → 码桶
    const c = await api("POST", "/api/sessions", { name: "码桶会话" });
    assert.strictEqual(c.status, 401, "无凭证建会话 401");
    const c2 = await jarFetch(codeJar, "POST", "/api/sessions", { name: "码桶会话" });
    assert.strictEqual(c2.status, 201, c2.data && c2.data.detail);
    const codeSid = c2.data.session.id;
    const adm = await adminFetch("GET", "/api/sessions/" + codeSid, undefined, adminTok);
    assert.strictEqual(adm.data.session.access_mode, "code");
    assert.ok(adm.data.session.access_code_id, "码桶带 access_code_id");
    // 同码可见；其他主体不可见
    const listC = await jarFetch(codeJar, "GET", "/api/sessions");
    assert.ok(listC.data.sessions.some((s) => s.id === codeSid), "码主体可见码桶会话");
    assert.strictEqual(listC.data.sessions.find((s) => s.id === codeSid).access_mode, "code", "P8.47: 码桶列表项 access_mode=code");
    assert.ok(!listC.data.sessions.some((s) => s.id === aliceSid), "码主体不可见用户私有会话");
    assert.ok(!(await jarFetch(aliceJar, "GET", "/api/sessions")).data.sessions.some((s) => s.id === codeSid), "用户不可见码桶会话");
    assert.strictEqual((await jarFetch(aliceJar, "GET", "/api/sessions/" + codeSid)).status, 404, "用户读码桶会话 404");
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + codeSid, undefined, adminTok)).status, 200, "管理清理码桶会话");
  });

  await test("p3: IDOR 写保护（属主可改删己有；他人桶 401）", async () => {
    const list0 = await api("GET", "/api/sessions");
    const sharedSid = list0.data.sessions.find((s) => s.id !== aliceSid).id;
    assert.strictEqual((await jarFetch(aliceJar, "PUT", "/api/sessions/" + sharedSid, { name: "hijack" })).status, 401, "非属主改共享会话 401");
    assert.strictEqual((await jarFetch(aliceJar, "DELETE", "/api/sessions/" + sharedSid, undefined)).status, 401, "非属主删共享会话 401");
    const put = await jarFetch(aliceJar, "PUT", "/api/sessions/" + aliceSid, { name: "alice私有v2" });
    assert.strictEqual(put.status, 200, "属主改己有会话 200");
    assert.strictEqual(put.data.session.name, "alice私有v2");
    const del = await jarFetch(aliceJar, "DELETE", "/api/sessions/" + aliceSid, undefined);
    assert.strictEqual(del.status, 200, "属主删己有会话 200");
    assert.strictEqual((await adminFetch("GET", "/api/sessions/" + aliceSid, undefined, adminTok)).status, 404, "删除后 404");
  });
  await test("p3: 智能体 API（落地页列表/详情/管理 CRUD）", async () => {
    const anonOn = await api("GET", "/api/agents");
    assert.strictEqual(anonOn.status, 200);
    assert.ok(anonOn.data.agents.some((a) => a.code === "industry-brain"), "种子智能体在列");
    const brain = await api("GET", "/api/agents/industry-brain");
    assert.strictEqual(brain.status, 200);
    assert.strictEqual(brain.data.agent.code, "industry-brain");
    assert.ok(Array.isArray(brain.data.sessions), "详情带该主体可见会话");
    const pk = brain.data.protocol_config.api_key;
    assert.ok(pk === undefined || pk === "…已设置", "详情不泄露 api_key 原值: " + pk);
    assert.strictEqual((await api("GET", "/api/agents/nope-xxx")).status, 404, "未知 code 404");
    assert.strictEqual((await api("POST", "/api/admin/agents", { code: "qa", name: "x" })).status, 401, "非管理建智能体 401");
    assert.strictEqual((await adminFetch("POST", "/api/admin/agents", { code: "Bad_Code", name: "x" }, adminTok)).status, 400, "非法 code");
    const ag1 = await adminFetch("POST", "/api/admin/agents", { code: "qa-assist", name: "测试助理", protocol: "openai", description: "p3", config: { model: "m1" } }, adminTok);
    assert.strictEqual(ag1.status, 201, ag1.data && ag1.data.detail);
    assert.strictEqual(ag1.data.agent.protocol, "openai");
    assert.strictEqual((await adminFetch("POST", "/api/admin/agents", { code: "qa-assist", name: "x" }, adminTok)).status, 409, "重复 code 409");
    const list2 = await api("GET", "/api/agents");
    assert.ok(list2.data.agents.some((a) => a.code === "qa-assist"), "新智能体在列表");
    const dis = await adminFetch("PATCH", "/api/admin/agents/qa-assist", { enabled: false }, adminTok);
    assert.strictEqual(dis.status, 200);
    assert.ok(!(await api("GET", "/api/agents")).data.agents.some((a) => a.code === "qa-assist"), "停用后出列表");
    assert.strictEqual((await api("GET", "/api/agents/qa-assist")).status, 404, "停用后详情 404");
    const ren = await adminFetch("PATCH", "/api/admin/agents/qa-assist", { name: "测试助理v2", enabled: true }, adminTok);
    assert.strictEqual(ren.status, 200);
    assert.strictEqual(ren.data.agent.name, "测试助理v2");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/qa-assist", { protocol: "bogus" }, adminTok)).status, 400, "未知协议 400");
  });

  await test("p8.8: 智能体访问控制（anon/code/user 三开关 + 超集语义 + 桶隔离）", async () => {
    // v3 默认：存量智能体全放行（行为不变）
    const list0 = await adminFetch("GET", "/api/admin/agents", undefined, adminTok);
    const brain = list0.data.agents.find((a) => a.code === "industry-brain");
    assert.strictEqual(brain.allow_anon, true, "种子智能体默认允许匿名");
    assert.strictEqual(brain.allow_code, true);
    assert.strictEqual(brain.allow_user, true);
    // 新建智能体 + 仅允许访问码
    const mk = await adminFetch("POST", "/api/admin/agents", { code: "sec-a", name: "安全测试体", protocol: "ragflow", config: { chat_id: "C-SEC" } }, adminTok);
    assert.strictEqual(mk.status, 201, mk.data && mk.data.detail);
    const setc = await adminFetch("PATCH", "/api/admin/agents/sec-a", { allow_anon: false, allow_code: true, allow_user: false }, adminTok);
    assert.strictEqual(setc.status, 200, setc.data && setc.data.detail);
    assert.strictEqual(setc.data.agent.allow_anon, false);
    assert.strictEqual(setc.data.agent.allow_user, false);
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/sec-a", { allow_anon: "yes" }, adminTok)).status, 400, "非布尔 → 400");
    // P8.9：落地页展示全部启用智能体（含 allow_* 供徽标），无权主体在入口被门控
    const anonList = (await api("GET", "/api/agents")).data.agents;
    const secAView = anonList.find((a) => a.code === "sec-a");
    assert.ok(secAView, "anon 列表仍展示 sec-a（点击进入再鉴权）");
    assert.strictEqual(secAView.allow_anon, false, "列表暴露 allow_anon（落地页徽标）");
    assert.strictEqual(secAView.allow_code, true);
    assert.strictEqual((await api("GET", "/api/agents/sec-a")).status, 404, "anon 打开 sec-a 404（入口门控）");
    // user 主体被拒
    const u1 = await adminFetch("POST", "/api/admin/users", { username: "carol", password: "carolpw1" }, adminTok);
    assert.strictEqual(u1.status, 201, u1.data && u1.data.detail);
    assert.deepStrictEqual(u1.data.user.agent_scope, [], "P8.51 新用户默认权限范围 = 无（最小权限）");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/users/" + u1.data.user.id, { agent_scope: [] }, adminTok)).status, 200, "P8.51 carol 显式放行全部");
    const carolJar = makeJar();
    const lg = await jarFetch(carolJar, "POST", "/api/auth/login", { username: "carol", password: "carolpw1" });
    assert.strictEqual(lg.status, 200, lg.data && lg.data.detail);
    assert.strictEqual((await jarFetch(carolJar, "POST", "/api/sessions", { name: "c1", agent_code: "sec-a" })).status, 403, "未放行 user 建会话 403");
    // code 主体放行 → 码私有桶
    const gen = await adminFetch("POST", "/api/admin/access-codes", { code: "888888", hours: 1 }, adminTok);
    assert.strictEqual(gen.status, 201, gen.data && gen.data.detail);
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/access-codes/888888", { agent_scope: [] }, adminTok)).status, 200, "P8.51 新码默认最小权限 → 显式放行全部");
    const code2 = makeJar();
    const cl = await jarFetch(code2, "POST", "/api/auth/access-code", { code: "888888" });
    assert.strictEqual(cl.status, 200, cl.data && cl.data.detail);
    const cs = await jarFetch(code2, "POST", "/api/sessions", { name: "码会话", agent_code: "sec-a" });
    assert.strictEqual(cs.status, 201, cs.data && cs.data.detail);
    assert.strictEqual((await adminFetch("GET", "/api/sessions/" + cs.data.session.id, undefined, adminTok)).data.session.access_mode, "code", "码主体落码桶");
    assert.strictEqual((await jarFetch(code2, "GET", "/api/agents/sec-a")).status, 200, "码主体可打开 sec-a");
    // 放行 user → 用户私有桶；两桶互不可见
    const setu = await adminFetch("PATCH", "/api/admin/agents/sec-a", { allow_user: true }, adminTok);
    assert.strictEqual(setu.status, 200);
    const us = await jarFetch(carolJar, "POST", "/api/sessions", { name: "用户会话", agent_code: "sec-a" });
    assert.strictEqual(us.status, 201, us.data && us.data.detail);
    assert.strictEqual((await adminFetch("GET", "/api/sessions/" + us.data.session.id, undefined, adminTok)).data.session.access_mode, "user", "用户主体落用户桶");
    assert.ok(!(await jarFetch(code2, "GET", "/api/sessions")).data.sessions.some((s) => s.id === us.data.session.id), "码主体不可见用户私有会话");
    assert.strictEqual((await jarFetch(carolJar, "GET", "/api/sessions/" + cs.data.session.id)).status, 404, "用户读码桶会话 404");
    // 超集语义：允许匿名 → 一切访问方式放行
    const seta = await adminFetch("PATCH", "/api/admin/agents/sec-a", { allow_anon: true }, adminTok);
    assert.strictEqual(seta.status, 200);
    assert.ok((await api("GET", "/api/agents")).data.agents.some((a) => a.code === "sec-a"), "允许匿名 → anon 回列表");
    // 全关 → 仅管理员
    const setn = await adminFetch("PATCH", "/api/admin/agents/sec-a", { allow_anon: false, allow_code: false, allow_user: false }, adminTok);
    assert.strictEqual(setn.status, 200);
    assert.strictEqual((await jarFetch(code2, "GET", "/api/agents/sec-a")).status, 404, "全关 → code 404");
    assert.strictEqual((await jarFetch(carolJar, "POST", "/api/sessions", { agent_code: "sec-a" })).status, 403, "全关 → user 403");
    assert.strictEqual((await api("GET", "/api/agents/sec-a")).status, 404, "全关 → anon 404");
    assert.strictEqual((await adminFetch("GET", "/api/agents/sec-a", undefined, adminTok)).status, 200, "全关 → admin 仍可打开");
  });

  await test("p8.40/P8.51: 主体权限范围三态（新建默认最小权限「无」；全部 / 仅指定 / 无；管理员恒全量）", async () => {
    // 两个智能体：种子 industry-brain + 新建 p840-b
    const listA = (await adminFetch("GET", "/api/admin/agents", undefined, adminTok)).data.agents;
    const brain = listA.find((a) => a.code === "industry-brain");
    const mk = await adminFetch("POST", "/api/admin/agents", { code: "p840-b", name: "P8.40 权限范围体", protocol: "ragflow", config: { chat_id: "C-P840" } }, adminTok);
    assert.strictEqual(mk.status, 201, mk.data && mk.data.detail);
    const b2 = (await adminFetch("GET", "/api/admin/agents", undefined, adminTok)).data.agents.find((a) => a.code === "p840-b");
    assert.ok(brain && b2, "两个智能体齐备");
    // 访问码：P8.51 新建默认 = 最小权限（不允许任何智能体）
    const gen = await adminFetch("POST", "/api/admin/access-codes", { code: "777123", hours: 1 }, adminTok);
    assert.strictEqual(gen.status, 201, gen.data && gen.data.detail);
    assert.deepStrictEqual(gen.data.entry.agent_scope, [], "新码默认权限范围 = 无（最小权限）");
    const codeJar = makeJar();
    const cl = await jarFetch(codeJar, "POST", "/api/auth/access-code", { code: "777123" });
    assert.strictEqual(cl.status, 200, cl.data && cl.data.detail);
    assert.strictEqual((await jarFetch(codeJar, "GET", "/api/agents/" + brain.code)).status, 404, "码默认「无」→ brain 404");
    assert.strictEqual((await jarFetch(codeJar, "GET", "/api/agents/" + b2.code)).status, 404, "码默认「无」→ b 404");
    assert.strictEqual((await jarFetch(codeJar, "POST", "/api/sessions", { name: "x", agent_code: "industry-brain" })).status, 403, "码默认「无」建会话 403");
    // 非法范围 → 400
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/access-codes/777123", { agent_scope: "all" }, adminTok)).status, 400, "非数组 → 400");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/access-codes/777123", { agent_scope: ["nope"] }, adminTok)).status, 400, "未知 agent id → 400");
    // 限定为仅 brain
    const sc = await adminFetch("PATCH", "/api/admin/access-codes/777123", { agent_scope: [brain.id] }, adminTok);
    assert.strictEqual(sc.status, 200, sc.data && sc.data.detail);
    assert.strictEqual((await jarFetch(codeJar, "GET", "/api/agents/" + brain.code)).status, 200, "码范围内 → 200");
    assert.strictEqual((await jarFetch(codeJar, "GET", "/api/agents/" + b2.code)).status, 404, "码范围外 → 404");
    assert.strictEqual((await jarFetch(codeJar, "POST", "/api/sessions", { name: "x", agent_code: "p840-b" })).status, 403, "码范围外建会话 403");
    // 镜像（GET /api/config）暴露 agent_scope
    const cfg = await adminFetch("GET", "/api/config", undefined, adminTok);
    const mirror = (cfg.data.security.access_codes || []).find((c) => c.code === "777123");
    assert.ok(mirror && Array.isArray(mirror.agent_scope) && mirror.agent_scope.includes(brain.id), "镜像暴露 agent_scope");
    // 空数组 → 允许全部
    const sc2 = await adminFetch("PATCH", "/api/admin/access-codes/777123", { agent_scope: [] }, adminTok);
    assert.strictEqual(sc2.status, 200, sc2.data && sc2.data.detail);
    assert.strictEqual((await jarFetch(codeJar, "GET", "/api/agents/" + b2.code)).status, 200, "空数组 → 允许全部");
    // null → 无（最小权限，P8.51）
    const sc3 = await adminFetch("PATCH", "/api/admin/access-codes/777123", { agent_scope: null }, adminTok);
    assert.strictEqual(sc3.status, 200, "null = 无 被接受");
    assert.strictEqual((await jarFetch(codeJar, "GET", "/api/agents/" + brain.code)).status, 404, "null → 不允许任何智能体");
    // 普通用户：carol（p8.8 已显式放行全部）做限定断言
    const carol = (await adminFetch("GET", "/api/admin/users", undefined, adminTok)).data.users.find((u) => u.username === "carol");
    assert.ok(carol, "carol 存在（p8.8 建）");
    const carolJar = makeJar();
    const clg = await jarFetch(carolJar, "POST", "/api/auth/login", { username: "carol", password: "carolpw1" });
    assert.strictEqual(clg.status, 200, clg.data && clg.data.detail);
    assert.strictEqual((await jarFetch(carolJar, "GET", "/api/agents/" + b2.code)).status, 200, "carol 已放行全部（p8.8）");
    const us = await adminFetch("PATCH", "/api/admin/users/" + carol.id, { agent_scope: [b2.id] }, adminTok);
    assert.strictEqual(us.status, 200, us.data && us.data.detail);
    assert.strictEqual((await jarFetch(carolJar, "GET", "/api/agents/" + brain.code)).status, 404, "用户范围外 → 404");
    assert.strictEqual((await jarFetch(carolJar, "GET", "/api/agents/" + b2.code)).status, 200, "用户范围内 → 200");
    assert.strictEqual((await jarFetch(carolJar, "POST", "/api/sessions", { name: "x", agent_code: "industry-brain" })).status, 403, "用户范围外建会话 403");
    // P8.51：新建用户默认 = 无（最小权限）→ 404/403；放行后生效
    const dn = await adminFetch("POST", "/api/admin/users", { username: "dana", password: "danapw123" }, adminTok);
    assert.strictEqual(dn.status, 201, dn.data && dn.data.detail);
    assert.deepStrictEqual(dn.data.user.agent_scope, [], "新用户默认权限范围 = 无（最小权限）");
    const danaJar = makeJar();
    assert.strictEqual((await jarFetch(danaJar, "POST", "/api/auth/login", { username: "dana", password: "danapw123" })).status, 200, "dana 登录");
    assert.strictEqual((await jarFetch(danaJar, "GET", "/api/agents/" + brain.code)).status, 404, "新用户默认「无」→ 404");
    assert.strictEqual((await jarFetch(danaJar, "POST", "/api/sessions", { name: "x", agent_code: "industry-brain" })).status, 403, "新用户默认「无」建会话 403");
    const du = await adminFetch("PATCH", "/api/admin/users/" + dn.data.user.id, { agent_scope: [b2.id] }, adminTok);
    assert.strictEqual(du.status, 200, "dana 限定为仅 b");
    assert.strictEqual((await jarFetch(danaJar, "GET", "/api/agents/" + b2.code)).status, 200, "新用户放行后 → 200");
    assert.strictEqual((await jarFetch(danaJar, "GET", "/api/agents/" + brain.code)).status, 404, "新用户范围外 → 404");
    // 管理员恒全量（不受任何范围影响）
    assert.strictEqual((await adminFetch("GET", "/api/agents/" + brain.code, undefined, adminTok)).status, 200, "admin 恒 200（brain）");
    assert.strictEqual((await adminFetch("GET", "/api/agents/" + b2.code, undefined, adminTok)).status, 200, "admin 恒 200（b）");
    // 恢复现场：carol 全量、删除测试码、停用测试智能体
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/users/" + carol.id, { agent_scope: [] }, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/admin/access-codes/777123", undefined, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/p840-b", { enabled: false }, adminTok)).status, 200);
  });

  await test("p8.53: 会话级协议配置仅管理可改（用户属主 PUT protocol_config 被忽略；protocol-test 仅管理）", async () => {
    const du0 = (await adminFetch("GET", "/api/admin/users", undefined, adminTok)).data.users;
    const dana = du0.find((u) => u.username === "dana");
    assert.ok(dana, "dana 存在（p8.51 建，仅放行 p840-b）");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/p840-b", { enabled: true }, adminTok)).status, 200);
    const danaJar = makeJar();
    assert.strictEqual((await jarFetch(danaJar, "POST", "/api/auth/login", { username: "dana", password: "danapw123" })).status, 200);
    const cs = await jarFetch(danaJar, "POST", "/api/sessions", { name: "p853", agent_code: "p840-b" });
    assert.strictEqual(cs.status, 201, cs.data && cs.data.detail);
    const sid = cs.data.session.id;
    // 1) 用户属主 PUT：name 生效，protocol_config 被静默忽略（保持空）
    const p1 = await jarFetch(danaJar, "PUT", "/api/sessions/" + sid, {
      name: "p853-renamed",
      protocol_config: { ragflow: { url: "http://evil.test", api_key: "evilkey", chat_id: "c1" } }
    });
    assert.strictEqual(p1.status, 200, p1.data && p1.data.detail);
    assert.strictEqual(p1.data.session.name, "p853-renamed", "name 生效");
    const g1 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    const pc1 = g1.data.session.protocol_config || {};
    assert.ok(!pc1.ragflow || pc1.ragflow.url !== "http://evil.test", "非 admin protocol_config 未落库");
    // 2) 用户 protocol-test → 401（仅管理）
    assert.strictEqual((await jarFetch(danaJar, "POST", "/api/sessions/" + sid + "/protocol-test", { protocol: "ragflow", config: {} })).status, 401);
    // 3) 管理 PUT protocol_config → 生效（管理视图回读）
    const p2 = await adminFetch("PUT", "/api/sessions/" + sid, {
      protocol_config: { ragflow: { url: "http://127.0.0.1:1", api_key: "p853key", chat_id: "p853chat" } }
    }, adminTok);
    assert.strictEqual(p2.status, 200, p2.data && p2.data.detail);
    const g2 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(g2.data.session.protocol_config.ragflow.api_key, "p853key", "管理 protocol_config 生效");
    // 4) 非 admin GET：视图不含 protocol_config / token（不暴露明文密钥）
    const g3 = await jarFetch(danaJar, "GET", "/api/sessions/" + sid);
    assert.strictEqual(g3.status, 200);
    assert.strictEqual(g3.data.session.protocol_config, undefined, "非 admin 视图无 protocol_config");
    assert.strictEqual(g3.data.session.token, undefined, "非 admin 视图无 token");
    // 清理：属主删会话 + 停用测试智能体
    assert.strictEqual((await jarFetch(danaJar, "DELETE", "/api/sessions/" + sid)).status, 200);
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/p840-b", { enabled: false }, adminTok)).status, 200);
  });

  await test("p8.43: 协议启用状态（停用协议 → 智能体管理端同步标注 + 提问拒绝 + 新建/改选被拒）", async () => {
    const gMock = "http://127.0.0.1:" + PORTS.generic + "/ask";
    // generic 智能体（指向 mock generic 后端）→ 停用前提问正常
    const mk = await adminFetch("POST", "/api/admin/agents", { code: "p843-a", name: "P8.43 协议停用体", protocol: "generic", config: { url: gMock, api_key: "", body: JSON.stringify({ q: "{question}" }) } }, adminTok);
    assert.strictEqual(mk.status, 201, mk.data && mk.data.detail);
    const s1 = await adminFetch("POST", "/api/sessions", { name: "p843", agent_code: "p843-a", protocol: "generic" }, adminTok); // 会话协议 = 智能体协议（与前端 Workspace 一致）
    assert.strictEqual(s1.status, 201, s1.data && s1.data.detail);
    const t1 = s1.data.session.token;
    const ok1 = await api("POST", "/api/push?sync=true", { token: t1, text: "hello p843" });
    assert.strictEqual(ok1.status, 200, "停用前提问正常: " + (ok1.data && ok1.data.detail));
    assert.ok(ok1.data && ok1.data.ok === true, "停用前 mock 正常应答");
    // 停用 generic 协议
    const dis = await adminFetch("PUT", "/api/config", { protocols: { generic: { enabled: false } } }, adminTok);
    assert.strictEqual(dis.status, 200, dis.data && dis.data.detail);
    assert.strictEqual((await adminFetch("GET", "/api/config", undefined, adminTok)).data.protocols.generic.enabled, false, "配置回显 enabled=false");
    // P8.43 修复：保存（不携带 security.admin_password 的）协议配置不得停用 admin 用户（users 表为密码权威源）
    assert.strictEqual((await adminFetch("GET", "/api/admin/users", undefined, adminTok)).data.users.find((x) => x.username === "admin").status, "active", "保存协议配置不停用 admin 用户");
    // 管理端同步：管理列表 + 公开列表 protocol_enabled=false
    assert.strictEqual((await adminFetch("GET", "/api/admin/agents", undefined, adminTok)).data.agents.find((x) => x.code === "p843-a").protocol_enabled, false, "管理列表协议已停用标注");
    assert.strictEqual((await api("GET", "/api/agents")).data.agents.find((x) => x.code === "p843-a").protocol_enabled, false, "公开列表协议已停用标注");
    // 停用协议新建智能体 → 400
    const mk2 = await adminFetch("POST", "/api/admin/agents", { code: "p843-b", name: "B", protocol: "generic" }, adminTok);
    assert.strictEqual(mk2.status, 400, "停用协议新建智能体 → 400");
    assert.ok(String((mk2.data && mk2.data.detail) || "").includes("已停用"), "错误文案注明已停用");
    // 提问被拒
    const dis2 = await api("POST", "/api/push?sync=true", { token: t1, text: "停用后" });
    assert.strictEqual(dis2.status, 400, "停用后提问 → 400");
    assert.ok(String((dis2.data && dis2.data.detail) || "").includes("已停用"), "拒绝文案注明协议已停用");
    // 重新启用 → 全面恢复
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { generic: { enabled: true } } }, adminTok)).status, 200, "重新启用");
    assert.strictEqual((await adminFetch("GET", "/api/admin/agents", undefined, adminTok)).data.agents.find((x) => x.code === "p843-a").protocol_enabled, true, "重新启用 → 标注恢复");
    const ok2 = await api("POST", "/api/push?sync=true", { token: t1, text: "hello again" });
    assert.strictEqual(ok2.status, 200, "重新启用后提问正常");
    assert.ok(ok2.data && ok2.data.ok === true, "重新启用后 mock 正常应答");
    // 清理：删测试会话 + 停用测试智能体
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + s1.data.session.id, undefined, adminTok)).status, 200, "删除测试会话");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/p843-a", { enabled: false }, adminTok)).status, 200, "停用测试智能体");
  });

  await test("p8.81: 配置体系重构（智能体级身份字段必填 + 三层解析 + 掩码哨兵 + 智能体级测试端点）", async () => {
    // 1) 必填校验：ragflow 缺 chat_id / openai 缺 model → 400（文案指明字段）
    const r1 = await adminFetch("POST", "/api/admin/agents", { code: "p881-a", name: "P8.81 必填体", protocol: "ragflow" }, adminTok);
    assert.strictEqual(r1.status, 400, "ragflow 缺 chat_id → 400");
    assert.ok(String(r1.data.detail).includes("Chat ID"), "400 文案指明 Chat ID");
    const r2 = await adminFetch("POST", "/api/admin/agents", { code: "p881-b", name: "P8.81 必填体B", protocol: "openai" }, adminTok);
    assert.strictEqual(r2.status, 400, "openai 缺 model → 400");
    assert.ok(String(r2.data.detail).includes("模型"), "400 文案指明模型");
    // 2) 智能体层生效：仅配 chat_id（url/key 留空 = 继承全局）
    const mk = await adminFetch("POST", "/api/admin/agents", { code: "p881-x", name: "P8.81 智能体层", protocol: "ragflow", config: { chat_id: "AX" } }, adminTok);
    assert.strictEqual(mk.status, 201, mk.data && mk.data.detail);
    const lv = await adminFetch("GET", "/api/admin/agents", undefined, adminTok);
    const xrow = lv.data.agents.find((x) => x.code === "p881-x");
    assert.strictEqual(xrow.config_status.chat_id, "custom", "config_status = custom");
    assert.strictEqual(xrow.config_complete, true, "config_complete = true");
    // 3) 新建会话不带协议 → 继承智能体协议
    const sx = await adminFetch("POST", "/api/sessions", { name: "p881-x", agent_code: "p881-x" }, adminTok);
    assert.strictEqual(sx.status, 201, sx.data && sx.data.detail);
    assert.strictEqual(sx.data.session.protocol, "ragflow", "会话协议 = 智能体协议");
    // 4) 提问 → mock 收到 /chats/AX/...（智能体层 chat_id 覆盖全局空值；url/key 继承全局）
    const ask1 = await api("POST", "/api/push?sync=true", { token: sx.data.session.token, text: "p881 智能体层" });
    assert.strictEqual(ask1.status, 200, ask1.data && ask1.data.detail);
    assert.ok(ask1.data.ok === true, "智能体层提问成功: " + (ask1.data && ask1.data.detail));
    assert.strictEqual(MOCKS.ragflow.last.body.chat_id, "AX", "智能体层 chat_id 生效（新路径 body.chat_id）: " + JSON.stringify(MOCKS.ragflow.last.body));
    assert.strictEqual(MOCKS.ragflow.last.headers.authorization, "Bearer ragflow-key", "url/key 继承全局");
    assert.strictEqual(MOCKS.ragflow.last.body.user, "qa-mini", "ragflow user 连接级：智能体层未设 → 继承全局");
    // 5) 会话层 > 智能体层：管理 PUT protocol_config 覆盖 chat_id=S1 → 旧后端会话失效重建
    const ov = await adminFetch("PUT", "/api/sessions/" + sx.data.session.id, { protocol_config: { ragflow: { chat_id: "S1" } } }, adminTok);
    assert.strictEqual(ov.status, 200, ov.data && ov.data.detail);
    const ask2 = await api("POST", "/api/push?sync=true", { token: sx.data.session.token, text: "p881 会话层" });
    assert.strictEqual(ask2.status, 200, ask2.data && ask2.data.detail);
    assert.ok(ask2.data.ok === true, "会话层覆盖后提问成功: " + (ask2.data && ask2.data.detail));
    assert.strictEqual(MOCKS.ragflow.last.body.chat_id, "S1", "会话层覆盖智能体层（body.chat_id）");
    // 6) 全局 url 变化 → 继承全局的会话后端上下文失效（智能体自有配置的会话不受影响）
    const cfg1 = await adminFetch("PUT", "/api/config", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1-x" } } }, adminTok);
    assert.strictEqual(cfg1.status, 200);
    assert.ok(cfg1.data.invalidated_sessions >= 1, "全局 url 变化 → 继承全局的会话失效: " + cfg1.data.invalidated_sessions);
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1" } } }, adminTok)).status, 200, "恢复全局 url");
    // 7) 掩码哨兵：自有 key 的智能体，保存回传「…已设置」= 保留真值（不再丢失）
    const mkK = await adminFetch("POST", "/api/admin/agents", { code: "p881-k", name: "P8.81 哨兵体", protocol: "ragflow", config: { chat_id: "CK", api_key: "k-own" } }, adminTok);
    assert.strictEqual(mkK.status, 201, mkK.data && mkK.data.detail);
    const view = await adminFetch("GET", "/api/admin/agents", undefined, adminTok);
    assert.strictEqual(view.data.agents.find((x) => x.code === "p881-k").config.api_key, "…已设置", "api_key 管理视图掩码");
    const pk = await adminFetch("PATCH", "/api/admin/agents/p881-k", { config: { url: "", api_key: "…已设置", chat_id: "CK" } }, adminTok);
    assert.strictEqual(pk.status, 200, pk.data && pk.data.detail);
    const sk = await adminFetch("POST", "/api/sessions", { name: "p881-k", agent_code: "p881-k" }, adminTok);
    const askK = await api("POST", "/api/push?sync=true", { token: sk.data.session.token, text: "p881 哨兵" });
    assert.strictEqual(askK.status, 200, askK.data && askK.data.detail);
    assert.ok(askK.data.ok === true, "哨兵体提问成功: " + (askK.data && askK.data.detail));
    assert.strictEqual(MOCKS.ragflow.last.headers.authorization, "Bearer k-own", "哨兵保留自有 key（未丢失）");
    // 8) POST /api/admin/protocol-test：全局 ← 智能体 ← 草稿 合并链
    const pt1 = await adminFetch("POST", "/api/admin/protocol-test", { protocol: "ragflow", agent_code: "p881-x" }, adminTok);
    assert.strictEqual(pt1.status, 200);
    assert.strictEqual(pt1.data.ok, true, pt1.data.detail);
    assert.strictEqual(MOCKS.ragflow.lastChatGetId, "AX", "测试 = 智能体现有配置 + 全局 url/key");
    const pt2 = await adminFetch("POST", "/api/admin/protocol-test", { protocol: "ragflow", agent_code: "p881-x", config: { chat_id: "PT" } }, adminTok);
    assert.strictEqual(pt2.data.ok, true, pt2.data.detail);
    assert.strictEqual(MOCKS.ragflow.lastChatGetId, "PT", "草稿 chat_id 优先于智能体现值");
    // dify 预检：先清全局 dify.api_key（启动期为早期协议测试恢复过；v8 后本为空）→ 模拟三层皆无身份
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { dify: { api_key: "" } } }, adminTok)).status, 200, "清全局 dify api_key（预检测试用）");
    const pt3 = await adminFetch("POST", "/api/admin/protocol-test", { protocol: "dify", config: { url: "http://127.0.0.1:" + PORTS.dify } }, adminTok);
    assert.strictEqual(pt3.data.ok, false, "dify 缺 api_key 预检失败（不泄漏智能体 ragflow key）");
    assert.ok(String(pt3.data.detail).includes("API Key"), "预检文案指明 API Key");
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { dify: { api_key: "dify-key" } } }, adminTok)).status, 200, "恢复全局 dify api_key");
    // 9) 协议切换 = 旧协议字段作废：ragflow → dify 缺必填 → 400
    const sw = await adminFetch("PATCH", "/api/admin/agents/p881-x", { protocol: "dify" }, adminTok);
    assert.strictEqual(sw.status, 400, "协议切换缺 dify api_key → 400");
    assert.ok(String(sw.data.detail).includes("API Key"), "切换文案指明 API Key");
    const sw2 = await adminFetch("PATCH", "/api/admin/agents/p881-x", { protocol: "dify", config: { api_key: "app-key-x" } }, adminTok);
    assert.strictEqual(sw2.status, 200, sw2.data && sw2.data.detail);
    // 10) dify 智能体 → 新建会话继承 dify 协议（不再恒 ragflow）
    const sd = await adminFetch("POST", "/api/sessions", { name: "p881-d", agent_code: "p881-x" }, adminTok);
    assert.strictEqual(sd.status, 201, sd.data && sd.data.detail);
    assert.strictEqual(sd.data.session.protocol, "dify", "切换后新会话协议 = dify");
    // 清理：删测试会话 + 停用测试智能体
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sx.data.session.id, undefined, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sk.data.session.id, undefined, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sd.data.session.id, undefined, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/p881-x", { enabled: false }, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/p881-k", { enabled: false }, adminTok)).status, 200);
  });


  await test("p8.10: 权限与数据边界（admin 新建 → 管理员私有桶；重构前共享保持共享）", async () => {
    const users = (await adminFetch("GET", "/api/admin/users", undefined, adminTok)).data.users;
    const adminU = users.find((u) => u.role === "admin");
    // admin 新建 → 管理员私有桶（P8.10：不再落共享桶）
    const mk = await adminFetch("POST", "/api/sessions", { name: "p810-admin" }, adminTok);
    assert.strictEqual(mk.status, 201, mk.data && mk.data.detail);
    const sid = mk.data.session.id;
    const det = (await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok)).data.session;
    assert.strictEqual(det.access_mode, "user", "admin 新建会话 → user 私有桶（P8.10）");
    assert.strictEqual(det.user_id, adminU.id, "归属管理员用户");
    // 访问码主体：列表不含 + 详情 404
    const codeJar = makeJar();
    const cl = await jarFetch(codeJar, "POST", "/api/auth/access-code", { code: "888888" });
    assert.strictEqual(cl.status, 200, cl.data && cl.data.detail);
    assert.ok(!(await jarFetch(codeJar, "GET", "/api/sessions")).data.sessions.some((s) => s.id === sid), "code 列表不含管理员私有会话");
    assert.strictEqual((await jarFetch(codeJar, "GET", "/api/sessions/" + sid)).status, 404, "code 访问管理员私有会话 404");
    // 重构前共享会话：code 仍可见（「访问码 = 共享会话」语义保留）
    const adminList = (await adminFetch("GET", "/api/sessions", undefined, adminTok)).data.sessions;
    assert.ok(adminList.some((s) => s.id === sid), "admin 列表含自身私有会话");
    let sharedVisible = false;
    for (const s of adminList.slice(0, 10)) {
      const d = (await adminFetch("GET", "/api/sessions/" + s.id, undefined, adminTok)).data.session;
      if (d.access_mode === "shared") {
        sharedVisible = (await jarFetch(codeJar, "GET", "/api/sessions/" + s.id)).status === 200;
        break;
      }
    }
    assert.ok(sharedVisible, "重构前共享会话对 code 仍可见");
    // 登录用户 / 匿名：均不可见
    const uJar = makeJar();
    const ul = await jarFetch(uJar, "POST", "/api/auth/login", { username: "carol", password: "carolpw1" });
    assert.strictEqual(ul.status, 200, ul.data && ul.data.detail);
    assert.ok(!(await jarFetch(uJar, "GET", "/api/sessions")).data.sessions.some((s) => s.id === sid), "user 列表不含管理员私有会话");
    assert.ok(!(await api("GET", "/api/sessions")).data.sessions.some((s) => s.id === sid), "anon 列表不含管理员私有会话");
  });

  await test("p3: 审计日志（admin 操作留痕）", async () => {
    assert.strictEqual((await api("GET", "/api/admin/audit")).status, 401, "非管理 401");
    const au = await adminFetch("GET", "/api/admin/audit?limit=200", undefined, adminTok);
    assert.strictEqual(au.status, 200);
    const acts = au.data.items.map((x) => x.action);
    assert.ok(acts.includes("users.create"), "users.create 留痕");
    assert.ok(acts.includes("agents.create"), "agents.create 留痕");
    assert.ok(acts.includes("auth.login"), "auth.login 留痕");
    const uRec = au.data.items.find((x) => x.action === "users.create" && x.detail.username === "alice");
    assert.ok(uRec, "alice users.create 留痕");
    assert.ok(uRec.actor_id, "审计带 actor_id");
    // P8.29：访问码登录/登出留痕 + 设备指纹字段（访问码脱敏）
    const cJar = makeJar();
    const clg = await jarFetch(cJar, "POST", "/api/auth/access-code", { code: "555556" });
    assert.strictEqual(clg.status, 200, clg.data && clg.data.detail);
    assert.strictEqual((await jarFetch(cJar, "POST", "/api/auth/logout")).status, 200, "访问码登出");
    const au2 = await adminFetch("GET", "/api/admin/audit?limit=200", undefined, adminTok);
    const acts2 = au2.data.items.map((x) => x.action);
    assert.ok(acts2.includes("access.login"), "access.login 留痕（P8.29）");
    assert.ok(acts2.includes("access.logout"), "access.logout 留痕（P8.29）");
    const clRec = au2.data.items.find((x) => x.action === "access.login");
    assert.ok(typeof clRec.user_agent === "string", "审计带设备指纹字段（P8.29）");
    assert.ok(String(clRec.detail.code || "").includes("•••"), "访问码详情脱敏（P8.29）");
  });
  await test("p8.33: 访问控制 在线列表 + 一键踢出", async () => {
    // 匿名 + 访问码主体建立 SSE 长连接（带设备指纹 dev）
    const sA = await collectSse({ query: "?dev=devA123" });
    await sA.wait("sessions");
    const ck = await adminFetch("POST", "/api/admin/access-codes", { code: "666677" }, adminTok);
    assert.strictEqual(ck.status, 201, ck.data && ck.data.detail);
    const kJar = makeJar();
    const kl = await jarFetch(kJar, "POST", "/api/auth/access-code", { code: "666677" });
    assert.strictEqual(kl.status, 200, kl.data && kl.data.detail);
    const sB = await collectSse({ query: "?dev=devB456", headers: kJar.header() });
    await sB.wait("sessions");
    // 在线列表：设备指纹 + IP 判定唯一
    const ol = await adminFetch("GET", "/api/admin/online", undefined, adminTok);
    assert.strictEqual(ol.status, 200);
    assert.ok(ol.data.online.length >= 2, "在线列表 ≥ 2 个身份");
    const aRow = ol.data.online.find((x) => x.dev === "devA123");
    const bRow = ol.data.online.find((x) => x.dev === "devB456");
    assert.ok(aRow && aRow.kind === "anon" && aRow.label === "匿名", "匿名身份行");
    assert.ok(bRow && bRow.kind === "code" && String(bRow.label).includes("••••77"), "访问码身份行（脱敏）");
    assert.strictEqual(bRow.ip, "127.0.0.1", "身份行带 IP");
    // 踢匿名：evicted 控制事件 + 冷却期内探针 403 + 重建长连接 403
    const kA = await adminFetch("POST", "/api/admin/online/kick", { dev: "devA123", ip: "127.0.0.1" }, adminTok);
    assert.strictEqual(kA.status, 200, "踢出匿名 200");
    assert.strictEqual(kA.data.kicked, 1, "kicked=1");
    await sA.wait("evicted");
    await sleep(200);
    const probe = await fetch(BASE + "/api/events/check?dev=devA123");
    assert.strictEqual(probe.status, 403, "冷却期探针 403");
    assert.ok((await probe.json()).evicted, "探针 evicted 标记");
    const reopen = await fetch(BASE + "/api/events?dev=devA123");
    assert.strictEqual(reopen.status, 403, "冷却期重建长连接 403");
    if (reopen.body && reopen.body.cancel) reopen.body.cancel();
    // 踢访问码主体：cookie 会话吊销
    const kB = await adminFetch("POST", "/api/admin/online/kick", { dev: "devB456", ip: "127.0.0.1" }, adminTok);
    assert.strictEqual(kB.status, 200, "踢出访问码 200");
    await sB.wait("evicted");
    const meB = await jarFetch(kJar, "GET", "/api/auth/me");
    assert.strictEqual(meB.data.principal, null, "cookie 已吊销（principal 空）");
    // 管理员不可踢；已不在线目标 404
    const sC = await collectSse({ query: "?admin=" + adminTok + "&dev=devC789" });
    await sC.wait("sessions");
    const ol2 = await adminFetch("GET", "/api/admin/online", undefined, adminTok);
    const cRow = ol2.data.online.find((x) => x.dev === "devC789");
    assert.ok(cRow && cRow.kind === "admin", "管理员身份行");
    assert.strictEqual((await adminFetch("POST", "/api/admin/online/kick", { dev: "devC789", ip: "127.0.0.1" }, adminTok)).status, 400, "管理员不可被下线");
    assert.strictEqual((await adminFetch("POST", "/api/admin/online/kick", { dev: "devA123", ip: "127.0.0.1" }, adminTok)).status, 404, "目标已不在线 404");
    // 审计留痕
    const au3 = await adminFetch("GET", "/api/admin/audit?limit=200", undefined, adminTok);
    const kickRec = au3.data.items.find((x) => x.action === "access.kick");
    assert.ok(kickRec, "access.kick 留痕");
    assert.ok(kickRec.detail && kickRec.detail.ip, "kick 详情带 ip");
    sA.close(); sB.close(); sC.close();
  });
  await test("p8.35: 访问控制 在线口径（登录用户/访问码按会话，匿名按长连接）", async () => {
    // 访问码用户：仅登录、无长连接 → 按会话出现在在线列表
    const j1 = makeJar();
    const l1 = await jarFetch(j1, "POST", "/api/auth/access-code", { code: "666677" });
    assert.strictEqual(l1.status, 200, l1.data && l1.data.detail);
    let ol = await adminFetch("GET", "/api/admin/online", undefined, adminTok);
    assert.strictEqual(ol.status, 200);
    const cRow = ol.data.online.find((x) => x.kind === "code" && x.session_id);
    assert.ok(cRow, "访问码用户按会话显示（无长连接）");
    assert.strictEqual(cRow.connections, 0, "无长连接 = 连接数 0");
    assert.ok(String(cRow.label).includes("••••77"), "访问码脱敏");
    assert.ok(cRow.last_seen, "last_seen 存在");
    // 登录用户：复用既有 carol（P8.8 访问控制矩阵已建）登录（无长连接）→ 按会话显示
    const j2 = makeJar();
    const l2 = await jarFetch(j2, "POST", "/api/auth/login", { username: "carol", password: "carolpw1" });
    assert.strictEqual(l2.status, 200, l2.data && l2.data.detail);
    ol = await adminFetch("GET", "/api/admin/online", undefined, adminTok);
    const uRow = ol.data.online.find((x) => x.kind === "user" && x.label === "carol");
    assert.ok(uRow && uRow.session_id, "登录用户按会话显示");
    // 会话踢出：吊销 cookie + 无禁入冷却（与匿名 5 分钟冷却区分）
    const k1 = await adminFetch("POST", "/api/admin/online/kick", { session_id: cRow.session_id }, adminTok);
    assert.strictEqual(k1.status, 200, "会话踢出 200");
    const me1 = await jarFetch(j1, "GET", "/api/auth/me");
    assert.strictEqual(me1.data.principal, null, "会话已吊销（principal 空）");
    const reopen1 = await fetch(BASE + "/api/events?dev=devD111");
    assert.strictEqual(reopen1.status, 200, "会话踢出后无禁入冷却（SSE 重建 200）");
    if (reopen1.body && reopen1.body.cancel) reopen1.body.cancel();
    ol = await adminFetch("GET", "/api/admin/online", undefined, adminTok);
    assert.ok(!ol.data.online.some((x) => x.session_id === cRow.session_id), "踢出后会话行消失");
    // 管理员会话行：存在且不可被下线；已吊销会话踢出 404
    const aj = makeJar();
    const al = await jarFetch(aj, "POST", "/api/admin/login", { password: "newpw456" });
    assert.strictEqual(al.status, 200, "管理员 cookie 登录: " + (al.data && al.data.detail));
    ol = await adminFetch("GET", "/api/admin/online", undefined, adminTok);
    const aRow = ol.data.online.find((x) => x.kind === "admin" && x.session_id);
    assert.ok(aRow, "管理员会话行");
    assert.strictEqual((await adminFetch("POST", "/api/admin/online/kick", { session_id: aRow.session_id }, adminTok)).status, 400, "管理员会话不可被下线");
    assert.strictEqual((await adminFetch("POST", "/api/admin/online/kick", { session_id: cRow.session_id }, adminTok)).status, 404, "已吊销会话 404");
  });
  await test("p3: 最后一个 active 管理员守护", async () => {
    const b = await adminFetch("POST", "/api/admin/users", { username: "bob", password: "bobpw123", role: "admin" }, adminTok);
    assert.strictEqual(b.status, 201);
    const bobId = b.data.user.id;
    const disBob = await adminFetch("PATCH", "/api/admin/users/" + bobId, { status: "disabled" }, adminTok);
    assert.strictEqual(disBob.status, 200, "停用非唯一 admin 允许");
    const u = await adminFetch("GET", "/api/admin/users", undefined, adminTok);
    const adminU = u.data.users.find((x) => x.role === "admin" && x.status === "active" && x.id !== bobId);
    assert.ok(adminU, "当前 admin 用户应存在");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/users/" + adminU.id, { status: "disabled" }, adminTok)).status, 400, "停用最后 admin 400");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/users/" + adminU.id, { role: "user" }, adminTok)).status, 400, "降级最后 admin 400");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/users/" + bobId, { status: "active" }, adminTok)).status, 200, "恢复 bob");
  });
  await test("p3: 访问码失效吊销 cookie 会话", async () => {
    const jar = makeJar();
    const lg = await jarFetch(jar, "POST", "/api/auth/access-code", { code: "555556" });
    assert.strictEqual(lg.status, 200, lg.data && lg.data.detail);
    const me1 = await jarFetch(jar, "GET", "/api/auth/me");
    assert.strictEqual(me1.data.principal.kind, "code");
    assert.strictEqual((await adminFetch("DELETE", "/api/admin/access-codes/555556", undefined, adminTok)).status, 200, "管理失效该码");
    const me2 = await jarFetch(jar, "GET", "/api/auth/me");
    assert.ok(!me2.data.principal || me2.data.principal.kind !== "code", "码失效后 cookie 不再是 code 主体");
  });
  await test("p4/p7: 根 PWA 产物（manifest scope / + workbox sw + SPA fallback + 缺失资源 404）", async () => {
    const mf = await api("GET", "/manifest.webmanifest");
    assert.strictEqual(mf.status, 200, "manifest 可访问");
    assert.strictEqual(mf.data.start_url, "/");
    assert.strictEqual(mf.data.scope, "/");
    const sw = await (await fetch(BASE + "/sw.js")).text();
    assert.ok(sw.includes("workbox"), "SW 为 workbox generateSW 产物");
    const r2 = await fetch(BASE + "/login");
    assert.strictEqual(r2.status, 200, "SPA fallback 200");
    assert.ok((await r2.text()).includes('<div id="app">'), "无扩展名路径回 index.html");
    assert.strictEqual((await fetch(BASE + "/assets/nope-404.js")).status, 404, "缺失资源 404（不回 fallback）");
  });
  await test("p7: /app/ 旧挂载退役（回根壳由 vue-router 重定向；无 /app 资源）", async () => {
    const r = await fetch(BASE + "/app");
    assert.strictEqual(r.status, 200, "遗留路径不 5xx（SPA fallback）");
    assert.ok((await r.text()).includes('<div id="app">'), "Vue 壳");
    assert.strictEqual((await fetch(BASE + "/app/assets/nope.js")).status, 404, "无 /app/assets 资源");
  });
  await test("p5: 会话列表携带 agent_id（新前端工作区按智能体过滤依赖）", async () => {
    const ag = await api("GET", "/api/agents");
    assert.strictEqual(ag.status, 200);
    const brain = (ag.data.agents || []).find((a) => a.code === "industry-brain");
    assert.ok(brain, "播种智能体 industry-brain 存在");
    const ls = await api("GET", "/api/sessions");
    assert.strictEqual(ls.status, 200);
    const items = ls.data.sessions || [];
    assert.ok(items.length >= 1, "至少 1 个会话");
    for (const v of items) assert.ok("agent_id" in v, "会话视图含 agent_id 字段");
    const legacy = items.find((v) => v.name === "默认会话");
    assert.ok(legacy, "启动默认会话存在");
    assert.strictEqual(legacy.agent_id, brain.id, "默认会话归属 industry-brain");
  });
  await test("p5: 工作区路由 /agents/:code 走 SPA fallback（P7 切根后）", async () => {
    const r = await fetch(BASE + "/agents/industry-brain");
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<div id="app">'));
  });
  await test("p6: 管理台 /admin 走 SPA fallback（P7 切根后）", async () => {
    const r = await fetch(BASE + "/admin");
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<div id="app">'));
  });

  // ================= P8.48：/api/admin/stats 仪表盘统计 =================
  await test("p8.48: /api/admin/stats 鉴权（匿名/普通用户 401）", async () => {
    const anon = await api("GET", "/api/admin/stats");
    assert.strictEqual(anon.status, 401, "无凭证 401");
    const ju = makeJar();
    const lu = await jarFetch(ju, "POST", "/api/auth/login", { username: "carol", password: "carolpw1" });
    assert.strictEqual(lu.status, 200, "carol 登录: " + (lu.data && lu.data.detail));
    const cu = await jarFetch(ju, "GET", "/api/admin/stats");
    assert.strictEqual(cu.status, 401, "普通用户 401");
  });
  await test("p8.48: days 参数（缺省 7 / 999→90 / 0→400）+ 顶层形状", async () => {
    const r0 = await adminFetch("GET", "/api/admin/stats?days=0", undefined, adminTok);
    assert.strictEqual(r0.status, 400, "days=0 → 400");
    const r9 = await adminFetch("GET", "/api/admin/stats?days=999&fresh=1", undefined, adminTok);
    assert.strictEqual(r9.status, 200);
    assert.strictEqual(r9.data.days, 90, "999 截断 90");
    assert.strictEqual(r9.data.daily.length, 90, "daily 90 天");
    const rd = await adminFetch("GET", "/api/admin/stats?fresh=1", undefined, adminTok);
    assert.strictEqual(rd.data.days, 7, "缺省 7 天");
    assert.strictEqual(rd.data.daily.length, 7, "daily 7 天");
    assert.strictEqual(rd.data.hours.length, 24, "hours 24 桶");
    for (const k of ["ok", "generated_at", "summary", "agents", "protocols", "errors"]) assert.ok(k in rd.data, "缺字段 " + k);
    for (const k of ["records_total", "records_today", "online", "active_qa", "uptime_s", "error_rate_range_pct", "avg_duration_s"]) assert.ok(k in rd.data.summary, "缺 summary." + k);
  });
  await test("p8.48: 聚合准确性（四主体 + 协议/智能体/错误，差值法）", async () => {
    const before = await adminFetch("GET", "/api/admin/stats?days=30&fresh=1", undefined, adminTok);
    assert.strictEqual(before.status, 200, "admin 200");
    const b = before.data;
    // 1) 匿名共享桶（默认会话）：成功 1 + 失败 1（会话级 url 覆盖 → 死端口 → ok=0 记录，用完即清。
    //    P8.81：默认会话归 industry-brain（智能体层自有 url），改全局 url 不再影响它 → 失败记录改走会话覆盖）
    const lsA = await api("GET", "/api/sessions");
    assert.strictEqual(lsA.status, 200);
    const shared = (lsA.data.sessions || []).find((x) => x.name === "默认会话") || (lsA.data.sessions || [])[0];
    assert.ok(shared, "默认共享会话存在");
    const a1 = await api("POST", "/api/chat", { session_id: shared.id, question: "dash-anon-ok" });
    assert.strictEqual(a1.status, 202, "匿名提问: " + (a1.data && a1.data.detail));
    const rec1 = await waitDone(a1.data.qa_id);
    assert.strictEqual(rec1.ok, true, "匿名成功记录");
    const protoName = shared.protocol || "ragflow";
    await adminFetch("PUT", "/api/sessions/" + shared.id, { protocol_config: { [protoName]: { url: "http://127.0.0.1:1/dead" } } }, adminTok);
    const a2 = await api("POST", "/api/chat", { session_id: shared.id, question: "dash-anon-fail" });
    assert.strictEqual(a2.status, 202);
    const rec2 = await waitDone(a2.data.qa_id);
    assert.strictEqual(rec2.ok, false, "连接拒绝记录 ok=false");
    assert.ok(String(rec2.detail).length > 0, "错误文案非空: " + rec2.detail);
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + shared.id, { protocol_config: { [protoName]: {} } }, adminTok)).status, 200, "清除会话 url 覆盖");
    // 2) 管理员私有桶（新建专用会话 → 桶归属 admin）
    const ja = makeJar();
    const la = await jarFetch(ja, "POST", "/api/admin/login", { password: "newpw456" });
    assert.strictEqual(la.status, 200, "admin cookie 登录: " + (la.data && la.data.detail));
    const csA = await jarFetch(ja, "POST", "/api/sessions", { name: "dash-admin", agent_code: "industry-brain" });
    assert.strictEqual(csA.status, 201, "建管理员私有会话");
    const q1 = await jarFetch(ja, "POST", "/api/chat", { session_id: csA.data.session.id, question: "dash-admin-ok" });
    assert.strictEqual(q1.status, 202);
    await waitDoneAs(ja, q1.data.qa_id);
    // 3) 用户私有桶（carol，P8.40 已恢复全量范围）
    const jc = makeJar();
    const lc = await jarFetch(jc, "POST", "/api/auth/login", { username: "carol", password: "carolpw1" });
    assert.strictEqual(lc.status, 200);
    const csC = await jarFetch(jc, "POST", "/api/sessions", { name: "dash-user", agent_code: "industry-brain" });
    assert.strictEqual(csC.status, 201, "建用户私有会话");
    const q2 = await jarFetch(jc, "POST", "/api/chat", { session_id: csC.data.session.id, question: "dash-user-ok" });
    assert.strictEqual(q2.status, 202);
    await waitDoneAs(jc, q2.data.qa_id);
    // 4) 访问码桶（新建专用码 + 专用会话）
    let mk = await adminFetch("POST", "/api/admin/access-codes", { code: "888899" }, adminTok);
    if (mk.status === 409) mk = await adminFetch("POST", "/api/admin/access-codes", { code: "888898" }, adminTok);
    assert.ok(mk.status === 201 || mk.status === 200, "建专用码: " + (mk.data && mk.data.detail));
    const newCode = mk.data.entry && mk.data.entry.code;
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/access-codes/" + newCode, { agent_scope: [] }, adminTok)).status, 200, "P8.51 专用码默认最小权限 → 显式放行全部");
    const jk = makeJar();
    const lk = await jarFetch(jk, "POST", "/api/auth/access-code", { code: newCode });
    assert.strictEqual(lk.status, 200, "码登录");
    const csK = await jarFetch(jk, "POST", "/api/sessions", { name: "dash-code", agent_code: "industry-brain" });
    assert.strictEqual(csK.status, 201, "建访问码私有会话");
    const q3 = await jarFetch(jk, "POST", "/api/chat", { session_id: csK.data.session.id, question: "dash-code-ok" });
    assert.strictEqual(q3.status, 202);
    await waitDoneAs(jk, q3.data.qa_id);
    // ---- 差值断言 ----
    const after = await adminFetch("GET", "/api/admin/stats?days=30&fresh=1", undefined, adminTok);
    assert.strictEqual(after.status, 200);
    const a = after.data;
    assert.strictEqual(a.summary.records_total - b.summary.records_total, 5, "累计提问 +5");
    const dayA = a.daily[a.daily.length - 1], dayB = b.daily[b.daily.length - 1];
    assert.strictEqual(dayA.total - dayB.total, 5, "今日提问 +5");
    assert.strictEqual(dayA.anon - dayB.anon, 2, "匿名 +2");
    assert.strictEqual(dayA.admin - dayB.admin, 1, "管理员 +1");
    assert.strictEqual(dayA.user - dayB.user, 1, "用户 +1");
    assert.strictEqual(dayA.code - dayB.code, 1, "访问码 +1");
    assert.ok(dayA.err - dayB.err >= 1, "错误计数 +>=1");
    assert.ok(dayA.logins - dayB.logins >= 3, "登录 +>=3（admin/carol/code）");
    assert.ok(dayA.new_sessions - dayB.new_sessions >= 3, "新建会话 +>=3（dash-admin/user/code）");
    const protoDeltaAll = a.protocols.reduce((s, x) => s + x.questions, 0) - b.protocols.reduce((s, x) => s + x.questions, 0);
    assert.strictEqual(protoDeltaAll, 5, "协议提问合计 +5");
    assert.ok(a.protocols.some((x) => { const y = b.protocols.find((v) => v.name === x.name) || { err: 0 }; return x.err - y.err >= 1; }), "协议错误 +>=1");
    assert.ok(a.protocols.every((x) => typeof x.enabled === "boolean"), "协议 enabled 字段（P8.43）");
    const brainA = a.agents.find((x) => x.code === "industry-brain");
    const brainB = b.agents.find((x) => x.code === "industry-brain");
    assert.ok(brainA, "agents 含 industry-brain 行");
    assert.strictEqual(brainA.questions - (brainB ? brainB.questions : 0), 5, "industry-brain 提问 +5（5 条记录全归 brain）");
    assert.ok(a.errors.some((e) => e.detail === String(rec2.detail).slice(0, 80)), "errors 含注入的失败文案");
    assert.ok(a.errors.every((e) => typeof e.protocol === "string" && e.count >= 1), "错误行形状");
    assert.ok(a.summary.uptime_s >= 0, "uptime");
    assert.ok(a.summary.online.sse >= 0 && a.summary.online.auth_sessions >= 0 && a.summary.online.groups >= 0, "online 形状");
  });

  // ================= P8.49：/api/admin/security 安全监控 + IP 封禁 =================
  const rawReq = async (method, p, body, headers) => {
    const resp = await fetch(BASE + p, { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await resp.json(); } catch {}
    return { status: resp.status, data };
  };
  await test("p8.49: /api/admin/security 鉴权（匿名/普通用户 401）", async () => {
    const anon = await api("GET", "/api/admin/security");
    assert.strictEqual(anon.status, 401, "无凭证 401");
    const ju = makeJar();
    const lu = await jarFetch(ju, "POST", "/api/auth/login", { username: "carol", password: "carolpw1" });
    assert.strictEqual(lu.status, 200, "carol 登录: " + (lu.data && lu.data.detail));
    const cu = await jarFetch(ju, "GET", "/api/admin/security");
    assert.strictEqual(cu.status, 401, "普通用户 401");
  });
  await test("p8.49: days 参数（缺省 7 / 999→90 / 0→400）+ 顶层形状", async () => {
    const r0 = await adminFetch("GET", "/api/admin/security?days=0", undefined, adminTok);
    assert.strictEqual(r0.status, 400, "days=0 → 400");
    const r9 = await adminFetch("GET", "/api/admin/security?days=999&fresh=1", undefined, adminTok);
    assert.strictEqual(r9.status, 200);
    assert.strictEqual(r9.data.days, 90, "999 截断 90");
    assert.strictEqual(r9.data.daily.length, 90, "daily 90 天");
    const rd = await adminFetch("GET", "/api/admin/security?fresh=1", undefined, adminTok);
    assert.strictEqual(rd.data.days, 7, "缺省 7 天");
    assert.strictEqual(rd.data.daily.length, 7, "daily 7 天");
    assert.strictEqual(rd.data.hour24.length, 24, "hour24 24 桶");
    for (const k of ["ok", "summary", "alerts", "top_ips", "bans", "events"]) assert.ok(k in rd.data, "缺字段 " + k);
    for (const k of ["qa_today", "logins_today", "fails_today", "events_24h", "alerts", "bans_active", "bans_total", "qa_24h", "error_rate_24h"]) assert.ok(k in rd.data.summary, "缺 summary." + k);
    assert.ok(rd.data.hour24.every((x) => "logins" in x && "fails" in x && "qa" in x && typeof x.h === "string"), "hour24 行形状");
  });
  await test("p8.49: 手动封禁（XFF 假 IP 拦截 / admin 豁免 / 幂等解封）", async () => {
    const p1 = await adminFetch("POST", "/api/admin/security/bans", { ip: "203.0.113.7", minutes: 5, reason: "e2e 手动封禁" }, adminTok);
    assert.strictEqual(p1.status, 201, "封禁 201: " + (p1.data && p1.data.detail));
    assert.strictEqual(p1.data.ban.ip, "203.0.113.7");
    assert.strictEqual(p1.data.ban.permanent, false, "5 分钟非永久");
    const pBad = await adminFetch("POST", "/api/admin/security/bans", { ip: "999.1.1.1", minutes: 5 }, adminTok);
    assert.strictEqual(pBad.status, 400, "非法 ip 400");
    const pBad2 = await adminFetch("POST", "/api/admin/security/bans", { ip: "203.0.113.7", minutes: -1 }, adminTok);
    assert.strictEqual(pBad2.status, 400, "负 minutes 400");
    const pDup = await adminFetch("POST", "/api/admin/security/bans", { ip: "203.0.113.7", minutes: 5 }, adminTok);
    assert.strictEqual(pDup.status, 409, "重复封禁 409");
    const b1 = await rawReq("GET", "/api/agents", undefined, { "x-forwarded-for": "203.0.113.7" });
    assert.strictEqual(b1.status, 403, "被封 IP 403");
    assert.ok(String(b1.data.detail).includes("限制"), "403 文案: " + (b1.data && b1.data.detail));
    const b2 = await rawReq("GET", "/api/agents", undefined, { "x-forwarded-for": "203.0.113.7", "X-Admin-Token": adminTok });
    assert.strictEqual(b2.status, 200, "admin 豁免 200");
    const b3 = await rawReq("GET", "/api/agents", undefined, {});
    assert.strictEqual(b3.status, 200, "未封 IP 不受影响");
    const b4 = await rawReq("GET", "/api/health", undefined, { "x-forwarded-for": "203.0.113.7" });
    assert.strictEqual(b4.status, 200, "health 豁免 200");
    assert.strictEqual((await adminFetch("DELETE", "/api/admin/security/bans/203.0.113.7", undefined, adminTok)).status, 200, "解封 200");
    assert.strictEqual((await adminFetch("DELETE", "/api/admin/security/bans/203.0.113.7", undefined, adminTok)).status, 404, "无封禁再解 404");
    const b5 = await rawReq("GET", "/api/agents", undefined, { "x-forwarded-for": "203.0.113.7" });
    assert.strictEqual(b5.status, 200, "解封后恢复 200");
    const bl = await adminFetch("GET", "/api/admin/security/bans", undefined, adminTok);
    assert.strictEqual(bl.status, 200);
    assert.ok(Array.isArray(bl.data.bans), "bans 数组");
  });
  await test("p8.49: 登录爆破自动封禁（10 次失败 → auto: 封禁 + 审计）", async () => {
    // 场景内把阈值调回 10（爆破源 = XFF 假 IP，与 127.0.0.1 隔离；测试末恢复）
    const cfgSet = await adminFetch("PUT", "/api/config", { security: { auto_ban: { login_fails: 10 } } }, adminTok);
    assert.strictEqual(cfgSet.status, 200, "阈值 10: " + (cfgSet.data && cfgSet.data.detail));
    const victim = "203.0.113.9";
    await adminFetch("DELETE", "/api/admin/security/bans/" + victim, undefined, adminTok);
    const codes = [];
    for (let i = 0; i < 10; i++) {
      const r = await rawReq("POST", "/api/auth/login", { username: "nosuchuser" + i, password: "bad-pass-" + i }, { "x-forwarded-for": victim });
      codes.push(r.status);
    }
    assert.ok(codes.every((s) => s === 401 || s === 429), "均为登录失败: " + codes.join(","));
    assert.ok(codes.filter((s) => s === 401).length >= 9, "前 N 次 401: " + codes.join(","));
    const bl = await adminFetch("GET", "/api/admin/security/bans", undefined, adminTok);
    const hit = (bl.data.bans || []).find((b) => b.ip === victim);
    assert.ok(hit, "自动封禁记录存在");
    assert.ok(String(hit.reason).startsWith("auto:"), "原因为 auto: " + hit.reason);
    assert.strictEqual(hit.active, true, "封禁生效");
    const after = await rawReq("POST", "/api/auth/login", { username: "nosuchuser", password: "x" }, { "x-forwarded-for": victim });
    assert.strictEqual(after.status, 403, "被封 IP 再登录 403");
    const ev = await adminFetch("GET", "/api/admin/security/events?limit=50", undefined, adminTok);
    assert.strictEqual(ev.status, 200);
    assert.ok(ev.data.events.some((e) => e.action === "security.auto_ban" && e.target_id === victim), "审计 security.auto_ban");
    assert.ok(ev.data.events.some((e) => e.action === "auth.login_failed"), "审计 auth.login_failed");
    assert.strictEqual((await adminFetch("DELETE", "/api/admin/security/bans/" + victim, undefined, adminTok)).status, 200, "清理自动封禁");
    await adminFetch("PUT", "/api/config", { security: { auto_ban: { login_fails: 100000 } } }, adminTok);
  });
  await test("p8.49: 安全事件流（动作集合 + 分页形状 + 总览内嵌）", async () => {
    const ev = await adminFetch("GET", "/api/admin/security/events?limit=100", undefined, adminTok);
    assert.strictEqual(ev.status, 200);
    assert.ok(typeof ev.data.total === "number" && ev.data.total > 0, "total > 0（本轮有登录/封禁事件）");
    assert.ok(ev.data.events.length > 0 && ev.data.events.length <= 100, "events 分页");
    const allowed = new Set(["auth.login", "auth.login_failed", "admin.login", "admin.login_failed", "access.login", "access.login_failed", "access.kick", "security.ban", "security.unban", "security.auto_ban"]);
    assert.ok(ev.data.events.every((e) => allowed.has(e.action)), "动作均在安全集合内");
    assert.ok(ev.data.events.every((e) => typeof e.created_at === "string" && e.created_at.length > 0), "事件含 created_at");
    assert.ok(ev.data.events.some((e) => e.action === "security.ban" && e.target_id === "203.0.113.7"), "含手动 security.ban");
    assert.ok(ev.data.events.some((e) => e.action === "security.unban" && e.target_id === "203.0.113.7"), "含 security.unban");
    const ov = await adminFetch("GET", "/api/admin/security?fresh=1", undefined, adminTok);
    assert.ok(ov.data.events.length > 0 && ov.data.events.length <= 20, "总览 events ≤20");
  });

  await test("p8.55: 个人设置自助（PUT /api/auth/me 显示名 / 修改密码；匿名 401）", async () => {
    const pu = await adminFetch("POST", "/api/admin/users", { username: "p855u", password: "p855pw1" }, adminTok);
    assert.strictEqual(pu.status, 201, pu.data && pu.data.detail);
    const jar = makeJar();
    assert.strictEqual((await jarFetch(jar, "POST", "/api/auth/login", { username: "p855u", password: "p855pw1" })).status, 200);
    // 显示名
    const p1 = await jarFetch(jar, "PUT", "/api/auth/me", { display_name: "小P" });
    assert.strictEqual(p1.status, 200, p1.data && p1.data.detail);
    assert.strictEqual(p1.data.user.display_name, "小P", "显示名更新");
    const ul = (await adminFetch("GET", "/api/admin/users", undefined, adminTok)).data.users.find((u) => u.username === "p855u");
    assert.strictEqual(ul.display_name, "小P", "管理端列表可见显示名");
    // 修改密码：缺当前密码 → 400；当前密码错 → 403；正确 → 200
    assert.strictEqual((await jarFetch(jar, "PUT", "/api/auth/me", { new_password: "p855pw2" })).status, 400, "缺当前密码 → 400");
    assert.strictEqual((await jarFetch(jar, "PUT", "/api/auth/me", { old_password: "wrong", new_password: "p855pw2" })).status, 403, "当前密码错 → 403");
    const p2 = await jarFetch(jar, "PUT", "/api/auth/me", { old_password: "p855pw1", new_password: "p855pw2" });
    assert.strictEqual(p2.status, 200, p2.data && p2.data.detail);
    assert.strictEqual((await jarFetch(makeJar(), "POST", "/api/auth/login", { username: "p855u", password: "p855pw1" })).status, 401, "旧密码失效");
    assert.strictEqual((await jarFetch(makeJar(), "POST", "/api/auth/login", { username: "p855u", password: "p855pw2" })).status, 200, "新密码可登录");
    // 匿名 → 401
    assert.strictEqual((await api("PUT", "/api/auth/me", { display_name: "x" })).status, 401, "匿名不可用");
    // 清理：停用测试用户
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/users/" + pu.data.user.id, { status: "disabled" }, adminTok)).status, 200);
  });

  await test("p8.58: 智能体「系统提示词」字段移除（问答流程未使用，API/UI 不再暴露）", async () => {
    const mk = await adminFetch("POST", "/api/admin/agents", { code: "p858-a", name: "P8.58 字段移除体", protocol: "openai", prompt: "should-be-ignored", config: { model: "m-858" } }, adminTok);
    assert.strictEqual(mk.status, 201, "创建智能体（prompt 被忽略）");
    const pp = await adminFetch("PATCH", "/api/admin/agents/p858-a", { prompt: "hello" }, adminTok);
    assert.strictEqual(pp.status, 400, "PATCH 仅含 prompt = 无有效字段");
    assert.match(String(pp.data && pp.data.detail), /无有效字段/);
    const view = (await adminFetch("GET", "/api/admin/agents", undefined, adminTok)).data.agents.find((a) => a.code === "p858-a");
    assert.ok(view && !("prompt" in view), "智能体视图不再含 prompt 字段");
    assert.strictEqual((await adminFetch("PATCH", "/api/admin/agents/p858-a", { enabled: false }, adminTok)).status, 200, "清理");
  });

  // 收尾
  await new Promise((resolve) => {
    serverProc.once("exit", resolve);
    serverProc.kill();
  });
  await stopMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log("\n[3] 结果: " + passed + " 通过, " + failed + " 失败, 用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  if (failures.length) {
    console.error("失败项: " + failures.join(" | "));
    if (failed && failed > 0 && /FAIL/.test(serverLog)) {
      console.error("---- 服务器日志（尾部）----");
      console.error(serverLog.slice(-3000));
    }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("测试框架异常:", e);
  process.exit(2);
});
