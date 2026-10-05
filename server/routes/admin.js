"use strict";
// 管理路由（双轨期）：
//  访问码生成/延期/清理/失效 + /api/config GET/PUT（深合并 → config.json + v2 库同步）
const { sendJSON, parseJSONBody, maskConfigForBroadcast } = require("../middleware");
const { deepMerge, validateConfig, saveConfig, resolveProtocolConfig } = require("../../lib/config");
const { syncConfigToStore } = require("../services/config_sync");

function register(router, ctx) {
  const admin401 = (req, urlObj, res) => {
    if (!ctx.auth.isAdmin(req, urlObj)) {
      sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
      return true;
    }
    return false;
  };

  // ---- 访问码（管理）----
  router.exact("POST", "/api/admin/access-codes", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    return ctx.codes.handleAdd(req, res);
  });
  router.exact("DELETE", "/api/admin/access-codes/expired", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    ctx.codes.handleCleanupExpired(res);
    return Promise.resolve();
  });
  router.regex("POST", /^\/api\/admin\/access-codes\/([A-Za-z0-9]+)\/renew$/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    return ctx.codes.handleRenew(req, res, params[0]);
  });
  router.regex("DELETE", /^\/api\/admin\/access-codes\/([A-Za-z0-9]+)$/, (req, res, ctx_, urlObj, params) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    ctx.codes.handleInvalidate(res, params[0]);
    return Promise.resolve();
  });

  // ---- GET /api/config（管理 · 全量）----
  router.exact("GET", "/api/config", (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return Promise.resolve();
    sendJSON(res, 200, ctx.config);
    return Promise.resolve();
  });

  // ---- PUT /api/config（管理 · 深合并 → 落盘 + v2 库同步）----
  router.exact("PUT", "/api/config", async (req, res, ctx_, urlObj) => {
    if (admin401(req, urlObj, res)) return;
    let patch;
    try { patch = await parseJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) }); }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    const next = deepMerge(ctx.config, patch);
    const problems = validateConfig(next);
    if (problems.length) {
      return sendJSON(res, 400, { ok: false, detail: "配置无效: " + problems.join("；") });
    }
    try {
      saveConfig(ctx.configFile, next);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, detail: "配置保存失败: " + e.message });
    }
    const prev = ctx.config;
    ctx.config = next;
    // 全局协议配置变化 → 回退全局的会话（对应字段留空）后端上下文失效：
    // ragflow 的 url/api_key/chat_id、dify 的 url/api_key 变化时清空会话后端会话 ID，
    // 下次提问按新配置重建（否则旧会话不属于新 chat → RAGFlow 报错/空回答）
    let invalidated = 0;
    for (const s of ctx.manager.getSessions()) {
      const p = s.protocol;
      if (p !== "ragflow" && p !== "dify") continue;
      const a = resolveProtocolConfig(s, prev, p);
      const b = resolveProtocolConfig(s, next, p);
      const sameStr = (x, y) => String(x || "") === String(y || "");
      if (p === "ragflow" &&
          (!sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key) || !sameStr(a.chat_id, b.chat_id))) {
        if (s.ragflow_session_id) { s.ragflow_session_id = ""; invalidated++; }
      }
      if (p === "dify" && (!sameStr(a.url, b.url) || !sameStr(a.api_key, b.api_key))) {
        if (s.dify_conversation_id) { s.dify_conversation_id = ""; invalidated++; }
      }
    }
    if (invalidated) ctx.manager.save();
    try {
      syncConfigToStore(ctx.store, next); // v2 库同步（protocol_defaults/system_configs/access_codes/admin 密码）
    } catch (e) {
      console.error("[config] v2 库同步失败（已落盘 config.json）:", e && e.message || e);
    }
    ctx.codes.refreshMirror();
    ctx.bus.emit("config", { ok: true, config: maskConfigForBroadcast(next) });
    return sendJSON(res, 200, { ok: true, config: next, invalidated_sessions: invalidated });
  });
}
module.exports = { register };
