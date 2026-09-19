"use strict";
// RAGFlow 聊天助手协议（移植 asr_live/ragflow_qa.py）：
//  - 新路径 POST {base}/chat/completions（v0.24+）；404 时自动回退一次旧路径
//    POST {base}/chats/{chat_id}/completions（v0.19-v0.23，chat_id 在路径、body 去掉）
//  - 新会话两步调用：先 POST {base}/chats/{chat_id}/sessions 拿 session_id 再提问
//    （RAGFlow <= v0.24 无 session_id 的调用会把 question 清空、只返回开场白；
//      sessions 端点缺失 404 时退回单调用行为）
//  - SSE 信封 {"code","message","data"}：data==true 结束；code!=0 流内报错；
//    session_id 回传；start/end_to_think 思考区跳过；reference 文档名去重脚注；
//    answer 增量(delta)/累积(cumulative)自动识别（第 2 个非空 answer 判定，
//    cumulative 走最长公共前缀差分，兼容 ##0$$ 句中插入）

const { QaError, postJSONStream, postJSON } = require("../sse");

const CHAT_COMPLETIONS = "/chat/completions";
const LEGACY_PATH = "/chats/{chat_id}/completions";
const SESSIONS_PATH = "/chats/{chat_id}/sessions";

function normalizeRagflowUrls(base, chatId) {
  const u = (base || "").trim().replace(/\/+$/, "");
  const cid = (chatId || "").trim();
  let newUrl, root;
  if (u.toLowerCase().endsWith(CHAT_COMPLETIONS)) {
    newUrl = u;
    root = u.slice(0, -CHAT_COMPLETIONS.length);
  } else {
    newUrl = u + CHAT_COMPLETIONS;
    root = u;
  }
  const legacyUrl = root + LEGACY_PATH.replace("{chat_id}", cid);
  return { newUrl, legacyUrl };
}

