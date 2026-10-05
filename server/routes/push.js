"use strict";
// /api/push：EchoScribe 推送接口（兼容性红线：只带 token 必须可用）
// 请求体 = { token, session_id?, text }（可携带 EchoScribe body 的其他字段）。
// token 定位会话；带 session_id 时校验一致。默认 202 异步；?sync=true 阻塞（上限 28s）。
const { sendJSON, parseJSONBody, withTimeout } = require("../middleware");
const { QaError } = require("../../lib/sse");

function register(router, ctx) {
  router.exact("POST", "/api/push", async (req, res, ctx_, urlObj) => {
    let body;
    try { body = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    // 推送鉴权 = 会话推送 token 本身（48 位随机高熵凭证，持有即授权），
    // 无需再叠加访问码：EchoScribe 请求体已配好 token，访问码失效/换码不影响推送。
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
    const session = ctx.manager.byToken(token);
    if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
    const sidIn = typeof body.session_id === "string" ? body.session_id.trim() : "";
    if (sidIn && sidIn !== session.id) {
      return sendJSON(res, 400, { ok: false, detail: "session_id 与 token 不匹配" });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return sendJSON(res, 400, { ok: false, detail: "text 为空" });
    const protocol = session.protocol;

    let started;
    try {
      started = ctx.manager.runnerFor(session).start({
        question: text,
        source: "push",
        context: typeof body.context === "string" ? body.context : "",
        newSession: !session.continue_session
      });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, detail: e instanceof QaError ? e.detail : String(e.message || e) });
    }

    if (urlObj.searchParams.get("sync") !== "true") {
      return sendJSON(res, 202, { ok: true, accepted: true, qa_id: started.id, session_id: session.id, protocol });
    }

    const result = await withTimeout(started.promise, 28000, () => null);
    if (result === null) {
      return sendJSON(res, 200, {
        ok: false, detail: "等待超时（28s）", answer: "", qa_id: started.id, session_id: session.id
      });
    }
    if (result.__error) {
      return sendJSON(res, 500, { ok: false, detail: String(result.__error.message || result.__error) });
    }
    return sendJSON(res, 200, {
      ok: result.ok, detail: result.detail, answer: result.answer,
      qa_id: result.id, session_id: session.id
    });
  });
}
module.exports = { register };
