"use strict";
// 会话级/智能体级协议配置「测试连接」：用 全局配置 × 智能体配置 × 表单草稿 的合并值发起轻量探测。
// 合并语义与 qa_runner.start 的取值完全一致（config.resolveProtocolConfig 同义：
// 逐字段非空胜，草稿 > 智能体 > 全局），保证「测试通过 ⇒ 提问可走」。
// 探测请求：
//   openai  POST <url>（完整 chat completions 地址）max_tokens=1 非流式 ping
//   dify    GET  <基址>/parameters（应用存在性 + key 有效性）
//   ragflow GET  <基址>/chats/<chat_id>（key + Chat ID 有效性）
//   generic POST <url>（按模板发送 question=ping，真实请求一次）
// 全局级探测 testGlobal（系统设置各卡「测试连接」，仅连接级配置）：
//   ragflow GET <基址>/chats（列表，Bearer 全局 Key）→ 地址 + Key 有效性
//   dify    GET <基址>/parameters（不带 Key——全局不存应用 Key）→ 接口可达性（401/403 = 服务在线）
//   openai / generic 复用 testProtocol（model/api_key 取全局，草稿可覆盖）
// 结果 detail 绝不回显 api_key。

const { sanitizeProtocolConfig, PROTOCOL_FIELDS } = require("./config");
const { buildGenericBody } = require("./protocols/generic");

const PROBE_TIMEOUT_MS = 10000;

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

// 合并 全局 + 智能体 + 草稿（草稿 = 表单当前值，含空串；agentCfg = 智能体现有配置，可空）；
// 白名单/去空由 sanitize 负责（草稿经 sanitize；智能体值入库前已同口径清洗）
function mergedForTest(proto, globalCfg, draft, agentCfg) {
  const base = (globalCfg && globalCfg.protocols && globalCfg.protocols[proto]) || {};
  const merged = {};
  for (const k of Object.keys(base)) if (typeof base[k] === "string") merged[k] = base[k];
  if (agentCfg && typeof agentCfg === "object") {
    // P8.81: 仅取本协议字段（与 resolveProtocolConfig 同口径：防跨协议配置泄漏）
    const known = PROTOCOL_FIELDS[proto] || [];
    for (const [k, v] of Object.entries(agentCfg)) {
      if (known.includes(k) && typeof v === "string" && v.trim() !== "") merged[k] = v;
    }
  }
  const clean = sanitizeProtocolConfig({ [proto]: draft && typeof draft === "object" && !Array.isArray(draft) ? draft : {} });
  Object.assign(merged, clean[proto] || {});
  return merged;
}

// 前置校验（文案与 qa_runner.start 一致）；不通过直接返回失败原因（不发请求）
function preCheck(proto, m) {
  if (!(m.url || "").trim()) return "未配置接口地址";
  if (proto === "dify" && !(m.api_key || "").trim()) return "未配置 API Key（编排引擎应用密钥）";
  if (proto === "ragflow" && !(m.api_key || "").trim()) return "未配置 API Key（知识引擎 API 密钥）";
  if (proto === "ragflow" && !(m.chat_id || "").trim()) return "未配置知识引擎 Chat ID";
  if (proto === "generic") {
    try {
      buildGenericBody(m.body, "ping", "");
    } catch (e) {
      return String(e.detail || e.message);
    }
  }
  return null;
}

function safeDetail(status, bodyText, key) {
  let msg = "";
  try {
    const j = JSON.parse(bodyText);
    if (j && typeof j === "object") {
      const err = j.error;
      msg = typeof j.message === "string" ? j.message
        : typeof err === "string" ? err
        : err && typeof err.message === "string" ? err.message
        : typeof j.detail === "string" ? j.detail : "";
    }
  } catch {}
  msg = String(msg).replace(/\s+/g, " ").slice(0, 120);
  if (key && msg && msg.includes(key)) msg = "[回显密钥已隐去]";
  return "HTTP " + status + (msg ? " " + msg : "");
}

function netDetail(e) {
  if (e.name === "AbortError") return "连接超时（10s 无响应）";
  const code = (e.cause && e.cause.code) || e.code || "";
  const map = {
    ECONNREFUSED: "连接被拒绝（确认接口地址正确且后端服务已启动）",
    ENOTFOUND: "域名解析失败（确认接口地址正确）",
    ECONNRESET: "连接被重置",
    EAI_AGAIN: "DNS 暂时不可用"
  };
  return "无法连接: " + (map[code] || code || String(e.message || e));
}

