"use strict";
// /api/chat（网页提问 · 查看级）/ /api/cancel（取消在途问答 · 查看级）
const { sendJSON, parseJSONBody } = require("../middleware");
const { QaError } = require("../../lib/sse");
const { canView, agentAllows } = require("../services/principal");

// P8.8：会话归属智能体未对该主体放行 → 视为不可见（404，与 IDOR 同口径）
function sessionAgentOk(ctx, principal, session) {
  if (!principal || !session) return false;
  if (principal.kind === "admin") return true;
  if (!session.agent_id) return true; // 无归属的遗留会话：维持旧语义
  const ag = ctx.store.getAgent(session.agent_id);
  return agentAllows(principal, ag);
}

function register(router, ctx) {
  router.exact("POST", "/api/chat", async (req, res, ctx_, urlObj) => {
    if (!ctx.auth.viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) }); }
    const sid = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const session = sid ? ctx.manager.sessionById(sid) : null;
    if (!session) return sendJSON(res, 400, { ok: false, detail: "session_id 必填且为有效会话" });
    // P3 IDOR：非 admin 须对该会话有查看权（不可见 = 404，不泄露存在性）
    // P8.8：且会话归属智能体须对该主体放行
    if (!ctx.auth.isAdmin(req, urlObj) && !(canView(ctx.auth.principal(req, urlObj), session) && sessionAgentOk(ctx, ctx.auth.principal(req, urlObj), session))) {
      return sendJSON(res, 404, { ok: false, detail: "session_id 必填且为有效会话" });
    }
    const question = typeof body.question === "string" ? body.question : "";
    if (!question.trim()) return sendJSON(res, 400, { ok: false, detail: "question 为空" });
    ctx.security.noteQa(req); // P8.49：提问高频监控（安全维度 IP 1 分钟滑动窗）
    let started;
    try {
      started = ctx.manager.runnerFor(session).start({
        question,
        source: "web",
        context: typeof body.context === "string" ? body.context : "",
        newSession: body.newSession === true
      });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, detail: e instanceof QaError ? e.detail : String(e.message || e) });
    }
    return sendJSON(res, 202, {
      ok: true, qa_id: started.id, session_id: session.id, protocol: session.protocol
    });
  });
  router.exact("POST", "/api/cancel", async (req, res, ctx_, urlObj) => {
    if (!ctx.auth.viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
    let body;
    try { body = await parseJSONBody(req); }
    catch { return sendJSON(res, 400, { ok: false, detail: "请求体不是合法 JSON" }); }
    if (!body.id) return sendJSON(res, 400, { ok: false, detail: "id 必填" });
    // P3 IDOR：在途问答归属他桶 → 404；P8.8：归属智能体未放行同口径
    const sid2 = ctx.manager.sessionByQaId(String(body.id));
    if (sid2 && !ctx.auth.isAdmin(req, urlObj) && !(canView(ctx.auth.principal(req, urlObj), ctx.manager.sessionById(sid2)) && sessionAgentOk(ctx, ctx.auth.principal(req, urlObj), ctx.manager.sessionById(sid2)))) {
      return sendJSON(res, 404, { ok: false, detail: "无此在途问答" });
    }
    const ok = ctx.manager.cancelAny(String(body.id));
    return sendJSON(res, ok ? 200 : 404, { ok, detail: ok ? "已请求取消" : "无此在途问答" });
  });
}
module.exports = { register };
