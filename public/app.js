"use strict";
// QA Mini 前端（多会话版）：
//  - 左侧会话列表（新建/切换）；每会话独立 token / 会话ID / 协议 / 历史
//  - EventSource /api/events：事件均带 session_id，同一会话多浏览器同步实时输出
//  - 提问 POST /api/chat {session_id, question}（乐观建卡，按 会话+问题 合并）
//  - 内置极简 Markdown 渲染（先转义再应用子集，防 XSS）

// ---------- Markdown ----------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderInline(s) {
  // s 已转义；处理 行内代码 / 加粗 / 斜体 / 链接（\x60 = 反引号）
  const codes = [];
  s = s.replace(/\x60([^\x60]+)\x60/g, (m, c) => {
    codes.push(c);
    return "\u0001" + (codes.length - 1) + "\u0001";
  });
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>");
  s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => "<code>" + codes[Number(i)] + "</code>");
  return s;
}

function renderMarkdown(src) {
  const blocks = [];
  let text = src.replace(/\x60{3}(?:\w*)\n?([\s\S]*?)\x60{3}/g, (m, code) => {
    blocks.push(code.replace(/\n$/, ""));
    return "\u0002" + (blocks.length - 1) + "\u0002";
  });
  text = escapeHtml(text);
  const lines = text.split("\n");
  const out = [];
  let inUl = false, inOl = false, inQuote = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
    if (inQuote) { out.push("</blockquote>"); inQuote = false; }
  };
  for (const line of lines) {
    const fence = line.match(/^\u0002(\d+)\u0002$/);
    if (fence) {
      closeLists();
      out.push("<pre><code>" + escapeHtml(blocks[Number(fence[1])]) + "</code></pre>");
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      out.push("<h" + h[1].length + ">" + renderInline(h[2]) + "</h" + h[1].length + ">");
      continue;
    }
    if (/^\s*([-*])\s+/.test(line) && line.trim() !== "-") {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push("<li>" + renderInline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
      continue;
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push("<li>" + renderInline(ol[2]) + "</li>");
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) { closeLists(); out.push("<hr>"); continue; }
    if (/^&gt;\s?/.test(line)) {
      if (inUl || inOl) { closeLists(); }
      if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
      out.push("<p>" + renderInline(line.replace(/^&gt;\s?/, "")) + "</p>");
      continue;
    }
    closeLists();
    if (line.trim() === "") continue;
    out.push("<p>" + renderInline(line) + "</p>");
  }
  closeLists();
  return out.join("");
}

