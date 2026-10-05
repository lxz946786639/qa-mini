"use strict";
// 会话服务（P2 双轨期核心）：
//  - 内存会话数组 = 运行时唯一事实源（与旧版语义一致：QaRunner 直接读写会话对象）
//  - 持久化改为 Store 增量写入（不再整表重写）：saveAll() 做 内存↔DB 差异同步
//    （旧 saveAll = DELETE 全表 + 重插；新 syncAll = 逐会话字段 diff + 历史增量追加/删除，
//     事实模型相同、IO 增量，且保留 v2 归属列不被整表重写冲掉）
//  - 启动：Store 载入全桶会话 + 历史；data/sessions.json 兜底迁移（最老形态，DB 为空时）；
//    遗留桶（管理员私有桶 × industry-brain）为空 → 补「默认会话」（旧版启动不变量，
//    双轨期保留以支撑旧前端与存量测试）
//  - 运行期「至少 1 会话」不变量由 SessionManager.remove() 原样保留（补建进遗留桶）

const fs = require("fs");
const { SessionManager } = require("../../lib/qa_runner");
const { newSession } = require("../../lib/config");

// 内存会话 → v2 行（归属列取遗留桶）
function rowOf(s, legacy) {
  return Object.assign({}, s, {
    user_id: legacy.userId,
    agent_id: legacy.agentId,
    access_mode: "user",
    access_code_id: null
  });
}

class V2SessionManager extends SessionManager {
  constructor(ctx) {
    super({
      getConfig: () => ctx.config,
      getSessions: () => ctx.sessions,
      saveAll: () => this.syncAll(),
      broadcast: (event, payload) => ctx.bus.emit(event, payload)
    });
    this.ctx = ctx;
    this.store = ctx.store;
  }

  // 全量差异同步（幂等）：内存 → DB。调用点与旧 saveAll 完全相同：
  // create / update / save（QaRunner persist、外部改对象）/ remove / removeRecord
  syncAll() {
    const store = this.store;
    const sessions = this.ctx.sessions;
    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.id);
      const row = store.getSession(s.id);
      if (!row) {
        store.createSession(rowOf(s, this.ctx.legacy));
        continue;
      }
      const same =
        row.name === s.name &&
        row.protocol === s.protocol &&
        row.continue_session === s.continue_session &&
        row.token === s.token &&
        JSON.stringify(row.protocol_config) === JSON.stringify(s.protocol_config || {}) &&
        JSON.stringify(row.audio_remote) === JSON.stringify(s.audio_remote || { enabled: false, preferred_device: "" }) &&
        row.dify_conversation_id === (s.dify_conversation_id || "") &&
        row.ragflow_session_id === (s.ragflow_session_id || "") &&
        row.updated_at === s.updated_at;
      if (!same) {
        store.updateSession(s.id, {
          name: s.name,
          protocol: s.protocol,
          continue_session: s.continue_session,
          token: s.token,
          protocol_config: s.protocol_config || {},
          audio_remote: s.audio_remote || { enabled: false, preferred_device: "" },
          dify_conversation_id: s.dify_conversation_id || "",
          ragflow_session_id: s.ragflow_session_id || ""
        }, { updatedAt: s.updated_at });
      }
      // 历史差异：DB 有内存无 → 删；内存有 DB 无 → 追加（环形 100 上限在 appendRecord 内）
      const dbRecs = store.listRecords(s.id);
      const memRecs = Array.isArray(s.history) ? s.history : [];
      const memIds = new Set(memRecs.map((r) => r.id));
      for (const r of dbRecs) if (!memIds.has(r.id)) store.removeRecord(s.id, r.id);
      const dbIds = new Set(dbRecs.map((r) => r.id));
      for (const r of memRecs) if (!dbIds.has(r.id)) store.appendRecord(s.id, r);
    }
    // 内存已删 → DB 删
    for (const row of store.listSessions({})) {
      if (!seen.has(row.id)) store.removeSession(row.id);
    }
  }
}

/**
 * 启动时会话装载（在 Store 初始化后调用）：
 *  - 全桶载入 + 历史
 *  - 遗留桶为空且 data/sessions.json 存在 → JSON 迁移（归档 .bak）
 *  - 遗留桶仍为空 → 默认会话（config.push 的 token/协议，旧版语义）
 * @returns {{sessions: object[], legacy: {userId: string|null, agentId: string|null}, defaultCreated: object|null}}
 */
function loadSessions(ctx, cfgmod) {
  const store = ctx.store;
  const sessions = store.listSessions({}).map((s) => Object.assign({}, s, { history: [] }));
  for (const s of sessions) s.history = store.listRecords(s.id);
  ctx.sessions = sessions;

  // 遗留桶 = 管理员私有桶（迁移后存量会话均在此）；agent = industry-brain
  const admin = store.getUserByUsername("admin");
  const agent = store.getAgentByCode("industry-brain");
  ctx.legacy = { userId: admin ? admin.id : null, agentId: agent ? agent.id : null };

  const legacyBucketCount = () =>
    sessions.filter((s) => s.access_mode === "user" &&
      (ctx.legacy.userId === null ? s.user_id === null : s.user_id === ctx.legacy.userId)
    ).length;

  // 最老形态兜底：DB 为空 + 存在旧 sessions.json（migrateFromJson 只读文件并归档，不碰 DB）
  if (!sessions.length) {
    const imported = cfgmod.migrateFromJson() || [];
    for (const s of imported) {
      const ns = newSession({
        id: s.id, name: s.name, token: s.token, protocol: s.protocol,
        continue_session: s.continue_session
      });
      ns.created_at = s.created_at;
      ns.updated_at = s.updated_at;
      ns.dify_conversation_id = s.dify_conversation_id;
      ns.ragflow_session_id = s.ragflow_session_id;
      ns.history = s.history || [];
      sessions.push(ns);
      store.createSession(rowOf(ns, ctx.legacy));
      for (const r of ns.history) store.appendRecord(ns.id, r);
    }
    if (imported.length) console.log("[sessions] 已迁移旧 sessions.json → v2 库（" + imported.length + " 个会话）");
  }

  // 旧版启动不变量（双轨期保留）：遗留桶为空 → 默认会话
  let defaultCreated = null;
  if (legacyBucketCount() === 0) {
    const push = (ctx.config && ctx.config.push) || {};
    const s = newSession({
      name: "默认会话",
      protocol: push.protocol,
      continue_session: push.continue_session !== false,
      token: typeof push.token === "string" && push.token ? push.token : undefined
    });
    sessions.push(s);
    store.createSession(rowOf(s, ctx.legacy));
    defaultCreated = s;
    console.log("[sessions] 已生成默认会话（会话ID " + s.id + "）");
  } else {
    console.log("[sessions] 已加载 " + sessions.length + " 个会话（v2 库）");
  }
  return { sessions, legacy: ctx.legacy, defaultCreated };
}

module.exports = { V2SessionManager, loadSessions };
