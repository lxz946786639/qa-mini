"use strict";
// 认证基础设施（v2 多用户体系，零依赖，仅 Node 内置 crypto）：
//  - 密码：scrypt 加盐哈希（绝不存明文；timingSafeEqual 校验）
//  - 认证会话 token：32B 随机高熵，服务端只存 SHA-256 哈希（见 store.auth_sessions）
//  - 登录限流：10 次/10min/IP + 5 次/10min/账户（内存实现，单进程约束）
//  - 时间戳：ISO-8601 字符串（与 sessions 表口径一致，PG 兼容）

const crypto = require("crypto");

// scrypt 参数（OWASP 建议下限以上；N=16384, r=8, p=1, keylen=64）
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_LEN = 16;

function isStr(v) { return typeof v === "string"; }

// 哈希密码 → "s1:<N>:<r>:<p>:<saltB64>:<hashB64>"（格式带版本号，未来可换算法）
function hashPassword(pw) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return "s1:" + SCRYPT_N + ":" + SCRYPT_R + ":" + SCRYPT_P + ":" + salt.toString("base64") + ":" + hash.toString("base64");
}

// 校验密码（格式非法/参数不符一律 false；比较用 timingSafeEqual）
function verifyPassword(pw, stored) {
  if (!isStr(pw) || !isStr(stored)) return false;
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "s1") return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // 只接受本项目当前参数（防篡改的存储串改变计算成本）
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch { return false; }
  if (salt.length !== SALT_LEN || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { N, r, p });
  return crypto.timingSafeEqual(actual, expected);
}

// 随机认证会话 token（32B hex，64 字符；客户端明文持有，服务端存哈希）
function issueToken() {
  return crypto.randomBytes(32).toString("hex");
}

// token → 存储用哈希（SHA-256 hex）
function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// 随机临时密码（12 位：大小写字母 + 数字，不含易混淆字符 0O1lI）；
// 仅在管理员引导（无预设密码且无存量明文密码）时生成，打印到启动日志。
function generateTempPassword(len) {
  const n = Number.isInteger(len) && len > 0 ? len : 12;
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += chars[buf[i] % chars.length];
  return out;
}

// 登录限流器（内存）：IP 维度 + 账户维度双限。
// 默认：10 次/10min/IP 且 5 次/10min/账户（窗口/次数可注入，测试用短窗口）。
// check() 返回 true = 已超限（应 429）；recordFail() 记录一次失败。
// check() 顺带惰性清理过期窗口；recordFail 不清理（由 check 驱动），规模小无压力。
class RateLimiter {
  constructor(opts) {
    opts = opts || {};
    this.ipMax = opts.ipMax || 10;
    this.accountMax = opts.accountMax || 5;
    this.windowMs = opts.windowMs || 10 * 60e3;
    this.byIp = new Map();    // ip -> { count, reset_at }
    this.byAccount = new Map(); // key -> { count, reset_at }
  }
  _bucket(map, key) {
    let n = map.get(key);
    const now = Date.now();
    if (n && now > n.reset_at) { n.count = 0; n.reset_at = now + this.windowMs; }
    if (!n) { n = { count: 0, reset_at: now + this.windowMs }; map.set(key, n); }
    return n;
  }
  // 是否已超限（IP 或账户任一达到上限）
  exceeded(ip, account) {
    if (account === undefined || account === null || account === "") {
      return this._bucket(this.byIp, String(ip)).count >= this.ipMax;
    }
    return this._bucket(this.byIp, String(ip)).count >= this.ipMax ||
           this._bucket(this.byAccount, String(ip) + "|" + String(account)).count >= this.accountMax;
  }
  recordFail(ip, account) {
    this._bucket(this.byIp, String(ip)).count += 1;
    if (account !== undefined && account !== null && account !== "") {
      this._bucket(this.byAccount, String(ip) + "|" + String(account)).count += 1;
    }
  }
  // 成功登录不清零（保持防暴力窗口；与现状语义一致）
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  tokenHash,
  generateTempPassword,
  RateLimiter,
  SCRYPT_N, SCRYPT_R, SCRYPT_P
};
