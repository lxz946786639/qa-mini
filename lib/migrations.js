"use strict";
// 数据库迁移链 v1 → v2 → v3 → v4（PRAGMA user_version；零依赖）：
//  - 触发：server 启动时 migrations.initDataDir(dataDir, opts)
//  - 文件级备份（迁移红线）：
//      data/echoanswer.db{,-wal,-shm} → data/backup/echoanswer.db.bak-<ts>{,-wal,-shm}
//      <config.json> → <config.json>.bak-<ts>（当需要改写配置时）
//  - v1 → v2：单事务（DDL + 播种 + 归属回填），失败回滚且文件备份仍在
//  - 幂等：user_version=2 时直接返回；播种步骤逐一检查现状
//  - v2 → v3：agents 补列 allow_anon/allow_code/allow_user（P8.8 访问控制，默认全允许 = 不改变现状）
//  - v3 → v4：P8.10 数据回填（无 DDL）——双轨期管理员新建会话被 bucketFor 落入共享桶，
//    对码/用户/匿名主体全部可见；本步把「P3 切换点（2026-10-05）之后创建、user_id = 管理员」
//    的共享会话改回管理员私有桶。重构前存量会话（早于切换点）保留共享语义不变；
//    全新安装无匹配行（no-op）。
//  - v4 → v5：P8.29 audit_logs 表补列 user_agent（访问设备浏览器特征，供审计
//    日志展示设备识别码 + 浏览器特征）。
//  - v5 → v6：P8.40 users/access_codes 补列 agent_scope（主体权限范围：JSON 数组 =
//    允许的 agent id 列表，空 = 全部；管理员恒全量不受限）
//  - v6 → v7：P8.49 新增 ip_bans 表（IP 封禁：手动 + 自动，expires_at NULL = 永久）
//  - v7 → v8：P8.81 配置体系重构（无 DDL）——身份级字段（ragflow.chat_id /
//    openai.model / dify.api_key）从全局预设移入智能体级：对相应字段为空的智能体
//    回填旧全局值（protocol_defaults 优先，缺行回落 config.json），随后清空全局
//    protocol_defaults 行与 config.json 文件对应字段。生效配置逐字段不变
//    （回填前运行时本就回退全局值）→ 无需清空会话后端会话 ID；幂等。
//  - 旧代码前向兼容：v2/v3/v4/v5/v6/v7/v8 库对只读写已知列的旧代码仍可用（新表/新列被忽略）
//
// 播种规则（M3-M7）：
//  - 管理员：config.security.admin_password 或 ECHOANSWER_ADMIN_PASSWORD 非空 → 哈希建 admin 用户；
//    否则不建（保留「首次登录即初始化」引导流程，见 routes/auth.js）
//  - 智能体：industry-brain（产业大脑），协议取 push.protocol，配置取合并后的 protocol_defaults
//  - protocol_defaults ← config.json.protocols（深合并 DEFAULTS）
//  - access_codes ← security.access_codes（agent_id=NULL 全局码）；allow_anonymous → ANON 特殊码
//  - system_configs ← security.allow_anonymous / asr / audio_stream / system_name
//  - 存量 sessions → user_id=管理员(若已建，否则待 bootstrap 回填)、agent_id=industry-brain、access_mode='user'

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { DEFAULTS, deepMerge, PROTOCOLS } = require("./config");
const { hashPassword } = require("./auth");
const { ANON_CODE } = require("./store");

const V2 = 2;
const V3 = 3; // P8.8：agents 表增访问控制列 allow_anon/allow_code/allow_user
const V4 = 4; // P8.10：管理员新建会话回填管理员私有桶（数据回填，无 DDL）
const V5 = 5; // P8.29：audit_logs 补列 user_agent（访问设备浏览器特征）
const V6 = 6; // P8.40：users/access_codes 补列 agent_scope（主体权限范围，JSON 数组 = agent id 列表，空 = 全部）
const V7 = 7; // P8.49：ip_bans 表（IP 封禁：手动 + 自动；expires_at NULL = 永久）
const V8 = 8; // P8.81：身份级字段（ragflow.chat_id/openai.model/dify.api_key）全局 → 智能体级（回填 + 清全局）
const V9 = 9; // P8.93：agents.anon_window 匿名开放时段（JSON：start/end 本地日期、dayStart/dayEnd 本地时间；NULL = 永久开放）
// P8.81 v8：协议 → 身份级字段名（generic 无身份级字段）
const V8_IDENTITY = { ragflow: "chat_id", openai: "model", dify: "api_key" };
// P3 多用户切换点（P3 提交日）：早于此的共享会话 = 重构前存量，保留共享语义
const P810_LEGACY_CUTOVER = "2026-10-05T00:00:00.000Z";
const FUTURE_ISO = "9999-12-31T00:00:00.000Z";

