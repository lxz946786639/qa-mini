"use strict";
// 登录：/api/admin/login（管理密码 · 首登初始化）/ /api/access/login（访问码）
// 双轨期：内存 token（12h/24h）；P3 起 /api/auth/* cookie 流程并行，本路由保留一个版本。
function register(router, ctx) {
  router.exact("POST", "/api/admin/login", (req, res) => ctx.auth.handleAdminLogin(req, res));
  router.exact("POST", "/api/access/login", (req, res) => ctx.auth.handleAccessLogin(req, res));
}
module.exports = { register };
