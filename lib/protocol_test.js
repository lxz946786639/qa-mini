"use strict";
// 会话级/智能体级协议配置「测试连接」：用 全局配置 × 智能体配置 × 表单草稿 的合并值发起轻量探测。
// 合并语义与 qa_runner.start 的取值完全一致（config.resolveProtocolConfig 同义：
// 逐字段非空胜，草稿 > 智能体 > 全局），保证「测试通过 ⇒ 提问可走」。
// 探测请求：
//   openai  POST <url>（完整 chat completions 地址）max_tokens=1 非流式 ping
//   dify    GET  <基址>/parameters（应用存在性 + key 有效性）
//   ragflow GET  <基址>/chats/<chat_id>（key + Chat ID 有效性）
//   generic POST <url>（按模板发送 question=ping，真实请求一次）
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

module.exports = { testProtocol, mergedForTest, preCheck, PROBE_TIMEOUT_MS };