// ---------- 状态 ----------
const chatEl = document.getElementById("chat");
const emptyHint = document.getElementById("empty-hint");
let es = null;
let toastTimer = null;
let currentSid = null;                 // 当前查看/提问的会话
const sessions = new Map();            // id -> 会话摘要
const sessionCards = new Map();        // sid -> Map<qaId, state>（当前视图卡片）
const pendingLocals = [];              // 乐观卡片（仅当前会话）[{sid, state}]
const lastActive = new Map();          // sid -> 最近一次 qa id
const PROTOCOL_NAMES = { openai: "OpenAI 兼容", dify: "Dify Chatflow", generic: "第三方通用", ragflow: "RAGFlow" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function $(id) { return document.getElementById(id); }

// ---------- 会话侧栏（宽桌面：收起/展开且记忆；平板/窄屏 ≤1024px：自动收起，可手动展开；
//          手机 ≤720px：左侧滑出抽屉，选择后关闭） ----------
const appEl = document.querySelector(".app");
const mqMobile = window.matchMedia("(max-width: 720px)");
const mqNarrow = window.matchMedia("(max-width: 1024px)");
let desktopCollapsed = false;
let tabletExpanded = false;
let mobileSessOpen = false;
try { desktopCollapsed = localStorage.getItem("qa-mini-sidebar") === "1"; } catch {}
function applySidebar() {
  const mobile = mqMobile.matches;
  const narrow = mqNarrow.matches;
  if (mobile) {
    appEl.classList.remove("collapsed");
    appEl.classList.toggle("sidebar-open", mobileSessOpen);
  } else {
    appEl.classList.remove("sidebar-open");
    const collapsed = narrow ? !tabletExpanded : desktopCollapsed;
    appEl.classList.toggle("collapsed", collapsed);
  }
  const b = $("btn-toggle-sidebar");
  if (b) {
    b.title = mobile
      ? (mobileSessOpen ? "关闭会话列表" : "打开会话列表")
      : (appEl.classList.contains("collapsed") ? "展开会话列表" : "收起会话列表");
  }
}
function closeMobileSess() {
  if (mobileSessOpen) {
    mobileSessOpen = false;
    applySidebar();
  }
}

// ---------- 主题（深色 / 浅色，本地记忆；index.html 内联脚本先行避免闪烁） ----------
let themeMode = "dark";
try {
  const t = localStorage.getItem("qa-mini-theme");
  if (t === "light" || t === "dark") themeMode = t;
} catch {}
function applyTheme() {
  document.documentElement.setAttribute("data-theme", themeMode);
  const mt = $("meta-theme");
  if (mt) mt.setAttribute("content", themeMode === "dark" ? "#0f1216" : "#f2f4f7");
  const b = $("btn-theme");
  if (b) {
    b.textContent = themeMode === "dark" ? "☀️" : "🌙";
    b.title = themeMode === "dark" ? "切换到浅色主题" : "切换到深色主题";
  }
}

function showToast(msg, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms || 2200);
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function sourceBadge(source) {
  if (source === "push") return '<span class="badge push">🎤 语音推送</span>';
  return '<span class="badge web">💬 网页</span>';
}

// ---------- 问答字号（默认 / 大 / 自定义，本地持久化） ----------
const FONT_SIZES = { default: 15, large: 18 };
let fontState = { mode: "default", px: 15 };
try {
  const raw = localStorage.getItem("qa-mini-font");
  if (raw) {
    const f = JSON.parse(raw);
    if (f && ["default", "large", "custom"].indexOf(f.mode) >= 0) fontState = f;
  }
} catch {}
function applyFont() {
  const size = fontState.mode === "custom" ? fontState.px : (FONT_SIZES[fontState.mode] || 15);
  document.documentElement.style.setProperty("--qa-size", size + "px");
  const m = $("font-mode");
  const p = $("font-px");
  if (m) m.value = fontState.mode;
  if (p) {
    p.value = fontState.px;
    p.classList.toggle("hidden", fontState.mode !== "custom");
  }
  try { localStorage.setItem("qa-mini-font", JSON.stringify(fontState)); } catch {}
}

function curSession() { return sessions.get(currentSid) || null; }

function cardsOf(sid) {
  let m = sessionCards.get(sid);
  if (!m) { m = new Map(); sessionCards.set(sid, m); }
  return m;
}

// ---------- 卡片 ----------
function makeCard(sid, opts) {
  const id = opts.id || null;
  emptyHint.classList.add("hidden");
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML =
    '<div class="card-q">' +
      '<span class="q-tag">问</span>' +
      '<span class="q-text">' + escapeHtml(opts.question || "") + "</span>" +
      '<span class="card-meta">' +
        sourceBadge(opts.source) +
        '<span class="badge proto">' + escapeHtml(opts.protocolName || opts.protocol || "") + "</span>" +
        '<span class="time">' + fmtTime(opts.ts) + "</span>" +
        '<button class="mini-del hidden" title="删除这条记录">🗑</button>' +
        '<button class="mini-stop hidden" title="停止生成">✕</button>' +
      "</span>" +
      '<button class="copy-btn" title="复制问题">⧉ 复制</button>' +
    "</div>" +
    '<div class="card-a">' +
      '<div class="a-head"><span class="a-tag">答</span></div>' +
      '<div class="a-body"></div>' +
      '<span class="status status-running"><span class="status-text">生成中…</span><button class="copy-btn hidden" title="复制答案">⧉ 复制</button></span>' +
    "</div>";
  chatEl.appendChild(el);
  const state = {
    sid,
    el,
    answerEl: el.querySelector(".a-body"),
    statusEl: el.querySelector(".status"),
    statusTextEl: el.querySelector(".status .status-text"),
    stopBtn: el.querySelector(".mini-stop"),
    delBtn: el.querySelector(".mini-del"),
    qCopyBtn: el.querySelector(".card-q .copy-btn"),
    aCopyBtn: el.querySelector(".status .copy-btn"),
    raw: opts.raw || "",
    pending: !id,
    renderQueued: false,
    question: opts.question || "",
    _id: id
  };
  if (id) cardsOf(sid).set(id, state);
  if (!id || opts.running) state.stopBtn.classList.remove("hidden");
  state.stopBtn.addEventListener("click", () => {
    if (state._id) cancelQa(state._id);
  });
  wireCopyBtn(state.qCopyBtn, () => state.question, "问题");
  wireCopyBtn(state.aCopyBtn, () => state.raw, "答案");
  state.delBtn.addEventListener("click", async () => {
    if (!state._id) return;
    if (!window.confirm("删除这条问答记录？（各端同步删除，不可恢复）")) return;
    const r = await api("DELETE", "/api/sessions/" + state.sid + "/history/" + state._id);
    if (r.status === 200) {
      state.el.remove();
      if (cardsOf(state.sid).size === 0) {
        emptyHint.classList.remove("hidden");
        updateActiveCount();
      }
    } else {
      showToast("删除失败: " + ((r.data && r.data.detail) || ""), 2500);
    }
  });
  scrollToBottom(true);
  return state;
}

function renderCard(state) {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    if (state.aCopyBtn) state.aCopyBtn.classList.toggle("hidden", !state.raw);
    const running = state.statusEl.classList.contains("status-running");
    const html = renderMarkdown(state.raw) + (running ? '<span class="cursor"></span>' : "");
    state.answerEl.innerHTML = html;
    if (running) scrollToBottom(true);
  });
}

