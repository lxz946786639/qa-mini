// SSE 事件总线。
// P2（双轨期）：全局广播——与旧 server.js 的 sseClients 广播完全同语义
//   （所有事件带 session_id，客户端按会话过滤；旧前端依赖此行为）。
// P3：principal 作用域投递——载荷带 session_id 的事件仅投递给对该会话可见的
//   客户端（canView）；"sessions" 事件按客户端主体/管理级逐连接生成载荷；
//   事件自动补 agent_id（供多智能体前端路由）。接口不变，旧调用方零改动。
// P8.33：在线注册表 + 一键踢出——连接携带 meta（dev 设备指纹 / ip / ua / sid /
//   连接时间），按「设备 + IP」判定唯一身份；evicted 为连接级控制事件（与初始
//   sessions 推送同类，定向投递、非广播）；踢出冷却为内存 Map（5 分钟，重启清空）。
// P8.35：meta 增 sessionId（cookie 会话行 id，连接可归属到会话身份）；
//   kickSession 按会话踢出其长连接集合（会话吊销由调用方做，不做禁入冷却）。

const { canView } = require("./principal");

// P8.33：踢出后重新建立 SSE 的禁入冷却（固定常量，不做配置项）
const KICK_TTL_MS = 5 * 60 * 1000;

const EVICTED_LINE = 'event: evicted\ndata: {"reason":"kicked","detail":"您已被管理员下线"}\n\n';

class EventBus {
  constructor() {
    this.clients = new Set(); // { res, principal, isAdmin, meta: { dev, ip, ua, sid, connectedAt } }
    this.sessionLookup = null; // (id) => sessionRow|null（buildContext 装配后注入）
    this.kicked = new Map(); // P8.33："dev@ip" → 冷却截止时间戳
  }
  setSessionLookup(fn) { this.sessionLookup = fn; }
  setManager(m) { this.manager = m || null; }
  size() { return this.clients.size; }
  add(res, principal, isAdmin, meta) {
    this.clients.add({ res, principal: principal || null, isAdmin: !!isAdmin,
      meta: meta || { dev: "", ip: "", ua: "", sid: null, sessionId: null, connectedAt: new Date().toISOString() } });
  }
  delete(res) { for (const c of this.clients) if (c.res === res) this.clients.delete(c); }
  // ---- P8.33 在线注册表 / 一键踢出 ----
  listOnline() { return [...this.clients]; }
  static keyOf(dev, ip) { return (dev || "") + "@" + (ip || ""); }
  isKicked(dev, ip) {
    const exp = this.kicked.get(EventBus.keyOf(dev, ip));
    if (exp === undefined) return false;
    if (Date.now() > exp) { this.kicked.delete(EventBus.keyOf(dev, ip)); return false; }
    return true;
  }
  markKicked(dev, ip, ttlMs = KICK_TTL_MS) {
    this.kicked.set(EventBus.keyOf(dev, ip), Date.now() + ttlMs);
  }
  // P8.35：踢出某 cookie 会话的全部长连接（非 admin 连接推送 evicted 并关闭）；
  // 会话吊销由调用方做（凭证即失效，无禁入冷却——重进需重新走登录门禁）。
  kickSession(sessionId) {
    const hit = [...this.clients].filter((c) => c.meta && c.meta.sessionId === sessionId);
    const targets = hit.filter((c) => !(c.principal && c.principal.kind === "admin"));
    for (const c of targets) {
      try { c.res.write(EVICTED_LINE); } catch { /* 连接已断 */ }
      try { c.res.end(); } catch { /* 忽略 */ }
      this.clients.delete(c);
    }
    return { targets, none: hit.length === 0 };
  }
  // 踢出「dev+ip」身份：非 admin 连接推送 evicted 控制事件并关闭（sid 吊销由调用方做）；
  // 返回 { targets: 被踢连接, admins: 同身份 admin 连接（不受影响）, none: 未命中 }。
  kick(dev, ip) {
    const key = EventBus.keyOf(dev, ip);
    const hit = [...this.clients].filter((c) => EventBus.keyOf(c.meta && c.meta.dev, c.meta && c.meta.ip) === key);
    const admins = hit.filter((c) => c.principal && c.principal.kind === "admin");
    const targets = hit.filter((c) => !(c.principal && c.principal.kind === "admin"));
    for (const c of targets) {
      try { c.res.write(EVICTED_LINE); } catch { /* 连接已断 */ }
      try { c.res.end(); } catch { /* 忽略 */ }
      this.clients.delete(c);
    }
    return { targets, admins, none: hit.length === 0 };
  }
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

module.exports = { EventBus, KICK_TTL_MS };