function lcp(a, b) {
  // 最长公共前缀长度
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function namesFromReference(ref) {
  // 去重的文档名：优先 doc_aggs[].doc_name，退回 chunks[].document_name
  const names = [];
  if (typeof ref !== "object" || ref === null) return names;
  for (const agg of ref.doc_aggs || []) {
    if (typeof agg === "object" && agg !== null && agg.doc_name && !names.includes(agg.doc_name)) {
      names.push(agg.doc_name);
    }
  }
  if (names.length) return names;
  for (const ch of ref.chunks || []) {
    if (typeof ch === "object" && ch !== null && ch.document_name && !names.includes(ch.document_name)) {
      names.push(ch.document_name);
    }
  }
  return names;
}

function referenceFooter(ref) {
  const names = namesFromReference(ref);
  if (!names.length) return "";
  return "\n\n---\n**参考来源**：" + names.join("、");
}

// 显式创建会话；端点缺失（404）返回 "" 让调用方退回单调用
async function createRagflowSession(root, chatId, apiKey, signal) {
  if (signal && signal.aborted) return "";
  const url = root + SESSIONS_PATH.replace("{chat_id}", (chatId || "").trim());
  const headers = {
    Authorization: "Bearer " + (apiKey || "").trim(),
    "Content-Type": "application/json"
  };
  const r = await postJSON(url, { name: "qa-mini" }, headers, signal);
  if (r.status === 404) return "";
  if (!(r.status >= 200 && r.status < 300)) {
    throw new QaError(r.status, r.text200 || `HTTP ${r.status}`);
  }
  let obj;
  try {
    obj = JSON.parse(r.text || "{}");
  } catch (e) {
    throw new QaError(0, "会话创建响应解析失败: " + e.message);
  }
  const code = obj.code;
  if (typeof code !== "number" || code !== 0) {
    const msg = obj.message || `code=${code}`;
    throw new QaError(typeof code === "number" ? code : 0, String(msg));
  }
  const data = obj.data;
  const sid = typeof data === "object" && data !== null ? data.id : null;
  return sid ? String(sid).trim() : "";
}

// 消费一个 RAGFlow SSE 响应，yield 干净的 answer 增量
async function* consume(lines, onMeta) {
  let mode = null; // null -> 'cumulative' | 'delta'（第 2 个非空 answer 判定）
  let prevRaw = "";
  let thinking = false;
  let lastRef = null;

  for await (const raw of lines) {
    const s = raw.trim();
    if (!s || s.startsWith(":")) continue; // 空行 / keepalive
    if (!s.startsWith("data:")) continue;  // 非 data 的 SSE 字段忽略
    const p = s.slice(5).trim();
    let obj;
    try {
      obj = JSON.parse(p);
    } catch (e) {
      throw new QaError(0, `SSE 解析失败: ${p.slice(0, 100)} (${e.message})`);
    }
    if (obj === true) break; // 裸 data:true 终止（健壮性）
    if (typeof obj !== "object" || obj === null) continue;
    const code = obj.code;
    const inner = obj.data;
    if (inner === true) break; // {code:0, ..., data:true} = 流结束
    if (typeof code !== "number" || code !== 0) {
      const msg = obj.message || `code=${code}`;
      throw new QaError(typeof code === "number" ? code : 0, String(msg));
    }
    if (typeof inner !== "object" || inner === null) continue;
    const sid = inner.session_id;
    if (sid && onMeta) onMeta({ session_id: String(sid) });
    if (inner.start_to_think) thinking = true;
    else if (inner.end_to_think) thinking = false;
    const ref = inner.reference;
    if (typeof ref === "object" && ref !== null && Object.keys(ref).length) lastRef = ref;
    const ans = inner.answer;
    if (typeof ans !== "string" || !ans) continue;
    if (mode === null && !prevRaw) {
      // 首个非空 answer
      prevRaw = ans;
      if (!thinking) yield ans;
      continue;
    }
    if (mode === null) {
      // 第二个非空 answer 判定线上格式
      mode = ans.startsWith(prevRaw) ? "cumulative" : "delta";
    }
    let out;
    if (mode === "cumulative") {
      if (ans.startsWith(prevRaw)) out = ans.slice(prevRaw.length);
      else out = ans.slice(lcp(prevRaw, ans)); // 句中插入（##0$$）：LCP 续传
      prevRaw = ans;
    } else {
      out = ans;
    }
    if (!thinking && out) yield out;
  }

  const footer = referenceFooter(lastRef);
  if (footer) yield footer;
}

/**
 * @param cfg  { url(基址), api_key(必填), chat_id(必填) }
 * @param question 提问（上下文已按 asr-tool 规则拼好）
 * @param opts { sessionId, signal, onMeta(meta) }
 */
async function* streamRagflow(cfg, question, { sessionId = "", signal, onMeta } = {}) {
  const url = (cfg.url || "").trim();
  if (!url) throw new QaError(0, "未配置接口地址");
  const key = (cfg.api_key || "").trim();
  if (!key) throw new QaError(0, "未配置 API Key（RAGFlow API 密钥）");
  const chatId = (cfg.chat_id || "").trim();
  if (!chatId) throw new QaError(0, "未配置 RAGFlow Chat ID");

  const { newUrl, legacyUrl } = normalizeRagflowUrls(url, chatId);
  const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
  const payload = { question, stream: true };
  payload.chat_id = chatId;
  let sid = (sessionId || "").trim();
  if (!sid && (question || "").trim()) {
    // 无会话可续接：先显式建新会话（见模块头注释）
    const root = newUrl.slice(0, -CHAT_COMPLETIONS.length);
    sid = await createRagflowSession(root, chatId, key, signal);
    if (sid && onMeta) onMeta({ session_id: sid });
  }
  if (sid) payload.session_id = sid;
  const legacyPayload = Object.assign({}, payload);
  delete legacyPayload.chat_id;

  let r = await postJSONStream(newUrl, payload, headers, signal);
  if (r.status === 404) {
    // 旧版 RAGFlow：回退旧路径（仅一次）
    r.done();
    if (signal && signal.aborted) return;
    r = await postJSONStream(legacyUrl, legacyPayload, headers, signal);
  }
  try {
    if (!(r.status >= 200 && r.status < 300)) {
      const body = await r.errorBody();
      throw new QaError(r.status, body || `HTTP ${r.status}`);
    }
    yield* consume(r.lines, onMeta);
  } finally {
    r.done();
  }
}

module.exports = {
  normalizeRagflowUrls,
  createRagflowSession,
  namesFromReference,
  referenceFooter,
  streamRagflow
};