function nearBottom() {
  const c = document.scrollingElement || document.documentElement;
  return c.scrollTop + c.clientHeight >= c.scrollHeight - 120;
}

function scrollToBottom(force) {
  if (force || nearBottom()) window.scrollTo({ top: document.body.scrollHeight });
}

function finalizeCard(sid, id, ok, detail) {
  const st = cardsOf(sid).get(id);
  if (!st) return;
  st.statusEl.className = "status " + (ok ? "status-ok" : "status-err");
  st.statusTextEl.textContent = (ok ? "✔ " : "✘ ") + detail;
  st.stopBtn.classList.add("hidden");
  st.delBtn.classList.remove("hidden");
  renderCard(st);
  updateActiveCount();
}

// ---------- 视图 ----------
function renderSessionList() {
  const box = $("session-list");
  box.innerHTML = "";
  for (const s of sessions.values()) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === currentSid ? " active" : "");
    item.title = s.name + " · 会话ID " + s.id;
    const name = document.createElement("div");
    name.className = "s-name";
    name.textContent = s.name;
    const meta = document.createElement("div");
    meta.className = "s-meta";
    const badge = document.createElement("span");
    badge.className = "badge proto";
    badge.textContent = PROTOCOL_NAMES[s.protocol] || s.protocol;
    const time = document.createElement("span");
    time.className = "s-time";
    time.textContent = s.active > 0 ? "生成中…" : (s.last_at ? fmtTime(s.last_at) : "");
    meta.appendChild(badge);
    meta.appendChild(time);
    item.appendChild(name);
    item.appendChild(meta);
    if (s.last_question) {
      const last = document.createElement("div");
      last.className = "s-last";
      last.textContent = s.last_question;
      item.appendChild(last);
    }
    item.addEventListener("click", () => {
      switchSession(s.id);
      closeMobileSess();
    });
    box.appendChild(item);
  }
}

function updateComposerProto() {
  const s = curSession();
  $("composer-proto").textContent = s
    ? (PROTOCOL_NAMES[s.protocol] || s.protocol) + " · " + s.name
    : "无会话";
}

function renderSessionView(session, running) {
  const sid = session.id;
  // 只清除卡片，保留静态空态提示（innerHTML 清空会把 #empty-hint 销毁，导致空会话不再显示提示）
  chatEl.querySelectorAll(".card").forEach((el) => el.remove());
  for (const m of sessionCards.values()) m.clear();
  const items = (session.history || []).slice().reverse();
  for (const it of items) {
    const st = makeCard(sid, {
      id: it.id, question: it.question, source: it.source,
      protocol: it.protocol, protocolName: it.protocol_name, ts: it.started_at
    });
    st.raw = it.answer;
    st.statusEl.className = "status " + (it.ok ? "status-ok" : "status-err");
    st.statusTextEl.textContent = (it.ok ? "✔ " : "✘ ") + it.detail;
    st.stopBtn.classList.add("hidden");
    st.delBtn.classList.remove("hidden");
    renderCard(st);
  }
  for (const rec of running || []) {
    const st = makeCard(sid, {
      id: rec.id, question: rec.question, source: rec.source,
      protocol: rec.protocol, protocolName: rec.protocol_name,
      ts: rec.started_at, running: true
    });
    st.raw = rec.answer;
    renderCard(st);
    lastActive.set(sid, rec.id);
  }
  const is_empty = !items.length && !(running || []).length;
  emptyHint.classList.toggle("hidden", !is_empty);
  if (is_empty) {
    $("hint-proto").textContent = "当前协议：" + (PROTOCOL_NAMES[session.protocol] || session.protocol)
      + " · 会话ID " + session.id + " · 连接状态见左下角";
  }
  scrollToBottom(true);
}

