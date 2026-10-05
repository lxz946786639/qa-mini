"use strict";
// 智能体路由（v2 新面）：P3 注册（/api/agents 列表 → /api/agents/:code 工作区上下文，
// cookie 鉴权 + principal 过滤）。双轨期 P2 不注册任何路由（旧前端不依赖）。
// P3 实现时在此 register() 内注册：
//   GET  /api/agents          登录用户可选智能体列表（含 enabled 过滤）
//   GET  /api/agents/:code    工作区初始化上下文（agent + 私有桶会话列表）
function register(router, ctx) {
  // P2：无路由
}
module.exports = { register };
