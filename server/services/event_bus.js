"use strict";
// SSE 事件总线。
// P2（双轨期）：全局广播——与旧 server.js 的 sseClients 广播完全同语义
//   （所有事件带 session_id，客户端按会话过滤；旧前端依赖此行为）。
// P3：principal 作用域投递——载荷带 session_id 的事件仅投递给对该会话可见的
//   客户端（canView）；"sessions" 事件按客户端主体/管理级逐连接生成载荷；
//   事件自动补 agent_id（供多智能体前端路由）。接口不变，旧调用方零改动。

const { canView } = require("./principal");

class EventBus {
  constructor() {
    this.clients = new Set(); // { res, principal, isAdmin }
    this.sessionLookup = null; // (id) => sessionRow|null（buildContext 装配后注入）
  }
  setSessionLookup(fn) { this.sessionLookup = fn; }
  setManager(m) { this.manager = m || null; }
  size() { return this.clients.size; }
  add(res, principal, isAdmin) { this.clients.add({ res, principal: principal || null, isAdmin: !!isAdmin }); }
  delete(res) { for (const c of this.clients) if (c.res === res) this.clients.delete(c); }
  emit(event, payload) {
    // sessions 事件：逐连接按主体作用域 + 管理级生成载荷（token 剥离语义由 list 保证）
    if (event === "sessions" && this.manager) {
      for (const c of [...this.clients]) {
        // token 从不进 SSE（与 P2 字节兼容；管理视图 token 走 GET /api/sessions?admin=）
        const line = "event: " + event + "\ndata: " + JSON.stringify({ sessions: this.manager.list(false, c.principal) }) + "\n\n";
        try { c.res.write(line); } catch { this.clients.delete(c); }
      }
      return;
    }
    // 载荷级补 agent_id（P3：多智能体路由）
    let p = payload;
    if (p && typeof p === "object" && typeof p.session_id === "string" && p.agent_id === undefined && this.sessionLookup) {
      const s = this.sessionLookup(p.session_id);
      if (s && s.agent_id) p = Object.assign({}, p, { agent_id: s.agent_id });
    }
    const scoped = !!(p && typeof p === "object" && typeof p.session_id === "string");
    const line = "event: " + event + "\ndata: " + JSON.stringify(p) + "\n\n";
    for (const c of [...this.clients]) {
      if (scoped) {
        const s = this.sessionLookup ? this.sessionLookup(p.session_id) : null;
        if (!s || !canView(c.principal, s)) continue; // 不可见会话 → 不投递
      }
      try {
        c.res.write(line);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}

module.exports = { EventBus };