async function switchSession(sid) {
  if (sid === currentSid) return;
  currentSid = sid;
  pendingLocals.length = 0;
  renderSessionList();
  updateComposerProto();
  updateActiveCount();
  try {
    const r = await api("GET", "/api/sessions/" + sid);
    if (r.status === 200 && currentSid === sid) {
      renderSessionView(r.data.session, r.data.running);
    }
  } catch (e) {
    showToast("加载会话失败: " + e.message, 3000);
  }
}

function updateActiveCount() {
  let n = 0;
  for (const s of sessions.values()) n += s.active || 0;
  const pill = $("active-count");
  if (n > 0) {
    pill.textContent = n + " 个回答生成中";
    pill.classList.remove("hidden");
  } else {
    pill.classList.add("hidden");
  }
  const last = currentSid ? lastActive.get(currentSid) : null;
  const st = last ? cardsOf(currentSid).get(last) : null;
  $("btn-cancel").disabled = !(st && st.statusEl.classList.contains("status-running"));
}

// ---------- API ----------
async function api(method, p, body) {
  const resp = await fetch(p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  return { status: resp.status, data };
}

// ---------- 提问 / 取消 ----------
async function sendQuestion() {
  const q = $("question").value.trim();
  if (!q) return;
  const s = curSession();
  if (!s) { showToast("请先创建会话", 2500); return; }
  const protoName = PROTOCOL_NAMES[s.protocol] || s.protocol;
  const st = makeCard(currentSid, {
    source: "web", protocol: s.protocol, protocolName: protoName,
    question: q, ts: new Date().toISOString(), running: true
  });
  pendingLocals.push({ sid: currentSid, state: st });
  $("question").value = "";
  const drop = () => {
    const i = pendingLocals.findIndex((p) => p.state === st);
    if (i >= 0) pendingLocals.splice(i, 1);
  };
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: currentSid, question: q })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      st.statusEl.className = "status status-err";
      st.statusTextEl.textContent = "✘ " + (data.detail || ("HTTP " + resp.status));
      st.stopBtn.classList.add("hidden");
      drop();
      updateActiveCount();
    }
  } catch (err) {
    st.statusEl.className = "status status-err";
    st.statusTextEl.textContent = "✘ 网络错误: " + err.message;
    st.stopBtn.classList.add("hidden");
    drop();
    updateActiveCount();
  }
}

async function cancelQa(id) {
  try {
    const r = await api("POST", "/api/cancel", { id });
    if (!r.data || !r.data.ok) showToast(r.data ? r.data.detail : "取消失败", 2500);
  } catch (e) {
    showToast("取消失败: " + e.message, 2500);
  }
}

// ---------- 会话管理 ----------
async function createSession() {
  const input = window.prompt("新会话名称", "会话 " + (sessions.size + 1));
  if (input === null) return;
  const r = await api("POST", "/api/sessions", {
    name: input.trim() || undefined,
    protocol: "ragflow"
  });
  if (r.status === 201 && r.data && r.data.session) {
    showToast("已创建会话「" + r.data.session.name + "」");
    switchSession(r.data.session.id);
  } else {
    showToast("创建失败: " + ((r.data && r.data.detail) || ("HTTP " + r.status)), 3000);
  }
}

function asrBody(s) {
  return '{"token":"' + s.token + '","session_id":"' + s.id + '"}';
}

// config.toml 片段：TOML 单引号字面量，无转义，可直接复制粘贴
function asrSnippet(s) {
  const url = location.origin + "/api/push";
  const lines = [
    "[third_party]",
    "url = '" + url + "'",
    "body = '" + asrBody(s) + "'",
    "auto_send = true",
    "qa_enabled = false"
  ];
  return lines.join("\n");
}

