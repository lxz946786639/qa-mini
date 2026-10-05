"use strict";
// 静态页面与文件（public/ 纯静态资源；P7 起由 web/ 构建产物替换，路由层不变）
const path = require("path");
const { serveStatic, sendJSON } = require("../middleware");

function register(router, ctx) {
  const pub = () => ctx.publicDir;
  router.exact("GET", "/", (req, res) => { serveStatic(res, "index.html", pub()); return Promise.resolve(); });
  router.exact("GET", "/index.html", (req, res) => { serveStatic(res, "index.html", pub()); return Promise.resolve(); });
  router.exact("GET", "/admin", (req, res) => { serveStatic(res, "index.html", pub()); return Promise.resolve(); });
  // 其余 GET 一律按 public/ 静态文件提供（app.js / style.css / manifest / sw.js / icons/…）；
  // serveStatic 已做路径穿越防护（403）与存在性检查（404）
  router.regex("GET", /^/, (req, res) => {
    // 注意：dispatch 时 pathname 已含前导 /；此处按原始 path 提供
    serveStatic(res, req.url.split("?")[0].slice(1), pub());
    return Promise.resolve();
  });
}
module.exports = { register };
