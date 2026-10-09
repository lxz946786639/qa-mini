"use strict";
// 管理路由（双轨期）：
//  访问码生成/延期/清理/失效 + /api/config GET/PUT（深合并 → config.json + v2 库同步）
const { sendJSON, parseJSONBody, maskConfigForBroadcast, ipOf, uaOf } = require("../middleware");
const { deepMerge, validateConfig, saveConfig, resolveProtocolConfig, PROTOCOLS, protocolEnabled, PROTOCOL_FIELDS, IDENTITY_FIELDS, AGENT_CFG_KEEP_SENTINEL } = require("../../lib/config");
const { testProtocol } = require("../../lib/protocol_test");
const { EventBus } = require("../services/event_bus");
const { hashPassword } = require("../../lib/auth");
const { syncConfigToStore } = require("../services/config_sync");

// P8.40 权限范围校验：agent id 数组（空 = 允许全部；null = 非法）
function normalizeAgentScope(v, agents) {
  if (v === null || (typeof v === "string" && v.trim() === "")) return [];
  if (!Array.isArray(v)) return null;
  const ids = v.filter((x) => typeof x === "string" && x !== "");
  const known = new Set(agents.map((a) => a.id));
  for (const id of ids) if (!known.has(id)) return null;
  return [...new Set(ids)];
}

