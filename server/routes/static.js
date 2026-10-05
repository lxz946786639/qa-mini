"use strict";
// 静态页面与文件：public/（现役前端）+ web/dist（v59 P4 新代前端，挂载 /app/；P7 切根后 public/ 退役）
const path = require("path");
const fs = require("fs");
const { serveStatic, sendJSON } = require("../middleware");

// /app/ 下服务 web/dist：有实体文件直接提供；无扩展名路径 SPA fallback → index.html
// （vue-router history 模式；/api/* 永不命中此处——API 路由注册在前）
function serveApp(res, pathname, webDir) {
  let rel = pathname.slice(4); // "/app" → ""，"/app/x" → "/x"
  if (!rel || rel === "/") rel = "/index.html";
  const fp = path.normalize(path.join(webDir, rel.slice(1)));
  if (fp.startsWith(webDir) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    serveStatic(res, rel.slice(1), webDir);
  } else if (!path.extname(fp)) {
    serveStatic(res, "index.html", webDir); // SPA fallback
  } else {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function register(router, ctx) {
  const pub = () => ctx.publicDir;
  router.exact("GET", "/", (req, res) => { serveStatic(res, "index.html", pub()); return Promise.resolve(); });
  router.exact("GET", "/index.html", (req, res) => { serveStatic(res, "index.html", pub()); return Promise.resolve(); });
  router.exact("GET", "/admin", (req, res) => { serveStatic(res, "index.html", pub()); return Promise.resolve(); });
  // v59 P4：新代前端（web 构建产物）挂载 /app/ —— 同源共享 ea_sid cookie 与 /api
  router.regex("GET", /^\/app(\/.*)?$/, (req, res) => {
    serveApp(res, req.url.split("?")[0], ctx.webDist);
    return Promise.resolve();
  });
  // 其余 GET 一律按 public/ 静态文件提供（app.js / style.css / manifest / sw.js / icons/…）；
  // serveStatic 已做路径穿越防护（403）与存在性检查（404）
  router.regex("GET", /^/, (req, res) => {
    // 注意：dispatch 时 pathname 已含前导 /；此处按原始 path 提供
    serveStatic(res, req.url.split("?")[0].slice(1), pub());
    return Promise.resolve();
  });
}
module.exports = { register };
