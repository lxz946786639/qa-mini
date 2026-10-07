"use strict";
// v2 数据层（多用户/多智能体体系）：全部表的预编译 CRUD + 增量写入。
//  - 唯一允许触碰 data/ 下数据库文件的模块（lib/config.js 只管配置引导）。
//  - 时间一律 ISO-8601 字符串；布尔存 INTEGER；JSON 存 TEXT（PG 兼容口径）。
//  - 历史上限 100 条/会话（与现状一致的环形语义，改为增量删除最旧）。
//  - 打开时断言 schema v2；建表/迁移见 lib/migrations.js。

const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { tokenHash } = require("./auth");

const PROTOCOLS = ["openai", "dify", "generic", "ragflow"];
const HISTORY_MAX = 100;
const ANON_CODE = "ANON"; // 匿名共享桶特殊访问码（非 6 位数字，登录端点不可用）

function isObj(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
function nowISO() { return new Date().toISOString(); }
function genId(bytes) {
  bytes = bytes || 4;
  return crypto.randomBytes(bytes).toString("hex");
}
function parseJSON(v, fallback) {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    const o = JSON.parse(v);
    return isObj(o) ? o : fallback;
  } catch { return fallback; }
}

function sessionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    protocol: row.protocol,
    continue_session: Number(row.continue_session) === 1,
    protocol_config: parseJSON(row.protocol_config, {}),
    // audio_remote 归一化：v1 历史行可能是 '{}'（ALTER 默认值）→ 按默认对象兜底，显式字段优先
    audio_remote: Object.assign({ enabled: false, preferred_device: "" }, parseJSON(row.audio_remote, {})),
    dify_conversation_id: row.dify_conversation_id || "",
    ragflow_session_id: row.ragflow_session_id || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    // v2 归属字段
    user_id: row.user_id || null,
    agent_id: row.agent_id || null,
    access_mode: row.access_mode || "user",
    access_code_id: row.access_code_id || null
  };
}

function recordFromRow(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq),
    session_id: row.session_id,
    id: row.id,
    question: row.question,
    answer: row.answer,
    protocol: row.protocol,
    protocol_name: row.protocol_name,
    source: row.source,
    started_at: row.started_at,
    finished_at: row.finished_at || null,
    ok: Number(row.ok) === 1,
    detail: row.detail || "",
    // P8.12：持久化记录回读时补齐状态字段（内存记录在 QaRunner 内维护 status）；
    // P8.21：ok=1 的成功记录即使 finished_at 为空（迁移遗留空串/NULL）也视为 done，
    // 避免前端把历史卡永远显示为「生成中」；运行期记录仅在完成时落库并带 finished_at，
    // 故库中无 finished_at 且 ok=0 的行（理论不出现）仍按 running 回读
    status: (row.finished_at || row.ok) ? "done" : "running"
  };
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || "",
    role: row.role || "user",
    status: row.status || "active",
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at || null
  }; // 不映射 password_hash（listUsers 视图天然剥离）
}

function agentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    icon: row.icon || "",
    enabled: Number(row.enabled) === 1,
    sort: Number(row.sort) || 0,
    prompt: row.prompt || "",
    // P8.8 访问控制（缺列/缺值 = 允许，兼容迁移前读取）
    allow_anon: Number(row.allow_anon ?? 1) === 1,
    allow_code: Number(row.allow_code ?? 1) === 1,
    allow_user: Number(row.allow_user ?? 1) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function codeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    agent_id: row.agent_id || null,
    status: row.status || "active",
    created_at: row.created_at,
    expires_at: row.expires_at,
    created_by: row.created_by || null
  };
}

class Store {
  constructor(db, { dbFile } = {}) {
    this.db = db;
    this.dbFile = dbFile || null;
  }

  /** 打开 v2 数据库（文件须已由 migrations.initDataDir 初始化）。 */
  static open(dbFile) {
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 3000;");
    db.exec("PRAGMA foreign_keys = ON;");
    const v = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (v < 2) {
      db.close();
      throw new Error("数据库 schema 版本过低（" + v + " < 2），请先运行 migrations.initDataDir");
    }
    return new Store(db, { dbFile });
  }

