"use strict";
// 极简路由表：按注册顺序匹配（与旧 if 链的先后语义一致），首个命中即返回。
// match 形态：
//   "exact"      —— { path: "/api/health" }
//   "regex"      —— { re: /^\\/api\\/sessions\\/([a-zA-Z0-9]+)\\/(reset)$/ }
// handler(req, res, ctx, urlObj, params) → 可自行 return 结果；dispatch 不关心返回值。

class Router {
  constructor() { this.routes = []; }
  exact(method, p, handler) { this.routes.push({ method, kind: "exact", path: p, handler }); return this; }
  regex(method, re, handler) { this.routes.push({ method, kind: "regex", re, handler }); return this; }
  // 返回 true = 已处理（命中）
  dispatch(req, res, ctx, urlObj) {
    const p = urlObj.pathname;
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      let params = null;
      if (r.kind === "exact") {
        if (r.path !== p) continue;
      } else {
        const m = p.match(r.re);
        if (!m) continue;
        params = m.slice(1);
      }
      try {
        return Promise.resolve(r.handler(req, res, ctx, urlObj, params)).then(() => true);
      } catch (e) {
        // 同步抛出 → 交给 app 层统一 500（与旧 try/catch 语义一致）
        throw e;
      }
    }
    return false;
  }
}

module.exports = { Router };
