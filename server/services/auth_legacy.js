"use strict";
// 鉴权服务（P2 遗留双轨 + P3 主体/cookie）：
//  - P2 遗留：管理/访问 token 存内存（12h/24h，重启失效）；adminEnabled = DB 存在 active 管理员；
//    登录限流 10 次/10min/IP；管理密码变更走 config_sync 同步进 users 表
//  - P3 主体：cookie ea_sid（HttpOnly SameSite=Lax，auth_sessions 表持久化、哈希存储、可吊销）
//    + /api/auth/* 登录流程；遗留 X-Admin-Token/?admin=/?access= 保留一个版本（shim）

const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("../../lib/auth");
const { backfillSessionsForAdmin } = require("../../lib/migrations");
const { ipOf, safeEqual, parseJSONBody, sendJSON, cookieValue } = require("../middleware");

const ADMIN_TOKEN_TTL = 12 * 3600e3;   // 管理 token 12h
const ACCESS_TOKEN_TTL = 24 * 3600e3;  // 访问 token 24h（不超过码自身有效期）
const SID_COOKIE = "ea_sid";           // P3 会话 cookie（auth_sessions 持久化）
const SID_TTL = 12 * 3600e3;           // cookie 会话 12h
// 恒定时间占位哈希（防用户名枚举时序差异）
const DUMMY_HASH = hashPassword("echoanswer-dummy");

