"use strict";
// P3 主体（principal）模型 + 会话可见性规则 —— 租户隔离核心。
//
// principal（按请求解析，见 auth.principal()；解析源：cookie ea_sid → 遗留
// X-Admin-Token/?admin= → 遗留 ?access=/x-access-token → 匿名）：
//   { kind: "admin", userId, role: "admin" }
//   { kind: "user",  userId, role: "user" }
//   { kind: "code",  codeId, code }
//   { kind: "anon" }            // allow_anonymous = true 时
//   null                        // 无凭证（由调用方决定 401/403）
//
// 会话桶（sessions.access_mode）：
//   "shared" —— 共享桶：v1/v2 存量会话（P3 首启一次性回填）+ 匿名新建
//               （P8.84：agent_id = 创建入口的归属智能体，工作区新建不再落遗留桶智能体）；
//               一切查看级主体可见可问（保留旧「访问码 = 共享会话」语义）
//   "user"   —— 用户私有桶 (user_id, agent_id)：仅属主用户 + 管理
//               （P8.10：管理员新建会话也落此桶，user_id = 管理员用户，
//                 不再污染共享桶 —— 此前管理员新建对码/用户/匿名全部可见）
//   "code"   —— 访问码私有桶 (access_code_id, agent_id)：仅该码持有者 + 管理

function canView(principal, s) {
  if (!principal || !s) return false;
  if (principal.kind === "admin") return true;
  const mode = s.access_mode || "shared"; // 缺省 = 共享（基类直接 newSession 的遗留对象）
  if (mode === "shared") return true;
  if (mode === "user") return principal.kind === "user" && !!principal.userId && principal.userId === s.user_id;
  if (mode === "code") return principal.kind === "code" && !!principal.codeId && principal.codeId === s.access_code_id;
  return false;
}

// 主体能否在指定桶「创建」会话（路由层据此决定 401）：
//   shared —— 一切已放行查看主体（双轨期匿名创建 = 共享，维持旧行为）
//   user   —— 仅 user 主体（登录用户）
//   code   —— 仅 code 主体（访问码登录）
function canCreate(principal, mode) {
  if (!principal) return false;
  if (mode === "shared") return true;
  if (mode === "user") return principal.kind === "user";
  if (mode === "code") return principal.kind === "code";
  return false;
}

// P8.8 智能体级访问控制：主体能否使用该智能体（agent = store.getAgent()，含 allow_* 三列）。
//   admin —— 恒允许（管理台始终可管可用；P8.40 起也不受权限范围约束）
//   anon  —— allow_anon（allow_anonymous=false 时主体为 null，同样按此列）
//   user  —— (allow_anon || allow_user) && 权限范围命中（超集语义）
//   code  —— (allow_anon || allow_code) && 权限范围命中（同上）
// P8.40/P8.51 权限范围（principal.agentScope = 主体行的 agent_scope 解析值）：
//   null = 允许全部（存量 '' 行为与 P8.8 完全一致）；
//   [] = 不允许任何智能体（最小权限，P8.51 起新建主体默认）；
//   非空 = 仅列出的 agent id 可用（与 allow_* 开关取交集）。
function scopeAllows(scope, agentId) {
  if (scope === null || scope === undefined) return true;
  return scope.indexOf(agentId) !== -1;
}
// P8.93 匿名开放时段判定：win = null|{start,end,dayStart,dayEnd}
// （start/end 本地日期 YYYY-MM-DD、dayStart/dayEnd 本地时间 HH:MM；缺省 = 永久/全天）
function anonWindowOpen(win, now) {
  if (!win || typeof win !== "object") return true;
  now = now || new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const d = now.getFullYear() + "-" + p2(now.getMonth() + 1) + "-" + p2(now.getDate());
  if (typeof win.start === "string" && win.start && d < win.start) return false;
  if (typeof win.end === "string" && win.end && d > win.end) return false;
  if (typeof win.dayStart === "string" && win.dayStart && typeof win.dayEnd === "string" && win.dayEnd) {
    const t = p2(now.getHours()) + ":" + p2(now.getMinutes());
    if (t < win.dayStart || t >= win.dayEnd) return false;
  }
  return true;
}
function agentAllows(principal, agent) {
  if (!agent) return false;
  if (principal && principal.kind === "admin") return true;
  // P8.93：匿名通道受开放时段约束（时段外 anonOk = false——user/code 经匿名通道
  // 的超集放行同步关闭，但 allow_user/allow_code 开关自身的通道不受影响）
  const anonOk = agent.allow_anon === true && anonWindowOpen(agent.anon_window);
  if (!principal) return anonOk;
  if (principal.kind === "anon") return anonOk;
  if (principal.kind === "user") return (anonOk || agent.allow_user === true) && scopeAllows(principal.agentScope, agent.id);
  if (principal.kind === "code") return (anonOk || agent.allow_code === true) && scopeAllows(principal.agentScope, agent.id);
  return false;
}

// 按主体解析新建会话的归属桶（legacy = ctx.legacy 遗留桶兜底）
function bucketFor(principal, legacy) {
  if (principal && principal.kind === "user") {
    return { access_mode: "user", user_id: principal.userId, agent_id: principal.agentId || (legacy && legacy.agentId), access_code_id: null };
  }
  if (principal && principal.kind === "code") {
    return { access_mode: "code", user_id: null, agent_id: principal.agentId || (legacy && legacy.agentId), access_code_id: principal.codeId };
  }
  // P8.10：管理员新建 → 管理员私有桶（user 桶，user_id = 管理员用户）；
  // userId 缺失（遗留 token 边缘态）→ 兜底共享桶
  if (principal && principal.kind === "admin" && principal.userId) {
    return { access_mode: "user", user_id: principal.userId, agent_id: principal.agentId || (legacy && legacy.agentId), access_code_id: null };
  }
  // anon / null → 共享桶（双轨期遗留语义：匿名创建 = 共享）；
  // P8.84：智能体归属 = 创建入口的归属智能体（principal.agentId，工作区新建携带）——
  // 原实现恒落 legacy.agentId（遗留桶智能体），匿名工作区建会话落错智能体：
  // 该智能体会话列表不可见 + /api/chat 智能体门控 404（「session_id 必填且为有效会话」）
  const anonAgentId = (principal && principal.agentId) || (legacy ? legacy.agentId : null);
  return { access_mode: "shared", user_id: legacy ? legacy.userId : null, agent_id: anonAgentId, access_code_id: null };
}

module.exports = { canView, canCreate, bucketFor, agentAllows, scopeAllows, anonWindowOpen };