function register(router, ctx) {
  const admin401 = (req, urlObj, res) => {
    if (!ctx.auth.isAdmin(req, urlObj)) {
      sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return true;
    }
    return false;
  };

  // P8.81: 会话归属智能体的协议配置（无则 null）——运行时三层解析 / 配置保存失效判定共用
  const agentCfgOf = (s) => {
    if (!s || !s.agent_id) return null;
    const c = ctx.store.getAgentConfig(s.agent_id);
    if (!c || typeof c.config !== "object" || c.config === null) return null;
    // P8.81: 会话协议 = 智能体协议时才参与（与运行时解析同口径，防跨协议字段泄漏）
    if (typeof c.protocol === "string" && typeof s.protocol === "string" && c.protocol !== s.protocol) return null;
    return c.config;
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
  router.regex("PATCH", /^\/api\/admin\/access-codes\/([A-Za-z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    return ctx.codes.handleScope(req, res, params[0], urlObj);
  });
  router.regex("DELETE", /^\/api\/admin\/access-codes\/([A-Za-z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    ctx.codes.handleInvalidate(res, params[0]);
    return Promise.resolve();
  });

  // ---- P8.33/P8.35 访问控制：在线访问者 + 一键踢出 ----
  // 统计口径（P8.35）：登录用户/访问码用户/管理员 = ea_sid cookie 会话（DB auth_sessions，
  // 重启存活，每请求刷新活动快照）；匿名（无凭证）= SSE 长连接「设备指纹 + IP」分组。
  // 踢出：会话目标 = 吊销会话 + evicted（凭证即失效，无禁入冷却）；dev+ip 目标 =
  // evicted + 5 分钟禁入冷却（匿名无法吊销凭证，靠冷却防 F5 回场）。
  const identityLabel = (pr) => {
    if (!pr) return { kind: "unknown", label: "匿名" };
    if (pr.kind === "admin") {
      const u = pr.userId ? ctx.store.getUser(pr.userId) : null;
      return { kind: "admin", label: "管理员" + (u ? "（" + u.username + "）" : "") };
    }
    if (pr.kind === "user") {
      const u = pr.userId ? ctx.store.getUser(pr.userId) : null;
      return { kind: "user", label: (u && u.username) || "用户" };
    }
    if (pr.kind === "code") return { kind: "code", label: "访问码" + (pr.code ? "••••" + pr.code.slice(-2) : "") };
    return { kind: "anon", label: "匿名" };
  };
  // P8.35：auth_sessions 行 → 身份
  const sessionIdentity = (row) => {
    if (row.principal_type === "code") {
      const c = row.access_code_id ? ctx.store.getAccessCode(row.access_code_id) : null;
      return { kind: "code", label: "访问码" + (c && c.code ? "••••" + c.code.slice(-2) : "") };
    }
    const u = row.user_id ? ctx.store.getUser(row.user_id) : null;
    if (u && u.role === "admin") return { kind: "admin", label: "管理员（" + u.username + "）" };
    return { kind: "user", label: (u && u.username) || "用户" };
  };
  router.exact("GET", "/api/admin/online", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    // 1) 会话口径：全部有效 ea_sid 会话（登录用户 / 访问码用户 / 管理员）
    const sessions = ctx.store.listAuthSessions();
    const validSids = new Set(sessions.map((s) => s.id));
    ctx.auth.pruneSessionActivity(validSids);
    const sessRows = new Map(); // sessionId → 在线行
    for (const s of sessions) {
      const act = ctx.auth.sessionActivityOf(s.id) || {};
      sessRows.set(s.id, {
        session_id: s.id, dev: act.dev || "", ip: act.ip || s.ip || "", ua: act.ua || s.user_agent || "",
        kind: "", label: "", connections: 0,
        connected_at: s.created_at, last_seen: act.lastSeenAt || s.created_at
      });
    }
    // 2) 长连接口径：SSE 连接——归属有效会话的并入该会话行；其余（匿名/遗留）按「设备 + IP」分组
    const groups = new Map();
    for (const c of ctx.bus.listOnline()) {
      const dev = (c.meta && c.meta.dev) || "";
      const ip = (c.meta && c.meta.ip) || "";
      const ua = (c.meta && c.meta.ua) || "";
      const ca = (c.meta && c.meta.connectedAt) || "";
      const sid = (c.meta && c.meta.sessionId && validSids.has(c.meta.sessionId)) ? c.meta.sessionId : null;
      if (sid) {
        const r = sessRows.get(sid);
        r.connections += 1;
        if (dev && !r.dev) r.dev = dev;
        if (ua && !r.ua) r.ua = ua;
        if (ip && !r.ip) r.ip = ip;
        continue;
      }
      const key = EventBus.keyOf(dev, ip);
      let g = groups.get(key);
      if (!g) {
        g = { dev, ip, ua, connections: 0, connected_at: ca, principal: null };
        groups.set(key, g);
      }
      g.connections += 1;
      if (ca && (!g.connected_at || ca < g.connected_at)) g.connected_at = ca;
      if (c.principal) g.principal = c.principal; // 同设备主体一致；取最后一条非空
    }
    const online = [
      ...[...sessRows.values()].map((r) => {
        const id = sessionIdentity(ctx.store.getAuthSession(r.session_id));
        return Object.assign({}, r, { kind: id.kind, label: id.label });
      }),
      ...[...groups.values()].map((g) => {
        const id = identityLabel(g.principal);
        return { session_id: null, dev: g.dev, ip: g.ip, ua: g.ua, kind: id.kind, label: id.label,
          connections: g.connections, connected_at: g.connected_at, last_seen: g.connected_at };
      })
    ].sort((a2, b2) => (a2.last_seen < b2.last_seen ? 1 : -1));
    sendJSON(res, 200, { ok: true, count: online.length, online });
    return Promise.resolve();
  });
  router.exact("POST", "/api/admin/online/kick", async (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : "请求体必须是 JSON" }); }
    // P8.35 路径一：cookie 会话（session_id）——吊销会话 + 踢出长连接，无禁入冷却
    const sessionId = String((body && body.session_id) || "").slice(0, 64);
    if (sessionId) {
      const srow = ctx.store.getAuthSession(sessionId);
      if (!srow || srow.revoked_at || srow.expires_at <= new Date().toISOString()) {
        return sendJSON(res, 404, { ok: false, detail: "目标已不在线" });
      }
      if (srow.principal_type === "admin") return sendJSON(res, 400, { ok: false, detail: "管理员不可被下线" });
      const { targets } = ctx.bus.kickSession(sessionId);
      ctx.store.revokeAuthSessionById(sessionId);
      ctx.auth.dropSessionActivity(sessionId);
      const id = sessionIdentity(srow);
      const act = ctx.auth.sessionActivityOf(sessionId) || {};
      ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "access.kick", targetType: "online",
        targetId: "session:" + sessionId, detail: { kind: id.kind, label: id.label, session_id: sessionId,
          ip: act.ip || srow.ip || "", dev: act.dev || "", connections: targets.length }, ip: ipOf(req), userAgent: uaOf(req) });
      return sendJSON(res, 200, { ok: true, kicked: targets.length });
    }
    // 路径二：设备 + IP（匿名/遗留主体）——evicted + 吊销 sid（若有）+ 5 分钟禁入冷却
    const dev = String((body && body.dev) || "").slice(0, 32);
    const ip = String((body && body.ip) || "");
    const { targets, none } = ctx.bus.kick(dev, ip);
    if (none) return sendJSON(res, 404, { ok: false, detail: "目标已不在线" });
    if (targets.length === 0) return sendJSON(res, 400, { ok: false, detail: "管理员不可被下线" });
    let id = { kind: "unknown", label: "匿名" };
    for (const c of targets) {
      if (c.meta && c.meta.sid) ctx.store.revokeAuthSessionByToken(c.meta.sid);
      if (c.principal && id.kind === "unknown") id = identityLabel(c.principal);
    }
    ctx.bus.markKicked(dev, ip);
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "access.kick", targetType: "online",
      targetId: dev || ip, detail: { kind: id.kind, label: id.label, ip, dev, connections: targets.length }, ip: ipOf(req), userAgent: uaOf(req) });
    sendJSON(res, 200, { ok: true, kicked: targets.length });
    return Promise.resolve();
  });

  // ---- 用户（管理 · P3 多用户；管理员创建制）----
  const userView = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, status: u.status, created_at: u.created_at, last_login_at: u.last_login_at || null, agent_scope: u.agent_scope || null });
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
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "users.create", targetType: "user", targetId: u.id, detail: { username, role }, ip: ipOf(req), userAgent: uaOf(req) });
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
    if (body.agent_scope !== undefined) { // P8.40/P8.51 用户权限范围三态（管理员恒全量可用，范围仅记录）
      if (body.agent_scope === null) { // null = 不允许任何智能体（最小权限）
        patch.agent_scope = null; changed.agent_scope = "无（最小权限）";
      } else {
        const ids = normalizeAgentScope(body.agent_scope, ctx.store.listAgents({}));
        if (ids === null) return sendJSON(res, 400, { ok: false, detail: "agent_scope 需为 agent id 数组（空数组 = 允许全部；null = 不允许任何）" });
        patch.agent_scope = ids; changed.agent_scope = ids.length ? ids.length + " 个智能体" : "全部";
      }
    }
    if (!Object.keys(patch).length) return sendJSON(res, 400, { ok: false, detail: "无有效字段（display_name/role/status/password/agent_scope）" });
    // 守护：不得移除最后一个 active 管理员
    if (u.role === "admin" && u.status === "active" && ((patch.role && patch.role !== "admin") || (patch.status && patch.status !== "active"))) {
      const activeAdmins = ctx.store.listUsers().filter((x) => x.role === "admin" && x.status === "active").length;
      if (activeAdmins <= 1) return sendJSON(res, 400, { ok: false, detail: "不能停用最后一个 active 管理员" });
    }
    const updated = ctx.store.updateUser(u.id, patch);
    if (patch.status === "disabled") ctx.store.revokeAuthSessionsForUser(u.id); // 停用 → cookie 会话全吊销
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "users.update", targetType: "user", targetId: u.id, detail: changed, ip: ipOf(req), userAgent: uaOf(req) });
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
      // P8.81: 含智能体层——智能体自有身份字段的会话不随全局无关变更失效
      const ac = agentCfgOf(s);
      const a = resolveProtocolConfig(s, prev, p, ac);
      const b = resolveProtocolConfig(s, next, p, ac);
      const sameStr = (x, y) => String(x || "") === String(y || "");
      // P8.43: enabled 状态翻转（停用/恢复）同样清空后端会话 ID
      const enFlip = (a.enabled !== false) !== (b.enabled !== false);
      if (p === "ragflow" &&
          (enFlip || !sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key) || !sameStr(a.chat_id, b.chat_id))) {
        if (s.ragflow_session_id) { s.ragflow_session_id = ""; invalidated++; }
      }
      if (p === "dify" && (enFlip || !sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key))) {
        if (s.dify_conversation_id) { s.dify_conversation_id = ""; invalidated++; }
      }
    }
    if (invalidated) ctx.manager.save();
    // P8.43：仅当请求体显式携带 security.admin_password 字段时执行「清空=停用」旧语义
    const adminPwExplicit = typeof patch.security === "object" && patch.security !== null && "admin_password" in patch.security;
    try {
      syncConfigToStore(ctx.store, next, { adminPwExplicit }); // v2 库同步（protocol_defaults/system_configs/access_codes/admin 密码）
    } catch (e) {
      console.error("[config] v2 库同步失败（已落盘 config.json）:", e && e.message || e);
    }
    ctx.codes.refreshMirror();
    ctx.bus.emit("config", { ok: true, config: maskConfigForBroadcast(next) });
    return sendJSON(res, 200, { ok: true, config: next, invalidated_sessions: invalidated });
  });

  // ---- 协议连接测试（管理 · P8.81）----
  // POST /api/admin/protocol-test：body { protocol, config?, agent_code? }
  // 合并链 = 全局 ← 智能体（agent_code 现有配置）← 草稿（config，含空串），与运行时解析一致；
  // 供智能体创建/编辑对话框「测试连接」、智能体列表「测试」操作使用。
  router.exact("POST", "/api/admin/protocol-test", async (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : "请求体必须是 JSON" }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    const proto = typeof body.protocol === "string" ? body.protocol.trim() : "";
    if (!PROTOCOLS.includes(proto)) return sendJSON(res, 400, { ok: false, detail: "未知协议: " + proto });
    if (body.config !== undefined && (typeof body.config !== "object" || body.config === null || Array.isArray(body.config))) {
      return sendJSON(res, 400, { ok: false, detail: "config 必须是对象（{ 字段: 值 }）" });
    }
    let agentCfg = null;
    if (typeof body.agent_code === "string" && body.agent_code.trim()) {
      const ag = ctx.store.getAgentByCode(body.agent_code.trim());
      if (ag) {
        const c = ctx.store.getAgentConfig(ag.id);
        // P8.81: 智能体层仅当「测试协议 = 智能体协议」时生效（防跨协议字段泄漏）
        agentCfg = c && typeof c.config === "object" && c.config !== null &&
          !(typeof c.protocol === "string" && c.protocol !== proto) ? c.config : null;
      }
    }
    const r = await testProtocol(proto, ctx.config, body.config || {}, agentCfg);
    return sendJSON(res, 200, { ok: r.ok, detail: r.detail });
  });

  // ---- 智能体（管理 · P3 多智能体；每智能体一个协议，存 agent_configs）----
  const agentViewFull = (x) => {
    const cfg = ctx.store.getAgentConfig(x.id);
    const raw = (cfg && typeof cfg.config === "object" && cfg.config !== null) ? cfg.config : {};
    const m = JSON.parse(JSON.stringify(raw));
    if (m && typeof m.api_key === "string" && m.api_key) m.api_key = "…已设置";
    const proto = (cfg && cfg.protocol) || "ragflow";
    // P8.81: 身份级字段配置状态（只报告存在性，不回显值）：
    // custom = 智能体自有值 / global = 继承全局（遗留回退）/ none = 均未配置
    const g = (ctx.config.protocols && ctx.config.protocols[proto]) || {};
    const config_status = {};
    let config_complete = true;
    for (const f of IDENTITY_FIELDS[proto] || []) {
      const has = typeof raw[f] === "string" && raw[f].trim() !== "";
      const ghas = typeof g[f] === "string" && g[f].trim() !== "";
      config_status[f] = has ? "custom" : (ghas ? "global" : "none");
      if (!has && !ghas) config_complete = false;
    }
    return { id: x.id, code: x.code, name: x.name, description: x.description || "", icon: x.icon || "", enabled: x.enabled, sort: x.sort, protocol: proto, protocol_enabled: protocolEnabled(proto, ctx.config), config: m, config_status, config_complete, allow_anon: x.allow_anon, allow_code: x.allow_code, allow_user: x.allow_user };
  };

  // P8.81: 智能体配置逐字段合并（修复「掩码 api_key 保存即丢失」）：
  //  对 PROTOCOL_FIELDS[protocol] 每个字段——
  //   提交值 = 哨兵「…已设置」 → 保留现值（前端掩码回传，真实值碰撞概率≈0）；
  //   提交值 = 字符串（含空串） → 空串 = 删键（回退全局），非空 = 设置；
  //   字段未提交            → 保留现值（兼容旧客户端）。
  // 返回干净对象（仅含非空值键）。
  function mergeAgentConfig(protocol, curCfg, submitted) {
    const fields = PROTOCOL_FIELDS[protocol] || [];
    const cur = (curCfg && typeof curCfg === "object" && curCfg !== null) ? curCfg : {};
    const sub = (submitted && typeof submitted === "object" && submitted !== null) ? submitted : {};
    const out = {};
    for (const f of fields) {
      let v;
      if (typeof sub[f] === "string") v = sub[f];
      else if (typeof cur[f] === "string") v = cur[f];
      else v = "";
      if (v === AGENT_CFG_KEEP_SENTINEL) v = typeof cur[f] === "string" ? cur[f] : "";
      if (v.trim() !== "") out[f] = v;
    }
    for (const [k, v] of Object.entries(sub)) {
      if (fields.includes(k) || k === "enabled") continue; // 未知字段透传（前向兼容）
      if (typeof v === "string" && v.trim() !== "") out[k] = v;
    }
    return out;
  }

  // P8.81: 身份级字段必填校验（合并后为空 → 返回 400 文案；防「隐性共享」）
  const IDENTITY_REQUIRED_MSG = {
    "ragflow.chat_id": "知识引擎智能体必须配置 Chat ID（知识库对话）",
    "openai.model": "OpenAI 兼容智能体必须配置模型",
    "dify.api_key": "编排引擎智能体必须配置 API Key（应用密钥）"
  };
  function agentConfigProblem(protocol, merged) {
    for (const f of IDENTITY_FIELDS[protocol] || []) {
      if (!(typeof merged[f] === "string" && merged[f].trim())) {
        return IDENTITY_REQUIRED_MSG[protocol + "." + f] || (protocol + "." + f + " 必填");
      }
    }
    return null;
  }

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
    // P8.43: 停用协议不可用于新建智能体
    if (!protocolEnabled(protocol, ctx.config)) return sendJSON(res, 400, { ok: false, detail: "协议 " + protocol + " 已停用，请先在「系统设置 → 协议全局默认」启用" });
    if (body.config !== undefined && (typeof body.config !== "object" || body.config === null || Array.isArray(body.config))) {
      return sendJSON(res, 400, { ok: false, detail: "config 必须是对象" });
    }
    if (ctx.store.getAgentByCode(code)) return sendJSON(res, 409, { ok: false, detail: "code 已存在" });
    // P8.81: 身份级字段必填（全局预设不再携带身份值，智能体必须明确自己的后端资源）
    const newCfg = mergeAgentConfig(protocol, {}, body.config || {});
    const newCfgProb = agentConfigProblem(protocol, newCfg);
    if (newCfgProb) return sendJSON(res, 400, { ok: false, detail: newCfgProb });
    const ag = ctx.store.createAgent({ code, name, description: typeof body.description === "string" ? body.description.trim().slice(0, 200) : "", icon: typeof body.icon === "string" ? body.icon.trim().slice(0, 64) : "", enabled: body.enabled !== false, sort: typeof body.sort === "number" ? body.sort : 0, allow_anon: body.allow_anon !== false, allow_code: body.allow_code !== false, allow_user: body.allow_user !== false });
    ctx.store.setAgentConfig(ag.id, protocol, newCfg);
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "agents.create", targetType: "agent", targetId: ag.id, detail: { code, name, protocol }, ip: ipOf(req), userAgent: uaOf(req) });
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
      if (!protocolEnabled(body.protocol, ctx.config)) return sendJSON(res, 400, { ok: false, detail: "协议 " + body.protocol + " 已停用，请先在「系统设置 → 协议全局默认」启用" });
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
      const nextProto = typeof body.protocol === "string" ? body.protocol : (cur && cur.protocol) || "ragflow";
      // P8.81: 协议切换 = 旧协议字段作废（不以旧配置为基底），否则 ragflow.url 会泄漏进 dify.url
      const base = (typeof body.protocol === "string" && body.protocol !== (cur && cur.protocol))
        ? {}
        : (cur && typeof cur.config === "object" && cur.config !== null ? cur.config : {});
      const mergedCfg = mergeAgentConfig(nextProto, base, body.config !== undefined ? body.config : {});
      const prob = agentConfigProblem(nextProto, mergedCfg);
      if (prob) return sendJSON(res, 400, { ok: false, detail: prob });
      ctx.store.setAgentConfig(ag0.id, nextProto, mergedCfg);
      // 协议/配置变更 → 该智能体下会话的后端上下文失效（ragflow/dify 会话 ID 清空）
      let invalidated = 0;
      for (const s of ctx.manager.getSessions()) {
        if ((s.agent_id || null) !== updated.id) continue;
        if (s.ragflow_session_id) { s.ragflow_session_id = ""; invalidated++; }
        if (s.dify_conversation_id) { s.dify_conversation_id = ""; invalidated++; }
      }
      if (invalidated) ctx.manager.save();
    }
    ctx.store.insertAudit({ actorType: "admin", actorId: actorId(req, urlObj), action: "agents.update", targetType: "agent", targetId: ag0.id, detail: changed, ip: ipOf(req), userAgent: uaOf(req) });
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

  // ---- 仪表盘统计（管理 · P8.48）----
  // GET /api/admin/stats?days=7[&fresh=1]：访问/提问/活跃/运行多维聚合（无 DDL，纯查询，时间桶 localtime）；
  // 30s TTL 缓存（延迟 ≤30s；fresh=1 强制重算——手动刷新/测试用）；days 缺省 7，非整数或 <1 → 400，>90 截断 90
  const statsCache = new Map(); // days → { ts, data }
  const STATS_TTL_MS = 30000;
  router.exact("GET", "/api/admin/stats", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    let days = 7;
    const rawDays = urlObj.searchParams.get("days");
    if (rawDays !== null && rawDays !== "") {
      if (!/^\d+$/.test(rawDays) || Number(rawDays) < 1) {
        sendJSON(res, 400, { ok: false, detail: "days 参数必须是 >=1 的整数" });
        return Promise.resolve();
      }
      days = Math.min(Number(rawDays), 90);
    }
    const now = Date.now();
    const fresh = urlObj.searchParams.get("fresh") === "1";
    const hit = fresh ? undefined : statsCache.get(days);
    if (hit && now - hit.ts < STATS_TTL_MS) {
      sendJSON(res, 200, Object.assign({ cached: true }, hit.data));
      return Promise.resolve();
    }
    // 窗口起点：本地今天 0 点 − (days−1) 天（ISO UTC 字符串）
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const fromIso = start.toISOString();
    const raw = ctx_.store.getDashboardStats(fromIso);
    const roleById = new Map(raw.userRoles);
    const agentById = new Map(raw.agents);
    const localDate = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    // daily 零填充（升序）
    const daily = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      daily.push({ date: localDate(d), total: 0, ok: 0, err: 0, admin: 0, user: 0, code: 0, anon: 0, logins: 0, new_sessions: 0, avg_duration_s: 0 });
    }
    const dmap = new Map(daily.map((x) => [x.date, x]));
    for (const r of raw.dailyQuestions) {
      const t = dmap.get(r.d);
      if (!t) continue;
      const n = Number(r.n), okn = Number(r.okn || 0);
      t.total += n; t.ok += okn; t.err += n - okn;
      let key;
      if (r.m === "code") key = "code";
      else if (r.m === "shared") key = "anon";
      else key = r.uid && roleById.get(r.uid) === "admin" ? "admin" : "user";
      t[key] += n;
    }
    for (const r of raw.dailyDuration) {
      const t = dmap.get(r.d);
      if (t && r.avg_s != null) t.avg_duration_s = Math.round(Number(r.avg_s) * 10) / 10;
    }
    for (const r of raw.dailyLogins) { const t = dmap.get(r.d); if (t) t.logins += Number(r.n); }
    for (const r of raw.dailyNewSessions) { const t = dmap.get(r.d); if (t) t.new_sessions += Number(r.n); }
    // 近 7 天小时分布（24 桶）
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    for (const r of raw.hours) { if (r.h >= 0 && r.h <= 23) hours[r.h].count = Number(r.n); }
    // 按智能体（提问量降序）
    const agents = raw.byAgent.map((r) => {
      const a = r.aid ? agentById.get(r.aid) : null;
      const n = Number(r.n), okn = Number(r.okn || 0);
      return {
        id: r.aid || "", code: a ? a.code : "", name: a ? a.name : "未知", icon: a ? a.icon || "" : "", // P8.50：仪表盘智能体排行图标
        questions: n, ok: okn, err: n - okn,
        rate_pct: n ? Math.round((okn / n) * 1000) / 10 : 0,
        avg_duration_s: r.avg_s != null ? Math.round(Number(r.avg_s) * 10) / 10 : 0,
        last_active: r.last_at || null
      };
    }).sort((a, b) => b.questions - a.questions);
    // 按协议（固定顺序；enabled 走 P8.43 protocolEnabled）
    const pmap = new Map(raw.byProtocol.map((r) => [r.protocol, r]));
    const protocols = PROTOCOLS.map((p) => {
      const r = pmap.get(p);
      const n = r ? Number(r.n) : 0, okn = r ? Number(r.okn || 0) : 0;
      return {
        name: p, questions: n, ok: okn, err: n - okn,
        rate_pct: n ? Math.round((okn / n) * 1000) / 10 : 0,
        avg_duration_s: r && r.avg_s != null ? Math.round(Number(r.avg_s) * 10) / 10 : 0,
        enabled: protocolEnabled(ctx_.config, p)
      };
    });
    const errors = raw.errors.map((r) => ({ protocol: r.protocol, detail: r.detail, count: Number(r.n) }));
    // 运行实时块（与 /api/health、/api/admin/online 同源）
    const authSess = ctx_.store.listAuthSessions();
    const validSids = new Set(authSess.map((s) => s.id));
    const online = ctx_.bus.listOnline();
    const anonGroups = new Set(
      online
        .filter((c) => !c.meta || !c.meta.sessionId || !validSids.has(c.meta.sessionId))
        .map((c) => ((c.meta && c.meta.dev) || "") + "|" + ((c.meta && c.meta.ip) || ""))
    );
    const activeIds = ctx_.manager.activeIds();
    const rangeTotal = daily.reduce((s, x) => s + x.total, 0);
    const rangeOk = daily.reduce((s, x) => s + x.ok, 0);
    const data = {
      ok: true,
      days,
      generated_at: new Date(now).toISOString(),
      summary: {
        records_total: raw.totals.records_total,
        records_today: raw.totals.records_today,
        records_today_prev: raw.totals.records_today_prev,
        records_range: rangeTotal,
        sessions_total: raw.totals.sessions_total,
        sessions_range: daily.reduce((s, x) => s + x.new_sessions, 0),
        users_active: raw.totals.users_active,
        codes_active: raw.totals.codes_active,
        agents_total: raw.totals.agents_total,
        online: { auth_sessions: authSess.length, sse: online.length, groups: anonGroups.size },
        active_qa: Array.isArray(activeIds) ? activeIds.length : Number(activeIds || 0),
        uptime_s: Math.round(process.uptime()),
        error_rate_range_pct: rangeTotal ? Math.round(((rangeTotal - rangeOk) / rangeTotal) * 1000) / 10 : 0,
        avg_duration_s: Math.round(raw.rangeDuration * 10) / 10
      },
      daily,
      hours,
      agents,
      protocols,
      errors
    };
    statsCache.set(days, { ts: now, data });
    sendJSON(res, 200, data);
    return Promise.resolve();
  });
}
module.exports = { register };
