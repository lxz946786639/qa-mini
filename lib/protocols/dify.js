"use strict";
// Dify Chatflow / 聊天助手协议（移植 asr_live/dify_qa.py）：
// POST {基址}/chat-messages（response_mode="streaming"，SSE）；
// 按 data 行 JSON 的 event 字段分派：message→answer 增量（捕获 conversation_id）；
// message_end→结束；error→抛错；其余事件（workflow_started/node_*/tts_message 等）忽略。

const { QaError, postJSONStream } = require("../sse");

const CHAT_MESSAGES = "/chat-messages";

// Dify 没有 system 消息通道：上下文以带标签块拼进 query。
function buildQuery(question, context = "") {
  const ctx = (context || "").trim();
  if (!ctx) return question;
  return `参考上下文（最近识别内容）：\n${ctx}\n\n问题：${question}`;
}

// 接口基址（如 http://host/v1）→ 完整 /chat-messages 端点；已完整则原样返回。
function normalizeDifyUrl(url) {
  const u = (url || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (u.toLowerCase().endsWith(CHAT_MESSAGES)) return u;
  return u + CHAT_MESSAGES;
}

/**
 * @param cfg  { url(基址), api_key(必填), user }
 * @param query 提问（上下文已由 buildQuery 拼接）
 * @param opts { conversationId, signal, onMeta(meta) }
 */
async function* streamDify(cfg, query, { conversationId = "", signal, onMeta } = {}) {
  const url = (cfg.url || "").trim();
  if (!url) throw new QaError(0, "未配置接口地址");
  const key = (cfg.api_key || "").trim();
  if (!key) throw new QaError(0, "未配置 API Key（编排引擎应用密钥）");
  const user = (cfg.user || "").trim() || "asr-live";
  const payload = { inputs: {}, query, response_mode: "streaming", user };
  const cid0 = (conversationId || "").trim();
  if (cid0) payload.conversation_id = cid0;
  const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };

  const r = await postJSONStream(normalizeDifyUrl(url), payload, headers, signal);
  try {
    if (!(r.status >= 200 && r.status < 300)) {
      const body = await r.errorBody();
      throw new QaError(r.status, body || `HTTP ${r.status}`);
    }
    for await (const raw of r.lines) {
      const s = raw.trim();
      if (!s || s.startsWith(":")) continue; // 空行 / keepalive
      if (!s.startsWith("data:")) continue;  // 裸 event: ping 心跳行自然跳过
      const p = s.slice(5).trim();
      if (p === "[DONE]") return;
      let evt;
      try {
        evt = JSON.parse(p);
      } catch (e) {
        throw new QaError(0, `SSE 解析失败: ${p.slice(0, 100)} (${e.message})`);
      }
      if (typeof evt !== "object" || evt === null) continue;
      const kind = evt.event;
      if (kind === "message") {
        const cid = evt.conversation_id;
        if (cid && onMeta) onMeta({ conversation_id: String(cid) });
        const text = evt.answer;
        if (text) yield text;
      } else if (kind === "message_end") {
        const cid = evt.conversation_id;
        if (cid && onMeta) onMeta({ conversation_id: String(cid) });
        return;
      } else if (kind === "error") {
        const st = evt.status;
        const status = st ? parseInt(st, 10) || 0 : 0;
        const msg = evt.message || evt.code || "unknown";
        throw new QaError(status, String(msg));
      }
      // 其余事件（进度/遥测）忽略
    }
  } finally {
    r.done();
  }
}

module.exports = { buildQuery, normalizeDifyUrl, streamDify };
