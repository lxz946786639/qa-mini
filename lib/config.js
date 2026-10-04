"use strict";
// 配置管理：config.json 加载 / 深合并 / 原子写盘。
// 会话存储：SQLite data/qa-mini.db（零依赖 node:sqlite；首次启动自动迁移旧 sessions.json）。
// 内置默认值取自 asr-tool 的 config.toml（[third_party.*] 同构），本机开箱即用。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROTOCOLS = ["openai", "dify", "generic", "ragflow"];

// 内置默认为空模板（公开仓库安全：不含任何真实 key/token）；
// 首次启动后在网页「⚙ 设置」填入后端 url/api_key/chat_id（落盘 config.json）。
const DEFAULTS = {
  port: 8787,
  host: "0.0.0.0",
  // push.* 仅作为默认会话的迁移来源（会话体系见 data/qa-mini.db）
  push: {
    token: "",
    protocol: "ragflow",
    continue_session: true
  },
  protocols: {
    openai: {
      url: "",
      api_key: "",
      model: ""
    },
    dify: {
      url: "",
      api_key: "",
      user: "qa-mini"
    },
    generic: {
      url: "",
      api_key: "",
      body: JSON.stringify({ question: "{question}" })
    },
    ragflow: {
      url: "",
      api_key: "",
      chat_id: ""
    }
  },
  // asr: Web 端语音输入 → 服务端转发识别（OpenAI 兼容 ASR 服务，与 asr-tool 同源；
  // 「设置 → 语音输入」页签配置，url 空 = 未启用）
  asr: {
    url: "",
    api_key: "",
    model: "",
    language: "", // 空 = 自动检测
    timeout: 60   // 单段识别读超时（秒，1-300）
  },
  // audio_stream: 电脑输出音频流式接收（asr-tool「持续推流」）参数：
  // 环形缓冲保留时长 / 识别窗口下限/默认/上限（秒；窗口须 ≤ 缓冲）
  audio_stream: {
    max_buffer_s: 120,
    min_capture_s: 5,
    default_capture_s: 30,
    max_capture_s: 60
  },
  // 访问控制（安全）：
  //  - admin_password: 管理密码。空 = 管理未启用（保持旧行为：管理接口不鉴权）；
  //    首次 POST /api/admin/login（或浏览器 /admin）输入的密码即初始化。
  //  - allow_anonymous: true = 匿名可看/可问（旧行为）；false = 需访问码。
  //  - access_codes: [{ code: 6位数字, expires_at: ISO, created_at: ISO }]，一键失效=删除。
  security: {
    admin_password: "",
    allow_anonymous: true,
    access_codes: []
  }
};

function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 深合并：extra 覆盖 base（仅普通对象递归）
function deepMerge(base, extra) {
  if (!isObj(base) || !isObj(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// 会话级协议配置：session.protocol_config = { [协议]: { 字段: 值 } }
// 生效语义：同名「非空字符串」覆盖全局 protocols[协议] 对应字段；空值不生效（回退全局默认）。
function resolveProtocolConfig(session, cfg, protocol) {
  const base = (cfg.protocols && cfg.protocols[protocol]) || {};
  const pc = session && isObj(session.protocol_config) ? session.protocol_config : {};
  const ov = isObj(pc[protocol]) ? pc[protocol] : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(ov)) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v;
  }
  return out;
}

// 清洗会话级协议配置提交：只收已知协议 / 已知字段 / 字符串；
// 值 trim 后空字符串丢弃（空 = 用全局默认），未知协议/字段/类型丢弃。
// 协议 key 保留（字段全空 → {} = 清除该协议的全部会话覆盖）。非法入参返回 null。
function sanitizeProtocolConfig(pc) {
  if (!isObj(pc)) return null;
  const out = {};
  for (const [proto, fields] of Object.entries(pc)) {
    if (!PROTOCOLS.includes(proto) || !isObj(fields)) continue;
    const known = (DEFAULTS.protocols && DEFAULTS.protocols[proto]) || {};
    const fo = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!(k in known) || typeof v !== "string") continue;
      const t = v.trim();
      if (t !== "") fo[k] = t;
    }
    out[proto] = fo;
  }
  return out;
}

function defaultPath() {
  return process.env.QA_MINI_CONFIG
    ? path.resolve(process.env.QA_MINI_CONFIG)
    : path.join(__dirname, "..", "config.json");
}

function loadConfig(p) {
  const file = p || defaultPath();
  let merged = DEFAULTS;
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      merged = deepMerge(DEFAULTS, raw);
    } catch (e) {
      console.error("[config] 读取失败（使用内置默认值）: " + file + ": " + e.message);
    }
  } else {
    saveConfig(file, DEFAULTS);
    console.log("[config] 已生成默认配置: " + file);
  }
  return { config: merged, file };
}

