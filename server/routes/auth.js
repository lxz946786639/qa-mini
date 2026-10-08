"use strict";
// 登录：/api/admin/login（管理密码 · 首登初始化）/ /api/access/login（访问码）
// 双轨期：内存 token（12h/24h）；P3 起 /api/auth/* cookie 流程并行，本路由保留一个版本。
function register(router, ctx) {
  // 遗留端点（双轨 shim，保留一个版本）
  router.exact("POST", "/api/admin/login", (req, res) => ctx.auth.handleAdminLogin(req, res));
  router.exact("POST", "/api/access/login", (req, res) => ctx.auth.handleAccessLogin(req, res));
  // P3 cookie 登录流程
  router.exact("POST", "/api/auth/login", (req, res) => ctx.auth.handleAuthLogin(req, res));
  router.exact("POST", "/api/auth/access-code", (req, res) => ctx.auth.handleAuthCodeLogin(req, res));
  router.exact("GET", "/api/auth/me", (req, res, ctx_, urlObj) => ctx.auth.handleAuthMe(req, res, ctx_, urlObj));
  // P8.55：个人设置自助（显示名 / 修改密码；账号主体，访问码 401）
  router.exact("PUT", "/api/auth/me", (req, res, ctx_, urlObj) => ctx.auth.handleAuthMeUpdate(req, res, ctx_, urlObj));
  router.exact("POST", "/api/auth/logout", (req, res) => ctx.auth.handleAuthLogout(req, res));
}
module.exports = { register };
