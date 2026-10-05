"use strict";
// 会话 CRUD / 重置 / 协议测试 / 删记录（双轨期 = 遗留路由原样，鉴权：查看级/管理级）
const { sendJSON, parseJSONBody } = require("../middleware");
const { sessionView, PROTOCOLS } = require("../../lib/config");
const { testProtocol } = require("../../lib/protocol_test");
const { QaError } = require("../../lib/sse");
const { canView } = require("../services/principal");

// P3 IDOR：会话级操作需对该会话有查看权（admin 直通）；不可见 = 404（不泄露存在性）
// 属主写权：user 主体对自己的 'user' 私有会话可 改/删/删记录
function ownWrite(principal, s) {
  return !!(principal && principal.kind === "user" && s && s.access_mode === "user" && s.user_id === principal.userId);
}

function register(router, ctx) {
  const viewer403 = (req, urlObj, res) => {
    if (!ctx.auth.viewerOk(req, urlObj)) {
      sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return true;
    }
    return false;
  };
  const admin401 = (req, urlObj, res) => {
    if (!ctx.auth.isAdmin(req, urlObj)) {
      sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return true;
    }
    return false;
  };

  // GET /api/sessions（查看级；P3：按主体作用域过滤）
  router.exact("GET", "/api/sessions", (req, res, ctx_, urlObj) => {
    if (viewer403(req, urlObj, res)) return Promise.resolve();
    const p = ctx.auth.principal(req, urlObj);
    sendJSON(res, 200, { sessions: ctx.manager.list(ctx.auth.isAdmin(req, urlObj), p) });
    return Promise.resolve();
  });

  // GET /api/history（查看级 · 可见会话历史合并，新→旧）
  router.exact("GET", "/api/history", (req, res, ctx_, urlObj) => {
    if (viewer403(req, urlObj, res)) return Promise.resolve();
    const p = ctx.auth.principal(req, urlObj);
    sendJSON(res, 200, { items: ctx.manager.mergedHistory(p) });
    return Promise.resolve();
  });

  // POST /api/sessions（管理；P3：登录用户落自身私有桶、访问码落码桶）
  router.exact("POST", "/api/sessions", async (req, res, ctx_, urlObj) => {
    const p = ctx.auth.principal(req, urlObj);
    if (!ctx.auth.isAdmin(req, urlObj) && !(p && (p.kind === "user" || p.kind === "code"))) {
      return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
    }
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    // P3：智能体归属（agent_id 或 agent_code；缺省 = 遗留 industry-brain 桶）
    let pp = p;
    if (pp) {
      let agentId = null;
      if (typeof body.agent_id === "string" && body.agent_id) agentId = body.agent_id;
      else if (typeof body.agent_code === "string" && body.agent_code) {
        const ag = ctx.store.getAgentByCode(body.agent_code);
        agentId = ag ? ag.id : null;
      }
      pp = agentId ? Object.assign({}, pp, { agentId }) : pp;
    }
    const s = ctx.manager.create({
      name: typeof body.name === "string" ? body.name : "",
      protocol: typeof body.protocol === "string" ? body.protocol : "ragflow",
      continue_session: typeof body.continue_session === "boolean" ? body.continue_session : true
    }, pp);
    return sendJSON(res, 201, { ok: true, session: sessionView(s, 0, true) });
  });

  // POST /api/sessions/:id/reset（管理）
  router.regex("POST", /^\/api\/sessions\/([a-zA-Z0-9]+)\/reset$/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    const ok = ctx.manager.reset(params[0]);
    sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "会话已重置" : "会话不存在: " + params[0] });
    return Promise.resolve();
  });

  // POST /api/sessions/:id/protocol-test（管理）
  // body { protocol?, config? }：config = 表单当前草稿（含空串，空 = 回退全局）。
  router.regex("POST", /^\/api\/sessions\/([a-zA-Z0-9]+)\/protocol-test$/, async (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return;
    const id = params[0];
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    if (body.config !== undefined &&
        (typeof body.config !== "object" || body.config === null || Array.isArray(body.config))) {
      return sendJSON(res, 400, { ok: false, detail: "config 必须是对象（{ 字段: 值 }）" });
    }
    const s = ctx.manager.sessionById(id);
    if (!s) return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + id });
    const proto = typeof body.protocol === "string" ? body.protocol.trim() : s.protocol;
    if (!PROTOCOLS.includes(proto)) return sendJSON(res, 400, { ok: false, detail: "未知协议: " + proto });
    const r = await testProtocol(proto, ctx.config, body.config || {});
    return sendJSON(res, 200, { ok: r.ok, detail: r.detail });
  });

  // DELETE /api/sessions/:id/history/:qaId（管理）
  router.regex("DELETE", /^\/api\/sessions\/([a-zA-Z0-9]+)\/history\/([a-zA-Z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    const p = ctx.auth.principal(req, urlObj);
    if (!ctx.auth.isAdmin(req, urlObj) && !ownWrite(p, ctx.manager.sessionById(params[0]))) {
      return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
    }
    const ok = ctx.manager.removeRecord(params[0], params[1]);
    sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "已删除" : "记录不存在" });
    return Promise.resolve();
  });

  // POST /api/session/reset（管理 · 全局重置）
  router.exact("POST", "/api/session/reset", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    ctx.manager.resetAll();
    ctx.manager.broadcastSessions();
    sendJSON(res, 200, { ok: true });
    return Promise.resolve();
  });

  // /api/sessions/:id —— GET 查看级 / PUT 管理 / DELETE 管理
  router.regex("GET", /^\/api\/sessions\/([a-zA-Z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    if (viewer403(req, urlObj, res)) return Promise.resolve();
    if (!ctx.auth.isAdmin(req, urlObj)) {
      const s = ctx.manager.sessionById(params[0]);
      if (!s || !canView(ctx.auth.principal(req, urlObj), s)) {
        return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + params[0] });
      }
    }
    const full = ctx.manager.full(params[0], ctx.auth.isAdmin(req, urlObj));
    if (!full) return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + params[0] });
    return sendJSON(res, 200, full);
  });
  router.regex("PUT", /^\/api\/sessions\/([a-zA-Z0-9]+)$/, async (req, res, ctx_, urlObj, params) => {
    const p = ctx.auth.principal(req, urlObj);
    if (!ctx.auth.isAdmin(req, urlObj) && !ownWrite(p, ctx.manager.sessionById(params[0]))) {
      return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
    }
    const id = params[0];
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    if (body.protocol_config !== undefined &&
        (typeof body.protocol_config !== "object" || body.protocol_config === null || Array.isArray(body.protocol_config))) {
      return sendJSON(res, 400, { ok: false, detail: "protocol_config 必须是对象（按协议分组：{ 协议: { 字段: 值 } }）" });
    }
    const s = ctx.manager.update(id, body);
    if (!s) return sendJSON(res, 404, { ok: false, detail: "会话不存在: " + id });
    return sendJSON(res, 200, { ok: true, session: sessionView(s, 0, true) });
  });
  router.regex("DELETE", /^\/api\/sessions\/([a-zA-Z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    const p = ctx.auth.principal(req, urlObj);
    if (!ctx.auth.isAdmin(req, urlObj) && !ownWrite(p, ctx.manager.sessionById(params[0]))) {
      return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
    }
    const id = params[0];
    const ok = ctx.manager.remove(id);
    if (ok) {
      ctx.listen.stopForSession(id); // 会话删除 → 监听任务全清
      ctx.audioStreams.removeSession(id); // 会话删除 → 音频流全清
    }
    sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "已删除" : "会话不存在: " + id });
    return Promise.resolve();
  });
}
module.exports = { register };
