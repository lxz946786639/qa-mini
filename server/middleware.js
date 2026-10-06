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

function ipOf(req) { return req.socket ? (req.socket.remoteAddress || "?") : "?"; }

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
  MIME, serveStatic, withTimeout, ipOf, uaOf, cookieValue, safeEqual,
  maskConfigForBroadcast
};