function nowISO() { return new Date().toISOString(); }
function ts() { return Date.now().toString(); }

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name = ?").get(name);
  return !!row;
}
function columnExists(db, table, col) {
  const rows = db.prepare("PRAGMA table_info(" + table + ")").all();
  return rows.some((r) => r.name === col);
}

// ---- 文件级备份（DB + 可选配置）----
function backupDbFile(dbFile, dataDir, log) {
  if (!fs.existsSync(dbFile)) return null;
  const dir = path.join(dataDir, "backup");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = ".bak-" + ts();
  const copied = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbFile + suffix;
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dir, "echoanswer.db" + stamp + suffix));
    copied.push("echoanswer.db" + stamp + (suffix || ""));
  }
  log("已备份数据库 → " + path.join(dir, "echoanswer.db" + stamp));
  return dir;
}

function backupConfigFile(configFile, log) {
  if (!configFile || !fs.existsSync(configFile)) return null;
  const dest = configFile + ".bak-" + ts();
  fs.copyFileSync(configFile, dest);
  log("已备份配置 → " + dest);
  return dest;
}

// 迁移成功后把 config.json 的明文管理密码清空（已哈希入库；配置降级为引导/留档）
function clearConfigAdminPassword(configFile, log) {
  if (!configFile || !fs.existsSync(configFile)) return;
  let raw;
  try { raw = fs.readFileSync(configFile, "utf8"); } catch { return; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  if (!obj || !obj.security || !String(obj.security.admin_password || "")) return;
  backupConfigFile(configFile, log);
  obj.security.admin_password = "";
  const tmp = configFile + ".tmp-" + ts();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, configFile);
  log("config.json 明文管理密码已清空（已哈希入库）");
}

