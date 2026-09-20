"use strict";
// QA Mini 全量测试（零框架）：
//  [1] 四个协议客户端单测（mock 后端）
//  [2] 服务器 API 全链路（真实 server.js + mock 后端，多会话）
// 运行: node tests/run_tests.js   （或 npm test）

process.env.QA_MINI_IDLE_TIMEOUT_MS = "400";
process.env.QA_MINI_CONNECT_TIMEOUT_MS = "500";

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

async function collectSse() {
  const events = [];
  const ctrl = new AbortController();
  (async () => {
    const resp = await fetch(BASE + "/api/events", { signal: ctrl.signal });
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

  // ---------- [2] 服务器 API（多会话） ----------
  console.log("\n[2] 服务器 API 全链路（多会话）");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-mini-test-"));
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
      QA_MINI_CONFIG: cfgPath,
      QA_MINI_DATA_DIR: dataDir,
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
    assert.ok(html.includes("QA Mini"));
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
    assert.ok(txt.includes("qa-mini-v18"), "CACHE 版本常量");
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
