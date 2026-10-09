"use strict";
// 会话 CRUD / 重置 / 协议测试 / 删记录（双轨期 = 遗留路由原样，鉴权：查看级/管理级）
const { sendJSON, parseJSONBody } = require("../middleware");
const { sessionView, PROTOCOLS } = require("../../lib/config");
const { testProtocol } = require("../../lib/protocol_test");
const { QaError } = require("../../lib/sse");
const { canView, agentAllows } = require("../services/principal");

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
    const admin = ctx.auth.isAdmin(req, urlObj);
    // P8.47：列表项含桶类型 access_mode；管理端另带 user_id / owner_name（私有桶属主用户名）
    const sessions = ctx.manager.list(admin, p, admin).map((s) =>
      admin && s.access_mode === "user" && s.user_id
        ? Object.assign({}, s, { owner_name: (ctx.store.getUser(s.user_id) || {}).username || null })
        : s
    );
    sendJSON(res, 200, { sessions });
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
    // P8.8：归属智能体对主体未放行 → 403（访问控制：console·智能体管理·安全）
    let pp = p;
    if (pp) {
      let agentId = null;
      if (typeof body.agent_id === "string" && body.agent_id) {
        agentId = body.agent_id;
        const ag = ctx.store.getAgent(agentId);
        if (ag && !agentAllows(pp, ag)) {
          return sendJSON(res, 403, { ok: false, detail: "该智能体未允许此访问方式（控制台·智能体管理·安全）" });
        }
      } else if (typeof body.agent_code === "string" && body.agent_code) {
        const ag = ctx.store.getAgentByCode(body.agent_code);
        if (ag) {
          if (!agentAllows(pp, ag)) {
            return sendJSON(res, 403, { ok: false, detail: "该智能体未允许此访问方式（控制台·智能体管理·安全）" });
          }
          agentId = ag.id;
        }
      }
      pp = agentId ? Object.assign({}, pp, { agentId }) : pp;
    }
    // P8.81: 未显式指定协议时继承归属智能体的协议（agent_configs.protocol，
    // 缺省 ragflow）——工作区新建会话不再是「恒 ragflow」
    let proto = typeof body.protocol === "string" && body.protocol.trim() ? body.protocol.trim() : null;
    if (!proto) {
      const agId = pp && pp.agentId ? pp.agentId : null;
      const agCfg = agId ? ctx.store.getAgentConfig(agId) : null;
      proto = agCfg && typeof agCfg.protocol === "string" && PROTOCOLS.includes(agCfg.protocol)
        ? agCfg.protocol
        : "ragflow";
    }
    const s = ctx.manager.create({
      name: typeof body.name === "string" ? body.name : "",
      protocol: proto,
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
    // P8.81: 测试链含智能体层（全局 ← 智能体 ← 草稿），与运行时解析一致；
    // 智能体层仅当「测试协议 = 智能体协议」时生效（防跨协议字段泄漏）
    let agentCfg = null;
    if (s.agent_id) {
      const c = ctx.store.getAgentConfig(s.agent_id);
      if (c && typeof c.config === "object" && c.config !== null &&
          !(typeof c.protocol === "string" && c.protocol !== proto)) {
        agentCfg = c.config;
      }
    }
    const r = await testProtocol(proto, ctx.config, body.config || {}, agentCfg);
    return sendJSON(res, 200, { ok: r.ok, detail: r.detail });
  });

  // DELETE /api/sessions/:id/history/:qaId（管理）
  router.regex("DELETE", /^\/api\/sessions\/([a-zA-Z0-9]+)\/history\/([a-zA-Z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    const p = ctx.auth.principal(req, urlObj);
    if (!ctx.auth.isAdmin(req, urlObj) && !ownWrite(p, ctx.manager.sessionById(params[0]))) {
      // P8.79：无权限删除 → 明确提示（前端透传 detail）
      return sendJSON(res, 401, { ok: false, detail: "您无权限删除（仅会话属主/管理员可删除）" });
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
    // P8.53：会话级协议配置仅管理可改 —— 非 admin（用户属主 / 访问码）静默忽略 protocol_config（保持原值）
    if (!ctx.auth.isAdmin(req, urlObj)) delete body.protocol_config;
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
      // P8.79：无权限删除 → 明确提示（前端透传 detail）
      return sendJSON(res, 401, { ok: false, detail: "您无权限删除（仅会话属主/管理员可删除）" });
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
