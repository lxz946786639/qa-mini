"use strict";
// OpenAI 兼容协议（移植 asr_live/qa.py）：
// POST chat completions（stream=true，SSE），取 choices[0].delta.content
// （兼容 choices[0].text）为增量文本；data: [DONE] 结束；: 注释/空行忽略。

const { QaError, postJSONStream } = require("../sse");

function buildMessages(question, context = "") {
  // messages 列表：可选 system 上下文 + user 问题
  const messages = [];
  if (context && context.trim()) {
    messages.push({
      role: "system",
      content: "参考上下文（最近识别内容）：\n" + context.trim()
    });
  }
  messages.push({ role: "user", content: question });
  return messages;
}

/**
 * 从 OpenAI 兼容 chat completions 端点流式读取回答增量。
 * @param cfg  { url, model, api_key }
 * @param question 提问文本
 * @param opts { context, signal }
 */
async function* streamOpenAI(cfg, question, { context = "", signal } = {}) {
  const url = (cfg.url || "").trim();
  if (!url) throw new QaError(0, "未配置接口地址");
  const payload = { messages: buildMessages(question, context), stream: true };
  const model = (cfg.model || "").trim();
  if (model) payload.model = model;
  const headers = {};
  const key = (cfg.api_key || "").trim();
  if (key) headers.Authorization = "Bearer " + key;

  const r = await postJSONStream(url, payload, headers, signal);
  try {
    if (!(r.status >= 200 && r.status < 300)) {
      const body = await r.errorBody();
      throw new QaError(r.status, body || `HTTP ${r.status}`);
    }
    for await (const raw of r.lines) {
      const s = raw.trim();
      if (!s || s.startsWith(":")) continue; // 空行 / keepalive 注释
      if (!s.startsWith("data:")) continue;  // event:/id:/retry: 忽略
      const p = s.slice(5).trim();
      if (p === "[DONE]") return;
      let chunk;
      try {
        chunk = JSON.parse(p);
      } catch (e) {
        throw new QaError(0, `SSE 解析失败: ${p.slice(0, 100)} (${e.message})`);
      }
      const choices = chunk.choices || [];
      if (!choices.length) continue;
      const delta = choices[0].delta || {};
      let text = delta.content;
      if (text === undefined || text === null) text = choices[0].text;
      if (text) yield text;
    }
  } finally {
    r.done();
  }
}

module.exports = { buildMessages, streamOpenAI };
