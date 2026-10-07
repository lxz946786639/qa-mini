"use strict";
// 访问码管理服务（P2）：管理端 CRUD/延期/清理，后端 = v2 access_codes 表。
// 同步维护 ctx.config.security.access_codes 内存镜像（GET /api/config 形态不变）。
// 失效时联动吊销已签发访问 token（与旧版一致）。

const { parseJSONBody, sendJSON, ipOf, uaOf } = require("../middleware");
const { ANON_CODE } = require("../../lib/store");

const DEFAULT_CODE_HOURS = 8;

// P8.40 权限范围校验：agent id 数组（空 = 允许全部；null = 非法）
function normalizeAgentScope(v, agents) {
  if (v === null || (typeof v === "string" && v.trim() === "")) return [];
  if (!Array.isArray(v)) return null;
  const ids = v.filter((x) => typeof x === "string" && x !== "");
  const known = new Set(agents.map((a) => a.id));
  for (const id of ids) if (!known.has(id)) return null;
  return [...new Set(ids)];
}

function clampCodeHours(h) {
  let hours = typeof h === "number" && isFinite(h) ? h : DEFAULT_CODE_HOURS;
  if (!(hours > 0)) hours = DEFAULT_CODE_HOURS;
  return Math.min(hours, 720); // 上限 30 天
}

function createAccessCodeService(ctx, authService) {
  const store = ctx.store;

  // 内存镜像（供 GET /api/config）：从 DB 重建
  function refreshMirror() {
    ctx.config.security = Object.assign({}, ctx.config.security, {
      access_codes: store.listAccessCodes()
        .filter((c) => c.code !== ANON_CODE)
        .map((c) => ({ code: c.code, created_at: c.created_at, expires_at: c.expires_at, agent_scope: c.agent_scope || null }))
    });
  }

  // ---- POST /api/admin/access-codes：生成访问码（管理）----
  // body {code?, hours?, count?}：count 1-10 批量随机；code 指定时 count 忽略（单个）
  async function handleAdd(req, res) {
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    const hours = clampCodeHours(body.hours);
    const admin = store.getUserByUsername("admin");
    const entries = [];
    if (typeof body.code === "string" && body.code.trim() !== "") {
      const code = body.code.trim();
      if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { ok: false, detail: "自定义访问码必须为 6 位数字" });
      if (store.hasAccessCodeCode(code)) return sendJSON(res, 409, { ok: false, detail: "该访问码已存在（未过期）" });
      const c = store.createAccessCode({ code, expiresAt: new Date(Date.now() + hours * 3600e3).toISOString(), createdBy: admin ? admin.id : null });
      entries.push({ code: c.code, created_at: c.created_at, expires_at: c.expires_at });
    } else {
      let count = typeof body.count === "number" ? Math.floor(body.count) : 1;
      count = Math.max(1, Math.min(count, 10));
      const taken = new Set(store.listAccessCodes().map((c) => c.code));
      while (entries.length < count) {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        if (taken.has(code)) continue;
        taken.add(code);
        const c = store.createAccessCode({ code, expiresAt: new Date(Date.now() + hours * 3600e3).toISOString(), createdBy: admin ? admin.id : null });
        entries.push({ code: c.code, created_at: c.created_at, expires_at: c.expires_at });
      }
    }
    refreshMirror();
    return sendJSON(res, 201, { ok: true, entries, entry: entries[0] });
  }

  // ---- POST /api/admin/access-codes/:code/renew：延期（管理）----
  // 新到期 = max(当前到期, 现在) + hours
  async function handleRenew(req, res, code) {
    let body = {};
    try { body = await parseJSONBody(req); } catch { body = {}; }
    const hours = clampCodeHours(body.hours);
    const cur = store.getAccessCodeByCode(code);
    if (!cur) return sendJSON(res, 404, { ok: false, detail: "访问码不存在" });
    const c = store.renewAccessCode(cur.id, hours);
    refreshMirror();
    return sendJSON(res, 200, { ok: true, entry: { code: c.code, created_at: c.created_at, expires_at: c.expires_at }, detail: "已延期" });
  }

  // ---- PATCH /api/admin/access-codes/:code：设置权限范围（管理 · P8.40）----
  // body {agent_scope: string[]（agent id 列表）}：空数组 = 允许全部；非空 = 仅列出的智能体
  async function handleScope(req, res, code, urlObj) {
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON" }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    if (body.agent_scope === undefined) return sendJSON(res, 400, { ok: false, detail: "无有效字段（agent_scope）" });
    const ids = normalizeAgentScope(body.agent_scope, store.listAgents({}));
    if (ids === null) return sendJSON(res, 400, { ok: false, detail: "agent_scope 需为 agent id 数组（空数组 = 允许全部）" });
    const cur = store.getAccessCodeByCode(code);
    if (!cur) return sendJSON(res, 404, { ok: false, detail: "访问码不存在" });
    const c = store.updateAccessCode(cur.id, { agent_scope: ids });
    refreshMirror();
    const p = ctx.auth ? ctx.auth.principal(req, urlObj) : null;
    store.insertAudit({ actorType: "admin", actorId: p && p.userId ? p.userId : null, action: "access_code.scope", targetType: "access_code", targetId: cur.id, detail: { code, agent_scope: ids }, ip: ipOf(req), userAgent: uaOf(req) });
    return sendJSON(res, 200, { ok: true, entry: { code: c.code, agent_scope: c.agent_scope || null }, detail: ids.length ? "权限范围已更新（" + ids.length + " 个智能体）" : "已允许全部智能体" });
  }

  // ---- DELETE /api/admin/access-codes/expired：清理全部过期码（管理）----
  function handleCleanupExpired(res) {
    const removed = store.removeExpiredAccessCodes();
    if (removed > 0) refreshMirror();
    return sendJSON(res, 200, { ok: true, removed });
  }

  // ---- DELETE /api/admin/access-codes/:code：单个失效（管理）----
  function handleInvalidate(res, code) {
    const cur = store.getAccessCodeByCode(code);
    if (!cur) return sendJSON(res, 404, { ok: false, detail: "访问码不存在" });
    store.removeAccessCode(cur.id);
    authService.revokeTokensForCode(code);
    refreshMirror();
    return sendJSON(res, 200, { ok: true, detail: "已失效" });
  }

  return { refreshMirror, handleAdd, handleRenew, handleScope, handleCleanupExpired, handleInvalidate };
}

module.exports = { createAccessCodeService, DEFAULT_CODE_HOURS };
