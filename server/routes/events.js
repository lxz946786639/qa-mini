"use strict";
// /api/events：SSE 广播（查看级）。
// P2：全局广播（与旧版同语义，事件均带 session_id，客户端按会话过滤）；
// P3：EventBus principal 作用域投递（接口不变）。
function register(router, ctx) {
  router.exact("GET", "/api/events", (req, res, ctx_, urlObj) => {
    if (!ctx.auth.viewerOk(req, urlObj)) {
      const r = { ok: false, detail: "需要访问码" };
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
      return Promise.resolve();
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");
    res.write("event: sessions\ndata: " + JSON.stringify({ sessions: ctx.manager.list() }) + "\n\n");
    ctx.bus.add(res);
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
}
module.exports = { register };