  close() { try { this.db.close(); } catch { /* 忽略 */ } }

  // ================= users =================

  createUser({ username, passwordHash, displayName, role, status }) {
    const id = genId(4);
    const t = nowISO();
    this.db.prepare(
      "INSERT INTO users (id, username, password_hash, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(id, String(username), passwordHash, displayName || "", role || "user", status || "active", t, t);
    return this.getUser(id);
  }

  getUser(id) {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!row) return null;
    const u = userFromRow(row);
    u.password_hash = row.password_hash;
    return u;
  }

  getUserByUsername(username) {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(String(username));
    if (!row) return null;
    const u = userFromRow(row);
    u.password_hash = row.password_hash;
    return u;
  }

  listUsers() {
    return this.db.prepare("SELECT * FROM users ORDER BY created_at ASC, id ASC").all().map(userFromRow);
  }

  countAdmins() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n);
  }

  updateUser(id, patch) {
    const sets = [];
    const vals = [];
    for (const k of ["display_name", "role", "status", "password_hash", "last_login_at"]) {
      if (patch[k] !== undefined) { sets.push(k + " = ?"); vals.push(patch[k]); }
    }
    if (!sets.length) return this.getUser(id);
    sets.push("updated_at = ?");
    vals.push(nowISO());
    vals.push(id);
    this.db.prepare("UPDATE users SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
    return this.getUser(id);
  }

  removeUser(id) { this.db.prepare("DELETE FROM users WHERE id = ?").run(id); }

  // ================= agents =================

  createAgent({ code, name, description, icon, enabled, sort, prompt, allow_anon, allow_code, allow_user }) {
    const id = genId(4);
    const t = nowISO();
    this.db.prepare(
      "INSERT INTO agents (id, code, name, description, icon, enabled, sort, prompt, allow_anon, allow_code, allow_user, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(id, String(code), String(name), description || "", icon || "",
      enabled === false ? 0 : 1, Number(sort) || 0, prompt || "",
      allow_anon === false ? 0 : 1, allow_code === false ? 0 : 1, allow_user === false ? 0 : 1, t, t);
    return this.getAgent(id);
  }

  getAgent(id) { const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id); return agentFromRow(row); }
  getAgentByCode(code) { const row = this.db.prepare("SELECT * FROM agents WHERE code = ?").get(String(code)); return agentFromRow(row); }
  listAgents(opts) {
    opts = opts || {};
    let sql = "SELECT * FROM agents";
    if (opts.enabledOnly) sql += " WHERE enabled = 1";
    sql += " ORDER BY sort ASC, created_at ASC";
    return this.db.prepare(sql).all().map(agentFromRow);
  }
  countAgents() { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM agents").get().n); }

  updateAgent(id, patch) {
    const sets = [];
    const vals = [];
    for (const k of ["name", "description", "icon", "prompt"]) {
      if (patch[k] !== undefined) { sets.push(k + " = ?"); vals.push(patch[k]); }
    }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); vals.push(patch.enabled ? 1 : 0); }
    if (patch.sort !== undefined) { sets.push("sort = ?"); vals.push(Number(patch.sort) || 0); }
    // P8.8 访问控制（布尔 → INTEGER 1/0）
    for (const k of ["allow_anon", "allow_code", "allow_user"]) {
      if (patch[k] !== undefined) { sets.push(k + " = ?"); vals.push(patch[k] ? 1 : 0); }
    }
    if (!sets.length) return this.getAgent(id);
    sets.push("updated_at = ?");
    vals.push(nowISO());
    vals.push(id);
    this.db.prepare("UPDATE agents SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
    return this.getAgent(id);
  }

  removeAgent(id) { this.db.prepare("DELETE FROM agents WHERE id = ?").run(id); }

  // ================= agent_configs =================

  getAgentConfig(agentId) {
    const row = this.db.prepare("SELECT * FROM agent_configs WHERE agent_id = ?").get(agentId);
    if (!row) return null;
    return { agent_id: row.agent_id, protocol: row.protocol, config: parseJSON(row.config_json, {}), updated_at: row.updated_at };
  }

  setAgentConfig(agentId, protocol, configObj) {
    if (!PROTOCOLS.includes(protocol)) throw new Error("未知协议: " + protocol);
    const t = nowISO();
    const json = JSON.stringify(configObj || {});
    this.db.prepare(
      "INSERT INTO agent_configs (agent_id, protocol, config_json, created_at, updated_at) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(agent_id) DO UPDATE SET protocol = excluded.protocol, config_json = excluded.config_json, updated_at = excluded.updated_at"
    ).run(agentId, protocol, json, t, t);
    return this.getAgentConfig(agentId);
  }

  // ================= protocol_defaults =================

  getProtocolDefaults() {
    const out = {};
    for (const row of this.db.prepare("SELECT * FROM protocol_defaults").all()) {
      out[row.name] = parseJSON(row.config_json, {});
    }
    return out;
  }

  setProtocolDefault(name, configObj) {
    if (!PROTOCOLS.includes(name)) throw new Error("未知协议: " + name);
    const t = nowISO();
    this.db.prepare(
      "INSERT INTO protocol_defaults (name, config_json, updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(name) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at"
    ).run(name, JSON.stringify(configObj || {}), t);
  }

  // ================= system_configs =================

  getSystemConfig(key) {
    const row = this.db.prepare("SELECT value_json FROM system_configs WHERE key = ?").get(key);
    if (!row) return null;
    try { return JSON.parse(row.value_json); } catch { return null; }
  }

  setSystemConfig(key, value) {
    const t = nowISO();
    this.db.prepare(
      "INSERT INTO system_configs (key, value_json, updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at"
    ).run(String(key), JSON.stringify(value === undefined ? null : value), t);
  }

  listSystemConfigs() {
    const out = {};
    for (const row of this.db.prepare("SELECT * FROM system_configs").all()) {
      try { out[row.key] = JSON.parse(row.value_json); } catch { out[row.key] = null; }
    }
    return out;
  }

  // ================= access_codes =================

  createAccessCode({ code, agentId, expiresAt, createdBy }) {
    const id = genId(4);
    const t = nowISO();
    this.db.prepare(
      "INSERT INTO access_codes (id, code, agent_id, status, created_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?)"
    ).run(id, String(code), agentId || null, "active", t,
      expiresAt || new Date(Date.now() + 8 * 3600e3).toISOString(), createdBy || null);
    return this.getAccessCode(id);
  }

  getAccessCode(id) { const row = this.db.prepare("SELECT * FROM access_codes WHERE id = ?").get(id); return codeFromRow(row); }
  getAccessCodeByCode(code) { const row = this.db.prepare("SELECT * FROM access_codes WHERE code = ?").get(String(code)); return codeFromRow(row); }
  listAccessCodes() {
    return this.db.prepare("SELECT * FROM access_codes ORDER BY created_at DESC").all().map(codeFromRow);
  }

  // 有效码 = active 且未过期（登录用；atMs 缺省 = 当前时间）
  findValidAccessCode(code, atMs) {
    const c = this.getAccessCodeByCode(code);
    if (!c || c.status !== "active") return null;
    const at = atMs === undefined ? Date.now() : atMs;
    if (Date.parse(c.expires_at) <= at) return null;
    return c;
  }

  // 延期：max(当前到期, now) + hours（与现状 renew 语义一致）
  renewAccessCode(id, hours) {
    const c = this.getAccessCode(id);
    if (!c) return null;
    const base = Math.max(Date.parse(c.expires_at), Date.now());
    const exp = new Date(base + Number(hours) * 3600e3).toISOString();
    this.db.prepare("UPDATE access_codes SET expires_at = ? WHERE id = ?").run(exp, id);
    return this.getAccessCode(id);
  }

  updateAccessCode(id, patch) {
    const sets = [];
    const vals = [];
    if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
    if (patch.expires_at !== undefined) { sets.push("expires_at = ?"); vals.push(patch.expires_at); }
    if (patch.agent_id !== undefined) { sets.push("agent_id = ?"); vals.push(patch.agent_id || null); }
    if (!sets.length) return this.getAccessCode(id);
    vals.push(id);
    this.db.prepare("UPDATE access_codes SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
    return this.getAccessCode(id);
  }

  removeAccessCode(id) { this.db.prepare("DELETE FROM access_codes WHERE id = ?").run(id); }
  removeExpiredAccessCodes(atMs) {
    const exp = new Date(atMs === undefined ? Date.now() : atMs).toISOString();
    const r = this.db.prepare("DELETE FROM access_codes WHERE expires_at <= ? AND status = 'active'").run(exp);
    return Number(r.changes);
  }
  hasAccessCodeCode(code) {
    return !!this.db.prepare("SELECT 1 AS x FROM access_codes WHERE code = ?").get(String(code));
  }

  // ================= auth_sessions =================

  createAuthSession({ token, principalType, userId, accessCodeId, ip, userAgent, ttlMs }) {
    const id = genId(4);
    const t = nowISO();
    const exp = new Date(Date.now() + (ttlMs || 12 * 3600e3)).toISOString();
    this.db.prepare(
      "INSERT INTO auth_sessions (id, token_hash, principal_type, user_id, access_code_id, ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(id, tokenHash(token), principalType, userId || null, accessCodeId || null,
      String(ip || ""), String(userAgent || "").slice(0, 256), t, exp);
    return this.getAuthSession(id);
  }

  getAuthSession(id) {
    const row = this.db.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id);
    return row || null;
  }

  // 有效会话 = 哈希命中 + 未吊销 + 未过期
  getValidAuthSessionByToken(token) {
    if (!token) return null;
    const row = this.db.prepare(
      "SELECT * FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?"
    ).get(tokenHash(String(token)), nowISO());
    return row || null;
  }

  revokeAuthSessionByToken(token) {
    if (!token) return 0;
    const r = this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(nowISO(), tokenHash(String(token)));
    return Number(r.changes);
  }

  revokeAuthSessionsForUser(userId) {
    const r = this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(nowISO(), userId);
    return Number(r.changes);
  }

  revokeAuthSessionsForCode(accessCodeId) {
    const r = this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE access_code_id = ? AND revoked_at IS NULL").run(nowISO(), accessCodeId);
    return Number(r.changes);
  }

  countAuthSessions() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?").get(nowISO()).n);
  }

  // P8.35：有效会话枚举（访问控制在线列表：登录用户/访问码用户按会话统计）
  listAuthSessions() {
    return this.db.prepare("SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(nowISO());
  }

  revokeAuthSessionById(id) {
    if (!id) return 0;
    const r = this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowISO(), String(id));
    return Number(r.changes);
  }

  pruneAuthSessions() {
    const r = this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(nowISO());
    return Number(r.changes);
  }

  // ================= audit_logs =================

  insertAudit({ actorType, actorId, action, targetType, targetId, detail, ip, userAgent }) {
    this.db.prepare(
      "INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, detail_json, ip, user_agent, created_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(
      actorType || "system", actorId || null, String(action),
      targetType || null, targetId || null,
      JSON.stringify(detail || {}), String(ip || ""), String(userAgent || "").slice(0, 256), nowISO()
    );
  }

  listAuditLogs(opts) {
    opts = opts || {};
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    return this.db.prepare(
      "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?"
    ).all(limit, offset).map((r) => ({
      id: Number(r.id), actor_type: r.actor_type, actor_id: r.actor_id || null,
      action: r.action, target_type: r.target_type || null, target_id: r.target_id || null,
      detail: parseJSON(r.detail_json, {}), ip: r.ip || "", user_agent: r.user_agent || "", created_at: r.created_at
    }));
  }

  // ================= sessions（v2） =================

  createSession(opts) {
    const t = nowISO();
    const s = {
      id: opts.id || genId(4),
      name: opts.name || "新会话",
      token: opts.token || ("kaasr_" + crypto.randomBytes(24).toString("hex")),
      protocol: opts.protocol || "ragflow",
      continue_session: opts.continue_session !== false,
      protocol_config: opts.protocol_config || {},
      audio_remote: isObj(opts.audio_remote) ? opts.audio_remote : { enabled: false, preferred_device: "" },
      dify_conversation_id: opts.dify_conversation_id || "",
      ragflow_session_id: opts.ragflow_session_id || "",
      user_id: opts.user_id || null,
      agent_id: opts.agent_id || null,
      access_mode: opts.access_mode || "user",
      access_code_id: opts.access_code_id || null,
      created_at: opts.created_at || t,
      updated_at: opts.updated_at || t
    };
    this.db.prepare(
      "INSERT INTO sessions (id, name, token, protocol, continue_session, protocol_config, audio_remote, " +
      "dify_conversation_id, ragflow_session_id, created_at, updated_at, user_id, agent_id, access_mode, access_code_id) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      s.id, s.name, s.token, s.protocol, s.continue_session ? 1 : 0,
      JSON.stringify(s.protocol_config), JSON.stringify(s.audio_remote),
      s.dify_conversation_id, s.ragflow_session_id, s.created_at, s.updated_at,
      s.user_id, s.agent_id, s.access_mode, s.access_code_id
    );
    return this.getSession(s.id);
  }

  getSession(id) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return sessionFromRow(row);
  }

  getSessionByToken(token) {
    if (!token) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE token = ?").get(String(token));
    return sessionFromRow(row);
  }

  /**
   * 列表（桶语义）：
   *  - { accessCodeId, agentId }      → 共享桶 (access_code_id, agent_id)
   *  - { userId, agentId }            → 私有桶 (user_id, agent_id)
   *  - { agentId } / {}               → 全部（管理端，可按 agent 过滤）
   * 排序：updated_at 倒序（现状语义），id 升序兜底。
   */
  listSessions(opts) {
    opts = opts || {};
    const where = [];
    const vals = [];
    if (opts.accessCodeId) {
      where.push("access_mode = 'access_code' AND access_code_id = ?");
      vals.push(opts.accessCodeId);
      if (opts.agentId) { where.push("agent_id = ?"); vals.push(opts.agentId); }
    } else if (opts.userId) {
      where.push("access_mode = 'user' AND user_id = ?");
      vals.push(opts.userId);
      if (opts.agentId) { where.push("agent_id = ?"); vals.push(opts.agentId); }
    } else if (opts.agentId) {
      where.push("agent_id = ?");
      vals.push(opts.agentId);
    }
    let sql = "SELECT * FROM sessions";
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY updated_at DESC, id ASC";
    return this.db.prepare(sql).all(...vals).map(sessionFromRow);
  }

  countSessions(opts) { return this.listSessions(opts).length; }

  // 会话归属判定（IDOR 防护核心）：
  //  admin → 任意；user → (user_id, agent_id) 私有桶；code → (access_code_id, agent_id) 共享桶。
  //  返回会话或 null（不区分"不存在"与"不属于你"，防探测）。
  canViewSession(principal, session) {
    if (!session) return null;
    if (!principal) return null;
    if (principal.kind === "admin") return session;
    if (principal.kind === "user") {
      if (session.access_mode === "user" && session.user_id === principal.userId) return session;
      return null;
    }
    if (principal.kind === "access_code") {
      if (session.access_mode === "access_code" && session.access_code_id === principal.codeId) return session;
      return null;
    }
    return null;
  }

  /**
   * 更新会话字段。opts.updatedAt：显式指定 updated_at（缺省 = 当前时间）。
   * 用于「内存事实源 → DB」差异同步：仅持久化内存中的时间戳，不额外刷新。
   */
  updateSession(id, patch, opts) {
    const sets = [];
    const vals = [];
    for (const k of ["name", "protocol", "token", "dify_conversation_id", "ragflow_session_id"]) {
      if (patch[k] !== undefined) { sets.push(k + " = ?"); vals.push(patch[k]); }
    }
    for (const k of ["user_id", "agent_id", "access_mode", "access_code_id"]) {
      if (patch[k] !== undefined) { sets.push(k + " = ?"); vals.push(patch[k] == null ? null : String(patch[k])); }
    }
    if (patch.continue_session !== undefined) { sets.push("continue_session = ?"); vals.push(patch.continue_session ? 1 : 0); }
    if (patch.protocol_config !== undefined) { sets.push("protocol_config = ?"); vals.push(JSON.stringify(patch.protocol_config)); }
    if (patch.audio_remote !== undefined) { sets.push("audio_remote = ?"); vals.push(JSON.stringify(patch.audio_remote)); }
    if (!sets.length) return this.getSession(id);
    sets.push("updated_at = ?");
    vals.push(opts && opts.updatedAt ? String(opts.updatedAt) : nowISO());
    vals.push(id);
    this.db.prepare("UPDATE sessions SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
    return this.getSession(id);
  }

  touchSession(id) {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowISO(), id);
  }

  // P3 首启一次性回填：v1/v2 存量会话（access_mode='user' 双轨形态）→ 'shared' 共享桶。
  // 幂等：system_configs['p3.scoped_migrated'] 标记；返回回填行数。
  migrateLegacyToShared() {
    if (this.getSystemConfig("p3.scoped_migrated")) return 0;
    const r = this.db.prepare("UPDATE sessions SET access_mode = 'shared' WHERE access_mode = 'user'").run();
    this.setSystemConfig("p3.scoped_migrated", new Date().toISOString());
    return Number(r.changes);
  }

  removeSession(id) {
    this.db.prepare("DELETE FROM records WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ================= records =================

  /** 追加一条问答记录，并保持每会话最多 100 条（环形语义，增量删除最旧）。 */
  appendRecord(sessionId, rec) {
    this.db.prepare(
      "INSERT INTO records (session_id, id, question, answer, protocol, protocol_name, source, started_at, finished_at, ok, detail) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      sessionId, rec.id, rec.question, rec.answer || "", rec.protocol || "", rec.protocol_name || "",
      rec.source || "", rec.started_at || nowISO(), rec.finished_at || null,
      rec.ok ? 1 : 0, rec.detail || ""
    );
    // 删除超出上限的最旧行（保留最新 HISTORY_MAX 条）
    this.db.prepare(
      "DELETE FROM records WHERE session_id = ? AND " +
      "(SELECT COUNT(*) FROM records r2 WHERE r2.session_id = records.session_id AND r2.seq > records.seq) >= ?"
    ).run(sessionId, HISTORY_MAX);
  }

  listRecords(sessionId) {
    return this.db.prepare("SELECT * FROM records WHERE session_id = ? ORDER BY seq DESC").all(sessionId).map(recordFromRow);
  }

  removeRecord(sessionId, recId) {
    this.db.prepare("DELETE FROM records WHERE session_id = ? AND id = ?").run(sessionId, recId);
  }

  countRecords() { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM records").get().n); }

  // P8.21：归一化遗留中断记录——迁移前的旧数据 finished_at 可能为空串/NULL（运行期记录
  // 仅在完成时落库，故空值只可能是遗留数据）→ 回填 started_at（时长 ≈ 0s，detail 保留原文），
  // 启动时调用一次；幂等（第二次起 changes = 0）
  normalizeLegacyFinished() {
    const r = this.db.prepare("UPDATE records SET finished_at = started_at WHERE finished_at IS NULL OR finished_at = ''").run();
    return Number(r.changes);
  }

  // ================= 统计（管理端仪表盘） =================

  stats() {
    const today = new Date().toISOString().slice(0, 10);
    return {
      users: Number(this.db.prepare("SELECT COUNT(*) AS n FROM users").get().n),
      admins: this.countAdmins(),
      agents: this.countAgents(),
      agents_enabled: Number(this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE enabled = 1").get().n),
      sessions: this.countSessions({}),
      records: this.countRecords(),
      qa_today: Number(this.db.prepare("SELECT COUNT(*) AS n FROM records WHERE started_at >= ?").get(today + "T00:00:00").n),
      access_codes: Number(this.db.prepare("SELECT COUNT(*) AS n FROM access_codes WHERE status = 'active' AND expires_at > ?").get(nowISO()).n),
      auth_sessions: this.countAuthSessions()
    };
  }
}

module.exports = { Store, PROTOCOLS, HISTORY_MAX, ANON_CODE, sessionFromRow, recordFromRow };
