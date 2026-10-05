"use strict";
// 公开只读：/api/health（docker healthcheck 依赖）/ /api/status
const { sendJSON } = require("../middleware");
const { PROTOCOLS } = require("../../lib/config");

function register(router, ctx) {
  router.exact("GET", "/api/health", (req, res) => {
    sendJSON(res, 200, {
      ok: true,
      uptime_s: Math.round(process.uptime()),
      sessions: ctx.manager.list().length,
      active_qa: ctx.manager.activeIds(),
      sse_clients: ctx.bus.size(),
      protocols: PROTOCOLS,
      asr_configured: Boolean(String(((ctx.config || {}).asr || {}).url || "").trim())
    });
    return Promise.resolve();
  });
  router.exact("GET", "/api/status", (req, res) => {
    sendJSON(res, 200, {
      ok: true,
      allow_anonymous: ctx.auth.allowAnonymous(),
      admin_set: ctx.auth.adminEnabled()
    });
    return Promise.resolve();
  });
}
module.exports = { register };
