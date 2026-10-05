"use strict";
// 静态页面与文件：站点根 = web/dist（v59 P7 起；旧 public/ 前端与 /app/ 挂载已退役）。
// 有实体文件直接提供（assets/、sw.js、manifest.webmanifest、icons/…）；
// 无扩展名路径 SPA fallback → index.html（vue-router history 模式）；
// /api/* 永不命中此处（API 路由注册在前）。
const path = require("path");
const fs = require("fs");
const { serveStatic } = require("../middleware");

function serveSpa(res, pathname, webDir) {
  if (pathname.startsWith("/api/")) { // API 路由未命中 = 不存在（不回 SPA fallback）
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  let rel = pathname === "/" ? "/index.html" : pathname;
  const fp = path.normalize(path.join(webDir, rel.slice(1)));
  if (fp.startsWith(webDir) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    serveStatic(res, rel.slice(1), webDir);
  } else if (!path.extname(fp)) {
    serveStatic(res, "index.html", webDir); // SPA fallback（/login、/admin、/agents/:code…）
  } else {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function register(router, ctx) {
  const web = () => ctx.webDist;
  // 站点根 + 全部静态文件 / SPA 路由（P7：根 = 新代前端）
  router.exact("GET", "/", (req, res) => { serveStatic(res, "index.html", web()); return Promise.resolve(); });
  router.regex("GET", /^/, (req, res) => {
    serveSpa(res, req.url.split("?")[0], web());
    return Promise.resolve();
  });
}
module.exports = { register };
