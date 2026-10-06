"use strict";
// /api/events：SSE 广播（查看级）。
// P2：全局广播（与旧版同语义，事件均带 session_id，客户端按会话过滤）；
// P3：EventBus principal 作用域投递（接口不变）。
// P8.33：连接携带 ?dev= 设备指纹（客户端 UA 的 FNV-1a 码）入在线注册表；
// 踢出冷却期内建流直接 403（evicted）；/api/events/check 为踢出探针端点。
const { ipOf, uaOf, cookieValue, sendJSON } = require("../middleware");

function register(router, ctx) {
  router.exact("GET", "/api/events", (req, res, ctx_, urlObj) => {
    if (!ctx.auth.viewerOk(req, urlObj)) {
      const r = { ok: false, detail: "需要访问码" };
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
      return Promise.resolve();
    }
    // P8.33：在线注册 meta（dev 设备指纹 + IP 判定唯一；sid 供踢出时吊销）
    const dev = String(urlObj.searchParams.get("dev") || "").slice(0, 32);
    const ip = ipOf(req);
    if (ctx.bus.isKicked(dev, ip)) {
      sendJSON(res, 403, { ok: false, evicted: true, detail: "您已被管理员下线，请稍后再试" });
      return Promise.resolve();
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const p = ctx.auth.principal(req, urlObj);
    const isAdmin = ctx.auth.isAdmin(req, urlObj);
    res.write(": connected\n\n");
    // P3：初始会话列表按主体作用域（旧前端匿名场景 = 全共享桶，行为不变）
    res.write("event: sessions\ndata: " + JSON.stringify({ sessions: ctx.manager.list(false, p) }) + "\n\n");
    ctx.bus.add(res, p, isAdmin, { dev, ip, ua: uaOf(req), sid: cookieValue(req, "ea_sid"), connectedAt: new Date().toISOString() });
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        ctx.bus.delete(res);
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      ctx.bus.delete(res);
    });
    return Promise.resolve();
  });
  // P8.33：踢出探针（无需主体；仅回答「本端 dev+IP 是否处于踢出冷却」，无越权泄露）
  router.exact("GET", "/api/events/check", (req, res, ctx_, urlObj) => {
    const dev = String(urlObj.searchParams.get("dev") || "").slice(0, 32);
    if (ctx.bus.isKicked(dev, ipOf(req))) {
      sendJSON(res, 403, { ok: false, evicted: true, detail: "您已被管理员下线，请稍后再试" });
    } else {
      sendJSON(res, 200, { ok: true });
    }
    return Promise.resolve();
  });
}
module.exports = { register };