// 原子写盘：临时文件 + rename
function saveConfig(p, cfg) {
  const file = p || defaultPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// 校验一份配置是否可用（PUT /api/config 前置）
function validateConfig(cfg) {
  const problems = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    problems.push("port 必须是 1-65535 的整数");
  }
  if (typeof cfg.host !== "string") problems.push("host 必须是字符串");
  if (!isObj(cfg.push)) problems.push("push 必须是对象");
  else if (cfg.push.protocol && !PROTOCOLS.includes(cfg.push.protocol)) {
    problems.push("push.protocol 必须是 " + PROTOCOLS.join("/"));
  }
  if (!isObj(cfg.protocols)) problems.push("protocols 必须是对象");
  else {
    for (const name of PROTOCOLS) {
      if (cfg.protocols[name] !== undefined && !isObj(cfg.protocols[name])) {
        problems.push("protocols." + name + " 必须是对象");
      }
    }
  }
  if (cfg.asr !== undefined) {
    if (!isObj(cfg.asr)) problems.push("asr 必须是对象");
    else {
      for (const k of ["url", "api_key", "model", "language"]) {
        if (cfg.asr[k] !== undefined && typeof cfg.asr[k] !== "string") {
          problems.push("asr." + k + " 必须是字符串");
        }
      }
      const t = cfg.asr.timeout;
      if (t !== undefined && t !== "") {
        const n = Number(t);
        if (!Number.isFinite(n) || n < 1 || n > 300) problems.push("asr.timeout 必须是 1-300 的数字（秒）");
      }
    }
  }
  if (cfg.audio_stream !== undefined) {
    if (!isObj(cfg.audio_stream)) {
      problems.push("audio_stream 必须是对象");
    } else {
      const num = (k, lo, hi) => {
        const v = cfg.audio_stream[k];
        if (v === undefined || v === "") return;
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) problems.push("audio_stream." + k + " 必须是 " + lo + "-" + hi + " 的数字（秒）");
      };
      num("max_buffer_s", 1, 3600);
      num("min_capture_s", 1, 600);
      num("default_capture_s", 1, 600);
      num("max_capture_s", 1, 600);
      const g = (k) => Number(cfg.audio_stream[k]);
      if (Number.isFinite(g("min_capture_s")) && Number.isFinite(g("max_capture_s")) &&
          g("min_capture_s") > g("max_capture_s")) {
        problems.push("audio_stream.min_capture_s 不能大于 max_capture_s");
      }
      if (Number.isFinite(g("max_capture_s")) && Number.isFinite(g("max_buffer_s")) &&
          g("max_capture_s") > g("max_buffer_s")) {
        problems.push("audio_stream.max_capture_s 不能大于 max_buffer_s（识别窗口须落在缓冲内）");
      }
    }
  }
  return problems;
}

// ---------- 会话存储（SQLite：data/qa-mini.db · 零依赖 node:sqlite） ----------
// 首次启动自动迁移旧 data/sessions.json（旧文件归档为 .bak-<时间戳>）。
let storeDb = null;

function dataDir() {
  return process.env.QA_MINI_DATA_DIR
    ? path.resolve(process.env.QA_MINI_DATA_DIR)
    : path.join(__dirname, "..", "data");
}

// 旧 JSON 路径（仅作为一次性迁移来源）
function sessionsPath() {
  return path.join(dataDir(), "sessions.json");
}

// SQLite 数据库文件路径
function dbPath() {
  return path.join(dataDir(), "qa-mini.db");
}

