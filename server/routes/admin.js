"use strict";
// 管理路由（双轨期）：
//  访问码生成/延期/清理/失效 + /api/config GET/PUT（深合并 → config.json + v2 库同步）
const { sendJSON, parseJSONBody, maskConfigForBroadcast, ipOf } = require("../middleware");
const { deepMerge, validateConfig, saveConfig, resolveProtocolConfig, PROTOCOLS } = require("../../lib/config");
const { hashPassword } = require("../../lib/auth");
const { syncConfigToStore } = require("../services/config_sync");

function register(router, ctx) {
  const admin401 = (req, urlObj, res) => {
    if (!ctx.auth.isAdmin(req, urlObj)) {
      sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return true;
    }
    return false;
  };

  // ---- 访问码（管理）----
  router.exact("POST", "/api/admin/access-codes", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    return ctx.codes.handleAdd(req, res);
  });
  router.exact("DELETE", "/api/admin/access-codes/expired", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    ctx.codes.handleCleanupExpired(res);
    return Promise.resolve();
  });
  router.regex("POST", /^\/api\/admin\/access-codes\/([A-Za-z0-9]+)\/renew$/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    return ctx.codes.handleRenew(req, res, params[0]);
  });
  router.regex("DELETE", /^\/api\/admin\/access-codes\/([A-Za-z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    ctx.codes.handleInvalidate(res, params[0]);
    return Promise.resolve();
  });

  // ---- 用户（管理 · P3 多用户；管理员创建制）----
  const userView = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, status: u.status, created_at: u.created_at, last_login_at: u.last_login_at || null });
  const actorId = (req, urlObj) => { const p = ctx.auth.principal(req, urlObj); return p && p.userId ? p.userId : null; };

  router.exact("GET", "/api/admin/users", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    sendJSON(res, 200, { users: ctx.store.listUsers().map(userView) });
    return Promise.resolve();
  });
  router.exact("POST", "/api/admin/users", async (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return;
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : "请求体必须是 JSON" }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const pw = typeof body.password === "string" ? body.password : "";
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return sendJSON(res, 400, { ok: false, detail: "用户名需 2-32 位字母/数字/_/-." });
    if (pw.length < 4 || pw.length > 64) return sendJSON(res, 400, { ok: false, detail: "密码需 4-64 位字符" });
    const role = body.role === "admin" ? "admin" : "user";
    const display_name = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 32) : username;
    if (ctx.store.getUserByUsername(username)) return sendJSON(res, 409, { ok: false, detail: "用户名已存在" });
    const u = ctx.store.createUser({ username, passwordHash: hashPassword(pw), displayName: display_name, role });
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "users.create", targetType: "user", targetId: u.id, detail: { username, role }, ip: ipOf(req) });
    return sendJSON(res, 201, { ok: true, user: userView(u) });
  });
  router.regex("PATCH", /^\/api\/admin\/users\/([a-zA-Z0-9]+)$/, async (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return;
    const u = ctx.store.getUser(params[0]);
    if (!u) return sendJSON(res, 404, { ok: false, detail: "用户不存在: " + params[0] });
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : "请求体必须是 JSON" }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    const patch = {};
    const changed = {};
    if (body.display_name !== undefined) {
      if (typeof body.display_name !== "string") return sendJSON(res, 400, { ok: false, detail: "display_name 必须是字符串" });
      patch.display_name = body.display_name.trim().slice(0, 32); changed.display_name = patch.display_name;
    }
    if (body.role !== undefined) {
      if (body.role !== "user" && body.role !== "admin") return sendJSON(res, 400, { ok: false, detail: "role 必须是 user 或 admin" });
      patch.role = body.role; changed.role = body.role;
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "disabled") return sendJSON(res, 400, { ok: false, detail: "status 必须是 active 或 disabled" });
      patch.status = body.status; changed.status = body.status;
    }
    if (body.password !== undefined) {
      const pw = typeof body.password === "string" ? body.password : "";
      if (pw.length < 4 || pw.length > 64) return sendJSON(res, 400, { ok: false, detail: "密码需 4-64 位字符" });
      patch.password_hash = hashPassword(pw); changed.password = "••••";
    }
    if (!Object.keys(patch).length) return sendJSON(res, 400, { ok: false, detail: "无有效字段（display_name/role/status/password）" });
    // 守护：不得移除最后一个 active 管理员
    if (u.role === "admin" && u.status === "active" && ((patch.role && patch.role !== "admin") || (patch.status && patch.status !== "active"))) {
      const activeAdmins = ctx.store.listUsers().filter((x) => x.role === "admin" && x.status === "active").length;
      if (activeAdmins <= 1) return sendJSON(res, 400, { ok: false, detail: "不能停用最后一个 active 管理员" });
    }
    const updated = ctx.store.updateUser(u.id, patch);
    if (patch.status === "disabled") ctx.store.revokeAuthSessionsForUser(u.id); // 停用 → cookie 会话全吊销
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "users.update", targetType: "user", targetId: u.id, detail: changed, ip: ipOf(req) });
    return sendJSON(res, 200, { ok: true, user: userView(updated) });
  });

  // ---- GET /api/config（管理 · 全量）----
  router.exact("GET", "/api/config", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    sendJSON(res, 200, ctx.config);
    return Promise.resolve();
  });

  // ---- PUT /api/config（管理 · 深合并 → 落盘 + v2 库同步）----
  router.exact("PUT", "/api/config", async (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return;
    let patch;
    try { patch = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) }); }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    const next = deepMerge(ctx.config, patch);
    const problems = validateConfig(next);
    if (problems.length) {
      return sendJSON(res, 400, { ok: false, detail: "配置无效: " + problems.join("；") });
    }
    try {
      saveConfig(ctx.configFile, next);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, detail: "配置保存失败: " + e.message });
    }
    const prev = ctx.config;
    ctx.config = next;
    // 全局协议配置变化 → 回退全局的会话（对应字段留空）后端上下文失效：
    // ragflow 的 url/api_key/chat_id、dify 的 url/api_key 变化时清空会话后端会话 ID，
    // 下次提问按新配置重建（否则旧会话不属于新 chat → RAGFlow 报错/空回答）
    let invalidated = 0;
    for (const s of ctx.manager.getSessions()) {
      const p = s.protocol;
      if (p !== "ragflow" && p !== "dify") continue;
      const a = resolveProtocolConfig(s, prev, p);
      const b = resolveProtocolConfig(s, next, p);
      const sameStr = (x, y) => String(x || "") === String(y || "");
      if (p === "ragflow" &&
          (!sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key) || !sameStr(a.chat_id, b.chat_id))) {
        if (s.ragflow_session_id) { s.ragflow_session_id = ""; invalidated++; }
      }
      if (p === "dify" && (!sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key))) {
        if (s.dify_conversation_id) { s.dify_conversation_id = ""; invalidated++; }
      }
    }
    if (invalidated) ctx.manager.save();
    try {
      syncConfigToStore(ctx.store, next); // v2 库同步（protocol_defaults/system_configs/access_codes/admin 密码）
    } catch (e) {
      console.error("[config] v2 库同步失败（已落盘 config.json）:", e && e.message || e);
    }
    ctx.codes.refreshMirror();
    ctx.bus.emit("config", { ok: true, config: maskConfigForBroadcast(next) });
    return sendJSON(res, 200, { ok: true, config: next, invalidated_sessions: invalidated });
  });

  // ---- 智能体（管理 · P3 多智能体；每智能体一个协议，存 agent_configs）----
  const agentViewFull = (x) => {
    const cfg = ctx.store.getAgentConfig(x.id);
    const m = JSON.parse(JSON.stringify((cfg && cfg.config) || {}));
    if (m && typeof m.api_key === "string" && m.api_key) m.api_key = "…已设置";
    return { id: x.id, code: x.code, name: x.name, description: x.description || "", icon: x.icon || "", enabled: x.enabled, sort: x.sort, prompt: x.prompt || "", protocol: (cfg && cfg.protocol) || "ragflow", config: m, allow_anon: x.allow_anon, allow_code: x.allow_code, allow_user: x.allow_user };
  };

  router.exact("GET", "/api/admin/agents", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    sendJSON(res, 200, { agents: ctx.store.listAgents({}).map(agentViewFull) });
    return Promise.resolve();
  });
  router.exact("POST", "/api/admin/agents", async (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return;
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : "请求体必须是 JSON" }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "code 需 2-32 位小写字母/数字/-/_（首字符非符号）" });
    if (!name || name.length > 40) return sendJSON(res, 400, { ok: false, detail: "name 必填且 ≤40 字符" });
    const protocol = typeof body.protocol === "string" && body.protocol ? body.protocol : "ragflow";
    if (!PROTOCOLS.includes(protocol)) return sendJSON(res, 400, { ok: false, detail: "未知协议: " + protocol });
    if (body.config !== undefined && (typeof body.config !== "object" || body.config === null || Array.isArray(body.config))) {
      return sendJSON(res, 400, { ok: false, detail: "config 必须是对象" });
    }
    if (ctx.store.getAgentByCode(code)) return sendJSON(res, 409, { ok: false, detail: "code 已存在" });
    const ag = ctx.store.createAgent({ code, name, description: typeof body.description === "string" ? body.description.trim().slice(0, 200) : "", icon: typeof body.icon === "string" ? body.icon.trim().slice(0, 64) : "", enabled: body.enabled !== false, sort: typeof body.sort === "number" ? body.sort : 0, allow_anon: body.allow_anon !== false, allow_code: body.allow_code !== false, allow_user: body.allow_user !== false });
    ctx.store.setAgentConfig(ag.id, protocol, body.config || {});
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "agents.create", targetType: "agent", targetId: ag.id, detail: { code, name, protocol }, ip: ipOf(req) });
    return sendJSON(res, 201, { ok: true, agent: agentViewFull(ctx.store.getAgent(ag.id)) });
  });
  router.regex("PATCH", /^\/api\/admin\/agents\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/, async (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return;
    const ag0 = ctx.store.getAgentByCode(params[0]);
    if (!ag0) return sendJSON(res, 404, { ok: false, detail: "智能体不存在: " + params[0] });
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : "请求体必须是 JSON" }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    const patch = {};
    const changed = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 40) return sendJSON(res, 400, { ok: false, detail: "name 需 1-40 字符" });
      patch.name = body.name.trim(); changed.name = patch.name;
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") return sendJSON(res, 400, { ok: false, detail: "description 必须是字符串" });
      patch.description = body.description.trim().slice(0, 200); changed.description = patch.description;
    }
    if (body.icon !== undefined) {
      if (typeof body.icon !== "string") return sendJSON(res, 400, { ok: false, detail: "icon 必须是字符串" });
      patch.icon = body.icon.trim().slice(0, 64); changed.icon = patch.icon;
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string") return sendJSON(res, 400, { ok: false, detail: "prompt 必须是字符串" });
      patch.prompt = body.prompt.slice(0, 4000); changed.prompt = "•••";
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return sendJSON(res, 400, { ok: false, detail: "enabled 必须是布尔" });
      patch.enabled = body.enabled; changed.enabled = body.enabled;
    }
    if (body.sort !== undefined) {
      if (typeof body.sort !== "number") return sendJSON(res, 400, { ok: false, detail: "sort 必须是数字" });
      patch.sort = body.sort; changed.sort = body.sort;
    }
    // P8.8 访问控制（布尔）
    for (const k of ["allow_anon", "allow_code", "allow_user"]) {
      if (body[k] !== undefined) {
        if (typeof body[k] !== "boolean") return sendJSON(res, 400, { ok: false, detail: k + " 必须是布尔" });
        patch[k] = body[k]; changed[k] = body[k];
      }
    }
    let protoChanged = false;
    if (body.protocol !== undefined) {
      if (typeof body.protocol !== "string" || !PROTOCOLS.includes(body.protocol)) return sendJSON(res, 400, { ok: false, detail: "未知协议: " + body.protocol });
      protoChanged = true; changed.protocol = body.protocol;
    }
    if (body.config !== undefined) {
      if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) return sendJSON(res, 400, { ok: false, detail: "config 必须是对象" });
      protoChanged = true; changed.config = "•••";
    }
    if (!Object.keys(patch).length && !protoChanged) return sendJSON(res, 400, { ok: false, detail: "无有效字段" });
    const updated = Object.keys(patch).length ? ctx.store.updateAgent(ag0.id, patch) : ctx.store.getAgent(ag0.id);
    if (protoChanged) {
      const cur = ctx.store.getAgentConfig(ag0.id);
      ctx.store.setAgentConfig(ag0.id, typeof body.protocol === "string" ? body.protocol : (cur && cur.protocol) || "ragflow", body.config !== undefined ? body.config : (cur ? cur.config : {}));
      // 协议/配置变更 → 该智能体下会话的后端上下文失效（ragflow/dify 会话 ID 清空）
      let invalidated = 0;
      for (const s of ctx.manager.getSessions()) {
        if ((s.agent_id || null) !== updated.id) continue;
        if (s.ragflow_session_id) { s.ragflow_session_id = ""; invalidated++; }
        if (s.dify_conversation_id) { s.dify_conversation_id = ""; invalidated++; }
      }
      if (invalidated) ctx.manager.save();
    }
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "agents.update", targetType: "agent", targetId: ag0.id, detail: changed, ip: ipOf(req) });
    return sendJSON(res, 200, { ok: true, agent: agentViewFull(ctx.store.getAgent(ag0.id)) });
  });

  // ---- 审计日志（管理 · P3）----
  router.exact("GET", "/api/admin/audit", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    const limit = Math.min(Math.max(Number(urlObj.searchParams.get("limit")) || 100, 1), 500);
    const offset = Math.max(Number(urlObj.searchParams.get("offset")) || 0, 0);
    // listAuditLogs 已返回解析后的 detail（detail_json → detail）
    const items = ctx.store.listAuditLogs({ limit, offset });
    sendJSON(res, 200, { items });
    return Promise.resolve();
  });
}
module.exports = { register };
