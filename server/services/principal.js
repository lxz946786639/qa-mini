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
//   "shared" —— 共享桶：v1/v2 存量会话（P3 首启一次性回填）+ 管理员/匿名新建；
//               一切查看级主体可见可问（保留旧「访问码 = 共享会话」语义）
//   "user"   —— 用户私有桶 (user_id, agent_id)：仅属主用户 + 管理
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
//   admin —— 恒允许（管理台始终可管可用）
//   anon  —— allow_anon（allow_anonymous=false 时主体为 null，同样按此列）
//   user  —— allow_anon || allow_user（匿名放行时一切访问方式天然可用，超集语义）
//   code  —— allow_anon || allow_code（同上）
function agentAllows(principal, agent) {
  if (!agent) return false;
  if (!principal) return agent.allow_anon === true;
  if (principal.kind === "admin") return true;
  if (principal.kind === "anon") return agent.allow_anon === true;
  if (principal.kind === "user") return agent.allow_anon === true || agent.allow_user === true;
  if (principal.kind === "code") return agent.allow_anon === true || agent.allow_code === true;
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
  // admin / anon / null → 共享桶（双轨期遗留语义）
  return { access_mode: "shared", user_id: legacy ? legacy.userId : null, agent_id: legacy ? legacy.agentId : null, access_code_id: null };
}

module.exports = { canView, canCreate, bucketFor, agentAllows };