async function testProtocol(proto, globalCfg, draft, agentCfg) {
  const m = mergedForTest(proto, globalCfg, draft, agentCfg);
  const pre = preCheck(proto, m);
  if (pre) return { ok: false, detail: pre };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    let res;
    if (proto === "ragflow") {
      res = await fetch(trimSlash(m.url) + "/chats/" + encodeURIComponent((m.chat_id || "").trim()), {
        headers: { Authorization: "Bearer " + (m.api_key || "").trim() },
        signal: ctrl.signal
      });
    } else if (proto === "dify") {
      res = await fetch(trimSlash(m.url) + "/parameters", {
        headers: { Authorization: "Bearer " + (m.api_key || "").trim() },
        signal: ctrl.signal
      });
    } else if (proto === "openai") {
      const payload = { messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
      const model = (m.model || "").trim();
      if (model) payload.model = model;
      const h = { "Content-Type": "application/json" };
      const key = (m.api_key || "").trim();
      if (key) h.Authorization = "Bearer " + key;
      res = await fetch(m.url, { method: "POST", headers: h, body: JSON.stringify(payload), signal: ctrl.signal });
    } else {
      // generic：真实发送一次模板（question=ping）
      const h = { "Content-Type": "application/json" };
      const key = (m.api_key || "").trim();
      if (key) h.Authorization = "Bearer " + key;
      res = await fetch(m.url, {
        method: "POST", headers: h,
        body: JSON.stringify(buildGenericBody(m.body, "ping", "")),
        signal: ctrl.signal
      });
    }
    const bodyText = (await res.text()).slice(0, 512);
    if (res.status >= 200 && res.status < 300) {
      if (proto === "ragflow") {
        // RAGFlow 对不存在的 chat 也回 HTTP 200（body 业务码非 0），需解析业务码
        try {
          const j = JSON.parse(bodyText);
          if (j && typeof j.code === "number" && j.code !== 0) {
            const msg = String(j.message || j.msg || "").slice(0, 120);
            return { ok: false, detail: "HTTP " + res.status + (msg ? " " + msg : "（业务码 " + j.code + "）") };
          }
        } catch {}
      }
      return { ok: true, detail: "HTTP " + res.status };
    }
    return { ok: false, detail: safeDetail(res.status, bodyText, (m.api_key || "").trim()) };
  } catch (e) {
    return { ok: false, detail: netDetail(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- P8.81 续：全局级连接探测（系统设置 · 各协议卡「测试连接（全局配置）」）----
// 只验证「连接级」配置（URL + 全局 Key；chat_id/model/应用 Key 等身份字段在智能体级，
// 全局测试不覆盖）；draft = 表单草稿（系统设置未保存的值，空串 = 回退已存全局）。
async function testGlobal(proto, globalCfg, draft) {
  if (proto !== "ragflow" && proto !== "dify") return testProtocol(proto, globalCfg, draft || {}, null);
  const base = (globalCfg && globalCfg.protocols && globalCfg.protocols[proto]) || {};
  const m = {};
  for (const k of Object.keys(base)) if (typeof base[k] === "string") m[k] = base[k];
  const clean = sanitizeProtocolConfig({ [proto]: draft && typeof draft === "object" && !Array.isArray(draft) ? draft : {} });
  Object.assign(m, clean[proto] || {});
  if (!(m.url || "").trim()) return { ok: false, detail: "未配置服务地址 URL" };
  if (proto === "ragflow" && !(m.api_key || "").trim()) return { ok: false, detail: "未配置 API Key" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const key = (m.api_key || "").trim();
    const h = {};
    if (key) h.Authorization = "Bearer " + key;
    const res = await fetch(trimSlash(m.url) + (proto === "ragflow" ? "/chats" : "/parameters"), { headers: h, signal: ctrl.signal });
    const bodyText = (await res.text()).slice(0, 512);
    if (res.status === 404) return { ok: false, detail: proto === "ragflow" ? "地址可达但接口路径不存在（请检查服务地址）" : "接口路径不存在（请检查服务地址）" };
    if (proto === "ragflow") {
      if (res.status >= 200 && res.status < 300) return { ok: true, detail: "地址可达且 API Key 有效（Chat ID 需在智能体管理中按智能体配置）" };
      if (res.status === 401 || res.status === 403) return { ok: false, detail: "地址可达但 API Key 无效" };
      return { ok: false, detail: safeDetail(res.status, bodyText, key) };
    }
    // dify：401/403 = 服务在线且要求认证（应用 Key 在智能体级，全局测试不含 Key 校验）
    if (res.status >= 200 && res.status < 300 || res.status === 401 || res.status === 403) {
      return { ok: true, detail: "接口可达（应用 Key 需在智能体管理中按智能体配置，全局测试不含 Key 校验）" };
    }
    return { ok: false, detail: safeDetail(res.status, bodyText, key) };
  } catch (e) {
    return { ok: false, detail: netDetail(e) };
  } finally { clearTimeout(timer); }
}

module.exports = { testProtocol, mergedForTest, preCheck, testGlobal, PROBE_TIMEOUT_MS };
