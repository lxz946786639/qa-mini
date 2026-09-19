"use strict";
// 本机真实后端 E2E（RAGFlow 127.0.0.1:9380）：多会话推送 + 网页提问 + 会话续接
// 运行: node tests/e2e_local.js   （需 8787 服务已启动）
// 指定默认会话 token：环境变量 QA_MINI_E2E_TOKEN；不指定则自动取第一个会话
const BASE = "http://127.0.0.1:8787";
const KNOWN_TOKEN = process.env.QA_MINI_E2E_TOKEN || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const resp = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  return { status: resp.status, data };
}

async function waitDone(qaId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 120000)) {
    const r = await api("GET", "/api/history");
    const rec = (r.data.items || []).find((h) => h.id === qaId);
    if (rec && rec.status === "done") return rec;
    await sleep(300);
  }
  throw new Error("waitDone 超时: " + qaId);
}

(async () => {
  // 1) 健康检查 + UI
  const h = await api("GET", "/api/health");
  console.log("[1] health:", h.status, JSON.stringify(h.data));
  const html = await (await fetch(BASE + "/")).text();
  console.log("[1] UI:", html.length, "bytes | 标题:", html.includes("QA Mini"), "| 会话侧栏:", html.includes("session-list"), "| 会话抽屉:", html.includes("session-drawer"));

  // 2) 取默认会话（token 由旧 config.push 迁移而来）
  const sl = await api("GET", "/api/sessions");
  const list = sl.data.sessions || [];
  const sess = list.find((s) => s.token === KNOWN_TOKEN) || list[0];
  if (!sess) throw new Error("无可用会话");
  console.log("[2] 会话列表:", list.length, "个 | 当前:", sess.name, "id=" + sess.id, "token=" + sess.token.slice(0, 12) + "…", "protocol=" + sess.protocol);

  // 3) 模拟 asr-tool 推送（token + session_id 同传）
  const push = await api("POST", "/api/push", {
    token: sess.token, session_id: sess.id,
    text: "你好，请用一句话介绍一下你自己"
  });
  console.log("[3] push:", push.status, JSON.stringify(push.data));
  const rec1 = await waitDone(push.data.qa_id);
  console.log("[3] push 结果:", rec1.ok, "|", rec1.detail, "| 答案长度:", rec1.answer.length);
  console.log("---- 推送问答答案（前 300 字） ----");
  console.log(rec1.answer.slice(0, 300));

  // 4) 同会话二次推送（追问，验证会话续接）
  const push2 = await api("POST", "/api/push", {
    token: sess.token, session_id: sess.id,
    text: "你刚才回答中的关键词有哪些？"
  });
  const rec2 = await waitDone(push2.data.qa_id);
  console.log("[4] 追问:", rec2.ok, "|", rec2.detail, "| 答案长度:", rec2.answer.length);
  console.log("---- 追问答案（前 200 字） ----");
  console.log(rec2.answer.slice(0, 200));

  // 5) 网页提问（/api/chat，session_id 必填）
  const chat = await api("POST", "/api/chat", { session_id: sess.id, question: "用三个词总结你的特点" });
  console.log("[5] chat:", chat.status, JSON.stringify(chat.data));
  const rec3 = await waitDone(chat.data.qa_id);
  console.log("[5] chat 结果:", rec3.ok, "|", rec3.detail);
  console.log("---- 网页提问答案（前 200 字） ----");
  console.log(rec3.answer.slice(0, 200));

  // 6) 错误路径
  const bad = await api("POST", "/api/push", { token: "wrong", text: "hi" });
  console.log("[6] 错误 token:", bad.status, JSON.stringify(bad.data));
  const mismatch = await api("POST", "/api/push", { token: sess.token, session_id: "ffffffff", text: "hi" });
  console.log("[6] session_id 不匹配:", mismatch.status, JSON.stringify(mismatch.data));
  const noChat = await api("POST", "/api/chat", { question: "hi" });
  console.log("[6] chat 缺 session_id:", noChat.status, JSON.stringify(noChat.data));
  const empty = await api("POST", "/api/push", { token: sess.token, session_id: sess.id, text: "  " });
  console.log("[6] 空 text:", empty.status, JSON.stringify(empty.data));

  // 7) 会话详情（含历史）
  const det = await api("GET", "/api/sessions/" + sess.id);
  const hist = await api("GET", "/api/history");
  console.log("[7] 会话历史条数:", det.data.session.history.length,
    "| 合并历史条数:", hist.data.items.length,
    "| 全部 done:", hist.data.items.every((i) => i.status === "done"),
    "| 均带 session_id:", hist.data.items.every((i) => typeof i.session_id === "string"));
  console.log("E2E DONE");
})().catch((e) => {
  console.error("E2E 失败:", e);
  process.exit(1);
});