function openSessionDrawer() {
  const s = curSession();
  if (!s) { showToast("无当前会话", 2000); return; }
  $("sd-name").value = s.name;
  $("sd-protocol").value = s.protocol;
  $("sd-continue").checked = !!s.continue_session;
  $("sd-session-id").value = s.id;
  $("sd-token").value = s.token;
  $("sd-snippet").value = asrSnippet(s);
  $("sd-snippet-body").value = asrBody(s);
  $("sd-save-state").textContent = "";
  $("sd-save-state").className = "save-state";
  $("session-drawer").classList.remove("hidden");
}

async function saveSessionDrawer() {
  const s = curSession();
  if (!s) return;
  const state = $("sd-save-state");
  state.textContent = "保存中…";
  state.className = "save-state";
  try {
    const r = await api("PUT", "/api/sessions/" + s.id, {
      name: $("sd-name").value,
      protocol: $("sd-protocol").value,
      continue_session: $("sd-continue").checked
    });
    if (r.status === 200 && r.data && r.data.ok) {
      state.textContent = "已保存 " + fmtTime(new Date().toISOString());
      state.className = "save-state ok";
      showToast("会话已保存");
      $("session-drawer").classList.add("hidden");
      const fresh = r.data.session;
      s.name = fresh.name;
      s.protocol = fresh.protocol;
      s.continue_session = fresh.continue_session;
      s.token = fresh.token;
      $("sd-name").value = fresh.name;
      $("sd-token").value = fresh.token;
      $("sd-session-id").value = fresh.id;
      $("sd-snippet").value = asrSnippet(fresh);
      $("sd-snippet-body").value = asrBody(fresh);
      renderSessionList();
      updateComposerProto();
    } else {
      state.textContent = "保存失败";
      state.className = "save-state err";
      showToast("保存失败: " + ((r.data && r.data.detail) || ("HTTP " + r.status)), 3000);
    }
  } catch (err) {
    state.textContent = "保存失败";
    state.className = "save-state err";
    showToast("保存失败: " + err.message, 3000);
  }
}

async function regenToken() {
  const s = curSession();
  if (!s) return;
  if (!window.confirm("重新生成 token 后，asr-tool 的 body 需同步更新。确定？")) return;
  const r = await api("PUT", "/api/sessions/" + s.id, { regenerate_token: true });
  if (r.status === 200 && r.data && r.data.ok) {
    s.token = r.data.session.token;
    $("sd-token").value = s.token;
    $("sd-snippet").value = asrSnippet(s);
    $("sd-snippet-body").value = asrBody(s);
    showToast("token 已重新生成，请同步 asr-tool 配置");
  } else {
    showToast("重新生成失败: " + ((r.data && r.data.detail) || ("HTTP " + r.status)), 3000);
  }
}

async function resetCurrentSession() {
  const s = curSession();
  if (!s) return;
  if (!window.confirm("重置会话？将清空该会话的后端对话上下文（RAGFlow/Dify），已显示的问答记录保留。")) return;
  const r = await api("POST", "/api/sessions/" + s.id + "/reset");
  showToast(r.data && r.data.ok ? "会话已重置" : "重置失败: " + ((r.data && r.data.detail) || ""), 2500);
}

async function deleteCurrentSession() {
  const s = curSession();
  if (!s) return;
  if (!window.confirm("删除会话「" + s.name + "」？其问答记录将一并删除，不可恢复。")) return;
  const r = await api("DELETE", "/api/sessions/" + s.id);
  if (r.status === 200) {
    $("session-drawer").classList.add("hidden");
    showToast("会话已删除");
  } else {
    showToast("删除失败: " + ((r.data && r.data.detail) || ""), 2500);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } catch {
    showToast("复制失败", 2000);
  }
  document.body.removeChild(ta);
}

