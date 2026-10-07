"use strict";
// 鉴权服务（P2 遗留双轨 + P3 主体/cookie）：
//  - P2 遗留：管理/访问 token 存内存（12h/24h，重启失效）；adminEnabled = DB 存在 active 管理员；
//    登录限流 10 次/10min/IP；管理密码变更走 config_sync 同步进 users 表
//  - P3 主体：cookie ea_sid（HttpOnly SameSite=Lax，auth_sessions 表持久化、哈希存储、可吊销）
//    + /api/auth/* 登录流程；遗留 X-Admin-Token/?admin=/?access= 保留一个版本（shim）

const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("../../lib/auth");
const { backfillSessionsForAdmin } = require("../../lib/migrations");
const { ipOf, secIpOf, uaOf, safeEqual, parseJSONBody, sendJSON, cookieValue } = require("../middleware");

const ADMIN_TOKEN_TTL = 12 * 3600e3;   // 管理 token 12h
const ACCESS_TOKEN_TTL = 24 * 3600e3;  // 访问 token 24h（不超过码自身有效期）
const SID_COOKIE = "ea_sid";           // P3 会话 cookie（auth_sessions 持久化）
const SID_TTL = 12 * 3600e3;           // cookie 会话 12h
// 恒定时间占位哈希（防用户名枚举时序差异）
const DUMMY_HASH = hashPassword("echoanswer-dummy");

