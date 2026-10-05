"use strict";
// 遗留双轨鉴权（P2）：与旧 server.js 行为逐条一致，后端换到 v2 库。
//  - 管理/访问 token 仍存内存（12h/24h，重启失效——与旧版一致；P3 引入 cookie 后退役）
//  - adminEnabled：DB 存在 active 管理员（旧版 = config 密码非空；迁移后等价）
//  - 登录限流：10 次/10min/IP（与旧版一致）
//  - 管理密码变更：PUT /api/config {security:{admin_password}} 由 config_sync 同步进 users 表

const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("../../lib/auth");
const { backfillSessionsForAdmin } = require("../../lib/migrations");
const { ipOf, safeEqual, parseJSONBody, sendJSON } = require("../middleware");

const ADMIN_TOKEN_TTL = 12 * 3600e3;   // 管理 token 12h
const ACCESS_TOKEN_TTL = 24 * 3600e3;  // 访问 token 24h（不超过码自身有效期）

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
  function isAdmin(req, urlObj) {
    if (!adminEnabled()) return true; // 未设密码 = 未启用管理鉴权（兼容旧行为）
    const t = req.headers["x-admin-token"] || (urlObj && urlObj.searchParams.get("admin")) || "";
    return typeof t === "string" && t !== "" && validAdminToken(t);
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
  // 查看级鉴权：匿名开放 → 放行；否则 管理 token 或 有效访问 token 放行
  function viewerOk(req, urlObj, extraAccess) {
    if (allowAnonymous()) return true;
    if (adminEnabled() && isAdmin(req, urlObj)) return true;
    const t = extraAccess || (urlObj && urlObj.searchParams.get("access")) || req.headers["x-access-token"] || "";
    if (typeof t !== "string" || t === "") return false;
    // 管理 token 亦可走 ?access= 通道：/admin 页的 SSE（EventSource 无法自定义请求头）
    // 与查看级 XHR 都靠它携带管理凭证
    return validAccessToken(t) || (adminEnabled() && validAdminToken(t));
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

  // ---- POST /api/admin/login：管理密码登录/首次初始化 ----
  // 后端：v2 users 表（scrypt 哈希）。请求/响应形态与旧版一致 {ok, initialized?, token, expires_at}。
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
      return sendJSON(res, 200, { ok: true, initialized: true, ...t, detail: "已初始化并登录" });
    }
    const u = store.getUserByUsername("admin");
    if (u && u.password_hash && verifyPassword(pw, u.password_hash)) {
      store.updateUser(u.id, { last_login_at: new Date().toISOString() });
      const t = issueAdminToken();
      return sendJSON(res, 200, { ok: true, initialized: false, ...t });
    }
    recordFail(ip);
    return sendJSON(res, 401, { ok: false, detail: "管理密码错误" });
  }

  // ---- POST /api/access/login：访问码 → 访问 token ----
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
    return sendJSON(res, 200, { ok: true, anonymous: false, ...t, expires_at_code: valid.expires_at });
  }

  // 访问码失效时吊销其已签发 token（DELETE /api/admin/access-codes/:code 联动）
  function revokeTokensForCode(code) {
    for (const [t, e] of [...accessTokens]) if (e.code === code) accessTokens.delete(t);
  }

  return {
    adminTokens, accessTokens,
    revokeTokensForCode,
    adminEnabled, allowAnonymous, throttleExceeded, recordFail,
    validAdminToken, isAdmin, findValidCode, validAccessToken, viewerOk,
    issueAdminToken, issueAccessToken,
    handleAdminLogin, handleAccessLogin
  };
}

module.exports = { createAuthService };