function wireCopyBtn(btn, getText) {
  if (!btn) return;
  btn.addEventListener("click", () => {
    const text = getText();
    if (!text) { showToast("暂无可复制内容", 1500); return; }
    const done = () => {
      btn.classList.add("copied");
      btn.textContent = "✔ 已复制";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = "⧉ 复制";
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  });
}

function copyText(text, okMsg) {
  const done = () => showToast(okMsg || "已复制", 1800);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

// ---------- SSE 广播 ----------
function connectEvents() {
  const conn = $("conn-state");
  es = new EventSource("/api/events");
  es.addEventListener("open", () => {
    conn.textContent = "已连接";
    conn.className = "conn on";
  });
  es.addEventListener("error", () => {
    conn.textContent = "重连中…";
    conn.className = "conn off";
  });
  es.addEventListener("sessions", (e) => {
    const list = JSON.parse(e.data).sessions || [];
    sessions.clear();
    for (const s of list) sessions.set(s.id, s);
    renderSessionList();
    if (!currentSid || !sessions.has(currentSid)) {
      if (list.length) switchSession(list[0].id);
      else updateComposerProto();
    }
    updateActiveCount();
  });
  es.addEventListener("qa_start", (e) => {
    const d = JSON.parse(e.data);
    lastActive.set(d.session_id, d.id);
    if (d.session_id !== currentSid) {
      updateActiveCount();
      return;
    }
    let idx = pendingLocals.findIndex((p) => p.sid === d.session_id && p.state.question === d.question);
    if (idx < 0) idx = pendingLocals.findIndex((p) => p.sid === d.session_id);
    let st;
    if (idx >= 0) {
      const p = pendingLocals.splice(idx, 1)[0];
      st = p.state;
      st.pending = false;
      st._id = d.id;
      cardsOf(d.session_id).set(d.id, st);
    } else {
      st = makeCard(d.session_id, {
        id: d.id, question: d.question, source: d.source,
        protocol: d.protocol, protocolName: d.protocol_name,
        ts: new Date().toISOString(), running: true
      });
    }
    updateActiveCount();
  });
  es.addEventListener("delta", (e) => {
    const d = JSON.parse(e.data);
    if (d.session_id !== currentSid) return;
    const st = cardsOf(d.session_id).get(d.id);
    if (!st) return;
    st.raw += d.text;
    renderCard(st);
  });
  es.addEventListener("done", (e) => {
    const d = JSON.parse(e.data);
    if (d.session_id !== currentSid) {
      updateActiveCount();
      return;
    }
    finalizeCard(d.session_id, d.id, d.ok, d.detail);
  });
  es.addEventListener("record_removed", (e) => {
    const d = JSON.parse(e.data);
    if (d.session_id !== currentSid) return;
    const st = cardsOf(d.session_id).get(d.id);
    if (st) st.el.remove();
    if (currentSid && cardsOf(currentSid).size === 0) {
      emptyHint.classList.remove("hidden");
      updateActiveCount();
    }
  });
  es.addEventListener("session_reset", (e) => {
    const d = JSON.parse(e.data);
    if (d.session_id === currentSid) showToast("会话已重置（后端上下文已清空）");
  });
  es.addEventListener("config", () => {
    if (!$("settings").classList.contains("hidden")) fillSettingsForm();
  });
}

// ---------- 协议配置（全局） ----------
const CFG_FIELDS = [
  "protocols.openai.url", "protocols.openai.api_key", "protocols.openai.model",
  "protocols.dify.url", "protocols.dify.api_key", "protocols.dify.user",
  "protocols.generic.url", "protocols.generic.api_key", "protocols.generic.body",
  "protocols.ragflow.url", "protocols.ragflow.api_key", "protocols.ragflow.chat_id"
];

function cfgEl(key) {
  const parts = key.split(".");
  const secName = parts[0] === "protocols" ? parts[1] : parts[0];
  return $("cfg-" + secName + "-" + parts[parts.length - 1]);
}

function getNested(obj, key) {
  return key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : ""), obj);
}

function setNested(obj, key, val) {
  const parts = key.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = val;
}

async function fillSettingsForm() {
  try {
    const resp = await fetch("/api/config");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const cfg = await resp.json();
    for (const key of CFG_FIELDS) {
      const el = cfgEl(key);
      if (!el) continue;
      const val = getNested(cfg, key);
      if (el.type === "checkbox") el.checked = !!val;
      else el.value = val == null ? "" : val;
    }
  } catch (err) {
    showToast("设置加载失败: " + err.message, 3000);
  }
}

