"use strict";
// 服务装配：上下文 + 路由表 + http server（唯一入口由根 server.js 调用 start()）
const http = require("http");
const { Router } = require("./router");
const { sendJSON } = require("./middleware");
const { buildContext } = require("./context");

// 注册顺序 = 旧 server.js if 链顺序（首个命中即处理）：
// health/status → 登录 → 访问码管理 → SSE → 会话(查看+管理) → chat/cancel →
// asr/asr.test → 音频(推流/截取/实时识别/设备列表) → push → 智能体(P3) → 静态
const routeModules = [
  require("./routes/health"),
  require("./routes/auth"),
  require("./routes/admin"),
  require("./routes/security"),
  require("./routes/events"),
  require("./routes/sessions"),
  require("./routes/chat"),
  require("./routes/asr"),
  require("./routes/audio"),
  require("./routes/push"),
  require("./routes/agents"),
  require("./routes/static")
];

function start() {
  const ctx = buildContext();
  const router = new Router();
  for (const m of routeModules) m.register(router, ctx);

  const server = http.createServer(async (req, res) => {
    let urlObj;
    try {
      urlObj = new URL(req.url, "http://localhost");
    } catch {
      return sendJSON(res, 400, { ok: false, detail: "非法 URL" });
    }
    try {
      // P8.49：IP 封禁守卫（/api/* 含 SSE；/api/health 放行；admin 主体豁免防自锁）
      if (urlObj.pathname.startsWith("/api/") && urlObj.pathname !== "/api/health") {
        if (ctx.security.guard(req, urlObj, res)) return;
      }
      const handled = await router.dispatch(req, res, ctx, urlObj);
      if (!handled) sendJSON(res, 404, { ok: false, detail: "not found" });
    } catch (e) {
      console.error("[server] 处理异常:", e);
      if (!res.headersSent) sendJSON(res, 500, { ok: false, detail: String(e.message || e) });
      else {
        try { res.end(); } catch {}
      }
    }
  });

  const port = Number(process.env.PORT) || Number(ctx.config.port) || 8787;
  const host = process.env.HOST || ctx.config.host || "0.0.0.0";
  server.listen(port, host, () => {
    const def = ctx.sessions[0];
    console.log("==================================================");
    console.log("  EchoAnswer 已启动（多会话）");
    console.log("  Web 界面:   http://" + (host === "0.0.0.0" ? "127.0.0.1" : host) + ":" + port + "/");
    console.log("  推送接口:   POST http://<本机IP>:" + port + "/api/push");
    console.log("              请求体需同时携带 token 与 session_id（在网页「会话设置」中复制 EchoScribe 片段）");
    console.log("  音频推流:   POST /api/audio/stream（EchoScribe 持续推流；会话需启用「输出音频接收」）");
    console.log("  会话存储:   " + ctx.dbFile + "（SQLite v2）");
    console.log("  默认会话:   " + (def ? def.name + "（会话ID " + def.id + "）" : "（无）"));
    console.log("  配置:       " + ctx.configFile);
    console.log("==================================================");
  });
  return server;
}

module.exports = { start };