function createAuthService(ctx) {
  const store = ctx.store;
  const adminTokens = new Map();   // token -> { expires_at: ms }
  const accessTokens = new Map();  // token -> { code, expires_at: ms }
  const loginFails = new Map();    // ip -> { count, reset_at: ms }

  function adminEnabled() { return store.countAdmins() > 0; }

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
  function allowAnonymous() { return ctx.config.security.allow_anonymous !== false; }

  // 遗留管理主体兜底 userId（多管理员取第一个 active）
  function firstAdminUser() {
    const u = store.listUsers().find((x) => x.role === "admin" && x.status === "active");
    return u || null;
  }

  // ---- P3 主体解析：cookie ea_sid → 遗留管理 token → 遗留访问 token → 匿名 ----
  function principal(req, urlObj) {
    // 1) cookie（P3，auth_sessions 表）
    const sid = cookieValue(req, SID_COOKIE);
    if (sid) {
      const row = store.getValidAuthSessionByToken(sid);
      if (row) {
        if (row.principal_type === "code") {
          const c = row.access_code_id ? store.getAccessCode(row.access_code_id) : null;
          if (c && c.status === "active" && Date.parse(c.expires_at) > Date.now()) {
            return { kind: "code", codeId: c.id, code: c.code };
          }
          return null; // 码已失效/过期 → 视为未认证
        }
        const u = row.user_id ? store.getUser(row.user_id) : null;
        if (u && u.status === "active") {
          return u.role === "admin"
            ? { kind: "admin", userId: u.id, role: "admin" }
            : { kind: "user", userId: u.id, role: "user" };
        }
        return null; // 用户已禁用
      }
    }
    // 2) 遗留管理 token（X-Admin-Token / ?admin=，shim 一个版本）
    const at = req.headers["x-admin-token"] || (urlObj && urlObj.searchParams.get("admin")) || "";
    if (typeof at === "string" && at !== "" && validAdminToken(at)) {
      const a = firstAdminUser();
      return { kind: "admin", userId: a ? a.id : null, role: "admin" };
    }
    // 3) 遗留访问 token（?access= / x-access-token；管理 token 亦可走此通道，SSE 兼容）
    const t = (urlObj && urlObj.searchParams.get("access")) || req.headers["x-access-token"] || "";
    if (typeof t === "string" && t !== "") {
      const e = accessTokens.get(t);
      if (e && Date.now() <= e.expires_at) {
        const c = findValidCode(e.code);
        if (c) return { kind: "code", codeId: c.id, code: c.code };
      }
      if (validAdminToken(t)) {
        const a = firstAdminUser();
        return { kind: "admin", userId: a ? a.id : null, role: "admin" };
      }
    }
    // 4) 匿名
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
  // 查看级鉴权：存在任一有效主体即放行（匿名需 allow_anonymous）
  function viewerOk(req, urlObj, extraAccess) {
    if (allowAnonymous()) return true;
    const p = principal(req, urlObj);
    if (p) return true;
    // 兼容：显式传入的访问 token（旧调用签名保留）
    const t = extraAccess || "";
    if (typeof t === "string" && t !== "") return validAccessToken(t) || (adminEnabled() && validAdminToken(t));
    return false;
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
    if (throttleExceeded(ip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
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
      store.insertAudit({ actorType: "admin", actorId: u.id, action: "admin.bootstrap", detail: { username }, ip });
      const t = issueAdminToken();
      issueSidCookie(res, req, { principalType: "admin", userId: u.id });
      return sendJSON(res, 200, { ok: true, initialized: true, ...t, detail: "已初始化并登录" });
    }
    const u = store.getUserByUsername("admin");
    if (u && u.password_hash && verifyPassword(pw, u.password_hash)) {
      store.updateUser(u.id, { last_login_at: new Date().toISOString() });
      store.insertAudit({ actorType: "admin", actorId: u.id, action: "admin.login", ip });
      const t = issueAdminToken();
      issueSidCookie(res, req, { principalType: "admin", userId: u.id });
      return sendJSON(res, 200, { ok: true, initialized: false, ...t });
    }
    recordFail(ip);
    return sendJSON(res, 401, { ok: false, detail: "管理密码错误" });
  }

  // ---- POST /api/access/login：访问码 → 访问 token（遗留端点；成功同时签发 cookie） ----
  async function handleAccessLogin(req, res) {
    if (allowAnonymous()) {
      return sendJSON(res, 200, { ok: true, anonymous: true });
    }
    const ip = ipOf(req);
    if (throttleExceeded(ip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "访问码为 6 位数字" });
    const valid = findValidCode(code);
    if (!valid) {
      recordFail(ip);
      return sendJSON(res, 401, { ok: false, detail: "访问码无效或已过期" });
    }
    const t = issueAccessToken(valid.code);
    issueSidCookie(res, req, { principalType: "code", accessCodeId: valid.id });
    return sendJSON(res, 200, { ok: true, anonymous: false, ...t, expires_at_code: valid.expires_at });
  }

  // ---- P3 /api/auth/login：用户名密码 → cookie（users 表；管理员/普通用户同一入口） ----
  async function handleAuthLogin(req, res) {
    const ip = ipOf(req);
    if (throttleExceeded(ip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
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
      store.insertAudit({ actorType: u.role === "admin" ? "admin" : "user", actorId: u.id, action: "auth.login", detail: { username }, ip });
      const expires_at = issueSidCookie(res, req, {
        principalType: u.role === "admin" ? "admin" : "user", userId: u.id
      });
      return sendJSON(res, 200, {
        ok: true, expires_at,
        user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role }
      });
    }
    recordFail(ip);
    return sendJSON(res, 401, { ok: false, detail: "用户名或密码错误" });
  }

  // ---- P3 /api/auth/logout：吊销 cookie 会话 ----
  async function handleAuthLogout(req, res) {
    const sid = cookieValue(req, SID_COOKIE);
    if (sid) store.revokeAuthSessionByToken(sid);
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
    if (throttleExceeded(ip)) return sendJSON(res, 429, { ok: false, detail: "尝试过于频繁，请稍后再试" });
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "访问码为 6 位数字" });
    const valid = findValidCode(code);
    if (!valid) {
      recordFail(ip);
      return sendJSON(res, 401, { ok: false, detail: "访问码无效或已过期" });
    }
    const expires_at = issueSidCookie(res, req, { principalType: "code", accessCodeId: valid.id });
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
    handleAdminLogin, handleAccessLogin,
    handleAuthLogin, handleAuthLogout, handleAuthMe, handleAuthCodeLogin
  };
}

module.exports = { createAuthService };
