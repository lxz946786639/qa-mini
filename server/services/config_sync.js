"use strict";
// 配置同步（P2 双轨期）：旧版 PUT /api/config 落盘 config.json 后，
// 把同一份配置同步进 v2 库（protocol_defaults / system_configs / access_codes / users），
// 保证「新端点读库」与「旧端点读内存」永远同源。
// 启动反向同步（库 → 内存）见 context.js。

const { hashPassword } = require("../../lib/auth");
const { PROTOCOLS, DEFAULTS, deepMerge } = require("../../lib/config");
const { ANON_CODE } = require("../../lib/store");

// 管理密码 → users 表（权威源）：
//  非空 → 设置/激活 admin 用户密码（无则创建）；
//  空且显式提交（请求体含 security.admin_password 字段）→ 停用（adminEnabled 转 false，
//  等价旧版「清空密码 = 管理未启用」；保留用户行与会话归属）；
//  空且未显式提交（P8.43 修复）→ 保持不动：users 表是密码权威源，首启引导/重置密码
//  后 config 的 admin_password 恒为空遗留字段，UI 保存系统设置从不携带该字段，
//  无条件停用会让管理员每次保存系统设置都被锁定（本机 2026-07-22 实测触发过）。
function syncAdminPassword(store, security, explicit) {
  const pw = security && typeof security.admin_password === "string" ? security.admin_password : "";
  const u = store.getUserByUsername("admin");
  if (pw) {
    if (u) {
      const patch = { password_hash: hashPassword(pw) };
      if (u.status !== "active") patch.status = "active";
      store.updateUser(u.id, patch);
    } else {
      store.createUser({ username: "admin", passwordHash: hashPassword(pw), displayName: "管理员", role: "admin" });
    }
  } else if (explicit && u && u.status === "active") {
    store.updateUser(u.id, { status: "disabled" });
  }
}

// next = 已深合并的完整配置（PUT /api/config 校验后）
function syncConfigToStore(store, next, opts) {
  for (const p of PROTOCOLS) {
    store.setProtocolDefault(p, (next.protocols && next.protocols[p]) || {});
  }
  if (next.asr && typeof next.asr === "object") store.setSystemConfig("asr", next.asr);
  if (next.audio_stream && typeof next.audio_stream === "object") store.setSystemConfig("audio_stream", next.audio_stream);
  if (next.security && typeof next.security === "object") {
    store.setSystemConfig("allow_anonymous", next.security.allow_anonymous !== false);
    // 访问码全量同步（ANON 特殊码不动）
    const codes = Array.isArray(next.security.access_codes) ? next.security.access_codes : [];
    const want = new Map();
    for (const c of codes) if (c && typeof c.code === "string" && c.code && c.code !== ANON_CODE) want.set(c.code, c);
    for (const c of store.listAccessCodes()) {
      if (c.code === ANON_CODE) continue;
      if (!want.has(c.code)) store.removeAccessCode(c.id);
    }
    for (const c of codes) {
      if (!c || typeof c.code !== "string" || !c.code || c.code === ANON_CODE) continue;
      const exp = typeof c.expires_at === "string" && c.expires_at ? c.expires_at : new Date(Date.now() + 8 * 3600e3).toISOString();
      const cur = store.getAccessCodeByCode(c.code);
      if (cur) {
        if (cur.expires_at !== exp) store.updateAccessCode(cur.id, { expires_at: exp });
      } else {
        store.createAccessCode({ code: c.code, expiresAt: exp, createdBy: null });
      }
    }
    syncAdminPassword(store, next.security, !!(opts && opts.adminPwExplicit));
  }
}

module.exports = { syncConfigToStore, syncAdminPassword };
