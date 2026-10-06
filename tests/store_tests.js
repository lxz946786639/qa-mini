"use strict";
// P1 数据层测试（独立运行：node tests/store_tests.js）
// 覆盖：迁移链（全新安装 / v1→v2 / 旧库名 / 幂等 / 延迟回填 / 前向兼容）
//       Store CRUD（users/agents/agent_configs/protocol_defaults/system_configs/
//       access_codes/auth_sessions/audit_logs/sessions/records/桶隔离/stats）
//       auth（scrypt 哈希 / token / 限流）
// 隔离：全部使用 os.tmpdir 临时目录，不触碰真实 data/。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { initDataDir, backfillSessionsForAdmin } = require("../lib/migrations");
const { Store } = require("../lib/store");
const auth = require("../lib/auth");

// ---------- 断言框架 ----------
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; failures.push(name + " :: " + e.message); console.log("  FAIL " + name + " :: " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assert failed"); }
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((msg || "eq") + " | got " + ja + " want " + jb);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function throws(fn, msg) {
  try { fn(); } catch { return; }
  throw new Error(msg || "expected throw");
}

// ---------- fixture ----------
function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ea-p1-")); }
function writeConfig(dir, obj) {
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}
function readConfig(dir) { return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); }

// v1 旧 DDL（与 lib/config.js initStore 历史一致；故意不含 audio_remote 列）
const OLD_DDL = [
  "CREATE TABLE IF NOT EXISTS sessions (" +
  "  id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE," +
  "  protocol TEXT NOT NULL, continue_session INTEGER NOT NULL DEFAULT 1," +
  "  protocol_config TEXT NOT NULL DEFAULT '{}'," +
  "  dify_conversation_id TEXT NOT NULL DEFAULT ''," +
  "  ragflow_session_id TEXT NOT NULL DEFAULT ''," +
  "  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS records (" +
  "  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL," +
  "  id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL," +
  "  protocol TEXT NOT NULL, protocol_name TEXT NOT NULL," +
  "  source TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL," +
  "  finished_at TEXT, ok INTEGER NOT NULL DEFAULT 1, detail TEXT NOT NULL DEFAULT ''," +
  "  UNIQUE (session_id, id))",
  "CREATE INDEX IF NOT EXISTS idx_records_session_seq ON records (session_id, seq)"
];

