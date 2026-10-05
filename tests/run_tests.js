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
  const ragflowCfg = { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9" };
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
      ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9" }
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
  await test("静态 UI 可访问", async () => {
    const r = await fetch(BASE + "/");
    const html = await r.text();
    assert.ok(html.includes("EchoAnswer"));
    assert.ok(html.includes("session-list"));
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
  await test("PWA: sw.js 可访问且含缓存版本", async () => {
    const r = await fetch(BASE + "/sw.js");
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get("content-type") || "").includes("javascript"));
    const txt = await r.text();
    assert.ok(txt.includes("echoanswer-v49"), "CACHE 版本常量");
  });
  await test("前端语法护栏：node --check 通过 app.js / sw.js（防止语法错误上线）", async () => {
    const { spawnSync } = require("child_process");
    for (const f of [path.join(ROOT, "public/app.js"), path.join(ROOT, "public/sw.js")]) {
      const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
      assert.strictEqual(r.status, 0, "node --check " + path.basename(f) + "：" + (r.stderr || "").slice(0, 200));
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
  await test("chat: ragflow 缺 chat_id → 400 前置拦截", async () => {
    await api("PUT", "/api/config", { protocols: { ragflow: { chat_id: "" } } });
    const r = await api("POST", "/api/chat", { session_id: defId, question: "hi" });
    assert.strictEqual(r.status, 400);
    assert.ok(r.data.detail.includes("未配置知识引擎 Chat ID"));
    await api("PUT", "/api/config", { protocols: { ragflow: { chat_id: "C9" } } });
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
  await test("security: 关闭匿名 → 403；访问码登录 → 放行", async () => {
    assert.strictEqual((await adminFetch("PUT", "/api/config", { security: { allow_anonymous: false } }, adminTok)).status, 200);
    assert.strictEqual((await api("GET", "/api/sessions")).status, 403);
    assert.strictEqual((await api("GET", "/api/history")).status, 403);
    assert.strictEqual((await api("POST", "/api/access/login", { code: "999999" })).status, 401);
    const gen = await adminFetch("POST", "/api/admin/access-codes", { code: "123456", hours: 1 }, adminTok);
    assert.strictEqual(gen.status, 201);
    assert.strictEqual(gen.data.entry.code, "123456");
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
    assert.strictEqual((await api("GET", "/api/events?access=bogus_token")).status, 403, "SSE 事件流无效访问 token 应 403（前端探测依据）");
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
  await test("security: 过期码 401；恢复匿名", async () => {
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
    const anon = await api("GET", "/api/sessions/" + sid);
    assert.strictEqual(anon.status, 200);
    assert.ok(!("protocol_config" in anon.data.session), "非管理视图剥离 protocol_config");
    assert.ok(!("token" in anon.data.session));
    const p2 = await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: { openai: {} } }, adminTok);
    assert.strictEqual(p2.status, 200);
    assert.deepStrictEqual(p2.data.session.protocol_config.openai, {}, "空对象 = 清除该协议覆盖");
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
  });

  await test("sessions: 会话级配置运行时生效（覆盖优于全局；前置校验用合并值）", async () => {
    // 全局 ragflow 临时改为错误 key + 空 chat_id；本会话用覆盖值（正确 key + C9）
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { api_key: "wrong-key", chat_id: "" } } }, adminTok)).status, 200);
    const c = await adminFetch("POST", "/api/sessions", { name: "运行时覆盖", protocol: "ragflow" }, adminTok);
    assert.strictEqual(c.status, 201);
    const sid = c.data.session.id;
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, {
      protocol_config: { ragflow: { api_key: "ragflow-key", chat_id: "C9" } }
    }, adminTok)).status, 200);
    // 无覆盖会话：合并后 chat_id 仍为空 -> 前置校验 400
    const list = await api("GET", "/api/sessions");
    const other = list.data.sessions.find((s) => s.id !== sid && s.protocol === "ragflow");
    assert.ok(other, "需存在另一个 ragflow 会话");
    const rBad = await api("POST", "/api/chat", { session_id: other.id, question: "hi" });
    assert.strictEqual(rBad.status, 400, "无覆盖会话应被前置校验拦截");
    assert.ok(rBad.data.detail.includes("Chat ID"), rBad.data.detail);
    // 有覆盖会话：合并后 key/chat_id 齐全 -> 全链路成功
    const rOk = await api("POST", "/api/chat", { session_id: sid, question: "覆盖问题" });
    assert.strictEqual(rOk.status, 202);
    const rec = await waitDone(rOk.data.qa_id);
    assert.strictEqual(rec.ok, true, rec.detail);
    assert.strictEqual(rec.session_id, sid);
    // 恢复全局配置 + 清理会话
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { api_key: "ragflow-key", chat_id: "C9" } } }, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
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
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { url: "http://127.0.0.1:" + PORTS.ragflow + "/api/v1", api_key: "ragflow-key", chat_id: "C9" } } }, adminTok)).status, 200);
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
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
    const r1 = await api("POST", "/api/chat", { session_id: sid, question: "q1" });
    assert.strictEqual(r1.status, 202);
    const rec1 = await waitDone(r1.data.qa_id);
    assert.strictEqual(rec1.ok, true, rec1.detail);
    const d1 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.ok(d1.data.session.ragflow_session_id, "提问后保存了 ragflow_session_id");
    // 会话级 chat_id 变更 → 后端会话重置
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: { ragflow: { chat_id: "C8" } } }, adminTok)).status, 200);
    const d2 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d2.data.session.ragflow_session_id, "", "chat_id 变更后 ragflow_session_id 被清空");
    // 新 chat 下重新提问 → 建新会话并正常
    const r2 = await api("POST", "/api/chat", { session_id: sid, question: "q2" });
    const rec2 = await waitDone(r2.data.qa_id);
    assert.strictEqual(rec2.ok, true, rec2.detail);
    const d3 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.ok(d3.data.session.ragflow_session_id, "新 chat 会话已保存");
    // 协议切换也重置
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol: "openai" }, adminTok)).status, 200);
    const d4 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d4.data.session.ragflow_session_id, "", "协议切换后清空");
    assert.strictEqual((await adminFetch("DELETE", "/api/sessions/" + sid, undefined, adminTok)).status, 200);
  });

  await test("sessions: 全局 ragflow 配置变更重置回退全局会话的后端会话", async () => {
    const c = await adminFetch("POST", "/api/sessions", { name: "global-reset", protocol: "ragflow" }, adminTok);
    assert.strictEqual(c.status, 201);
    const sid = c.data.session.id;
    const r1 = await api("POST", "/api/chat", { session_id: sid, question: "q1" });
    const rec1 = await waitDone(r1.data.qa_id);
    assert.strictEqual(rec1.ok, true, rec1.detail);
    const d1 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.ok(d1.data.session.ragflow_session_id, "提问后保存了 ragflow_session_id");
    // 改全局 chat_id（该会话无覆盖 → 生效值变化）→ 重置
    const cp = await adminFetch("PUT", "/api/config", { protocols: { ragflow: { chat_id: "C8" } } }, adminTok);
    assert.strictEqual(cp.status, 200);
    const d2 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d2.data.session.ragflow_session_id, "", "全局 chat_id 变更后被清空");
    assert.strictEqual(typeof cp.data.invalidated_sessions, "number", "响应带 invalidated_sessions");
    // 该会话加覆盖（C9）→ 不受全局变更影响
    assert.strictEqual((await adminFetch("PUT", "/api/sessions/" + sid, { protocol_config: { ragflow: { chat_id: "C9" } } }, adminTok)).status, 200);
    const r2 = await api("POST", "/api/chat", { session_id: sid, question: "q2" });
    const rec2 = await waitDone(r2.data.qa_id);
    assert.strictEqual(rec2.ok, true, rec2.detail);
    const d3 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    const sid3 = d3.data.session.ragflow_session_id;
    assert.ok(sid3, "覆盖会话提问正常");
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { chat_id: "C7" } } }, adminTok)).status, 200);
    const d4 = await adminFetch("GET", "/api/sessions/" + sid, undefined, adminTok);
    assert.strictEqual(d4.data.session.ragflow_session_id, sid3, "有覆盖的会话不受全局变更影响");
    // 恢复全局 + 清理
    assert.strictEqual((await adminFetch("PUT", "/api/config", { protocols: { ragflow: { chat_id: "C9" } } }, adminTok)).status, 200);
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
    // 遗留 /api/access/login 在匿名 ON 时走匿名捷径（无 token）——双轨兼容语义；
    // 码主体 cookie 走新端点 /api/auth/access-code
    const legacy = await api("POST", "/api/access/login", { code: "666667" });
    assert.strictEqual(legacy.status, 200);
    assert.strictEqual(legacy.data.anonymous, true, "匿名 ON 时代码登录走匿名捷径");
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
    const ag1 = await adminFetch("POST", "/api/admin/agents", { code: "qa-assist", name: "测试助理", protocol: "openai", description: "p3" }, adminTok);
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

  await test("p3: 审计日志（admin 操作留痕）", async () => {
    assert.strictEqual((await api("GET", "/api/admin/audit")).status, 401, "非管理 401");
    const au = await adminFetch("GET", "/api/admin/audit?limit=200", undefined, adminTok);
    assert.strictEqual(au.status, 200);
    const acts = au.data.items.map((x) => x.action);
    assert.ok(acts.includes("users.create"), "users.create 留痕");
    assert.ok(acts.includes("agents.create"), "agents.create 留痕");
    assert.ok(acts.includes("auth.login"), "auth.login 留痕");
    const uRec = au.data.items.find((x) => x.action === "users.create");
    assert.strictEqual(uRec.detail.username, "alice");
    assert.ok(uRec.actor_id, "审计带 actor_id");
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
  await test("p4: /app/ 新前端挂载（HTML 壳/PWA 产物/SPA fallback/404）", async () => {
    const r1 = await fetch(BASE + "/app/");
    assert.strictEqual(r1.status, 200, "GET /app/ → 200");
    const html = await r1.text();
    assert.ok(html.includes('<div id="app">'), "Vue 挂载点");
    assert.ok(html.includes("/app/assets/"), "资源按 base /app/ 生成");
    const mf = await api("GET", "/app/manifest.webmanifest");
    assert.strictEqual(mf.status, 200, "manifest 可访问");
    assert.strictEqual(mf.data.start_url, "/app/");
    assert.strictEqual(mf.data.scope, "/app/");
    const sw = await (await fetch(BASE + "/app/sw.js")).text();
    assert.ok(sw.includes("workbox"), "SW 为 workbox generateSW 产物");
    const r2 = await fetch(BASE + "/app/login");
    assert.strictEqual(r2.status, 200, "SPA fallback 200");
    assert.ok((await r2.text()).includes('<div id="app">'), "无扩展名路径回 index.html");
    assert.strictEqual((await fetch(BASE + "/app/assets/nope-404.js")).status, 404, "缺失资源 404（不回 fallback）");
  });
  await test("p4: 根路径仍为现役前端（/ 与 /app 互不干扰）", async () => {
    const root = await (await fetch(BASE + "/")).text();
    assert.ok(root.includes("session-list"), "根路径 = 现役界面（session-list）");
    assert.ok(!root.includes('<div id="app">'), "根路径不是新前端壳");
    const r = await fetch(BASE + "/app");
    assert.strictEqual(r.status, 200, "/app（无尾斜杠）进入新前端");
    assert.ok((await r.text()).includes('<div id="app">'));
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
  await test("p5: 工作区路由 /app/agents/:code 走 SPA fallback", async () => {
    const r = await fetch(BASE + "/app/agents/industry-brain");
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<div id="app">'));
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