async function saveSettings() {
  const state = $("save-state");
  state.textContent = "保存中…";
  state.className = "save-state";
  const patch = {};
  for (const key of CFG_FIELDS) {
    const el = cfgEl(key);
    if (!el) continue;
    const val = el.type === "checkbox" ? el.checked : el.value;
    setNested(patch, key, val);
  }
  try {
    const resp = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      state.textContent = "已保存 " + fmtTime(new Date().toISOString());
      state.className = "save-state ok";
      showToast("配置已保存");
      $("settings").classList.add("hidden");
    } else {
      state.textContent = "保存失败";
      state.className = "save-state err";
      showToast("保存失败: " + (data.detail || ("HTTP " + resp.status)), 3500);
    }
  } catch (err) {
    state.textContent = "保存失败";
    state.className = "save-state err";
    showToast("保存失败: " + err.message, 3500);
  }
}

// ---------- 初始化 ----------
document.addEventListener("DOMContentLoaded", () => {
  connectEvents();
  applyFont();
  applySidebar();
  $("btn-toggle-sidebar").addEventListener("click", () => {
    if (mqMobile.matches) {
      mobileSessOpen = !mobileSessOpen;
    } else if (mqNarrow.matches) {
      tabletExpanded = !tabletExpanded; // 平板/窄屏：手动展开（不持久化）
    } else {
      desktopCollapsed = !desktopCollapsed;
      try { localStorage.setItem("qa-mini-sidebar", desktopCollapsed ? "1" : "0"); } catch {}
    }
    applySidebar();
  });
  $("btn-close-sidebar").addEventListener("click", closeMobileSess);
  applyTheme();
  $("btn-theme").addEventListener("click", () => {
    themeMode = themeMode === "dark" ? "light" : "dark";
    try { localStorage.setItem("qa-mini-theme", themeMode); } catch {}
    applyTheme();
  });
  mqNarrow.addEventListener("change", (e) => {
    if (e.matches) tabletExpanded = false; // 进入窄屏 → 自动收起
    applySidebar();
  });
  mqMobile.addEventListener("change", (e) => {
    if (!e.matches) mobileSessOpen = false;
    applySidebar();
  });
  $("font-mode").addEventListener("change", () => {
    fontState.mode = $("font-mode").value;
    applyFont();
  });
  $("font-px").addEventListener("change", () => {
    let v = parseInt($("font-px").value, 10);
    if (isNaN(v)) v = 15;
    v = Math.max(12, Math.min(28, v));
    fontState.px = v;
    fontState.mode = "custom";
    $("font-mode").value = "custom";
    applyFont();
  });
  $("btn-send").addEventListener("click", sendQuestion);
  $("btn-cancel").addEventListener("click", () => {
    const last = currentSid ? lastActive.get(currentSid) : null;
    if (last) cancelQa(last);
  });
  const q = $("question");
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuestion();
    }
  });
  $("btn-new-session").addEventListener("click", createSession);
  $("btn-session").addEventListener("click", openSessionDrawer);
  $("btn-close-session-drawer").addEventListener("click", () => $("session-drawer").classList.add("hidden"));
  $("sd-save").addEventListener("click", saveSessionDrawer);
  $("sd-regen-token").addEventListener("click", regenToken);
  $("sd-copy-sid").addEventListener("click", () => copyText($("sd-session-id").value, "会话 ID 已复制"));
  $("sd-copy-token").addEventListener("click", () => copyText($("sd-token").value, "token 已复制"));
  $("sd-copy-snippet").addEventListener("click", () => copyText($("sd-snippet").value, "asr-tool 配置片段已复制"));
  $("sd-copy-body").addEventListener("click", () => copyText($("sd-snippet-body").value, "body 值已复制"));
  $("sd-reset").addEventListener("click", resetCurrentSession);
  $("sd-delete").addEventListener("click", deleteCurrentSession);
  $("btn-settings").addEventListener("click", async () => {
    $("settings").classList.remove("hidden");
    await fillSettingsForm();
  });
  $("btn-close-settings").addEventListener("click", () => $("settings").classList.add("hidden"));
  $("btn-save-config").addEventListener("click", saveSettings);
  // 协议配置分 tab 切换
  const cfgTabs = Array.from(document.querySelectorAll(".cfg-tab"));
  for (const btn of cfgTabs) {
    btn.addEventListener("click", () => {
      for (const b of cfgTabs) b.classList.toggle("active", b === btn);
      const name = btn.dataset.cfgtab;
      for (const p of document.querySelectorAll(".cfg-panel")) {
        p.classList.toggle("hidden", p.dataset.cfgtab !== name);
      }
    });
  }

  // PWA：注册 service worker（离线外壳；/api 与 SSE 在 sw.js 中直通网络不缓存）
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
});
