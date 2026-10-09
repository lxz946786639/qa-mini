"use strict";
// HTTP 基础设施（从旧 server.js 原样抽出）：
// sendJSON / readBody / readRawBody / parseJSONBody / MIME / serveStatic /
// withTimeout / ipOf / safeEqual

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 原始字节请求体（WAV 音频上传用）；超过 limit 时读完丢弃，end 后 reject「请求体过大」
// （不立即 destroy：让客户端能收到 413 响应而非断连）
function readRawBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0; // 丢弃已缓存数据，继续消费流
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      if (overflow) {
        const e = new Error("请求体过大");
        e.tooLarge = true;
        reject(e);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

function parseJSONBody(req) {
  return readBody(req).then(
    (raw) => JSON.parse(raw || "{}"),
    (e) => {
      throw Object.assign(new Error("请求体不是合法 JSON: " + (e.message || "")), { __badBody: true });
    }
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

function serveStatic(res, rel, publicDir) {
  const fp = path.normalize(path.join(publicDir, rel));
  if (!fp.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(fp, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(buf);
  });
}

// 带超时上限的 Promise（?sync=true 推送用，上限 28s，留 2s 给 EchoScribe 的 30s 超时）
function withTimeout(promise, ms, onExpire) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onExpire()), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        resolve({ __error: e });
      }
    );
  });
}

// ---- P8.85：客户端 IP 解析（可信反向代理支持）----
// security.trusted_proxies = IPv4 / IPv4-CIDR 数组（缺省 [] = 单主机直部署语义，行为不变）。
// - remoteAddress 不在可信集 → 原样返回（XFF 不采信，客户端无法伪造）；
// - 在可信集（如 TLS 侧车 nginx）→ 取 XFF 链自右向左、跳过可信跳，第一个不可信跳 = 真实客户端；
// - 无 XFF 或全为可信跳 → 回落 remoteAddress。getter 由 context.js 注册（配置实时生效）。
let _trustedProxiesGet = null;
function setTrustedProxiesGetter(fn) { _trustedProxiesGet = fn; }

function normalizeIp(s) {
  if (typeof s !== "string") return "";
  let v = s.trim();
  if (v.toLowerCase().startsWith("::ffff:")) v = v.slice(7); // IPv4-mapped IPv6
  return v;
}
function ipToNum(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const d = Number(part);
    if (d > 255) return null;
    n = n * 256 + d;
  }
  return n;
}
function ipInCidr(ip, entry) {
  const i = entry.indexOf("/");
  if (i <= 0) return ip === entry;
  const bits = Number(entry.slice(i + 1));
  const base = ipToNum(entry.slice(0, i));
  const n = ipToNum(ip);
  if (base === null || n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}
function isTrustedProxy(ip, trusted) {
  if (!ip) return false;
  for (const t of trusted) {
    if (typeof t !== "string" || !t) continue;
    if (t === ip) return true;
    if (t.includes("/") && ipInCidr(ip, t)) return true;
  }
  return false;
}

// 客户端 IP：审计 / 凭证 / 会话活动 / 安全限流与封禁匹配 统一口径（P8.49 起 secIpOf 同源）
function ipOf(req) {
  const ra = normalizeIp(req && req.socket ? req.socket.remoteAddress : "") || "?";
  let trusted = [];
  try { trusted = _trustedProxiesGet ? (_trustedProxiesGet() || []) : []; } catch { trusted = []; }
  if (!trusted.length) return ra;
  if (!isTrustedProxy(ra, trusted)) return ra; // 非可信对端：XFF 不采信（防伪造）
  const xff = req && req.headers ? req.headers["x-forwarded-for"] : null;
  if (typeof xff === "string") {
    const parts = xff.split(",").map((s) => normalizeIp(s)).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(parts[i], trusted)) return parts[i];
    }
  }
  return ra;
}

// P8.49：安全维度 IP——P8.85 起与 ipOf 统一（原「XFF 首跳」直部署场景可伪造、
// 可信代理后取值又错；新语义 = 可信代理感知的真实客户端 IP，见 doc01 §6 安全）
function secIpOf(req) { return ipOf(req); }

// P8.29：访问设备浏览器特征（User-Agent，截断 256 字符；审计设备识别码来源）
function uaOf(req) { return String((req && req.headers && req.headers["user-agent"]) || "").slice(0, 256); }

// 解析 Cookie 头中指定 name 的值（无则 null）
function cookieValue(req, name) {
  const h = req && req.headers && req.headers.cookie;
  if (typeof h !== "string" || !h) return null;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 广播用脱敏配置：api_key/管理密码不出现在 SSE（管理端用 GET /api/config 取全量）
function maskConfigForBroadcast(c) {
  const m = JSON.parse(JSON.stringify(c));
  for (const k of Object.keys(m.protocols || {})) {
    if (m.protocols[k] && m.protocols[k].api_key) m.protocols[k].api_key = "…已设置";
  }
  if (m.asr && m.asr.api_key) m.asr.api_key = "…已设置";
  if (m.security) {
    m.security.admin_password = "";
    m.security.access_codes = (m.security.access_codes || []).map((x) => ({ ...x }));
  }
  return m;
}

module.exports = {
  sendJSON, readBody, readRawBody, parseJSONBody,
  MIME, serveStatic, withTimeout, ipOf, secIpOf, uaOf, cookieValue, safeEqual,
  maskConfigForBroadcast, setTrustedProxiesGetter
};