function initStore() {
  if (storeDb) return storeDb;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS sessions (" +
    "  id TEXT PRIMARY KEY," +
    "  name TEXT NOT NULL," +
    "  token TEXT NOT NULL," +
    "  protocol TEXT NOT NULL," +
    "  continue_session INTEGER NOT NULL DEFAULT 1," +
    "  protocol_config TEXT NOT NULL DEFAULT '{}'," +
    "  audio_remote TEXT NOT NULL DEFAULT '{}'," +
    "  dify_conversation_id TEXT NOT NULL DEFAULT ''," +
    "  ragflow_session_id TEXT NOT NULL DEFAULT ''," +
    "  created_at TEXT NOT NULL," +
    "  updated_at TEXT NOT NULL," +
    "  pos INTEGER NOT NULL DEFAULT 0" +
    ");" +
    "CREATE TABLE IF NOT EXISTS records (" +
    "  seq INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  session_id TEXT NOT NULL," +
    "  id TEXT NOT NULL," +
    "  question TEXT NOT NULL," +
    "  answer TEXT NOT NULL DEFAULT ''," +
    "  protocol TEXT NOT NULL DEFAULT ''," +
    "  protocol_name TEXT NOT NULL DEFAULT ''," +
    "  source TEXT NOT NULL DEFAULT ''," +
    "  started_at TEXT NOT NULL DEFAULT ''," +
    "  finished_at TEXT NOT NULL DEFAULT ''," +
    "  ok INTEGER NOT NULL DEFAULT 1," +
    "  detail TEXT NOT NULL DEFAULT ''," +
    "  UNIQUE (session_id, id)" +
    ");" +
    "CREATE INDEX IF NOT EXISTS idx_records_session ON records (session_id, seq);"
  );
  // 旧库升级：records 增加 finished_at 列（生成时长统计）
  const recCols = db.prepare("PRAGMA table_info(records)").all().map((c) => c.name);
  if (!recCols.includes("finished_at")) {
    db.exec("ALTER TABLE records ADD COLUMN finished_at TEXT NOT NULL DEFAULT ''");
  }
  // 旧库升级：sessions 增加 protocol_config 列（会话级协议配置，JSON 对象）
  const sesCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!sesCols.includes("protocol_config")) {
    db.exec("ALTER TABLE sessions ADD COLUMN protocol_config TEXT NOT NULL DEFAULT '{}'");
  }
  // 旧库升级：sessions 增加 audio_remote 列（电脑输出音频接收开关 + 首选设备，JSON 对象）
  if (!sesCols.includes("audio_remote")) {
    db.exec("ALTER TABLE sessions ADD COLUMN audio_remote TEXT NOT NULL DEFAULT '{}'");
  }
  storeDb = db;
  return db;
}

function parseProtocolConfig(v) {
  if (typeof v !== "string" || !v) return {};
  try {
    const o = JSON.parse(v);
    return isObj(o) ? o : {};
  } catch {
    return {};
  }
}

// audio_remote = { enabled: bool, preferred_device: string }（非法 JSON 回默认值）
function parseAudioRemote(v) {
  const empty = { enabled: false, preferred_device: "" };
  if (typeof v !== "string" || !v) return empty;
  try {
    const o = JSON.parse(v);
    if (!isObj(o)) return empty;
    return {
      enabled: o.enabled === true,
      preferred_device: typeof o.preferred_device === "string" ? o.preferred_device : ""
    };
  } catch {
    return empty;
  }
}

function sessionFromRow(r) {
  return {
    id: r.id,
    name: r.name,
    token: r.token,
    protocol: r.protocol,
    continue_session: !!r.continue_session,
    protocol_config: parseProtocolConfig(r.protocol_config),
    audio_remote: parseAudioRemote(r.audio_remote),
    dify_conversation_id: r.dify_conversation_id,
    ragflow_session_id: r.ragflow_session_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    history: []
  };
}

function recFromRow(r) {
  return {
    id: r.id,
    question: r.question,
    answer: r.answer,
    protocol: r.protocol,
    protocol_name: r.protocol_name,
    source: r.source,
    started_at: r.started_at,
    finished_at: r.finished_at,
    ok: !!r.ok,
    detail: r.detail
  };
}

function listRecords(db, sessionId) {
  return db
    .prepare("SELECT * FROM records WHERE session_id = ? ORDER BY seq DESC")
    .all(sessionId)
    .map(recFromRow);
}

// 一次性迁移：读旧 sessions.json → 内存会话数组（旧文件归档为 .bak）
function migrateFromJson() {
  const file = sessionsPath();
  if (!fs.existsSync(file)) return [];
  let arr = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(raw)) arr = raw;
  } catch (e) {
    console.error("[sessions] 读取旧 sessions.json 失败（跳过迁移）: " + e.message);
  }
  const out = (arr || [])
    .filter((s) => s && typeof s.id === "string" && typeof s.token === "string")
    .map((s) => {
      const ns = newSession({
        id: s.id,
        name: s.name,
        token: s.token,
        protocol: s.protocol,
        continue_session: s.continue_session
      });
      ns.created_at = typeof s.created_at === "string" ? s.created_at : ns.created_at;
      ns.updated_at = typeof s.updated_at === "string" ? s.updated_at : ns.updated_at;
      ns.dify_conversation_id = typeof s.dify_conversation_id === "string" ? s.dify_conversation_id : "";
      ns.ragflow_session_id = typeof s.ragflow_session_id === "string" ? s.ragflow_session_id : "";
      ns.history = Array.isArray(s.history) ? s.history : [];
      return ns;
    });
  try {
    fs.renameSync(file, file + ".bak-" + Date.now());
    console.log("[sessions] 已迁移旧会话数据（sessions.json 归档为 .bak）");
  } catch (e) {
    console.error("[sessions] 归档旧 sessions.json 失败: " + e.message);
  }
  return out;
}

// 生成推送令牌（与 asr-tool 同形态：kaasr_ + 48 hex）
function generateToken() {
  return "kaasr_" + crypto.randomBytes(24).toString("hex");
}

