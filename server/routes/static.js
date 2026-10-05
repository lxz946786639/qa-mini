"use strict";
// 静态页面与文件：站点根 = web/dist（v59 P7 起；旧 public/ 前端与 /app/ 挂载已退役）。
// 有实体文件直接提供（assets/、sw.js、manifest.webmanifest、icons/…）；
// 无扩展名路径 SPA fallback → index.html（vue-router history 模式）；
// /api/* 永不命中此处（API 路由注册在前）。
// P8：GET /doc/<文件名>.md —— 项目文档静态路由（首页「文档」导航 /「查看部署文档」入口）；
//   仅白名单提供 doc/ 目录下真实存在的 .md 文件（文件名白名单字符集 + 目录穿越拒绝）。
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

function serveDoc(res, rawFile) {
  // rawFile 为 URL 百分号编码形态（router 匹配的是 urlObj.pathname，不自动解码）
  let file = rawFile;
  try { file = decodeURIComponent(rawFile); } catch { file = rawFile; }
  // 白名单：单层文件名 + 限定字符集 + .md 结尾（拒绝路径分隔符 / 穿越 / 非 md）
  if (!file || !/^\/[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}\.md$/.test("/" + file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const docDir = path.join(__dirname, "..", "..", "doc");
  const fp = path.join(docDir, file);
  if (path.basename(fp) !== file || !fp.startsWith(docDir) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const buf = fs.readFileSync(fp);
  res.writeHead(200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-cache"
  });
  res.end(buf);
}

function register(router, ctx) {
  const web = () => ctx.webDist;
  // P8：项目文档静态路由（必须注册在 SPA catch-all 之前）
  router.regex("GET", /^\/doc\/(.+\.md)$/, (req, res, _ctx, _url, params) => {
    serveDoc(res, params[0]);
    return Promise.resolve();
  });
  // 站点根 + 全部静态文件 / SPA 路由（P7：根 = 新代前端）
  router.exact("GET", "/", (req, res) => { serveStatic(res, "index.html", web()); return Promise.resolve(); });
  router.regex("GET", /^/, (req, res) => {
    serveSpa(res, req.url.split("?")[0], web());
    return Promise.resolve();
  });
}
module.exports = { register };