// 4 会话 + 13 记录（模拟真实库形态：8b14dd80/0fd50fcc/6402e6ea/5516abef）
function defaultV1Sessions() {
  const base = "2026-07-01T02:00:00.000Z";
  return [
    { id: "8b14dd80", name: "默认会话", token: "kaasr_t1", protocol: "ragflow", continue: true, dify: "", rag: "b1bd-rag-0001", created: base, updated: "2026-07-03T05:00:00.000Z" },
    { id: "0fd50fcc", name: "dify 会话", token: "kaasr_t2", protocol: "dify", continue: true, dify: "0af5-dify-0001", rag: "", created: base, updated: "2026-07-04T06:00:00.000Z" },
    { id: "6402e6ea", name: "覆盖会话", token: "kaasr_t3", protocol: "ragflow", continue: false, pc: { url: "http://127.0.0.1:18799/v1" }, dify: "", rag: "", created: base, updated: "2026-07-05T07:00:00.000Z" },
    { id: "5516abef", name: "长历史会话", token: "kaasr_t4", protocol: "ragflow", continue: true, dify: "", rag: "b1bd-rag-0004", created: base, updated: "2026-07-06T08:00:00.000Z" }
  ];
}
function defaultV1Records() {
  const out = [];
  for (let i = 0; i < 3; i++) out.push({ session_id: "8b14dd80", id: "r1-" + i, q: "q" + i, a: "a" + i, p: "ragflow", pn: "知识引擎", started: "2026-07-02T10:0" + i + ":00.000Z", finished: "2026-07-02T10:0" + i + ":02.000Z", ok: true });
  for (let i = 0; i < 0; i++) {}
  out.push({ session_id: "0fd50fcc", id: "r2-0", q: "dify q", a: "dify a", p: "dify", pn: "编排引擎", started: "2026-07-03T11:00:00.000Z", finished: "2026-07-03T11:00:03.000Z", ok: true, detail: "" });
  out.push({ session_id: "6402e6ea", id: "r3-0", q: "q", a: "", p: "ragflow", pn: "知识引擎", started: "2026-07-04T12:00:00.000Z", finished: null, ok: false, detail: "HTTP 500: boom" });
  for (let i = 0; i < 7; i++) out.push({ session_id: "5516abef", id: "r4-" + i, q: "h" + i, a: "h" + i, p: "ragflow", pn: "知识引擎", started: "2026-07-05T13:0" + i + ":00.000Z", finished: "2026-07-05T13:0" + i + ":01.000Z", ok: true });
  return out; // 3+1+1+7 = 12 … 再补 1 条到 13
}
function buildV1Db(dataDir, opts) {
  opts = opts || {};
  const sessions = opts.sessions || defaultV1Sessions();
  const records = opts.records || defaultV1Records();
  const dbFile = path.join(dataDir, opts.legacy ? "qa-mini.db" : "echoanswer.db");
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  for (const sql of OLD_DDL) db.exec(sql);
  if (opts.setVersion) db.exec("PRAGMA user_version = 1");
  const insS = db.prepare(
    "INSERT INTO sessions (id,name,token,protocol,continue_session,protocol_config,dify_conversation_id,ragflow_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  for (const s of sessions) insS.run(s.id, s.name, s.token, s.protocol, s.continue ? 1 : 0, JSON.stringify(s.pc || {}), s.dify || "", s.rag || "", s.created, s.updated);
  const insR = db.prepare(
    "INSERT INTO records (session_id,id,question,answer,protocol,protocol_name,source,started_at,finished_at,ok,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const r of records) insR.run(r.session_id, r.id, r.q, r.a, r.p, r.pn, r.src || "", r.started, r.finished || null, r.ok ? 1 : 0, r.detail || "");
  db.close();
  return dbFile;
}

// 旧版 config.json fixture（含明文管理密码 + 2 访问码 + allow_anonymous）
function oldConfig(over) {
  return Object.assign({
    port: 8787,
    push: { token: "kaasr_t1", protocol: "ragflow", continue_session: true },
    protocols: {
      openai: { url: "http://127.0.0.1:18701/v1", api_key: "sk-test-openai", model: "test-model" },
      dify: { url: "http://127.0.0.1:18703/v1", api_key: "app-test-dify", user: "echoanswer" },
      generic: { url: "http://127.0.0.1:18704/v1/chat", api_key: "", body: "{\"question\":\"{question}\"}" },
      ragflow: { url: "http://127.0.0.1:18705/v1", api_key: "kaasr-test-ragflow", chat_id: "chat-abc" }
    },
    asr: { url: "http://127.0.0.1:18702/v1/audio/transcriptions", api_key: "sk-test-asr", model: "whisper-1", language: "zh", timeout: 60 },
    audio_stream: { max_buffer_s: 120, min_capture_s: 5, default_capture_s: 30, max_capture_s: 60 },
    security: {
      admin_password: "old-plain-pass",
      allow_anonymous: true,
      access_codes: [
        { code: "382154", created_at: "2026-06-01T00:00:00.000Z", expires_at: "2026-07-01T00:00:00.000Z" },
        { code: "100001", created_at: "2026-07-01T00:00:00.000Z", expires_at: "2999-01-01T00:00:00.000Z" }
      ]
    }
  }, over || {});
}

// ---------- 测试 ----------
(async function main() {
  const tmps = [];
  const mk = () => { const d = mkTmp(); tmps.push(d); return d; };
  const noop = () => {};

  console.log("\n[T1] 全新安装（无库 + config 播种）");
  {
    const dir = mk();
    const cfgFile = writeConfig(dir, oldConfig({ security: { admin_password: "fresh-pw-123", allow_anonymous: true, access_codes: [] } }));
    let res, store;
    await t("initDataDir 全新安装", async () => {
      res = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res.fresh === true, "fresh");
      assert(res.migrated === true, "migrated");
      store = Store.open(res.dbFile);
      const v = Number(store.db.prepare("PRAGMA user_version").get().user_version);
      eq(v, 4, "user_version（P8.10 起 v4）");
      assert(res.admin.created === true, "admin.created");
    });
    await t("管理员播种 + 密码可验证", async () => {
      const u = store.getUserByUsername("admin");
      assert(u, "admin 用户存在");
      eq(u.role, "admin", "role");
      assert(auth.verifyPassword("fresh-pw-123", u.password_hash), "密码验证");
    });
    await t("industry-brain 播种（协议=push.protocol，配置=合并默认）", async () => {
      const a = store.getAgentByCode("industry-brain");
      assert(a, "agent 存在");
      assert(a.enabled === true, "enabled");
      const ac = store.getAgentConfig(a.id);
      eq(ac.protocol, "ragflow", "protocol=push.protocol");
      eq(ac.config.url, "http://127.0.0.1:18705/v1", "config 来自 config.json.protocols.ragflow");
    });
    await t("protocol_defaults 四协议（含 generic body 模板）", async () => {
      const d = store.getProtocolDefaults();
      eq(Object.keys(d).sort(), ["dify", "generic", "openai", "ragflow"], "四协议");
      eq(d.openai.model, "test-model", "openai.model 覆盖");
      eq(d.generic.body, "{\"question\":\"{question}\"}", "generic.body");
      eq(d.dify.user, "echoanswer", "dify.user 覆盖");
    });
    await t("system_configs（allow_anonymous/asr/audio_stream/system_name）", async () => {
      eq(store.getSystemConfig("allow_anonymous"), true, "allow_anonymous");
      eq(store.getSystemConfig("asr").model, "whisper-1", "asr");
      eq(store.getSystemConfig("audio_stream").max_buffer_s, 120, "audio_stream");
      eq(store.getSystemConfig("system_name"), "EchoAnswer", "system_name");
    });
    await t("新模型不自动建会话（sessions=0）", async () => {
      eq(store.countSessions({}), 0, "sessions");
    });
    await t("config.json 明文密码清空 + 备份文件", async () => {
      eq(readConfig(dir).security.admin_password, "", "清空");
      const files = fs.readdirSync(dir).filter((f) => f.startsWith("config.json.bak-"));
      assert(files.length === 1, "config 备份存在");
    });
    store.close();
  }

  console.log("\n[T2] v1→v2 迁移（旧库名 qa-mini.db + 文件备份 + 前向兼容 + 幂等）");
  {
    const dir = mk();
    const records = defaultV1Records().concat([{ session_id: "0fd50fcc", id: "r2-1", q: "dify q2", a: "dify a2", p: "dify", pn: "编排引擎", started: "2026-07-03T12:00:00.000Z", finished: "2026-07-03T12:00:04.000Z", ok: true }]);
    buildV1Db(dir, { legacy: true, records });
    const cfgFile = writeConfig(dir, oldConfig());
    let res, store, adminId, agentId, bakCount;
    await t("迁移执行 + 库改名 + DB 备份", async () => {
      res = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res.migrated === true && res.fresh === false, "migrated");
      assert(!fs.existsSync(path.join(dir, "qa-mini.db")), "qa-mini.db 已改名");
      assert(fs.existsSync(path.join(dir, "echoanswer.db")), "echoanswer.db 存在");
      assert(res.backupDir && fs.existsSync(res.backupDir), "backup 目录");
      bakCount = fs.readdirSync(res.backupDir).filter((f) => f.startsWith("echoanswer.db.bak-") && !f.includes("-wal") && !f.includes("-shm")).length;
      eq(bakCount, 1, "一个 DB 备份");
      store = Store.open(res.dbFile);
    });
    await t("管理员从存量明文密码哈希播种", async () => {
      const u = store.getUserByUsername("admin");
      assert(u, "admin 存在");
      assert(auth.verifyPassword("old-plain-pass", u.password_hash), "旧密码可登录");
      adminId = u.id;
    });
    await t("存量 4 会话归属 admin/industry-brain/user 桶", async () => {
      const a = store.getAgentByCode("industry-brain");
      agentId = a.id;
      const list = store.listSessions({});
      eq(list.length, 4, "会话数");
      for (const s of list) {
        eq(s.user_id, adminId, s.id + " user_id");
        eq(s.agent_id, agentId, s.id + " agent_id");
        eq(s.access_mode, "user", s.id + " access_mode");
      }
    });
    await t("token/后端会话 ID/协议覆盖 原样保留", async () => {
      const s1 = store.getSession("8b14dd80");
      eq(s1.token, "kaasr_t1", "token");
      eq(s1.ragflow_session_id, "b1bd-rag-0001", "ragflow id");
      eq(store.getSession("0fd50fcc").dify_conversation_id, "0af5-dify-0001", "dify id");
      eq(store.getSession("6402e6ea").protocol_config.url, "http://127.0.0.1:18799/v1", "protocol_config 覆盖保留");
      eq(store.getSession("6402e6ea").continue_session, false, "continue_session=false 保留");
      eq(store.getSessionByToken("kaasr_t1").id, "8b14dd80", "token 索引");
      eq(s1.audio_remote, { enabled: false, preferred_device: "" }, "audio_remote 补默认");
    });
    await t("13 条记录保留 + 新→旧排序", async () => {
      eq(store.countRecords(), 13, "记录数");
      const r4 = store.listRecords("5516abef");
      eq(r4.length, 7, "会话4记录");
      eq(r4[0].id, "r4-6", "新→旧");
      eq(r4[6].id, "r4-0", "最旧");
    });
    await t("访问码迁移（过期保留可管理 + ANON）", async () => {
      const codes = store.listAccessCodes().map((c) => c.code).sort();
      eq(codes, ["100001", "382154", "ANON"], "码集合");
      assert(store.findValidAccessCode("382154") === null, "382154 已过期");
      assert(store.findValidAccessCode("100001"), "100001 有效");
      assert(store.findValidAccessCode("ANON"), "ANON 有效");
    });
    await t("旧代码前向兼容（v1 列面可查，含 pos）", async () => {
      const rows = store.db.prepare(
        "SELECT id,name,token,protocol,continue_session,protocol_config,dify_conversation_id,ragflow_session_id,created_at,updated_at,pos FROM sessions"
      ).all();
      eq(rows.length, 4, "v1 列面查询");
      eq(rows[0].pos, 0, "pos 列存在");
    });
    await t("config.json 明文密码清空 + 备份", async () => {
      eq(readConfig(dir).security.admin_password, "", "清空");
      assert(fs.readdirSync(dir).some((f) => f.startsWith("config.json.bak-")), "config 备份");
    });
    await t("幂等：二次迁移跳过且无新备份", async () => {
      const res2 = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res2.migrated === false, "跳过");
      const n2 = fs.readdirSync(res2.dbFile.replace("echoanswer.db", "backup") && res.backupDir).filter((f) => f.startsWith("echoanswer.db.bak-") && !f.includes("-wal") && !f.includes("-shm")).length;
      eq(n2, 1, "无新 DB 备份");
      eq(store.countSessions({}), 4, "会话不变");
      eq(store.listUsers().length, 1, "用户不变");
    });
    store.close();
  }

  console.log("\n[T3] v1（显式 user_version=1）迁移");
  {
    const dir = mk();
    buildV1Db(dir, { sessions: defaultV1Sessions().slice(0, 1), records: [], setVersion: true });
    const cfgFile = writeConfig(dir, oldConfig());
    let store;
    await t("user_version 1 → v4 + 归属", async () => {
      const res = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res.migrated === true, "migrated");
      store = Store.open(res.dbFile);
      eq(Number(store.db.prepare("PRAGMA user_version").get().user_version), 4, "v4");
      eq(store.listSessions({}).length, 1, "会话保留");
    });
    store.close();
  }

  console.log("\n[T3b] v2 → v3 迁移（P8.8 agents 访问控制列）");
  {
    const dir = mk();
    buildV1Db(dir, { sessions: defaultV1Sessions().slice(0, 1), records: [] });
    const cfgFile = writeConfig(dir, oldConfig());
    let store;
    await t("存量 v2 库补列 allow_*（默认 = 允许）+ 版本 3", async () => {
      const res0 = initDataDir(dir, { configFile: cfgFile, log: noop }); // v1 → v3
      assert(res0.migrated === true, "首次迁移");
      // 模拟遗留 v2 库：版本拨回 2 + 摘掉一个 P8.8 列
      const d = new DatabaseSync(res0.dbFile);
      d.exec("PRAGMA user_version = 2;");
      d.exec("ALTER TABLE agents DROP COLUMN allow_user");
      d.close();
      const res = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res.migrated === true, "v2 → v4 migrated");
      store = Store.open(res.dbFile);
      eq(Number(store.db.prepare("PRAGMA user_version").get().user_version), 4, "版本 4");
      const brain = store.getAgentByCode("industry-brain");
      eq(brain.allow_user, true, "补列默认 = 允许");
      eq(brain.allow_anon, true, "allow_anon 不变");
      eq(brain.allow_code, true, "allow_code 不变");
      eq(store.listSessions({}).length, 1, "会话保留");
    });
    await t("v4 幂等：二次启动跳过", async () => {
      const res2 = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res2.migrated === false, "跳过");
    });
    store.close();
  }

  console.log("\n[T3c] v3 → v4 迁移（P8.10 管理员新建会话 → 管理员私有桶）");
  {
    const dir = mk();
    buildV1Db(dir, { sessions: defaultV1Sessions(), records: [] });
    const cfgFile = writeConfig(dir, oldConfig());
    let store;
    await t("v3 模拟：2 个 P3 后管理员新建（其一 user_id NULL）+ 2 个重构前会话", async () => {
      const res0 = initDataDir(dir, { configFile: cfgFile, log: noop }); // v1 → v4
      assert(res0.migrated === true, "首次迁移");
      // 拨回 v3 并模拟真实 P3 终态（P3 首启后：存量全部 'shared'）
      const d = new DatabaseSync(res0.dbFile);
      d.exec("PRAGMA user_version = 3;");
      d.prepare("UPDATE sessions SET access_mode='shared'").run();
      d.prepare("UPDATE sessions SET created_at='2026-09-19T08:00:00.000Z' WHERE id='8b14dd80'").run();
      d.prepare("UPDATE sessions SET created_at='2026-10-05T14:00:00.000Z' WHERE id='0fd50fcc'").run();
      d.prepare("UPDATE sessions SET created_at='2026-10-05T06:00:00.000Z' WHERE id='6402e6ea'").run();
      d.prepare("UPDATE sessions SET user_id=NULL WHERE id='6402e6ea' OR id='5516abef'").run();
      d.close();
      const res = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res.migrated === true, "v3 → v4 migrated");
      store = Store.open(res.dbFile);
      eq(Number(store.db.prepare("PRAGMA user_version").get().user_version), 4, "版本 4");
      eq(store.getSession("0fd50fcc").access_mode, "user", "切换点后管理员新建 → 私有桶");
      eq(store.getSession("8b14dd80").access_mode, "shared", "重构前会话保持共享");
      eq(store.getSession("6402e6ea").access_mode, "shared", "user_id=NULL 新建保持共享（无可归属）");
      eq(store.getSession("5516abef").access_mode, "shared", "重构前 NULL 保持共享");
    });
    await t("v4 幂等：二次启动跳过", async () => {
      const res2 = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res2.migrated === false, "跳过");
    });
    store.close();
  }

  console.log("\n[T4] 无预设密码：延迟回填 + allow_anonymous=false 无 ANON");
  {
    const dir = mk();
    buildV1Db(dir, { sessions: defaultV1Sessions().slice(0, 3), records: [] });
    const cfgFile = writeConfig(dir, oldConfig({ security: { admin_password: "", allow_anonymous: false, access_codes: [] } }));
    let store;
    await t("迁移后无管理员、会话 user_id=NULL", async () => {
      const res = initDataDir(dir, { configFile: cfgFile, log: noop });
      assert(res.migrated === true, "migrated");
      assert(res.admin.created === false, "未建管理员");
      store = Store.open(res.dbFile);
      assert(store.getUserByUsername("admin") === null, "无 admin");
      for (const s of store.listSessions({})) assert(s.user_id === null, "user_id NULL");
      assert(store.findValidAccessCode("ANON") === null, "无 ANON");
    });
    await t("backfillSessionsForAdmin 幂等回填", async () => {
      eq(backfillSessionsForAdmin(store.db, "admin-x"), 3, "回填 3 条");
      for (const s of store.listSessions({})) eq(s.user_id, "admin-x", "回填后");
      eq(backfillSessionsForAdmin(store.db, "admin-x"), 0, "二次回填 0");
    });
    store.close();
  }

  console.log("\n[T5] Store CRUD 全表");
  {
    const dir = mk();
    const cfgFile = writeConfig(dir, oldConfig({ security: { admin_password: "crud-pw", allow_anonymous: true, access_codes: [] } }));
    const res = initDataDir(dir, { configFile: cfgFile, log: noop });
    const store = Store.open(res.dbFile);
    const admin = store.getUserByUsername("admin");
    const ib = store.getAgentByCode("industry-brain");
    const anon = store.getAccessCodeByCode("ANON");

    await t("users：创建/查询/列表剥密/改名改状态/唯一性/删除", async () => {
      const u = store.createUser({ username: "alice", passwordHash: auth.hashPassword("pw-a"), displayName: "Alice" });
      assert(u.id && u.username === "alice", "创建");
      assert(store.getUser(u.id).password_hash, "getUser 含 hash");
      const list = store.listUsers();
      eq(list.length, 2, "列表数量");
      assert(!("password_hash" in list[0]), "列表不泄密");
      throws(() => store.createUser({ username: "ALICE", passwordHash: "x" }), "UNIQUE NOCASE");
      store.updateUser(u.id, { status: "disabled", display_name: "Alicia" });
      eq(store.getUser(u.id).status, "disabled", "status");
      eq(store.getUser(u.id).display_name, "Alicia", "display");
      eq(store.countAdmins(), 1, "countAdmins");
      store.removeUser(u.id);
      assert(store.getUser(u.id) === null, "删除");
    });

    await t("agents：创建/按码查/启停/排序/重复码拒绝/删除", async () => {
      const a = store.createAgent({ code: "qa-math", name: "数学问答", description: "d" });
      assert(store.getAgentByCode("qa-math").id === a.id, "按码");
      eq(store.listAgents({ enabledOnly: true }).length, 2, "启用列表");
      store.updateAgent(a.id, { enabled: false, sort: 5, name: "数学" });
      assert(store.getAgent(a.id).enabled === false, "停用");
      eq(store.getAgent(a.id).sort, 5, "sort");
      throws(() => store.createAgent({ code: "qa-math", name: "x" }), "重复码拒绝");
      store.removeAgent(a.id);
      assert(store.getAgentByCode("qa-math") === null, "删除");
    });

    await t("agents：访问控制列（P8.8 默认全放行 / 创建时全关 / 更新回写）", async () => {
      const a = store.createAgent({ code: "qa-sec", name: "安全体" });
      eq(store.getAgent(a.id).allow_anon, true, "默认允许匿名");
      eq(store.getAgent(a.id).allow_code, true, "默认允许码");
      eq(store.getAgent(a.id).allow_user, true, "默认允许用户");
      const b = store.createAgent({ code: "qa-sec2", name: "安全体2", allow_anon: false, allow_code: false, allow_user: false });
      eq(b.allow_anon, false, "创建时全关");
      store.updateAgent(b.id, { allow_user: true });
      const g = store.getAgent(b.id);
      eq(g.allow_user, true, "更新回写");
      eq(g.allow_anon, false, "其余不变");
      store.removeAgent(a.id);
      store.removeAgent(b.id);
    });

    await t("agent_configs：upsert + 非法协议拒绝", async () => {
      store.setAgentConfig(ib.id, "dify", { url: "http://x", api_key: "k" });
      eq(store.getAgentConfig(ib.id).protocol, "dify", "upsert");
      store.setAgentConfig(ib.id, "ragflow", { url: "http://y" });
      eq(store.getAgentConfig(ib.id).config.url, "http://y", "二次覆盖");
      throws(() => store.setAgentConfig(ib.id, "unknown", {}), "非法协议");
    });

    await t("protocol_defaults / system_configs：读写", async () => {
      store.setProtocolDefault("generic", { url: "http://g", api_key: "", body: "b" });
      eq(store.getProtocolDefaults().generic.url, "http://g", "pd");
      throws(() => store.setProtocolDefault("nope", {}), "pd 非法");
      store.setSystemConfig("system_name", "测试系统");
      eq(store.getSystemConfig("system_name"), "测试系统", "sc");
      eq(Object.keys(store.listSystemConfigs()).sort().length >= 4, true, "sc list");
    });

    await t("access_codes：创建/有效期/延期/吊销/清理过期", async () => {
      const before = Date.now();
      const c = store.createAccessCode({ code: "200001", expiresAt: new Date(before + 3600e3).toISOString(), createdBy: admin.id });
      assert(store.findValidAccessCode("200001"), "有效");
      const r = store.renewAccessCode(c.id, 8);
      const delta = Date.parse(r.expires_at) - Date.parse(new Date(before + 3600e3).toISOString());
      assert(delta > 7.9 * 3600e3 && delta <= 8 * 3600e3 + 5000, "从当前到期延期 8h（got " + (delta / 3600e3) + "h）");
      store.updateAccessCode(c.id, { status: "revoked" });
      assert(store.findValidAccessCode("200001") === null, "吊销后不可用");
      const e = store.createAccessCode({ code: "300001", expiresAt: new Date(before - 1000).toISOString() });
      eq(store.removeExpiredAccessCodes(), 1, "清理过期");
      assert(store.getAccessCode(e.id) === null, "过期码已删");
      assert(store.hasAccessCodeCode("ANON"), "ANON 存在");
    });

    await t("auth_sessions：签发/有效判定/吊销/按用户按码批量/清理", async () => {
      const t1 = auth.issueToken(), t2 = auth.issueToken();
      store.createAuthSession({ token: t1, principalType: "user", userId: admin.id, ip: "1.1.1.1", ttlMs: 3600e3 });
      store.createAuthSession({ token: t2, principalType: "user", userId: admin.id, ttlMs: 3600e3 });
      store.createAuthSession({ token: "code-tok", principalType: "access_code", accessCodeId: anon.id, ttlMs: 3600e3 });
      store.createAuthSession({ token: "expired", principalType: "user", userId: admin.id, ttlMs: -3600e3 });
      assert(store.getValidAuthSessionByToken(t1), "t1 有效");
      assert(store.getValidAuthSessionByToken("expired") === null, "过期无效");
      eq(store.revokeAuthSessionByToken(t1), 1, "吊销 1");
      assert(store.getValidAuthSessionByToken(t1) === null, "吊销后无效");
      eq(store.revokeAuthSessionByToken(t1), 0, "二次吊销 0");
      eq(store.revokeAuthSessionsForUser(admin.id), 2, "按用户批量（t2 + 过期行）");
      eq(store.countAuthSessions(), 1, "仅剩 code 会话");
      eq(store.revokeAuthSessionsForCode(anon.id), 1, "按码批量");
      eq(store.countAuthSessions(), 0, "全部失效");
      store.createAuthSession({ token: "prune-me", principalType: "user", userId: admin.id, ttlMs: -1000 });
      eq(store.pruneAuthSessions(), 2, "清理过期行（expired + prune-me）");
    });

    await t("audit_logs：插入/倒序/详情 JSON", async () => {
      store.insertAudit({ actorType: "admin", actorId: admin.id, action: "user.create", targetType: "user", targetId: "u1", detail: { username: "alice" }, ip: "2.2.2.2" });
      store.insertAudit({ actorType: "admin", actorId: admin.id, action: "agent.update", detail: { enabled: false } });
      const list = store.listAuditLogs({ limit: 10 });
      eq(list.length, 2, "条数");
      eq(list[0].action, "agent.update", "倒序");
      eq(list[1].detail, { username: "alice" }, "detail JSON");
    });

    await t("sessions：桶列表 + canViewSession 隔离矩阵", async () => {
      const a2 = store.createAgent({ code: "qa-geo", name: "地理问答" });
      const alice = store.createUser({ username: "alice", passwordHash: auth.hashPassword("pw") });
      const bob = store.createUser({ username: "bob", passwordHash: auth.hashPassword("pw") });
      const sA1 = store.createSession({ name: "A@IB", user_id: alice.id, agent_id: ib.id, access_mode: "user" });
      store.createSession({ name: "A@MATH", user_id: alice.id, agent_id: a2.id, access_mode: "user" });
      const sB1 = store.createSession({ name: "B@IB", user_id: bob.id, agent_id: ib.id, access_mode: "user" });
      const sC1 = store.createSession({ name: "C@IB", access_mode: "access_code", access_code_id: anon.id, agent_id: ib.id });
      store.createSession({ name: "C@MATH", access_mode: "access_code", access_code_id: anon.id, agent_id: a2.id });

      eq(store.listSessions({ userId: alice.id, agentId: ib.id }).map((s) => s.id), [sA1.id], "alice×IB 私有桶");
      eq(store.listSessions({ userId: alice.id }).length, 2, "alice 全部");
      eq(store.listSessions({ accessCodeId: anon.id, agentId: ib.id }).map((s) => s.id), [sC1.id], "共享桶×IB");
      eq(store.listSessions({ accessCodeId: anon.id }).length, 2, "共享桶全部");
      eq(store.listSessions({ agentId: a2.id }).length, 2, "按 agent 过滤");
      eq(store.listSessions({}).length, 5, "全量");

      const pA = { kind: "user", userId: alice.id };
      const pB = { kind: "user", userId: bob.id };
      const pC = { kind: "access_code", codeId: anon.id };
      const pX = { kind: "user", userId: "stranger" };
      const pAdm = { kind: "admin" };
      assert(store.canViewSession(pA, sA1), "alice 看自己");
      assert(store.canViewSession(pA, sB1) === null, "alice 看不到 bob");
      assert(store.canViewSession(pA, sC1) === null, "alice 看不到共享桶");
      assert(store.canViewSession(pC, sC1), "code 看共享桶");
      assert(store.canViewSession(pC, sA1) === null, "code 看不到私有桶");
      assert(store.canViewSession(pB, sB1), "bob 看自己");
      assert(store.canViewSession(pX, sA1) === null, "陌生用户");
      assert(store.canViewSession(pAdm, sB1) && store.canViewSession(pAdm, sC1), "admin 全量");
      assert(store.canViewSession(pA, null) === null, "空会话");
    });

    await t("sessions：updateSession 全字段 + touch 排序 + remove 级联记录", async () => {
      const s = store.listSessions({ userId: store.listUsers().find((u) => u.username === "alice").id, agentId: ib.id })[0];
      const before = s.updated_at;
      await sleep(5);
      store.updateSession(s.id, {
        name: "重命名", protocol: "dify", continue_session: false,
        protocol_config: { url: "http://override" }, audio_remote: { enabled: true, preferred_device: "DevA" },
        dify_conversation_id: "conv-9", ragflow_session_id: ""
      });
      const s2 = store.getSession(s.id);
      eq(s2.name, "重命名", "name");
      eq(s2.protocol, "dify", "protocol");
      eq(s2.continue_session, false, "continue_session");
      eq(s2.protocol_config.url, "http://override", "protocol_config");
      eq(s2.audio_remote, { enabled: true, preferred_device: "DevA" }, "audio_remote");
      eq(s2.dify_conversation_id, "conv-9", "dify id");
      assert(s2.updated_at > before, "updated_at 前进");
      store.appendRecord(s.id, { id: "rec-1", question: "q", answer: "a", protocol: "dify", ok: true });
      store.removeSession(s.id);
      assert(store.getSession(s.id) === null, "会话删除");
      eq(store.listRecords(s.id).length, 0, "记录级联删除");
    });

    await t("records：100 条上限环形语义", async () => {
      const alice = store.listUsers().find((u) => u.username === "alice");
      const bob = store.listUsers().find((u) => u.username === "bob");
      const sB = store.getSession("8b14dd80"); // 已归属 alice？不：T5 全新安装无存量会话
      const fresh = store.createSession({ name: "R", user_id: bob.id, agent_id: ib.id, access_mode: "user" });
      for (let i = 0; i < 105; i++) {
        store.appendRecord(fresh.id, { id: "q" + i, question: "q" + i, answer: "a" + i, protocol: "ragflow", ok: true, started_at: "2026-07-10T10:00:00.000Z" });
      }
      const list = store.listRecords(fresh.id);
      eq(list.length, 100, "上限 100");
      eq(list[0].id, "q104", "最新在前");
      eq(list[99].id, "q5", "最旧=q5");
      assert(!list.some((r) => r.id === "q4"), "q4 被挤出");
      store.removeRecord(fresh.id, "q104");
      eq(store.listRecords(fresh.id).length, 99, "删除 1 条");
    });

    await t("stats：聚合", async () => {
      const st = store.stats();
      assert(st.users >= 3, "users");
      eq(st.admins, 1, "admins");
      assert(st.agents >= 2, "agents");
      assert(st.sessions >= 4, "sessions");
      assert(st.records >= 99, "records");
      assert(st.access_codes >= 1, "codes");
      assert(Number.isInteger(st.qa_today), "qa_today");
    });
    await t("P8.21 normalizeLegacyFinished：空 finished_at → started_at（含幂等）", async () => {
      const bob = store.listUsers().find((u) => u.username === "bob"); // 前测试作用域外，需本作用域取回
      const fresh2 = store.createSession({ name: "P816", user_id: bob.id, agent_id: ib.id, access_mode: "user" });
      store.appendRecord(fresh2.id, { id: "legacy-1", question: "q", answer: "a", protocol: "ragflow", ok: true, started_at: "2026-07-11T08:00:00.000Z" });
      const n1 = store.normalizeLegacyFinished();
      assert(n1 >= 1, "至少归一化 1 条（含环形上限测试遗留的 NULL 行）：" + n1);
      const rec = store.listRecords(fresh2.id)[0];
      eq(rec.finished_at, "2026-07-11T08:00:00.000Z", "回填 started_at");
      eq(rec.status, "done", "回读 status=done");
      eq(store.normalizeLegacyFinished(), 0, "幂等");
    });

    await t("P8.21 recordFromRow：ok=1 且 finished_at 为空串（迁移遗留形态）→ done", async () => {
      const bob = store.listUsers().find((u) => u.username === "bob"); // 同上
      const fresh3 = store.createSession({ name: "P816b", user_id: bob.id, agent_id: ib.id, access_mode: "user" });
      store.appendRecord(fresh3.id, { id: "legacy-2", question: "q", answer: "a", protocol: "ragflow", ok: true, started_at: "2026-07-12T09:00:00.000Z", finished_at: "2026-07-12T09:00:01.000Z" });
      store.db.prepare("UPDATE records SET finished_at = '' WHERE id = ? AND session_id = ?").run("legacy-2", fresh3.id);
      const rec = store.listRecords(fresh3.id)[0];
      eq(rec.status, "done", "ok=1 + 空串 finished_at → done");
      eq(rec.finished_at, null, "空串读取时归一为 null");
    });
    store.close();
  }

  console.log("\n[T6] auth 单元");
  {
    await t("scrypt 哈希/校验（含篡改与非法格式）", async () => {
      const h = auth.hashPassword("p@ss 中文");
      assert(auth.verifyPassword("p@ss 中文", h), "正确密码");
      assert(!auth.verifyPassword("p@ss 中文2", h), "错误密码");
      assert(!auth.verifyPassword("x", "garbage"), "非法格式");
      assert(!auth.verifyPassword("x", h.slice(0, 10)), "截断格式");
      const tampered = h.replace("s1:16384", "s1:1024");
      assert(!auth.verifyPassword("p@ss 中文", tampered), "篡改参数拒绝");
      const h2 = auth.hashPassword("");
      assert(auth.verifyPassword("", h2), "空密码");
      assert(h !== auth.hashPassword("p@ss 中文"), "盐随机");
    });
    await t("token 与 tokenHash", async () => {
      const t1 = auth.issueToken(), t2 = auth.issueToken();
      assert(/^[0-9a-f]{64}$/.test(t1), "64 hex");
      assert(t1 !== t2, "唯一");
      const h = auth.tokenHash("t");
      assert(/^[0-9a-f]{64}$/.test(h), "sha256 hex");
      eq(h, auth.tokenHash("t"), "稳定");
    });
    await t("RateLimiter：IP 维度 3/窗口", async () => {
      const rl = new auth.RateLimiter({ ipMax: 3, accountMax: 100, windowMs: 80 });
      assert(!rl.exceeded("9.9.9.9"), "初始不超限");
      rl.recordFail("9.9.9.9"); rl.recordFail("9.9.9.9");
      assert(!rl.exceeded("9.9.9.9"), "2 次不超限");
      rl.recordFail("9.9.9.9");
      assert(rl.exceeded("9.9.9.9"), "3 次超限");
      assert(!rl.exceeded("8.8.8.8"), "他 IP 不受影响");
      await sleep(100);
      assert(!rl.exceeded("9.9.9.9"), "窗口重置");
    });
    await t("RateLimiter：账户维度 2/窗口（先于 IP 触发）", async () => {
      const rl = new auth.RateLimiter({ ipMax: 100, accountMax: 2, windowMs: 80 });
      rl.recordFail("1.1.1.1", "alice"); rl.recordFail("1.1.1.1", "alice");
      assert(rl.exceeded("1.1.1.1", "alice"), "账户超限");
      assert(!rl.exceeded("1.1.1.1"), "IP 维度未超");
      assert(!rl.exceeded("1.1.1.1", "bob"), "他账户不受影响");
    });
    await t("generateTempPassword", async () => {
      const p = auth.generateTempPassword(12);
      eq(p.length, 12, "长度");
      assert(/^[a-zA-Z0-9]+$/.test(p), "字符集");
    });
  }

  // 清理
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }

  console.log("\n========================================");
  console.log("P1 数据层测试: " + pass + " 通过, " + fail + " 失败");
  if (failures.length) { console.log("失败明细:"); for (const f of failures) console.log("  - " + f); }
  console.log("========================================");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试运行异常:", e); process.exit(1); });