// 生成短会话ID（8 hex，保证唯一）
function generateSessionId(taken) {
  for (;;) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!taken.has(id)) return id;
  }
}

function newSession(opts) {
  opts = opts || {};
  const now = new Date().toISOString();
  return {
    id: opts.id || generateSessionId(new Set()),
    name: (opts.name && opts.name.trim()) || "会话",
    token: opts.token || generateToken(),
    protocol: PROTOCOLS.includes(opts.protocol) ? opts.protocol : "ragflow",
    continue_session: opts.continue_session !== false,
    protocol_config: {},
    audio_remote: { enabled: false, preferred_device: "" },
    dify_conversation_id: "",
    ragflow_session_id: "",
    created_at: now,
    updated_at: now,
    history: []
  };
}

// 加载会话列表（SQLite）；库为空 → 迁移旧 JSON；仍为空 → 默认会话（config.push 的 token/协议）
function loadSessions(cfg) {
  const db = initStore();
  const rows = db.prepare("SELECT * FROM sessions ORDER BY pos").all();
  let sessions = rows.map(sessionFromRow);
  let migrated = false;
  if (!sessions.length) {
    sessions = migrateFromJson();
    migrated = sessions.length > 0;
  }
  if (!sessions.length) {
    const push = (cfg && cfg.push) || {};
    const s = newSession({
      name: "默认会话",
      protocol: push.protocol,
      continue_session: push.continue_session !== false,
      token: typeof push.token === "string" && push.token ? push.token : undefined
    });
    sessions = [s];
    saveSessions(null, sessions);
    console.log("[sessions] 已生成默认会话: " + dbPath() + "（会话ID " + s.id + "）");
  } else {
    if (!migrated) {
      for (const s of sessions) s.history = listRecords(db, s.id);
    } else {
      saveSessions(null, sessions); // 迁移数据落库（history 来自 JSON，勿读空表覆盖）
    }
    console.log("[sessions] 已加载 " + sessions.length + " 个会话（SQLite）: " + dbPath());
  }
  return { sessions, file: dbPath() };
}

// 全量持久化会话列表（sessions 表 + records 表；数据量小，整表重写最稳）
function saveSessions(p, sessions) {
  const db = initStore();
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM records; DELETE FROM sessions;");
    const insSession = db.prepare(
      "INSERT INTO sessions (id, name, token, protocol, continue_session, protocol_config," +
      "  audio_remote, dify_conversation_id, ragflow_session_id, created_at, updated_at, pos)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insRec = db.prepare(
      "INSERT INTO records (session_id, id, question, answer, protocol," +
      "  protocol_name, source, started_at, finished_at, ok, detail)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    sessions.forEach((s, i) => {
      insSession.run(
        s.id, s.name, s.token, s.protocol, s.continue_session ? 1 : 0,
        JSON.stringify(s.protocol_config || {}),
        JSON.stringify(s.audio_remote && typeof s.audio_remote === "object" ? s.audio_remote : { enabled: false, preferred_device: "" }),
        s.dify_conversation_id || "", s.ragflow_session_id || "",
        s.created_at, s.updated_at, i
      );
      const hist = Array.isArray(s.history) ? s.history : [];
      for (let j = hist.length - 1; j >= 0; j--) {
        const r = hist[j];
        insRec.run(
          s.id, r.id, r.question, r.answer || "", r.protocol || "",
          r.protocol_name || "", r.source || "", r.started_at || "",
          r.finished_at || "", r.ok === false ? 0 : 1, r.detail || ""
        );
      }
    });
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// 会话摘要（不含历史；供列表展示与广播）。includeToken=false 时剥离 token
// （非管理客户端看不到推送令牌，防转发盗用）。
function sessionView(s, activeCount, includeToken) {
  const last = s.history && s.history.length ? s.history[0] : null;
  const v = {
    id: s.id,
    name: s.name,
    protocol: s.protocol,
    continue_session: s.continue_session,
    created_at: s.created_at,
    updated_at: s.updated_at,
    qa_count: s.history ? s.history.length : 0,
    active: activeCount || 0,
    last_question: last ? last.question : null,
    last_at: last ? last.started_at : null,
    audio_remote: isObj(s.audio_remote)
      ? s.audio_remote
      : { enabled: false, preferred_device: "" }
  };
  if (includeToken) {
    v.token = s.token;
    v.protocol_config = s.protocol_config || {};
  }
  return v;
}

module.exports = {
  PROTOCOLS,
  DEFAULTS,
  deepMerge,
  resolveProtocolConfig,
  sanitizeProtocolConfig,
  defaultPath,
  loadConfig,
  saveConfig,
  validateConfig,
  dataDir,
  sessionsPath,
  dbPath,
  generateToken,
  generateSessionId,
  newSession,
  loadSessions,
  saveSessions,
  sessionView
};
