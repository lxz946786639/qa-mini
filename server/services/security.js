"use strict";
// 安全监控服务（P8.49）：
//  - guard：IP 封禁守卫（app.js 派发前调用；/api/* 含 SSE；admin 主体豁免防自锁）
//  - noteQa：提问高频计数（安全维度 IP × 1 分钟滑动窗；内存态，重启清零）
//  - autoBan：自动封禁（登录爆破 / 提问高频；config.security.auto_ban 阈值）
//  - overview：安全总览聚合（30s 缓存，fresh 强制重算）= 审计/记录统计 + 告警 + Top IP + 封禁 + 事件
const { ipOf, secIpOf, sendJSON } = require("../middleware");

const OVERVIEW_TTL = 30000; // 与 P8.48 仪表盘缓存口径一致

function createSecurityService(ctx) {
  const store = ctx.store;
  const overviewCache = new Map(); // days -> { at, payload }
  const qaTs = new Map(); // 安全维度 IP -> [ts ms]（近 24h 提问时间戳，重启清零）

  function autoBanCfg() {
    const ab = (ctx.config && ctx.config.security && ctx.config.security.auto_ban) || {};
    return {
      enabled: ab.enabled !== false,
      loginFails: Number(ab.login_fails) > 0 ? Number(ab.login_fails) : 10,
      qaPerMin: Number(ab.qa_per_min) > 0 ? Number(ab.qa_per_min) : 20,
      banMinutes: Number(ab.ban_minutes) >= 0 ? Number(ab.ban_minutes) : 60
    };
  }

  // 自动封禁（幂等：已有生效封禁则跳过；审计 security.auto_ban）
  function autoBan(ip, reason) {
    const cfg = autoBanCfg();
    if (!cfg.enabled) return null;
    if (!ip || ip === "?" || store.hasActiveBan(ip)) return store.getBan(ip);
    const ban = store.addBan({ ip, reason, createdBy: null, minutes: cfg.banMinutes });
    store.insertAudit({ actorType: "system", action: "security.auto_ban", targetType: "ip", targetId: String(ip),
      detail: { reason, ban_minutes: cfg.banMinutes }, ip, userAgent: "" });
    return ban;
  }

  // 登录失败达阈值（auth_legacy 回调）
  function onLoginBrute(ip) { autoBan(ip, "auto:登录爆破"); }

  // 封禁守卫：返回 true = 已拦截（403 已写回）
  function guard(req, urlObj, res) {
    const real = ipOf(req);
    const sec = secIpOf(req);
    const hit = store.hasActiveBan(sec) || (sec !== real && store.hasActiveBan(real));
    if (!hit) return false;
    let pr = null;
    try { pr = ctx.auth.principal(req, urlObj); } catch { pr = null; }
    if (pr && pr.kind === "admin") return false; // admin 豁免（防自锁）
    sendJSON(res, 403, { ok: false, detail: "该访问已被管理员暂时限制" });
    return true;
  }

  // 记录一次提问（chat 路由入口；高频 → 自动封禁）
  function noteQa(req) {
    const sec = secIpOf(req);
    if (!sec || sec === "?") return;
    const now = Date.now();
    let ts = qaTs.get(sec);
    if (!ts) { ts = []; qaTs.set(sec, ts); }
    ts.push(now);
    while (ts.length && now - ts[0] > 86400000) ts.shift();
    let c1m = 0;
    for (const t of ts) if (now - t < 60000) c1m += 1;
    if (c1m >= autoBanCfg().qaPerMin) autoBan(sec, "auto:提问高频");
  }

  // 提问统计快照（Top IP / 告警用；24h 口径）
  function qaStats() {
    const now = Date.now();
    const out = new Map();
    for (const [ip, ts] of qaTs) {
      while (ts.length && now - ts[0] > 86400000) ts.shift();
      if (!ts.length) continue;
      let c1m = 0;
      for (const t of ts) if (now - t < 60000) c1m += 1;
      out.set(ip, { qa24h: ts.length, qa1m: c1m, lastAt: new Date(ts[ts.length - 1]).toISOString() });
    }
    return out;
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const hourKey = (d) => dayKey(d) + " " + pad2(d.getHours());

  // 安全总览（days 天窗口 + 固定 24h 口径；30s 缓存）
  function overview(days, fresh) {
    const key = String(days);
    if (!fresh) {
      const c = overviewCache.get(key);
      if (c && Date.now() - c.at < OVERVIEW_TTL) return c.payload;
    }
    const fromIso = new Date(Date.now() - days * 86400000).toISOString();
    const h24Iso = new Date(Date.now() - 86400000).toISOString();
    const s = store.getSecurityOverview(fromIso, h24Iso);

    // 近 24h 零填充（旧 → 新）
    const mL = new Map(s.hourLogins.map((r) => [r.h, Number(r.n)]));
    const mF = new Map(s.hourFails.map((r) => [r.h, Number(r.n)]));
    const mQ = new Map(s.hourQa.map((r) => [r.h, Number(r.n)]));
    const hour24 = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(Date.now() - i * 3600e3);
      const k = hourKey(d);
      hour24.push({ h: pad2(d.getHours()) + ":00", logins: mL.get(k) || 0, fails: mF.get(k) || 0, qa: mQ.get(k) || 0 });
    }
    // 每日零填充（窗口）
    const qMap = new Map(s.dailyQa.map((r) => [r.d, r]));
    const lMap = new Map(s.dailyLogins.map((r) => [r.d, Number(r.n)]));
    const fMap = new Map(s.dailyFails.map((r) => [r.d, Number(r.n)]));
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(new Date(Date.now() - i * 86400000));
      const qv = qMap.get(k);
      daily.push({ date: k, qa: qv ? Number(qv.n) : 0, ok: qv ? Number(qv.okn) : 0, logins: lMap.get(k) || 0, fails: fMap.get(k) || 0 });
    }
    // 告警（阈值规则；请求时计算）
    const cfg = autoBanCfg();
    const alerts = [];
    for (const r of s.failsByIp24h) {
      const n = Number(r.n);
      if (n >= 5) alerts.push({ level: "high", type: "login_brute", ip: r.ip, count: n, last_at: r.last_at,
        detail: "近 24 小时登录失败 " + n + " 次（疑似密码爆破）" });
      else if (n >= 3) alerts.push({ level: "medium", type: "login_brute", ip: r.ip, count: n, last_at: r.last_at,
        detail: "近 24 小时登录失败 " + n + " 次" });
    }
    const qa = qaStats();
    for (const [ip, v] of qa) {
      if (v.qa1m >= cfg.qaPerMin) alerts.push({ level: "high", type: "qa_burst", ip, count: v.qa1m, last_at: v.lastAt,
        detail: "近 1 分钟提问 " + v.qa1m + " 次，超过阈值 " + cfg.qaPerMin + "（已自动封禁该 IP）" });
      else if (v.qa1m >= Math.ceil(cfg.qaPerMin * 0.6)) alerts.push({ level: "medium", type: "qa_burst", ip, count: v.qa1m, last_at: v.lastAt,
        detail: "近 1 分钟提问 " + v.qa1m + " 次，接近高频阈值" });
    }
    const es = s.errorStats24h;
    if (es.n >= 10 && es.errn >= 10 && es.errn / es.n >= 0.5) {
      alerts.push({ level: "medium", type: "error_spike", ip: null, count: es.errn, last_at: null,
        detail: "近 24 小时协议错误 " + es.errn + " 次（错误率 " + Math.round(es.errn / es.n * 100) + "%），请检查上游服务或访问情况" });
    }
    alerts.sort((a, b) => (a.level === b.level ? (b.count || 0) - (a.count || 0) : a.level === "high" ? -1 : 1));
    // Top IP（近 7 天审计 ∪ 近 24h 提问 ∪ 生效封禁）
    const map = new Map();
    for (const r of s.auditByIp) {
      map.set(r.ip, { ip: r.ip, events: Number(r.events), logins: Number(r.logins), fails: Number(r.fails),
        qa24h: 0, last_at: r.last_at, banned: false });
    }
    for (const [ip, v] of qa) {
      const e = map.get(ip) || { ip, events: 0, logins: 0, fails: 0, qa24h: 0, last_at: v.lastAt, banned: false };
      e.qa24h = v.qa24h;
      if (!e.last_at || v.lastAt > e.last_at) e.last_at = v.lastAt;
      map.set(ip, e);
    }
    for (const b of store.listBans({ includeExpiredDays: 0 })) {
      const e = map.get(b.ip) || { ip: b.ip, events: 0, logins: 0, fails: 0, qa24h: 0, last_at: b.created_at, banned: false };
      e.banned = true;
      map.set(b.ip, e);
    }
    const top_ips = [...map.values()].sort((a, b) => (b.events + b.qa24h) - (a.events + a.qa24h)).slice(0, 10);
    // 封禁（含操作人名称）
    const bans = store.listBans({ includeExpiredDays: 7 }).map((b) => {
      const u = b.created_by ? store.getUser(b.created_by) : null;
      return Object.assign({}, b, { created_by_name: u ? (u.display_name || u.username) : "system" });
    });
    // 最近 20 条安全事件
    const ev = store.listSecurityEvents(20, 0);
    const payload = {
      ok: true, days,
      summary: {
        qa_today: s.today.qa,
        logins_today: s.today.logins,
        fails_today: s.today.fails,
        events_24h: s.today.events24h,
        alerts: alerts.length,
        bans_active: bans.filter((b) => b.active).length,
        bans_total: bans.length,
        qa_24h: es.n,
        error_rate_24h: es.n > 0 ? Math.round(es.errn / es.n * 100) : 0
      },
      hour24, daily, alerts, top_ips, bans,
      events: ev.rows
    };
    overviewCache.set(key, { at: Date.now(), payload });
    return payload;
  }

  return { guard, noteQa, onLoginBrute, autoBan, overview, qaStats };
}

module.exports = { createSecurityService };