function createAuthService(ctx, opts) {
  opts = opts || {};
  const store = ctx.store;
  const adminTokens = new Map();   // token -> { expires_at: ms }
  const accessTokens = new Map();  // token -> { code, expires_at: ms }
  const loginFails = new Map();    // ip -> { count, reset_at: ms }

  function adminEnabled() { return store.countAdmins() > 0; }

  // P8.35：会话活动快照（内存态，重启清空）：sessionId → { ip, ua, dev, lastSeenAt }
  // 用途：访问控制在线列表——登录用户/访问码用户按 ea_sid 会话统计（无长连接也显示），
  // 每次请求解析到有效会话时刷新 ip/ua，dev（设备指纹）由 /api/events 连接登记时补写
  const sessionActivity = new Map();
  function touchSessionActivity(sid, fields) {
    if (!sid) return;
    const cur = sessionActivity.get(sid) || { ip: "", ua: "", dev: "", lastSeenAt: new Date().toISOString() };
    if (fields.ip) cur.ip = String(fields.ip);
    if (fields.ua) cur.ua = String(fields.ua).slice(0, 256);
    if (fields.dev) cur.dev = String(fields.dev).slice(0, 32);
    cur.lastSeenAt = new Date().toISOString();
    sessionActivity.set(sid, cur);
  }
  function sessionActivityOf(sid) { return sid ? sessionActivity.get(sid) || null : null; }
  function dropSessionActivity(sid) { if (sid) sessionActivity.delete(sid); }
  function pruneSessionActivity(validSids) {
    for (const k of [...sessionActivity.keys()]) if (!validSids.has(k)) sessionActivity.delete(k);
  }

  function throttleExceeded(ip) {
    const n = loginFails.get(ip) || { count: 0, reset_at: 0 };
    if (Date.now() > n.reset_at) { n.count = 0; n.reset_at = Date.now() + 10 * 60e3; }
    if (n.count >= 10) return true;
    loginFails.set(ip, n);
    return false;
  }
  function recordFail(ip) {
    const n = loginFails.get(ip) || { count: 0, reset_at: Date.now() + 10 * 60e3 };
    n.count += 1;
    loginFails.set(ip, n);
    // P8.49：越过登录失败阈值 → 交安全服务自动封禁（已封禁则幂等跳过）
    const ab = (ctx.config && ctx.config.security && ctx.config.security.auto_ban) || {};
    const th = Number(ab.login_fails) > 0 ? Number(ab.login_fails) : 10;
    if (n.count >= th) opts.onLoginBrute && opts.onLoginBrute(ip);
  }
  function validAdminToken(t) {
    const e = adminTokens.get(t);
    if (!e) return false;
    if (Date.now() > e.expires_at) { adminTokens.delete(t); return false; }
    return true;
  }
  function findValidCode(code) {
    return store.findValidAccessCode(code) || null;
  }
  function validAccessToken(t) {
    const e = accessTokens.get(t);
    if (!e) return false;
    if (Date.now() > e.expires_at) { accessTokens.delete(t); return false; }
    if (!findValidCode(e.code)) { accessTokens.delete(t); return false; } // 码已失效/过期
    return true;
  }
  // P8.44：移除匿名访问开关——首屏与匿名问答恒公开（config.security.allow_anonymous 字段保留兼容、不再生效）
  function allowAnonymous() { return true; }

  // 遗留管理主体兜底 userId（多管理员取第一个 active）
  function firstAdminUser() {
    const u = store.listUsers().find((x) => x.role === "admin" && x.status === "active");
    return u || null;
  }

  // ---- P3 主体解析：cookie ea_sid → 遗留管理 token → 遗留访问 token → 匿名 ----
  // P8.44：显式携带的凭证（cookie / ?admin= / ?access= / x-access-token）无效 → null（查看级 403，
  // 前端 SSE 探针据此确认凭证失效）；完全无凭证 → 匿名主体（匿名恒放行）
  function principal(req, urlObj) {
    let explicit = false;
    // 1) cookie（P3，auth_sessions 表）
    const sid = cookieValue(req, SID_COOKIE);
    if (sid) {
      explicit = true;
      const row = store.getValidAuthSessionByToken(sid);
      if (row) {
        // P8.35：会话活动快照（键 = 会话行 id；每次有效请求刷新 ip/ua；dev 由 /api/events 登记）
        touchSessionActivity(row.id, { ip: ipOf(req), ua: req.headers["user-agent"] });
        if (row.principal_type === "code") {
          const c = row.access_code_id ? store.getAccessCode(row.access_code_id) : null;
          if (c && c.status === "active" && Date.parse(c.expires_at) > Date.now()) {
            return { kind: "code", codeId: c.id, code: c.code, sessionId: row.id, agentScope: c.agent_scope || null }; // P8.40 权限范围
          }
          return null; // 码已失效/过期 → 视为未认证
        }
        const u = row.user_id ? store.getUser(row.user_id) : null;
        if (u && u.status === "active") {
          return u.role === "admin"
            ? { kind: "admin", userId: u.id, role: "admin", sessionId: row.id }
            : { kind: "user", userId: u.id, role: "user", sessionId: row.id, agentScope: u.agent_scope || null }; // P8.40 权限范围
        }
        return null; // 用户已禁用
      }
    }
    // 2) 遗留管理 token（X-Admin-Token / ?admin=，shim 一个版本）
    const at = req.headers["x-admin-token"] || (urlObj && urlObj.searchParams.get("admin")) || "";
    if (typeof at === "string" && at !== "") {
      explicit = true;
      if (!validAdminToken(at)) return null; // P8.44：显式凭证无效 → 未认证（不匿名回退）
    }
    if (typeof at === "string" && at !== "" && validAdminToken(at)) {
      const a = firstAdminUser();
      return { kind: "admin", userId: a ? a.id : null, role: "admin" };
    }
    // 3) 遗留访问 token（?access= / x-access-token；管理 token 亦可走此通道，SSE 兼容）
    const t = (urlObj && urlObj.searchParams.get("access")) || req.headers["x-access-token"] || "";
    if (typeof t === "string" && t !== "") {
      explicit = true;
      const e = accessTokens.get(t);
      if (e && Date.now() <= e.expires_at) {
        const c = findValidCode(e.code);
        if (c) return { kind: "code", codeId: c.id, code: c.code, agentScope: c.agent_scope || null }; // P8.40 权限范围
      }
      if (validAdminToken(t)) {
        const a = firstAdminUser();
        return { kind: "admin", userId: a ? a.id : null, role: "admin" };
      }
      return null; // P8.44：访问 token 无效/已吊销 → 未认证（不匿名回退）
    }
    // 4) 匿名
    if (explicit) return null;
    if (allowAnonymous()) return { kind: "anon" };
    return null;
  }

  // P3 cookie 签发（auth_sessions 表；哈希存储、可吊销、重启存活）
  function issueSidCookie(res, req, { principalType, userId, accessCodeId }) {
    const token = crypto.randomBytes(16).toString("hex");
    store.createAuthSession({
      token, principalType, userId: userId || null, accessCodeId: accessCodeId || null,
      ip: ipOf(req), userAgent: String((req && req.headers && req.headers["user-agent"]) || "").slice(0, 256), ttlMs: SID_TTL
    });
    res.setHeader("Set-Cookie", SID_COOKIE + "=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + Math.floor(SID_TTL / 1000));
    return new Date(Date.now() + SID_TTL).toISOString();
  }
  function clearSidCookie(res) {
    res.setHeader("Set-Cookie", SID_COOKIE + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  }

  function isAdmin(req, urlObj) {
    if (!adminEnabled()) return true; // 未设密码 = 未启用管理鉴权（兼容旧行为）
    const p = principal(req, urlObj);
    return !!(p && p.kind === "admin");
  }
  // 查看级鉴权：存在任一有效主体即放行；
  // P8.44：匿名恒放行（无任何凭证 = 匿名主体，首屏与问答恒公开）；但**显式携带的凭证无效**
  // （cookie 失效 / ?admin= / ?access= / x-access-token 无效）→ 403——前端 SSE 探针据此
  // 确认凭证失效（踢出/过期 → 跳登录页），该语义自 v2 起保留，不因匿名放行而放宽。
  function viewerOk(req, urlObj, extraAccess) {
    const p = principal(req, urlObj);
    if (p) return true;
    const qs = (urlObj && urlObj.searchParams) || {};
    const hasExplicit = !!(cookieValue(req, SID_COOKIE)
      || qs.get("admin") || qs.get("access")
      || req.headers["x-admin-token"] || req.headers["x-access-token"]);
    const t = extraAccess || qs.get("access") || req.headers["x-access-token"] || "";
    if (hasExplicit || typeof t === "string" && t !== "") {
      return validAccessToken(t) || (adminEnabled() && validAdminToken(t));
    }
    return true;
  }

  function issueAdminToken() {
    const t = crypto.randomBytes(16).toString("hex");
    adminTokens.set(t, { expires_at: Date.now() + ADMIN_TOKEN_TTL });
    return { token: t, expires_at: new Date(Date.now() + ADMIN_TOKEN_TTL).toISOString() };
  }
  function issueAccessToken(code) {
    const c = findValidCode(code);
    const exp = Math.min(Date.parse(c.expires_at), Date.now() + ACCESS_TOKEN_TTL);
    const t = crypto.randomBytes(16).toString("hex");
    accessTokens.set(t, { code, expires_at: exp });
    return { token: t, expires_at: new Date(exp).toISOString() };
  }

  // ---- POST /api/admin/login：管理密码登录/首次初始化（遗留端点；成功同时签发 cookie） ----
  async function handleAdminLogin(req, res) {
    const ip = ipOf(req);
    const sip = secIpOf(req); // P8.49：限流/封禁用安全维度 IP
    if (throttleExceeded(sip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    const pw = typeof body.password === "string" ? body.password : "";
    if (!adminEnabled()) {
      // 初始化：首次设置管理密码（4-64 位）；username 可选（默认 admin；旧 API 无此字段）
      if (pw.length < 4 || pw.length > 64) {
        return sendJSON(res, 400, { ok: false, detail: "管理密码需 4-64 位字符" });
      }
      const username = (typeof body.username === "string" && body.username.trim() ? body.username.trim() : "admin").slice(0, 32);
      let u = store.getUserByUsername(username);
      if (u) store.updateUser(u.id, { password_hash: hashPassword(pw), status: "active" });
      else u = store.createUser({ username, passwordHash: hashPassword(pw), displayName: "管理员", role: "admin" });
      backfillSessionsForAdmin(store.db, u.id); // 存量会话归属回填（幂等）
      store.insertAudit({ actorType: "admin", actorId: u.id, action: "admin.bootstrap", detail: { username }, ip, userAgent: uaOf(req) });
      const t = issueAdminToken();
      issueSidCookie(res, req, { principalType: "admin", userId: u.id });
      return sendJSON(res, 200, { ok: true, initialized: true, ...t, detail: "已初始化并登录" });
    }
    const u = store.getUserByUsername("admin");
    if (u && u.password_hash && verifyPassword(pw, u.password_hash)) {
      store.updateUser(u.id, { last_login_at: new Date().toISOString() });
      store.insertAudit({ actorType: "admin", actorId: u.id, action: "admin.login", ip, userAgent: uaOf(req) });
      const t = issueAdminToken();
      issueSidCookie(res, req, { principalType: "admin", userId: u.id });
      return sendJSON(res, 200, { ok: true, initialized: false, ...t });
    }
    recordFail(sip);
    store.insertAudit({ actorType: "system", action: "admin.login_failed", detail: { username: "admin" }, ip, userAgent: uaOf(req) }); // P8.49
    return sendJSON(res, 401, { ok: false, detail: "管理密码错误" });
  }

  // ---- POST /api/access/login：访问码 → 访问 token（遗留端点；成功同时签发 cookie）
  //      P8.44：匿名捷径已移除（匿名恒放行，无需「匿名登录」），统一校验码签发 token ----
  async function handleAccessLogin(req, res) {
    const ip = ipOf(req);
    const sip = secIpOf(req); // P8.49：限流/封禁用安全维度 IP
    if (throttleExceeded(sip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "访问码为 6 位数字" });
    const valid = findValidCode(code);
    if (!valid) {
      recordFail(sip);
      store.insertAudit({ actorType: "system", action: "access.login_failed", detail: { code: "••••" + code.slice(-2) }, ip, userAgent: uaOf(req) }); // P8.49
      return sendJSON(res, 401, { ok: false, detail: "访问码无效或已过期" });
    }
    const t = issueAccessToken(valid.code);
    issueSidCookie(res, req, { principalType: "code", accessCodeId: valid.id });
    store.insertAudit({ actorType: "code", actorId: valid.id, action: "access.login", targetType: "access_code",
      targetId: valid.id, detail: { code: "••••" + valid.code.slice(-2) }, ip, userAgent: uaOf(req) });
    return sendJSON(res, 200, { ok: true, anonymous: false, ...t, expires_at_code: valid.expires_at });
  }

  // ---- P3 /api/auth/login：用户名密码 → cookie（users 表；管理员/普通用户同一入口） ----
  async function handleAuthLogin(req, res) {
    const ip = ipOf(req);
    const sip = secIpOf(req); // P8.49：限流/封禁用安全维度 IP
    if (throttleExceeded(sip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const pw = typeof body.password === "string" ? body.password : "";
    if (!username || !pw) return sendJSON(res, 400, { ok: false, detail: "请输入用户名和密码" });
    const u = store.getUserByUsername(username);
    // 无论用户是否存在都做密码比对（防用户名枚举时序差异）
    const okPw = verifyPassword(pw, u && u.password_hash ? u.password_hash : DUMMY_HASH);
    if (u && u.status === "active" && okPw) {
      store.updateUser(u.id, { last_login_at: new Date().toISOString() });
      store.insertAudit({ actorType: u.role === "admin" ? "admin" : "user", actorId: u.id, action: "auth.login", detail: { username }, ip, userAgent: uaOf(req) });
      const expires_at = issueSidCookie(res, req, {
        principalType: u.role === "admin" ? "admin" : "user", userId: u.id
      });
      return sendJSON(res, 200, {
        ok: true, expires_at,
        user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role }
      });
    }
    recordFail(sip);
    store.insertAudit({ actorType: "system", action: "auth.login_failed", detail: { username }, ip, userAgent: uaOf(req) }); // P8.49
    return sendJSON(res, 401, { ok: false, detail: "用户名或密码错误" });
  }

  // ---- P3 /api/auth/logout：吊销 cookie 会话（P8.29 登出留痕，含访问码登出） ----
  function auditLogout(sid, req) {
    const sess = store.getValidAuthSessionByToken(sid);
    if (!sess) return;
    const ip = ipOf(req), ua = uaOf(req);
    if (sess.principal_type === "code" && sess.access_code_id) {
      const c = store.getAccessCode(sess.access_code_id);
      store.insertAudit({ actorType: "code", actorId: sess.access_code_id, action: "access.logout",
        targetType: "access_code", targetId: sess.access_code_id,
        detail: c ? { code: "••••" + c.code.slice(-2) } : {}, ip, userAgent: ua });
    } else if (sess.user_id) {
      const u = store.getUser(sess.user_id);
      store.insertAudit({ actorType: u && u.role === "admin" ? "admin" : "user", actorId: sess.user_id, action: "auth.logout",
        detail: u ? { username: u.username } : {}, ip, userAgent: ua });
    }
  }
  async function handleAuthLogout(req, res) {
    const sid = cookieValue(req, SID_COOKIE);
    if (sid) {
      auditLogout(sid, req);
      store.revokeAuthSessionByToken(sid);
    }
    clearSidCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  // ---- P3 /api/auth/me：当前主体（无凭证时：匿名放行则 anonymous，否则 401） ----
  async function handleAuthMe(req, res, ctx_, urlObj) {
    const p = principal(req, urlObj);
    if (p && p.kind !== "anon") {
      let user = null;
      if (p.userId) {
        const u = store.getUser(p.userId);
        if (u) user = { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
      }
      return sendJSON(res, 200, { ok: true, principal: { kind: p.kind, user, code: p.kind === "code" ? p.code : null } });
    }
    // anon 主体（或无主体）：匿名环境 → anonymous；关闭匿名 → 401
    if (allowAnonymous()) return sendJSON(res, 200, { ok: true, anonymous: true, principal: null });
    return sendJSON(res, 401, { ok: false, detail: "未登录" });
  }

  // ---- P3 /api/auth/access-code：访问码 → cookie（显式码登录；无匿名捷径） ----
  async function handleAuthCodeLogin(req, res) {
    const ip = ipOf(req);
    const sip = secIpOf(req); // P8.49：限流/封禁用安全维度 IP
    if (throttleExceeded(sip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "访问码为 6 位数字" });
    const valid = findValidCode(code);
    if (!valid) {
      recordFail(sip);
      store.insertAudit({ actorType: "system", action: "access.login_failed", detail: { code: "••••" + code.slice(-2) }, ip, userAgent: uaOf(req) }); // P8.49
      return sendJSON(res, 401, { ok: false, detail: "访问码无效或已过期" });
    }
    const expires_at = issueSidCookie(res, req, { principalType: "code", accessCodeId: valid.id });
    store.insertAudit({ actorType: "code", actorId: valid.id, action: "access.login", targetType: "access_code",
      targetId: valid.id, detail: { code: "••••" + valid.code.slice(-2) }, ip, userAgent: uaOf(req) });
    return sendJSON(res, 200, { ok: true, expires_at, expires_at_code: valid.expires_at });
  }

  // 访问码失效时吊销其已签发凭证（DELETE /api/admin/access-codes/:code 联动）
  function revokeTokensForCode(code) {
    for (const [t, e] of [...accessTokens]) if (e.code === code) accessTokens.delete(t);
    const c = store.getAccessCodeByCode(code);
    if (c) store.revokeAuthSessionsForCode(c.id);
  }

  return {
    adminTokens, accessTokens,
    SID_COOKIE, SID_TTL,
    revokeTokensForCode,
    adminEnabled, allowAnonymous, throttleExceeded, recordFail,
    validAdminToken, isAdmin, findValidCode, validAccessToken, viewerOk,
    issueAdminToken, issueAccessToken,
    principal, issueSidCookie, clearSidCookie,
    touchSessionActivity, sessionActivityOf, dropSessionActivity, pruneSessionActivity,
    handleAdminLogin, handleAccessLogin,
    handleAuthLogin, handleAuthLogout, handleAuthMe, handleAuthCodeLogin
  };
}

module.exports = { createAuthService };
