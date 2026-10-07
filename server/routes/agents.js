"use strict";
// 智能体路由（P3 实体化）：
//  GET /api/agents        （查看级）启用中智能体列表 → 落地页选择器
//  GET /api/agents/:code  （查看级）工作区初始化上下文（agent + 该主体可见的该智能体会话）
//  每智能体一个协议：agents 表无 protocol 列，协议与配置存 agent_configs（每智能体一行）。
const { sendJSON } = require("../middleware");
const { agentAllows } = require("../services/principal");
const { protocolEnabled } = require("../../lib/config");

function maskCfg(cfg) {
  const m = JSON.parse(JSON.stringify(cfg || {}));
  if (m && typeof m.api_key === "string" && m.api_key) m.api_key = "…已设置";
  return m;
}

function agentView(ctx, a) {
  const cfg = ctx.store.getAgentConfig(a.id);
  const proto = (cfg && cfg.protocol) || "ragflow";
  return {
    id: a.id, code: a.code, name: a.name, description: a.description || "",
    icon: a.icon || "", protocol: proto, protocol_enabled: protocolEnabled(proto, ctx.config), sort: a.sort,
    // P8.9：访问控制标志随公开视图下发（落地页「访问」徽标；门控仍在入口端点）
    allow_anon: a.allow_anon === true, allow_code: a.allow_code === true, allow_user: a.allow_user === true
  };
}

function register(router, ctx) {
  const viewer403 = (req, urlObj, res) => {
    if (!ctx.auth.viewerOk(req, urlObj)) {
      sendJSON(res, 403, { ok: false, detail: "需要访问码" });
      return true;
    }
    return false;
  };

  router.exact("GET", "/api/agents", (req, res, ctx_, urlObj) => {
    if (viewer403(req, urlObj, res)) return Promise.resolve();
    // P8.9：落地页展示全部启用智能体（不按访问控制过滤，含 allow_* 标志供徽标）；
    // 无权主体的门控在入口：GET /api/agents/:code → 404、POST /api/sessions → 403。
    const agents = ctx.store.listAgents({ enabledOnly: true }).map((a) => agentView(ctx, a));
    return sendJSON(res, 200, { agents });
  });

  router.regex("GET", /^\/api\/agents\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/, (req, res, ctx_, urlObj, params) => {
    if (viewer403(req, urlObj, res)) return Promise.resolve();
    const a = ctx.store.getAgentByCode(params[0]);
    if (!a || a.enabled !== true) return sendJSON(res, 404, { ok: false, detail: "智能体不存在: " + params[0] });
    const p = ctx.auth.principal(req, urlObj);
    // P8.8：主体未被该智能体放行 → 404（与不存在同码，不泄露存在性）
    if (!agentAllows(p, a)) return sendJSON(res, 404, { ok: false, detail: "智能体不存在: " + params[0] });
    // 该主体在该智能体下的可见会话（user=私有桶 / code=该码桶 / admin=全部 / anon=共享桶）
    const sessions = ctx.manager.list(false, p).filter((s) => (s.agent_id || null) === a.id);
    const cfg = ctx.store.getAgentConfig(a.id);
    return sendJSON(res, 200, {
      agent: agentView(ctx, a),
      protocol_config: maskCfg(cfg ? cfg.config : {}),
      sessions
    });
  });
}

module.exports = { register };
