"use strict";
// SSE 事件总线。
// P2（双轨期）：全局广播——与旧 server.js 的 sseClients 广播完全同语义
//   （所有事件带 session_id，客户端按会话过滤；旧前端依赖此行为）。
// P3：升级为 principal 作用域投递（sessionId 反向索引 + 权限过滤），
//   接口不变（emit(event, payload[, scope])），旧调用方零改动。

class EventBus {
  constructor() { this.clients = new Set(); }
  size() { return this.clients.size; }
  add(res) { this.clients.add(res); }
  delete(res) { this.clients.delete(res); }
  // scope（P3 使用）：{ sessionId, principal }；P2 忽略（全局投递）
  emit(event, payload) {
    const line = "event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
    for (const res of [...this.clients]) {
      try {
        res.write(line);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

module.exports = { EventBus };
