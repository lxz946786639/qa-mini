"use strict";
// 安全监控路由（P8.49，仅 admin）：总览 / 安全事件流 / IP 封禁管理
const { sendJSON, parseJSONBody, ipOf, uaOf } = require("../middleware");

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function validIp(ip) {
  if (typeof ip !== "string") return false;
  const s = ip.trim();
  if (!s || s.length > 45) return false;
  if (IPV4_RE.test(s)) return s.split(".").every((p) => Number(p) <= 255);
  return s.includes(":") && /^[0-9a-fA-F:]+$/.test(s);
}

function register(router, ctx) {
  const admin401 = (req, urlObj, res) => {
    if (!ctx.auth.isAdmin(req, urlObj)) {
      sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return true;
    }
    return false;
  };

  // 总览（days 1-90 缺省 7；fresh=1 强制重算）
  router.exact("GET", "/api/admin/security", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    const daysRaw = urlObj.searchParams.get("days");
    let days = 7;
    if (daysRaw !== null && daysRaw !== "") {
      days = Number(daysRaw);
      if (!Number.isInteger(days) || days < 1) { sendJSON(res, 400, { ok: false, detail: "days 必须是 ≥1 的整数" }); return Promise.resolve(); }
      if (days > 90) days = 90;
    }
    sendJSON(res, 200, ctx.security.overview(days, urlObj.searchParams.get("fresh") === "1"));
    return Promise.resolve();
  });

  // 安全事件流（分页）
  router.exact("GET", "/api/admin/security/events", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    const limit = Math.min(Math.max(Number(urlObj.searchParams.get("limit")) || 100, 1), 500);
    const offset = Math.max(Number(urlObj.searchParams.get("offset")) || 0, 0);
    const { total, rows } = ctx.store.listSecurityEvents(limit, offset);
    sendJSON(res, 200, { ok: true, total, events: rows });
    return Promise.resolve();
  });

  // 封禁列表（生效 + 近 7 天过期）
  router.exact("GET", "/api/admin/security/bans", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    const bans = ctx.store.listBans({ includeExpiredDays: 7 }).map((b) => {
      const u = b.created_by ? ctx.store.getUser(b.created_by) : null;
      return Object.assign({}, b, { created_by_name: u ? (u.display_name || u.username) : "system" });
    });
    sendJSON(res, 200, { ok: true, bans });
    return Promise.resolve();
  });

  // 手动封禁（minutes 0 = 永久，上限 43200 = 30 天）
  router.exact("POST", "/api/admin/security/bans", async (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return;
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { sendJSON(res, 400, { ok: false, detail: e && e.__badBody ? "请求体必须是 JSON" : String((e && e.message) || e) }); return; }
    const ip = typeof body.ip === "string" ? body.ip.trim() : "";
    if (!validIp(ip)) { sendJSON(res, 400, { ok: false, detail: "ip 必须是合法 IPv4/IPv6 地址" }); return; }
    const minutesRaw = body.minutes === undefined || body.minutes === null || body.minutes === "" ? 60 : body.minutes;
    const minutes = Number(minutesRaw);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 43200) {
      sendJSON(res, 400, { ok: false, detail: "minutes 必须是 0-43200 的整数（0 = 永久）" }); return;
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
    const pr = ctx.auth.principal(req, urlObj);
    const uid = pr && pr.userId ? pr.userId : null;
    const existing = ctx.store.getBan(ip);
    if (existing && existing.active) { sendJSON(res, 409, { ok: false, detail: "该 IP 已有生效封禁" }); return; }
    const ban = ctx.store.addBan({ ip, reason: reason || "手动封禁", createdBy: uid, minutes });
    ctx.store.insertAudit({ actorType: "admin", actorId: uid, action: "security.ban", targetType: "ip", targetId: ip,
      detail: { reason: ban.reason, minutes: ban.permanent ? 0 : minutes }, ip: ipOf(req), userAgent: uaOf(req) });
    sendJSON(res, 201, { ok: true, ban });
  });

  // 解除封禁（404 幂等：无记录 = 未封禁）
  router.regex("DELETE", /^\/api\/admin\/security\/bans\/([0-9A-Fa-f.:]+)/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    const ip = params[0];
    const n = ctx.store.removeBan(ip);
    if (n === 0) { sendJSON(res, 404, { ok: false, detail: "该 IP 无封禁记录" }); return Promise.resolve(); }
    const pr = ctx.auth.principal(req, urlObj);
    const uid = pr && pr.userId ? pr.userId : null;
    ctx.store.insertAudit({ actorType: "admin", actorId: uid, action: "security.unban", targetType: "ip", targetId: ip,
      detail: {}, ip: ipOf(req), userAgent: uaOf(req) });
    sendJSON(res, 200, { ok: true });
    return Promise.resolve();
  });
}

module.exports = { register };