// ---- v1 旧 schema（与 lib/config.js initStore 历史 DDL 一致，用于全新库识别/补建）----
const V1_DDL = [
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

// ---- v2 新表 DDL（PG 兼容口径：TEXT 时间 / INTEGER 布尔 / TEXT JSON）----
const V2_NEW_TABLES = [
  "CREATE TABLE IF NOT EXISTS users (" +
  "  id TEXT PRIMARY KEY," +
  "  username TEXT NOT NULL UNIQUE COLLATE NOCASE," +
  "  password_hash TEXT NOT NULL," +
  "  display_name TEXT NOT NULL DEFAULT ''," +
  "  role TEXT NOT NULL DEFAULT 'user'," +
  "  status TEXT NOT NULL DEFAULT 'active'," +
  "  created_at TEXT NOT NULL, updated_at TEXT NOT NULL," +
  "  last_login_at TEXT)",
  "CREATE TABLE IF NOT EXISTS agents (" +
  "  id TEXT PRIMARY KEY," +
  "  code TEXT NOT NULL UNIQUE," +
  "  name TEXT NOT NULL," +
  "  description TEXT NOT NULL DEFAULT ''," +
  "  icon TEXT NOT NULL DEFAULT ''," +
  "  enabled INTEGER NOT NULL DEFAULT 1," +
  "  sort INTEGER NOT NULL DEFAULT 0," +
  "  prompt TEXT NOT NULL DEFAULT ''," +
  "  allow_anon INTEGER NOT NULL DEFAULT 1," +
  "  allow_code INTEGER NOT NULL DEFAULT 1," +
  "  allow_user INTEGER NOT NULL DEFAULT 1," +
  "  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS agent_configs (" +
  "  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE," +
  "  protocol TEXT NOT NULL," +
  "  config_json TEXT NOT NULL DEFAULT '{}'," +
  "  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS protocol_defaults (" +
  "  name TEXT PRIMARY KEY," +
  "  config_json TEXT NOT NULL DEFAULT '{}'," +
  "  updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS system_configs (" +
  "  key TEXT PRIMARY KEY," +
  "  value_json TEXT NOT NULL," +
  "  updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS access_codes (" +
  "  id TEXT PRIMARY KEY," +
  "  code TEXT NOT NULL UNIQUE," +
  "  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL," +
  "  status TEXT NOT NULL DEFAULT 'active'," +
  "  created_at TEXT NOT NULL, expires_at TEXT NOT NULL," +
  "  created_by TEXT)",
  "CREATE TABLE IF NOT EXISTS auth_sessions (" +
  "  id TEXT PRIMARY KEY," +
  "  token_hash TEXT NOT NULL UNIQUE," +
  "  principal_type TEXT NOT NULL," +
  "  user_id TEXT REFERENCES users(id) ON DELETE CASCADE," +
  "  access_code_id TEXT REFERENCES access_codes(id) ON DELETE CASCADE," +
  "  ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT ''," +
  "  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_auth_sessions_code ON auth_sessions (access_code_id)",
  "CREATE TABLE IF NOT EXISTS audit_logs (" +
  "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "  actor_type TEXT NOT NULL," +
  "  actor_id TEXT," +
  "  action TEXT NOT NULL," +
  "  target_type TEXT, target_id TEXT," +
  "  detail_json TEXT NOT NULL DEFAULT '{}'," +
  "  ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at)"
];

const V2_SESSIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions (user_id, agent_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions (access_code_id, agent_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions (agent_id, updated_at)"
];

// ---- 播种（幂等；在事务内调用）----
function seedProtocolDefaults(db, config, log) {
  const n = Number(db.prepare("SELECT COUNT(*) AS n FROM protocol_defaults").get().n);
  const have = new Set(db.prepare("SELECT name FROM protocol_defaults").all().map((r) => r.name));
  for (const name of PROTOCOLS) {
    if (have.has(name)) continue;
    const merged = deepMerge(DEFAULTS.protocols[name], (config.protocols || {})[name] || {});
    db.prepare("INSERT INTO protocol_defaults (name, config_json, updated_at) VALUES (?,?,?)")
      .run(name, JSON.stringify(merged), nowISO());
  }
  if (n === 0) log("protocol_defaults ← config.json.protocols（四协议）");
}

function seedSystemConfigs(db, config, log) {
  const put = (key, value) => {
    if (db.prepare("SELECT 1 AS x FROM system_configs WHERE key = ?").get(key)) return;
    db.prepare("INSERT INTO system_configs (key, value_json, updated_at) VALUES (?,?,?)")
      .run(key, JSON.stringify(value), nowISO());
  };
  put("system_name", (config && config.system_name) || "EchoAnswer");
  put("allow_anonymous", !!(config && config.security && config.security.allow_anonymous !== false));
  if (config && config.asr) put("asr", config.asr);
  if (config && config.audio_stream) put("audio_stream", config.audio_stream);
  log("system_configs ← security/asr/audio_stream");
}

function seedAccessCodes(db, config, adminId, log) {
  const sec = (config && config.security) || {};
  const list = Array.isArray(sec.access_codes) ? sec.access_codes : [];
  for (const item of list) {
    if (!item || typeof item.code !== "string" || !item.code) continue;
    if (db.prepare("SELECT 1 AS x FROM access_codes WHERE code = ?").get(item.code)) continue;
    db.prepare(
      "INSERT INTO access_codes (id, code, agent_id, status, created_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?)"
    ).run(
      crypto.randomBytes(4).toString("hex"), item.code, null,
      "active",
      item.created_at || nowISO(),
      item.expires_at || new Date(Date.now() + 8 * 3600e3).toISOString(),
      adminId || null
    );
  }
  if (list.length) log("access_codes ← config.security.access_codes（" + list.length + " 个，全局码）");
  // 匿名共享桶（allow_anonymous=true 时，完整复刻现状「打开页面直接问、多浏览器共享」）
  if (sec.allow_anonymous !== false && !db.prepare("SELECT 1 AS x FROM access_codes WHERE code = ?").get(ANON_CODE)) {
    db.prepare(
      "INSERT INTO access_codes (id, code, agent_id, status, created_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?)"
    ).run(crypto.randomBytes(4).toString("hex"), ANON_CODE, null, "active", nowISO(), FUTURE_ISO, null);
    log("已建匿名共享桶访问码 ANON（allow_anonymous=true）");
  }
}

function seedAgent(db, config, log) {
  const code = "industry-brain";
  if (db.prepare("SELECT 1 AS x FROM agents WHERE code = ?").get(code)) {
    return db.prepare("SELECT id FROM agents WHERE code = ?").get(code).id;
  }
  const id = crypto.randomBytes(4).toString("hex");
  const t = nowISO();
  db.prepare(
    "INSERT INTO agents (id, code, name, description, icon, enabled, sort, prompt, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, code, "产业大脑", "面向产业领域的多领域知识问答（默认智能体）", "", 1, 0, "", t, t);
  const proto = PROTOCOLS.includes(config && config.push && config.push.protocol) ? config.push.protocol : "ragflow";
  const defaults = {};
  for (const r of db.prepare("SELECT * FROM protocol_defaults").all()) {
    try { defaults[r.name] = JSON.parse(r.config_json); } catch { defaults[r.name] = {}; }
  }
  db.prepare(
    "INSERT INTO agent_configs (agent_id, protocol, config_json, created_at, updated_at) VALUES (?,?,?,?,?)"
  ).run(id, proto, JSON.stringify(defaults[proto] || {}), t, t);
  log("已播种智能体 industry-brain（" + proto + "）");
  return id;
}

function seedAdminUser(db, opts, log) {
  const username = opts.adminUsername || "admin";
  if (db.prepare("SELECT 1 AS x FROM users WHERE username = ?").get(username)) {
    return { username, created: false, passwordSet: true };
  }
  const pw = opts.adminPassword || "";
  if (!pw) return { username, created: false, passwordSet: false };
  const id = crypto.randomBytes(4).toString("hex");
  const t = nowISO();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, username, hashPassword(pw), "管理员", "admin", "active", t, t);
  log("已播种管理员用户 " + username + "（密码来自预设，已哈希入库）");
  return { username, created: true, passwordSet: true, id };
}

// v1 存量会话归属回填：私有桶 → 管理员（若已建）；agent → industry-brain
function attributeSessions(db, adminId, agentId, log) {
  const r = db.prepare(
    "UPDATE sessions SET user_id = ?, agent_id = ?, access_mode = 'user' WHERE user_id IS NULL"
  ).run(adminId || null, agentId || null);
  if (Number(r.changes) > 0) log("存量 " + r.changes + " 个会话已归属（" + (adminId ? "管理员私有桶" : "待管理员初始化回填") + " / industry-brain）");
  return Number(r.changes);
}

// 管理员「首次登录初始化」后调用：把当时 user_id=NULL 的存量会话回填给新管理员（幂等）
function backfillSessionsForAdmin(db, adminId) {
  const r = db.prepare("UPDATE sessions SET user_id = ? WHERE user_id IS NULL AND access_mode = 'user'").run(adminId);
  return Number(r.changes);
}

function applyV2Schema(db, log) {
  // v1 补列（极旧库可能缺 audio_remote）
  if (!columnExists(db, "sessions", "audio_remote")) {
    db.exec("ALTER TABLE sessions ADD COLUMN audio_remote TEXT NOT NULL DEFAULT '{}'");
    log("sessions 补列 audio_remote");
  }
  // v2 归属列
  for (const col of ["user_id", "agent_id", "access_mode", "access_code_id"]) {
    if (!columnExists(db, "sessions", col)) {
      db.exec("ALTER TABLE sessions ADD COLUMN " + col + " TEXT" +
        (col === "access_mode" ? " NOT NULL DEFAULT 'user'" : ""));
      log("sessions 补列 " + col);
    }
  }
  for (const sql of V2_NEW_TABLES) db.exec(sql);
  for (const sql of V2_SESSIONS_INDEXES) db.exec(sql);
}

// ---- v3 → v4（P8.10 管理员新建会话回填管理员私有桶；幂等）----
// 判定：access_mode='shared' 且 user_id = 管理员用户 且 created_at >= P810_LEGACY_CUTOVER。
// 双轨期 bucketFor(admin) → shared 且 user_id 取 legacy.userId（= 管理员），与重构前
// 存量（P3 首启由 'user' 回填 'shared'，created_at 早于切换点）可据此区分。
function applyV4Data(db, log) {
  if (!tableExists(db, "sessions") || !tableExists(db, "users")) return;
  const adminRow = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!adminRow) return; // 管理员未初始化（首启引导中）→ 无可归属
  const r = db.prepare(
    "UPDATE sessions SET access_mode = 'user' WHERE access_mode = 'shared' AND user_id = ? AND created_at >= ?"
  ).run(adminRow.id, P810_LEGACY_CUTOVER);
  const n = Number(r.changes);
  if (n > 0) log("P8.10：回填 " + n + " 个管理员新建会话 共享桶 → 管理员私有桶（重构前存量会话保持共享）");
}

// ---- v4 → v5（P8.29 audit_logs 补列 user_agent：访问设备浏览器特征；幂等）----
function applyV5Schema(db, log) {
  if (!tableExists(db, "audit_logs")) return;
  if (!columnExists(db, "audit_logs", "user_agent")) {
    db.exec("ALTER TABLE audit_logs ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''");
    log("audit_logs 补列 user_agent（访问设备浏览器特征）");
  }
}

// ---- v5 → v6（P8.40 主体权限范围：users/access_codes 补列 agent_scope；幂等）----
// agent_scope：JSON 数组（agent id 列表）；空串/空数组 = 允许全部智能体（旧数据行为不变）
function applyV6Schema(db, log) {
  for (const tbl of ["users", "access_codes"]) {
    if (!tableExists(db, tbl)) continue;
    if (!columnExists(db, tbl, "agent_scope")) {
      db.exec("ALTER TABLE " + tbl + " ADD COLUMN agent_scope TEXT NOT NULL DEFAULT ''");
      log(tbl + " 补列 agent_scope（权限范围，P8.40）");
    }
  }
}

// ---- v6 → v7（P8.49 IP 封禁表；幂等）----
// ip_bans：安全监控模块的封禁策略（管理端手动封禁 + 登录爆破/提问高频自动封禁）；
// expires_at = NULL 表示永久封禁；同一 ip 重复封禁 = 覆盖（新原因/新到期）
function applyV7Schema(db, log) {
  if (!tableExists(db, "ip_bans")) {
    db.exec("CREATE TABLE IF NOT EXISTS ip_bans (" +
      "  ip TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT ''," +
      "  created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT)");
    log("新增 ip_bans 表（IP 封禁，P8.49）");
  }
}

// ---- v7 → v8（P8.81 配置体系重构：身份级字段全局 → 智能体级；无 DDL；幂等）----
// 规则：
//  1) 逐智能体：agent_configs.protocol ∈ {ragflow,openai,dify} 且 config 对应身份字段
//     为空、旧全局值非空 → 回填（该智能体自此持有明确身份，行为不变）；
//  2) 清空 protocol_defaults 对应字段（DB 权威源）；config.json 文件由外层
//     clearConfigIdentityFields 清空（防文件兜底在 DB 无行时复活旧值）。
// 生效配置不变 → 不清空 ragflow_session_id / dify_conversation_id。
function applyV8Data(db, config, log) {
  if (!tableExists(db, "agent_configs") || !tableExists(db, "protocol_defaults")) return;
  const globalVal = (proto, field) => {
    let v = "";
    try {
      const row = db.prepare("SELECT config_json FROM protocol_defaults WHERE name = ?").get(proto);
      if (row && row.config_json) {
        const j = JSON.parse(row.config_json);
        if (typeof j[field] === "string" && j[field].trim()) v = j[field];
      }
    } catch {}
    if (!v && config && config.protocols && config.protocols[proto] && typeof config.protocols[proto] === "object") {
      const f = config.protocols[proto][field];
      if (typeof f === "string" && f.trim()) v = f;
    }
    return v;
  };
  const now = nowISO();
  const rows = db.prepare("SELECT agent_id, protocol, config_json FROM agent_configs").all();
  let filled = 0;
  for (const r of rows) {
    const field = V8_IDENTITY[r.protocol];
    if (!field) continue;
    let cfgj = {};
    try { cfgj = JSON.parse(r.config_json || "{}"); } catch { cfgj = {}; }
    if (typeof cfgj[field] === "string" && cfgj[field].trim()) continue; // 已有独立身份值
    const gv = globalVal(r.protocol, field);
    if (!gv) continue; // 全局亦无 → 无可回填（全新安装）
    cfgj[field] = gv;
    db.prepare("UPDATE agent_configs SET config_json = ?, updated_at = ? WHERE agent_id = ?")
      .run(JSON.stringify(cfgj), now, r.agent_id);
    filled++;
  }
  if (filled) log("v8：旧全局身份值已回填 " + filled + " 个智能体（ragflow.chat_id/openai.model/dify.api_key）");
  for (const proto of Object.keys(V8_IDENTITY)) {
    const field = V8_IDENTITY[proto];
    const row = db.prepare("SELECT config_json FROM protocol_defaults WHERE name = ?").get(proto);
    if (!row || !row.config_json) continue;
    let j = null;
    try { j = JSON.parse(row.config_json); } catch { continue; }
    if (j && typeof j[field] === "string" && j[field].trim()) {
      j[field] = "";
      db.prepare("UPDATE protocol_defaults SET config_json = ? WHERE name = ?").run(JSON.stringify(j), proto);
      log("v8：已清空全局 " + proto + "." + field);
    }
  }
}

// P8.81 v8：清空 config.json 文件中的身份级字段（先备份；与 clearConfigAdminPassword 同模式）
function clearConfigIdentityFields(configFile, log) {
  if (!configFile || !fs.existsSync(configFile)) return;
  let raw;
  try { raw = fs.readFileSync(configFile, "utf8"); } catch { return; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  let changed = false;
  if (obj && obj.protocols && typeof obj.protocols === "object") {
    for (const proto of Object.keys(V8_IDENTITY)) {
      const p = obj.protocols[proto];
      if (p && typeof p === "object" && typeof p[V8_IDENTITY[proto]] === "string" && p[V8_IDENTITY[proto]].trim()) {
        p[V8_IDENTITY[proto]] = "";
        changed = true;
      }
    }
  }
  if (!changed) return;
  backupConfigFile(configFile, log);
  const tmp = configFile + ".tmp-" + ts();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, configFile);
  log("config.json 身份级字段已清空（ragflow.chat_id/openai.model/dify.api_key）");
}

// ---- v8 → v9（P8.93 智能体匿名开放时段列；幂等）----
function applyV9Schema(db, log) {
  if (!tableExists(db, "agents")) return;
  if (!columnExists(db, "agents", "anon_window")) {
    db.exec("ALTER TABLE agents ADD COLUMN anon_window TEXT");
    log("agents 补列 anon_window（匿名开放时段 JSON；NULL = 永久开放）");
  }
}

// ---- v2 → v3（P8.8 智能体访问控制列；幂等）----
function applyV3Schema(db, log) {
  if (!tableExists(db, "agents")) return;
  for (const col of ["allow_anon", "allow_code", "allow_user"]) {
    if (!columnExists(db, "agents", col)) {
      db.exec("ALTER TABLE agents ADD COLUMN " + col + " INTEGER NOT NULL DEFAULT 1");
      log("agents 补列 " + col + "（默认 = 允许）");
    }
  }
}

/**
 * 初始化数据目录并执行 v2 迁移。
 * @param {string} dataDir 数据目录（绝对路径）
 * @param {object} opts {
 *   configFile: string|null   旧 config.json 路径（迁移来源；无则按 DEFAULTS）
 *   config: object|null       已解析的旧配置（缺省时自读 configFile）
 *   adminUsername: string     管理员用户名（默认 admin）
 *   adminPassword: string     预设管理员密码（env ECHOANSWER_ADMIN_PASSWORD）
 *   log: (msg)=>void          日志函数
 * }
 * @returns {{dbFile:string, migrated:boolean, fresh:boolean, backupDir:string|null,
 *            admin:{username:string,created:boolean,passwordSet:boolean}, log:string[]}}
 */
function initDataDir(dataDir, opts) {
  opts = opts || {};
  const logLines = [];
  const log = (m) => { logLines.push(m); if (typeof opts.log === "function") opts.log(m); };
  fs.mkdirSync(dataDir, { recursive: true });

  // 1) 旧库名改名（qa-mini.db → echoanswer.db，含 WAL 边车）
  let dbFile = path.join(dataDir, "echoanswer.db");
  const legacy = path.join(dataDir, "qa-mini.db");
  if (!fs.existsSync(dbFile) && fs.existsSync(legacy)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = legacy + suffix;
      if (fs.existsSync(src)) fs.renameSync(src, dbFile + suffix);
    }
    log("旧库 qa-mini.db 已改名 → echoanswer.db");
  }

  // 2) 旧配置
  let config = opts.config || DEFAULTS;
  if (!opts.config && opts.configFile && fs.existsSync(opts.configFile)) {
    try { config = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(opts.configFile, "utf8"))); }
    catch (e) { log("config.json 解析失败，按默认值播种: " + e.message); }
  }

  // 预设管理员密码优先级：env（opts.adminPassword）> 存量 config 明文密码（迁移后即哈希入库）
  const presetPw = String(opts.adminPassword || "") || String((config.security && config.security.admin_password) || "");
  const seedOpts = Object.assign({}, opts, { adminPassword: presetPw });

  const fresh = !fs.existsSync(dbFile);
  let freshAdmin = { username: opts.adminUsername || "admin", created: false, passwordSet: false };
  if (fresh) {
    // 全新安装：直接建 v2 schema（无旧数据可丢 → 无需备份）
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("BEGIN");
    try {
      for (const sql of V1_DDL) db.exec(sql); // 基础表（含 pos 列，保持旧列面）
      applyV2Schema(db, log);
      seedProtocolDefaults(db, config, log);
      seedSystemConfigs(db, config, log);
      freshAdmin = seedAdminUser(db, seedOpts, log);
      const agentId = seedAgent(db, config, log);
      seedAccessCodes(db, config, freshAdmin.created ? freshAdmin.id : null, log);
      applyV3Schema(db, log);
      applyV4Data(db, log);
      applyV5Schema(db, log);
      applyV6Schema(db, log);
      applyV7Schema(db, log);
      applyV8Data(db, config, log);
      applyV9Schema(db, log);
      db.exec("PRAGMA user_version = " + V9);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
    log("全新安装：已建 v9 schema");
    if (opts.configFile && config && config.security && String(config.security.admin_password || "")) {
      clearConfigAdminPassword(opts.configFile, log);
    }
    clearConfigIdentityFields(opts.configFile, log);
    db.close();
    return { dbFile, migrated: true, fresh: true, backupDir: null, admin: freshAdmin, log: logLines };
  }

  // 既有库：判定版本
  const probe = new DatabaseSync(dbFile, { readOnly: true });
  const version = Number(probe.prepare("PRAGMA user_version").get().user_version);
  const hasSessions = tableExists(probe, "sessions");
  probe.close();

  if (version >= V9) {
    log("schema 已是 v" + version + "，跳过迁移");
    return { dbFile, migrated: false, fresh: false, backupDir: null, admin: { username: opts.adminUsername || "admin", created: false, passwordSet: false }, log: logLines };
  }

  // v1 → v2 → v3（user_version 0 但有 sessions 表 = 历史库，从未打版本号）
  const backupDir = backupDbFile(dbFile, dataDir, log);
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("BEGIN");
  let admin = { username: opts.adminUsername || "admin", created: false, passwordSet: false };
  try {
    if (version < V2) {
      if (!hasSessions) {
        // 异常态：有库文件但无 sessions 表 → 按 v1 补基础表
        for (const sql of V1_DDL) db.exec(sql);
        log("检测到空库：已补建基础表");
      }
      applyV2Schema(db, log);
      seedProtocolDefaults(db, config, log);
      seedSystemConfigs(db, config, log);
      admin = seedAdminUser(db, seedOpts, log);
      const agentId = seedAgent(db, config, log);
      seedAccessCodes(db, config, admin.created ? admin.id : null, log);
      attributeSessions(db, admin.created ? admin.id : null, agentId, log);
      db.exec("PRAGMA user_version = " + V2);
    }
    if (version < V3) {
      applyV3Schema(db, log);
      db.exec("PRAGMA user_version = " + V3);
    }
    if (version < V4) {
      applyV4Data(db, log);
      db.exec("PRAGMA user_version = " + V4);
    }
    if (version < V5) {
      applyV5Schema(db, log);
      db.exec("PRAGMA user_version = " + V5);
    }
    if (version < V6) {
      applyV6Schema(db, log);
      db.exec("PRAGMA user_version = " + V6);
    }
    if (version < V7) {
      applyV7Schema(db, log);
      db.exec("PRAGMA user_version = " + V7);
    }
    if (version < V8) {
      applyV8Data(db, config, log);
      db.exec("PRAGMA user_version = " + V8);
    }
    if (version < V9) {
      applyV9Schema(db, log);
      db.exec("PRAGMA user_version = " + V9);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.close();
    throw e; // 文件备份仍在 backupDir
  }
  log("迁移完成：v" + (version || "0(历史库)") + " → v" + V9);
  if (opts.configFile && config.security && String(config.security.admin_password || "")) {
    clearConfigAdminPassword(opts.configFile, log);
  }
  clearConfigIdentityFields(opts.configFile, log);
  return { dbFile, migrated: true, fresh: false, backupDir, admin, log: logLines };
}

module.exports = { initDataDir, backfillSessionsForAdmin, V2, V3, V7, V8, V9, FUTURE_ISO };
