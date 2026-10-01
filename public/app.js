"use strict";
// QA Mini 前端（多会话版）：
//  - 左侧会话列表（新建/切换）；每会话独立 token / 会话ID / 协议 / 历史
//  - EventSource /api/events：事件均带 session_id，同一会话多浏览器同步实时输出
//  - 提问 POST /api/chat {session_id, question}（乐观建卡，按 会话+问题 合并）
//  - 内置极简 Markdown 渲染（先转义再应用子集，防 XSS）

// ---------- Markdown ----------
// 轻量 SVG 图标（自托管 sprite /icons.svg，Lucide 风格 2px 描边）
const IC = (id, cls) =>
  '<svg class="icon' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="/icons.svg#' + id + '"></use></svg>';
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
const btnToLatest = document.getElementById("btn-to-latest");
let es = null;
let toastTimer = null;
let currentSid = null;                 // 当前查看/提问的会话
const sessions = new Map();            // id -> 会话摘要
const sessionCards = new Map();        // sid -> Map<qaId, state>（当前视图卡片）
const pendingLocals = [];              // 乐观卡片（仅当前会话）[{sid, state}]
const lastActive = new Map();          // sid -> 最近一次 qa id
const PROTOCOL_NAMES = { openai: "OpenAI 兼容", dify: "编排引擎", generic: "第三方通用", ragflow: "知识引擎" };
// 会话级协议配置字段（顺序/文案与「⚙ 设置」抽屉一致）：[字段, 标签]，字段名与全局 protocols[协议] 同构
const PROTO_FIELD_DEFS = {
  openai: [
    ["url", "接口地址（chat completions 完整地址）"],
    ["api_key", "API Key"],
    ["model", "模型（可空）"]
  ],
  dify: [
    ["url", "接口基址（如 http://host/v1）"],
    ["api_key", "API Key（app-xxx，必填）"],
    ["user", "user 标识"]
  ],
  generic: [
    ["url", "目标接口完整地址"],
    ["api_key", "API Key（可空）"],
    ["body", "请求体 JSON 模板（{question} / {context} 占位符）"]
  ],
  ragflow: [
    ["url", "接口基址（如 http://host:9380/api/v1）"],
    ["api_key", "API Key（必填）"],
    ["chat_id", "Chat ID（必填）"]
  ]
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function $(id) { return document.getElementById(id); }

// ---------- 访问控制（管理密码 /admin + 访问码）----------
// 管理：仅 /admin 路由 + 有效管理 token 时显示「会话设置 / ⚙ 设置」；服务端对管理接口强制鉴权。
// 访问：allow_anonymous=false 时需访问码（换访问 token）；token 存 localStorage（带过期）。
const ADMIN_ROUTE = location.pathname === "/admin" || location.pathname === "/admin/";
function readAuthToken(k) {
  try {
    const v = JSON.parse(localStorage.getItem(k) || "null");
    if (v && v.token && typeof v.expires_at === "number" && Date.now() < v.expires_at) return v.token;
  } catch {}
  return "";
}
function getAdminToken() { return readAuthToken("qa-mini-admin"); }
function getAccessToken() { return readAuthToken("qa-mini-access"); }
function setAuth(k, token, expiresAtIso) {
  try { localStorage.setItem(k, JSON.stringify({ token, expires_at: Date.parse(expiresAtIso) })); } catch {}
}
function viewerToken() {
  // /admin 页优先用管理 token（viewerOk 明确接受，经 ?access= 承载）：
  // 本地未过期但服务端已失效（如容器重启清空内存 token 表）的 access token
  // 若抢先发送，会使查看级调用全部 403 → nudgeAuth 误弹管理员登录
  if (ADMIN_ROUTE) return getAdminToken() || getAccessToken();
  return getAccessToken();
}
let lastAuthNudge = 0;
function nudgeAuth(isAdminCall) {
  if (Date.now() - lastAuthNudge < 4000) return;
  lastAuthNudge = Date.now();
  if (isAdminCall) showAdminGate();
  else if (ADMIN_ROUTE) showAdminGate();
  else showAccessGate();
}
function showAdminGate(adminSet) {
  if (adminSet === undefined) {
    // 未知时取最近一次状态缓存
    adminSet = window.__qaStatusAdminSet;
  }
  $("admin-gate-hint").textContent = adminSet
    ? "输入管理密码后，右上角显示「会话设置 / ⚙︎ 设置」"
    : "尚未设置管理密码：现在输入的密码将初始化为管理密码（4-64 位）";
  $("admin-pw").value = "";
  $("admin-gate-err").textContent = "";
  $("admin-gate").classList.remove("hidden");
}
function showAccessGate() {
  $("access-code").value = "";
  $("access-gate-err").textContent = "";
  $("access-gate").classList.remove("hidden");
}
function hideGates() {
  $("admin-gate").classList.add("hidden");
  $("access-gate").classList.add("hidden");
}
function updateAdminUI() {
  const on = ADMIN_ROUTE && !!getAdminToken();
  $("btn-session").classList.toggle("hidden", !on);
  $("btn-settings").classList.toggle("hidden", !on);
}
// 门禁通过（或无需门禁）后解锁首页（去掉 booting 类）
function unlockApp() { document.body.classList.remove("booting"); }

async function checkGates() {
  let st = null;
  try {
    const r = await fetch("/api/status");
    st = await r.json();
    window.__qaStatusAdminSet = !!st.admin_set;
  } catch {}
  updateAdminUI();
  if (ADMIN_ROUTE && !getAdminToken()) {
    showAdminGate(window.__qaStatusAdminSet);
    return false;
  }
  if (st && st.allow_anonymous === false && !getAccessToken() && !(ADMIN_ROUTE && getAdminToken())) {
    showAccessGate();
    return false;
  }
  hideGates();
  return true;
}

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
    const u = b.querySelector("use");
    if (u) u.setAttribute("href", themeMode === "dark" ? "/icons.svg#i-sun" : "/icons.svg#i-moon");
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

// 会话列表时间：今天/昨天/前天 hh:mm:ss，更早 YYYY-MM-DD hh:mm:ss（按本地日历日）
function fmtListTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  const hms = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  if (diffDays === 0) return "今天 " + hms;
  if (diffDays === 1) return "昨天 " + hms;
  if (diffDays === 2) return "前天 " + hms;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + hms;
}

function sourceBadge(source) {
  if (source === "push") return '<span class="badge push">' + IC("i-mic") + '语音推送</span>';
  return '<span class="badge web">' + IC("i-message") + '网页</span>';
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

// ---------- 内容宽度（窄 / 宽 / 铺满，本地持久化） ----------
const WIDTH_MODES = ["narrow", "wide", "full"];
let widthMode = "narrow";
try {
  const rw = localStorage.getItem("qa-mini-width");
  if (rw && WIDTH_MODES.indexOf(rw) >= 0) widthMode = rw;
} catch {}
function applyWidthMode() {
  const root = document.documentElement;
  root.classList.remove("qa-w-narrow", "qa-w-wide", "qa-w-full");
  root.classList.add("qa-w-" + widthMode);
  const sel = $("width-mode");
  if (sel) sel.value = widthMode;
}
applyWidthMode();

// ---------- 行间距（默认 / 窄 / 自定义，本地持久化；默认=各元素原行距不变） ----------
const LINE_PRESETS = { narrow: 1.35 };
let lineState = { mode: "default", val: 1.65 };
try {
  const rl = localStorage.getItem("qa-mini-line");
  if (rl) {
    const l = JSON.parse(rl);
    if (l && ["default", "narrow", "custom"].indexOf(l.mode) >= 0) lineState = l;
  }
} catch {}
function applyLineMode() {
  const root = document.documentElement;
  if (lineState.mode === "custom") root.style.setProperty("--qa-line", String(lineState.val));
  else if (lineState.mode === "narrow") root.style.setProperty("--qa-line", String(LINE_PRESETS.narrow));
  else root.style.removeProperty("--qa-line");
  const m = $("line-mode");
  const p = $("line-val");
  if (m) m.value = lineState.mode;
  if (p) {
    p.value = lineState.val;
    p.classList.toggle("hidden", lineState.mode !== "custom");
  }
  try { localStorage.setItem("qa-mini-line", JSON.stringify(lineState)); } catch {}
}
applyLineMode();

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
      "</span>" +
      '<button class="copy-btn" title="复制问题">' + IC("i-copy") + ' 复制</button>' +
    "</div>" +
    '<div class="card-a">' +
      '<div class="a-head"><span class="a-tag">答</span></div>' +
      '<div class="a-body"></div>' +
      '<span class="status status-running"><span class="status-text">生成中…</span>' +
      '<span class="card-acts">' +
        '<button class="mini-btn mini-stop hidden" title="停止生成">' + IC("i-stop") + ' 停止</button>' +
        '<button class="mini-btn mini-regen hidden" title="重新生成（删除本条，按相同上下文重新提问）">' + IC("i-rotate") + ' 重新生成</button>' +
        '<button class="copy-btn hidden" title="复制答案">' + IC("i-copy") + ' 复制</button>' +
        '<button class="mini-btn mini-del hidden" title="删除这条记录（各端同步，不可恢复）">' + IC("i-trash") + ' 删除</button>' +
      "</span></span>" +
    "</div>";
  chatEl.appendChild(el);
  const state = {
    sid,
    el,
    answerEl: el.querySelector(".a-body"),
    statusEl: el.querySelector(".status"),
    statusTextEl: el.querySelector(".status .status-text"),
    stopBtn: el.querySelector(".mini-stop"),
    regenBtn: el.querySelector(".mini-regen"),
    delBtn: el.querySelector(".mini-del"),
    qCopyBtn: el.querySelector(".card-q .copy-btn"),
    aCopyBtn: el.querySelector(".status .copy-btn"),
    raw: opts.raw || "",
    pending: !id,
    renderQueued: false,
    question: opts.question || "",
    startedAtMs: Date.now(),
    _id: id
  };
  if (id) cardsOf(sid).set(id, state);
  if (!id || opts.running) state.stopBtn.classList.remove("hidden");
  if (!id || opts.running) startTicker(state);
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
      removeCardLocal(state);
      if (cardsOf(state.sid).size === 0) {
        emptyHint.classList.remove("hidden");
        updateActiveCount();
      }
    } else {
      showToast("删除失败: " + ((r.data && r.data.detail) || ""), 2500);
    }
  });
  state.regenBtn.addEventListener("click", async () => {
    if (!state._id) return;
    if (!window.confirm("重新生成回答？\n将删除这条记录，并按相同上下文重新提问。")) return;
    const r = await api("DELETE", "/api/sessions/" + state.sid + "/history/" + state._id);
    if (r.status !== 200) {
      showToast("删除失败: " + ((r.data && r.data.detail) || ""), 2500);
      return;
    }
    removeCardLocal(state);
    askQuestion(state.question);
  });
  scrollToBottom(true);
  refreshRegenButtons(sid);
  return state;
}

// 本地移除卡片（服务端 record_removed 广播随后到达时找不到卡片即忽略）
function removeCardLocal(st) {
  stopTicker(st);
  st.el.remove();
  if (st._id) cardsOf(st.sid).delete(st._id);
}

// 重生成按钮：仅当前会话最后一张「非生成中且有记录ID」的卡片显示。
// 对更早的记录重新提问会带上其后新增的上下文（与原提问环境不符），故不提供；
// 在途乐观卡（pendingLocals，尚无 id）或卡内的 running 状态都视为「有在生成」。
function refreshRegenButtons(sid) {
  const map = cardsOf(sid);
  let latest = null;
  const busy = pendingLocals.some((p) => p.sid === sid);
  if (!busy) {
    for (const st of map.values()) {
      if (st.statusEl.classList.contains("status-running")) { latest = null; break; }
      if (st._id) latest = st;
    }
  }
  for (const st of map.values()) {
    if (st.regenBtn) st.regenBtn.classList.toggle("hidden", st !== latest);
  }
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
    if (running) { scrollToBottom(false); updateToLatestBtn(); }
  });
}

// 滚动容器是 main#chat（非 window）：
// - 流式输出中：仅当用户已贴近底部时自动跟随（不被打断上滑阅读），即时滚动不排队
// - 切会话/新提问等 force 场景：平滑滚动到底部
// - 用户上滑后显示「↓ 最新」浮钮，点击平滑回底
function isNearBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 140;
}

function updateToLatestBtn() {
  if (btnToLatest) btnToLatest.classList.toggle("hidden", isNearBottom());
}

function scrollToBottom(force) {
  if (!(force || isNearBottom())) return;
  // force（切会话/新提问/浮钮）平滑；流式跟随时必须 instant（每帧跟随，slow 动画会滞后）
  chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: force ? "smooth" : "instant" });
  updateToLatestBtn();
}

// 生成中实时计时「生成中… Xs」（客户端时钟；最终时长以服务端 started/finished 计算）
function startTicker(st) {
  if (st.tick) return;
  st.tick = setInterval(() => {
    if (!st.statusEl.classList.contains("status-running")) { stopTicker(st); return; }
    const s = (Date.now() - st.startedAtMs) / 1000;
    st.statusTextEl.textContent = "生成中… " + (s < 10 ? s.toFixed(1) : Math.round(s)) + "s";
  }, 250);
}
function stopTicker(st) {
  if (st.tick) { clearInterval(st.tick); st.tick = null; }
}

// 错误卡片：「请求失败」详情渲染进答案区（与「答」标签同行、红色），状态行留简短摘要；
// 其余详情（已取消等）保持状态行文本不变。已有部分内容（流式中断）时不覆盖。
function applyErrorStatus(st, detail, dur) {
  st.statusEl.className = "status status-err";
  const d = String(detail || "");
  const bodyText = d.indexOf("请求失败") === 0 && !st.raw
    ? (d.slice("请求失败: ".length) || d) : "";
  if (bodyText) {
    st.raw = bodyText;
    st.answerEl.classList.add("err-msg");
    st.statusTextEl.innerHTML = IC("i-xmark", "st-err") + "请求失败" + (dur != null ? escapeHtml(" · " + dur + "s") : "");
  } else {
    st.statusTextEl.innerHTML = IC("i-xmark", "st-err") + escapeHtml(d) + (dur != null ? escapeHtml(" · " + dur + "s") : "");
  }
}

function finalizeCard(sid, id, ok, detail, dur) {
  const st = cardsOf(sid).get(id);
  if (!st) return;
  stopTicker(st);
  if (ok) {
    st.statusEl.className = "status status-ok";
    st.statusTextEl.innerHTML = IC("i-check", "st-ok") + escapeHtml(detail) + (dur != null ? escapeHtml(" · " + dur + "s") : "");
  } else {
    applyErrorStatus(st, detail, dur);
  }
  st.stopBtn.classList.add("hidden");
  st.delBtn.classList.remove("hidden");
  renderCard(st);
  scrollToBottom(false); // 完成后若贴近底部则补齐状态行
  refreshRegenButtons(sid);
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
    const ttext = s.active > 0 ? "生成中…" : (s.last_at ? fmtListTime(s.last_at) : "");
    time.textContent = ttext;
    if (ttext) time.title = ttext;
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
  for (const m of sessionCards.values()) {
    for (const st of m.values()) stopTicker(st); // 丢弃的卡片停止计时器
    m.clear();
  }
  const items = (session.history || []).slice().reverse();
  for (const it of items) {
    const st = makeCard(sid, {
      id: it.id, question: it.question, source: it.source,
      protocol: it.protocol, protocolName: it.protocol_name, ts: it.started_at
    });
    st.raw = it.answer;
    if (it.ok) {
      st.statusEl.className = "status status-ok";
      st.statusTextEl.innerHTML = IC("i-check", "st-ok") + escapeHtml(it.detail) + (it.duration_s != null ? escapeHtml(" · " + it.duration_s + "s") : "");
    } else {
      applyErrorStatus(st, it.detail, it.duration_s);
    }
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
  // 历史/在途卡片的最终状态在 makeCard 之后才确定（ok/err 类名在上方赋值），
  // 循环内每次 makeCard 末尾的刷新看到的是「生成中」中间态 → 渲染完成后统一重算一次
  refreshRegenButtons(sid);
  const is_empty = !items.length && !(running || []).length;
  emptyHint.classList.toggle("hidden", !is_empty);
  if (is_empty) {
    $("hint-proto").textContent = "当前协议：" + (PROTOCOL_NAMES[session.protocol] || session.protocol)
      + " · 会话ID " + session.id + " · 连接状态见左下角";
  }
  // 打开会话默认显示最新位置：即时落底（不用 smooth——此刻 scrollHeight 尚缺
  // rAF 延迟渲染的答案高度，且动画会被后续增高打断），markdown 渲染完成后再补一次
  chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: "instant" });
  requestAnimationFrame(() => {
    chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: "instant" });
    updateToLatestBtn();
  });
}

async function switchSession(sid) {
  if (sid === currentSid) return;
  currentSid = sid;
  pendingLocals.length = 0;
  renderSessionList();
  updateComposerProto();
  updateActiveCount();
  // 会话设置抽屉：打开状态下跟随会话切换同步刷新内容（保留点击外部收起）
  if (!$("session-drawer").classList.contains("hidden")) openSessionDrawer();
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
// 管理接口路径（需要 X-Admin-Token）；其余 /api/* 为查看级（带 access 参数）
const ADMIN_PATH_RE = /^\/api\/(config|sessions(\/.*)?|session\/reset|admin\/access-codes)/;
// 注意：GET /api/sessions 与 GET /api/sessions/:id 是查看级（走访问 token），
// 其余 sessions 路径（POST/PUT/DELETE）才是管理级 —— 必须按方法区分
function isViewerSessionsPath(method, p) {
  return method === "GET" && /^\/api\/sessions(\/[^/]+)?(\/.*)?$/.test(p);
}
function withAuth(method, p, body, headers, forceAdmin) {
  const isAdminCall = forceAdmin === true || (ADMIN_PATH_RE.test(p) && !isViewerSessionsPath(method, p));
  const h = Object.assign({ "Content-Type": "application/json" }, headers || {});
  let url = p;
  if (isAdminCall) {
    const t = getAdminToken();
    if (t) h["X-Admin-Token"] = t;
  } else if (!/^\/api\/(status|admin\/login|access\/login)/.test(p)) {
    const t = viewerToken();
    if (t) url = p + (p.includes("?") ? "&" : "?") + "access=" + encodeURIComponent(t);
  }
  return { url, headers: h, isAdminCall };
}
async function api(method, p, body, opts) {
  const au = withAuth(method, p, body, undefined, opts && opts.asAdmin);
  const resp = await fetch(au.url, {
    method,
    headers: au.headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  if (resp.status === 401 && au.isAdminCall) nudgeAuth(true);
  else if (resp.status === 403 && !au.isAdminCall) nudgeAuth(false);
  return { status: resp.status, data };
}

// 全局配置（管理视图）缓存：会话抽屉的协议配置字段用其值作占位符（当前全局默认）
let globalCfgCache = null;
async function loadGlobalCfg() {
  if (globalCfgCache) return globalCfgCache;
  const r = await api("GET", "/api/config", undefined, { asAdmin: true });
  if (r.status !== 200 || !r.data) throw new Error("HTTP " + r.status);
  globalCfgCache = r.data;
  return r.data;
}

// 会话抽屉：渲染协议配置覆盖字段（值 = 本会话覆盖；占位符 = 全局默认；留空保存 = 回退全局）
function renderSessionProtoFields(s, protoOverride) {
  const box = $("sd-proto-fields");
  if (!box || !s) return;
  const proto = protoOverride || s.protocol;
  const g = (globalCfgCache && globalCfgCache.protocols && globalCfgCache.protocols[proto]) || {};
  const ov = (s.protocol_config && s.protocol_config[proto]) || {};
  box.textContent = "";
  for (const [field, label] of PROTO_FIELD_DEFS[proto] || []) {
    const lab = document.createElement("label");
    lab.textContent = label;
    box.appendChild(lab);
    let el;
    if (field === "body") { el = document.createElement("textarea"); el.rows = 3; }
    else { el = document.createElement("input"); el.type = field === "api_key" ? "password" : "text"; }
    el.spellcheck = false;
    el.dataset.pf = field;
    el.value = typeof ov[field] === "string" ? ov[field] : "";
    // 占位符不显示全局默认明文（避免密钥/地址明文暴露），仅提示全局侧是否已配置
    const hasGlobal = typeof g[field] === "string" && g[field].trim() !== "";
    el.placeholder = "留空使用全局默认（" + (hasGlobal ? "已配置" : "未配置") + "）";
    box.appendChild(el);
  }
}

// —— 会话级协议配置「测试连接」+ 保存门控 ——
// 语义：当前协议的配置草稿与已保存值有差异（= 有修改）时，必须先测试通过才能保存；
// 只改名称/协议选择等不涉及该协议配置修改的保存不受限。
// sdProtoTested = { proto, key }：测试通过的草稿指纹（协议 + 各字段 trim 后非空值）
let sdProtoTested = null;

function protoFieldValues() {
  const vals = {};
  for (const el of $("sd-proto-fields").querySelectorAll("[data-pf]")) vals[el.dataset.pf] = el.value;
  return vals;
}

function protoDraftKey(proto, vals) {
  const parts = [];
  for (const [field] of PROTO_FIELD_DEFS[proto] || []) {
    const v = typeof vals[field] === "string" ? vals[field].trim() : "";
    if (v) parts.push(field + "=" + v);
  }
  return parts.join("|");
}

function protoDraftDirty(s, proto) {
  if (!s) return false;
  const saved = (s.protocol_config && s.protocol_config[proto]) || {};
  return protoDraftKey(proto, protoFieldValues()) !== protoDraftKey(proto, saved);
}

function protoTested(proto) {
  return !!(sdProtoTested && sdProtoTested.proto === proto &&
    sdProtoTested.key === protoDraftKey(proto, protoFieldValues()));
}

function setProtoTestState(text, cls) {
  const el = $("sd-proto-test-state");
  el.textContent = text;
  el.className = "save-state proto-test-state" + (cls ? " " + cls : "");
}

function refreshProtoTestGate() {
  const s = curSession();
  const saveBtn = $("sd-save");
  if (!s || !saveBtn) return;
  const proto = $("sd-protocol").value;
  // 草稿含非空值（= 真正引入/修改覆盖）才需测试通过；全部清空（回退全局默认）无需测试
  const blocked = protoDraftDirty(s, proto) && protoDraftKey(proto, protoFieldValues()) !== "" && !protoTested(proto);
  saveBtn.disabled = blocked;
  saveBtn.title = blocked ? "协议配置有修改，请先通过「测试连接」再保存" : "";
  if (blocked) {
    const st = $("sd-proto-test-state");
    if (!st.classList.contains("ok") && !st.classList.contains("err")) {
      setProtoTestState("修改后需测试通过才能保存", "warn");
    }
  }
}

async function testSessionProto() {
  const s = curSession();
  if (!s) return;
  const proto = $("sd-protocol").value;
  const pf = protoFieldValues();
  const btn = $("sd-proto-test");
  btn.disabled = true;
  setProtoTestState("测试中…", "");
  try {
    const r = await api("POST", "/api/sessions/" + s.id + "/protocol-test",
      { protocol: proto, config: pf }, { asAdmin: true });
    if (r.status === 200 && r.data && typeof r.data.ok === "boolean") {
      if (r.data.ok) {
        setProtoTestState("连接正常", "ok");
        sdProtoTested = { proto, key: protoDraftKey(proto, pf) };
      } else {
        setProtoTestState(r.data.detail || "测试失败", "err");
        sdProtoTested = null;
      }
    } else {
      setProtoTestState("测试失败: " + ((r.data && r.data.detail) || ("HTTP " + r.status)), "err");
      sdProtoTested = null;
    }
  } catch (err) {
    setProtoTestState("测试失败: " + err.message, "err");
    sdProtoTested = null;
  }
  btn.disabled = false;
  refreshProtoTestGate();
}

// ---------- 提问 / 取消 ----------
// 统一的提问入口（输入框提交 / 卡片「重新生成」共用）
async function askQuestion(q) {
  const s = curSession();
  if (!s) { showToast("请先创建会话", 2500); return null; }
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
    const au = withAuth("POST", "/api/chat", null);
    const resp = await fetch(au.url, {
      method: "POST",
      headers: au.headers,
      body: JSON.stringify({ session_id: currentSid, question: q })
    });
    if (resp.status === 403) nudgeAuth(false);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      applyErrorStatus(st, data.detail || ("HTTP " + resp.status), null);
      st.stopBtn.classList.add("hidden");
      drop();
      refreshRegenButtons(currentSid);
      updateActiveCount();
    }
  } catch (err) {
    applyErrorStatus(st, "网络错误: " + err.message, null);
    st.stopBtn.classList.add("hidden");
    drop();
    refreshRegenButtons(currentSid);
    updateActiveCount();
  }
  return st;
}

async function sendQuestion() {
  const q = $("question").value.trim();
  if (!q) return;
  $("question").value = "";
  await askQuestion(q);
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
  $("sd-token").value = s.token || "";
  $("sd-snippet").value = asrSnippet(s);
  $("sd-snippet-body").value = asrBody(s);
  $("sd-save-state").textContent = "";
  $("sd-save-state").className = "save-state";
  // asr-tool 对接区块每次「打开抽屉」时收起（打开状态下跟随切换刷新时保留用户当前展开状态）
  if ($("session-drawer").classList.contains("hidden")) {
    $("sd-asr-extra").classList.add("hidden");
    $("sd-asr-toggle").setAttribute("aria-expanded", "false");
  }
  $("session-drawer").classList.remove("hidden");
  // 协议配置字段：值 = 本会话覆盖，占位符 = 全局是否已配置（全局配置加载完成后刷新一次）
  renderSessionProtoFields(s);
  sdProtoTested = null;
  setProtoTestState("", "");
  refreshProtoTestGate();
  loadGlobalCfg().then(() => {
    if (curSession() === s && !$("session-drawer").classList.contains("hidden")) {
      renderSessionProtoFields(s, $("sd-protocol").value);
    }
  }).catch(() => {});
  // 会话设置需要推送 token + 会话级协议配置：查看级视图剥离二者（防非管理端获取），
  // 用管理视图补取一次详情，保证抽屉内值始终最新
  api("GET", "/api/sessions/" + s.id, undefined, { asAdmin: true }).then((r) => {
    const fresh = r.status === 200 && r.data && r.data.session;
    if (fresh && curSession() === s && !$("session-drawer").classList.contains("hidden")) {
      s.token = fresh.token || s.token;
      s.protocol_config = fresh.protocol_config || {};
      sessions.set(s.id, s);
      $("sd-token").value = s.token || "";
      $("sd-snippet").value = asrSnippet(s);
      $("sd-snippet-body").value = asrBody(s);
      renderSessionProtoFields(s, $("sd-protocol").value);
      setProtoTestState("", "");
      refreshProtoTestGate();
    }
  }).catch(() => {});
}

async function saveSessionDrawer() {
  const s = curSession();
  if (!s) return;
  // 门控：当前协议的配置草稿有修改且未测试通过 → 拒绝保存
  const protoNow0 = $("sd-protocol").value;
  if (protoDraftDirty(s, protoNow0) && protoDraftKey(protoNow0, protoFieldValues()) !== "" && !protoTested(protoNow0)) {
    setProtoTestState("协议配置有修改，请先测试", "err");
    showToast("协议配置有修改，请先点「测试连接」并通过后再保存", 3000);
    return;
  }
  const state = $("sd-save-state");
  state.textContent = "保存中…";
  state.className = "save-state";
  try {
    // 会话级协议配置：只提交当前协议的字段（空值由服务端丢弃 = 回退全局默认）
    const protoNow = $("sd-protocol").value;
    const pf = {};
    for (const el of $("sd-proto-fields").querySelectorAll("[data-pf]")) pf[el.dataset.pf] = el.value;
    const r = await api("PUT", "/api/sessions/" + s.id, {
      name: $("sd-name").value,
      protocol: protoNow,
      continue_session: $("sd-continue").checked,
      protocol_config: { [protoNow]: pf }
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
      s.protocol_config = fresh.protocol_config || {};
      sdProtoTested = { proto: protoNow, key: protoDraftKey(protoNow, pf) };
      setProtoTestState("", "");
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
  if (!window.confirm("重置会话？将清空该会话的后端对话上下文（知识引擎/编排引擎），已显示的问答记录保留。")) return;
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
      btn.innerHTML = IC("i-check") + " 已复制";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = IC("i-copy") + " 复制";
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
// ---------- SSE 鉴权探测：EventSource 看不到 403 状态，出错后用一次
// 带鉴权的探测请求区分「token 已失效（过期/被撤销/服务端重启）」与「网络抖动」；
// 确认失效 → 清除本地 token、停掉无谓重连、弹出对应门禁要求重新输入 ----------
let authProbeAt = 0;
let authProbeBusy = false;
async function probeAuthOnSSEError() {
  const now = Date.now();
  if (authProbeBusy || now - authProbeAt < 5000) return;
  authProbeBusy = true;
  authProbeAt = now;
  try {
    let r;
    try {
      if (ADMIN_ROUTE) {
        const t = getAdminToken();
        r = await fetch("/api/config", { headers: t ? { "X-Admin-Token": t } : {} });
      } else {
        const t = viewerToken();
        r = await fetch("/api/sessions" + (t ? "?access=" + encodeURIComponent(t) : ""));
      }
    } catch {
      return; // 网络错误：不是鉴权问题，继续按 SSE 自动重连
    }
    if (ADMIN_ROUTE) {
      if (r.status === 401) {
        try { localStorage.removeItem("qa-mini-admin"); } catch {}
        if (es) { es.close(); es = null; }
        showAdminGate();
      }
    } else if (r.status === 403) {
      try { localStorage.removeItem("qa-mini-access"); } catch {}
      if (es) { es.close(); es = null; }
      showAccessGate();
    }
  } finally {
    authProbeBusy = false;
  }
}

function connectEvents() {
  if (es) { try { es.close(); } catch {} es = null; }
  const conn = $("conn-state");
  const t = viewerToken();
  // EventSource 无法自定义请求头 → 访问 token 走查询参数
  es = new EventSource("/api/events" + (t ? "?access=" + encodeURIComponent(t) : ""));
  es.addEventListener("open", () => {
    conn.textContent = "已连接";
    conn.className = "conn on";
  });
  es.addEventListener("error", () => {
    conn.textContent = "重连中…";
    conn.className = "conn off";
    probeAuthOnSSEError();
  });
  es.addEventListener("sessions", (e) => {
    const list = JSON.parse(e.data).sessions || [];
    // 广播统一剥离 token（防非管理端获取）；管理端保留本地已知值
    for (const s of list) {
      if (!s.token) {
        const prev = sessions.get(s.id);
        if (prev && prev.token) s.token = prev.token;
      }
    }
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
    refreshRegenButtons(d.session_id);
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
    finalizeCard(d.session_id, d.id, d.ok, d.detail, d.duration_s);
  });
  es.addEventListener("record_removed", (e) => {
    const d = JSON.parse(e.data);
    if (d.session_id !== currentSid) return;
    const st = cardsOf(d.session_id).get(d.id);
    if (st) {
      removeCardLocal(st);
    } else {
      cardsOf(d.session_id).delete(d.id);
    }
    if (currentSid && cardsOf(currentSid).size === 0) {
      emptyHint.classList.remove("hidden");
      updateActiveCount();
    }
    refreshRegenButtons(d.session_id);
  });
  es.addEventListener("session_reset", (e) => {
    const d = JSON.parse(e.data);
    if (d.session_id === currentSid) showToast("会话已重置（后端上下文已清空）");
  });
  es.addEventListener("config", () => {
    if (!$("settings").classList.contains("hidden")) fillSettingsForm(false);
  });
}

// ---------- 协议配置（全局） ----------
const CFG_FIELDS = [
  "protocols.openai.url", "protocols.openai.api_key", "protocols.openai.model",
  "protocols.dify.url", "protocols.dify.api_key", "protocols.dify.user",
  "protocols.generic.url", "protocols.generic.api_key", "protocols.generic.body",
  "protocols.ragflow.url", "protocols.ragflow.api_key", "protocols.ragflow.chat_id",
  "asr.url", "asr.api_key", "asr.model", "asr.language", "asr.timeout"
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

function setSettingsLoading(on) {
  const ov = $("settings-loading");
  if (ov) ov.classList.toggle("hidden", !on);
  const sb = $("btn-save-config");
  if (sb) sb.disabled = !!on;
}
async function fillSettingsForm(showLoading) {
  if (showLoading) setSettingsLoading(true);
  try {
    const h = {};
    const t = getAdminToken();
    if (t) h["X-Admin-Token"] = t;
    const resp = await fetch("/api/config", { headers: h });
    if (resp.status === 401) { nudgeAuth(true); throw new Error("管理登录已失效"); }
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const cfg = await resp.json();
    for (const key of CFG_FIELDS) {
      const el = cfgEl(key);
      if (!el) continue;
      const val = getNested(cfg, key);
      if (el.type === "checkbox") el.checked = !!val;
      else el.value = val == null ? "" : val;
    }
    const sec = cfg.security || {};
    $("cfg-sec-anonymous").checked = sec.allow_anonymous !== false;
    $("cfg-sec-adminpw").value = "";
    $("sec-pw-state").textContent = sec.admin_password
      ? "已设置。输入新密码后点「修改管理密码」即可更换。"
      : "未设置（管理接口暂不鉴权）。输入 4-64 位密码后点「修改管理密码」完成初始化。";
    $("btn-save-adminpw").textContent = sec.admin_password ? "修改管理密码" : "设置管理密码";
    renderCodeList(Array.isArray(sec.access_codes) ? sec.access_codes : []);
  } catch (err) {
    showToast("设置加载失败: " + err.message, 3000);
  } finally {
    if (showLoading) setSettingsLoading(false);
  }
}

// 访问码列表（设置 → 安全）：状态徽标 + 剩余时长 + 复制/延期/失效
function fmtRemaining(expiresAt) {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!(ms > 0)) return { label: "已过期", cls: "off" };
  const h = ms / 3600e3;
  const label = h < 1
    ? Math.max(1, Math.round(ms / 60e3)) + " 分钟"
    : h < 100 ? h.toFixed(1) + " 小时" : Math.round(h / 24) + " 天";
  return { label: "剩 " + label, cls: "on" };
}
function renderCodeList(codes) {
  const box = $("sec-codes");
  box.innerHTML = "";
  if (!codes.length) {
    box.innerHTML = '<div class="sec-empty">暂无访问码（在下方生成，可多个、各自时长）</div>';
    return;
  }
  for (const c of codes) {
    const row = document.createElement("div");
    row.className = "sec-code-item";
    const left = document.createElement("span");
    left.className = "sec-code";
    const rem = fmtRemaining(c.expires_at);
    left.innerHTML = "<b>" + escapeHtml(c.code) + "</b> "
      + '<span class="code-state ' + rem.cls + '">' + rem.label + "</span> "
      + "<small>至 " + escapeHtml(fmtTime(c.expires_at)) + "</small>";
    const acts = document.createElement("span");
    acts.className = "sec-code-acts";
    const mk = (txt, title, fn) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = txt;
      b.title = title;
      b.addEventListener("click", fn);
      acts.appendChild(b);
    };
    mk("⧉", "复制访问码", () => copyText(c.code, "访问码已复制"));
    if (rem.cls === "on") {
      mk("+8h", "在到期时间上延期 8 小时", async () => {
        const r = await api("POST", "/api/admin/access-codes/" + encodeURIComponent(c.code) + "/renew", { hours: 8 });
        if (r.status === 200) {
          showToast("已延期至 " + fmtTime(r.data.entry.expires_at));
          refreshCodeList();
        } else {
          showToast((r.data && r.data.detail) || "延期失败", 2500);
        }
      });
    }
    mk("失效", "立即失效（并吊销已发凭证）", async () => {
      if (!window.confirm("将访问码 " + c.code + " 立即失效？")) return;
      const r = await api("DELETE", "/api/admin/access-codes/" + encodeURIComponent(c.code));
      if (r.status === 200) {
        showToast("访问码已失效");
        refreshCodeList();
      } else {
        showToast((r.data && r.data.detail) || "失效失败", 2500);
      }
    });
    row.appendChild(left);
    row.appendChild(acts);
    box.appendChild(row);
  }
}
async function refreshCodeList() {
  try {
    const h = {};
    const t = getAdminToken();
    if (t) h["X-Admin-Token"] = t;
    const resp = await fetch("/api/config", { headers: h });
    if (!resp.ok) return;
    const cfg = await resp.json();
    const sec = cfg.security || {};
    renderCodeList(Array.isArray(sec.access_codes) ? sec.access_codes : []);
  } catch {}
}

// 安全面板：匿名开关即时生效（独立于「保存配置」）
async function applyAnonymousToggle() {
  const checked = $("cfg-sec-anonymous").checked;
  try {
    const h = { "Content-Type": "application/json" };
    const t = getAdminToken();
    if (t) h["X-Admin-Token"] = t;
    const resp = await fetch("/api/config", {
      method: "PUT", headers: h, body: JSON.stringify({ security: { allow_anonymous: checked } })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      showToast(checked ? "已开放匿名访问" : "已关闭匿名访问（打开应用需访问码）", 3000);
    } else {
      $("cfg-sec-anonymous").checked = !checked;
      showToast("切换失败: " + (data.detail || ("HTTP " + resp.status)), 3000);
    }
  } catch (err) {
    $("cfg-sec-anonymous").checked = !checked;
    showToast("切换失败: " + err.message, 3000);
  }
}

// 安全面板：管理密码独立修改（不经过「保存配置」）
async function saveAdminPassword() {
  const pw = $("cfg-sec-adminpw").value.trim();
  if (!pw) { showToast("请输入新管理密码", 2500); return; }
  if (pw.length < 4 || pw.length > 64) { showToast("管理密码需 4-64 位字符", 2500); return; }
  const btn = $("btn-save-adminpw");
  const wasSet = !/未设置/.test($("sec-pw-state").textContent);
  btn.disabled = true;
  try {
    const h = { "Content-Type": "application/json" };
    const t = getAdminToken();
    if (t) h["X-Admin-Token"] = t;
    const resp = await fetch("/api/config", {
      method: "PUT", headers: h, body: JSON.stringify({ security: { admin_password: pw } })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      $("cfg-sec-adminpw").value = "";
      $("sec-pw-state").textContent = "已设置。输入新密码后点「修改管理密码」即可更换。";
      btn.textContent = "修改管理密码";
      showToast(wasSet ? "管理密码已更新" : "管理密码已初始化", 3000);
    } else {
      showToast("修改失败: " + (data.detail || ("HTTP " + resp.status)), 3500);
    }
  } catch (err) {
    showToast("修改失败: " + err.message, 3000);
  } finally {
    btn.disabled = false;
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
    let val = el.type === "checkbox" ? el.checked : el.value;
    if (key === "asr.timeout") {
      const n = parseFloat(val);
      val = Number.isFinite(n) ? n : "";
    }
    setNested(patch, key, val);
  }
  try {
    const h = { "Content-Type": "application/json" };
    const t = getAdminToken();
    if (t) h["X-Admin-Token"] = t;
    const resp = await fetch("/api/config", {
      method: "PUT",
      headers: h,
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

// ---------- 初始化（门禁 → 主流程）----------
// ---------- 语音输入（麦克风 → WAV 16-bit PCM → POST /api/asr → 服务端转发识别 → 填入输入框） ----------
// 约束：getUserMedia / AudioWorklet 需安全上下文（https 或 127.0.0.1/localhost）；
// 经 http 地址访问时按钮禁用并在 title 说明。硬上限 60s 自动停止送识别（对齐 asr-tool
// max_segment_s），<0.4s 丢弃（min_segment_s）。识别结果填入输入框待确认，不自动发送。
const ASR_MAX_S = 60;
const ASR_MIN_S = 0.4;
const ASR_PARTIAL_S = 1.5; // 对齐 asr-tool partial_interval_s：中间识别周期（前缀重提）
const ASR_AUTOSEND_KEY = "qa-mini-asr-autosend"; // 识别定稿后是否立即发送（默认勾选 = 立即发送；取消勾选 = 确认后再发）
function asrAutosend() {
  try {
    const v = localStorage.getItem(ASR_AUTOSEND_KEY);
    return v === null ? true : v === "1"; // 无偏好记录时默认开
  } catch { return true; }
}
const AUDIO_SOURCE_KEY = "qa-mini-audio-source"; // 音频源：default | 输入设备 deviceId | tab（捕获标签页/窗口音频，Chrome）
function audioSource() {
  try { return localStorage.getItem(AUDIO_SOURCE_KEY) || "default"; } catch { return "default"; }
}
function tabCaptureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}
function rebuildAudioSourceOptions(devices) {
  const sel = $("audio-source");
  if (!sel) return;
  const cur = sel.value || audioSource();
  const opts = [{ v: "default", t: "默认麦克风" }];
  let n = 0;
  for (const d of devices || []) {
    n++;
    opts.push({ v: d.deviceId, t: d.label || ("麦克风 " + n) });
  }
  opts.push({ v: "tab", t: tabCaptureSupported() ? "捕获标签页/窗口音频" : "捕获标签页/窗口音频（需 Chrome）" });
  sel.innerHTML = "";
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o.v;
    el.textContent = o.t;
    if (o.v === "tab" && !tabCaptureSupported()) el.disabled = true;
    sel.appendChild(el);
  }
  if ([...sel.options].some((o) => o.value === cur && !o.disabled)) sel.value = cur;
  else { sel.value = sel.options[0].value; try { localStorage.setItem(AUDIO_SOURCE_KEY, sel.value); } catch {} }
}
async function populateAudioSources() {
  const sel = $("audio-source");
  if (!sel || !mic.secure) return;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId); } catch {} // 无权限时 deviceId 为空，跳过
  rebuildAudioSourceOptions(devs);
}
const mic = {
  recording: false, transcribing: false, starting: false, timer: null, t0: 0,
  partialTimer: null, partialSeq: 0, partialBusy: false,
  stream: null, ctx: null, node: null, srcNode: null, rate: 16000, chunks: [],
  secure: !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
};
function fmtMicTime(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return m + ":" + String(ss).padStart(2, "0");
}
function setMicUI() {
  const b = $("btn-mic");
  const label = $("btn-mic-label");
  const srcSel = $("audio-source");
  if (srcSel) srcSel.disabled = !mic.secure;
  b.classList.remove("recording", "busy");
  if (!mic.secure) {
    b.disabled = true;
    b.title = "麦克风需要 https 访问（当前为 http 地址或浏览器不支持）";
    label.textContent = "语音";
    return;
  }
  if (mic.transcribing) {
    b.disabled = true;
    b.title = "语音识别中…";
    b.classList.add("busy");
    label.textContent = "识别中…";
    return;
  }
  if (mic.recording) {
    b.disabled = false;
    b.title = "再点一次停止录音";
    b.classList.add("recording");
    return;
  }
  b.disabled = false;
  b.title = "语音输入：点击开始/停止录音，识别后填入输入框";
  label.textContent = "语音";
}
// 16-bit PCM 单声道 WAV 封装（44 字节 RIFF 头）
function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true);
  return new Uint8Array(buf);
}
function hideMicInterim() {
  const el = $("mic-interim");
  if (el) { el.textContent = ""; el.classList.add("hidden"); }
}
// 中间识别（对齐 asr-tool「段进行中」语义）：周期性把「段首→当前」音频前缀重提一次
// 中间识别，以 … 前缀刷新预览行；同一时刻至多 1 个在途（忙则跳过、不排队）；
// 中间结果不落盘、不入输入框；失败静默忽略（不 toast）。
async function partialTick() {
  if (!mic.recording || mic.transcribing || mic.partialBusy) return;
  const total = mic.chunks.reduce((n, c) => n + c.length, 0);
  if (total < 800) return; // 样本不足
  mic.partialBusy = true;
  const seq = ++mic.partialSeq;
  try {
    const data = new Int16Array(total);
    let off = 0;
    for (const c of mic.chunks) { data.set(c, off); off += c.length; }
    const wav = encodeWav(data, mic.rate);
    const au = withAuth("POST", "/api/asr", null, { "Content-Type": "audio/wav" });
    const resp = await fetch(au.url, { method: "POST", headers: au.headers, body: wav });
    const d = await resp.json().catch(() => ({}));
    // 序号守卫：仍在录音且为本段最新 partial 才展示（防旧响应回写）
    if (resp.ok && d.ok && d.text && mic.recording && seq === mic.partialSeq) {
      const el = $("mic-interim");
      el.textContent = "…" + d.text;
      el.classList.remove("hidden");
    }
  } catch { /* 中间识别失败静默忽略 */ }
  finally { mic.partialBusy = false; }
}
async function micStop() {
  if (!mic.recording) return;
  mic.recording = false;
  mic.starting = false;
  if (mic.timer) { clearInterval(mic.timer); mic.timer = null; }
  if (mic.partialTimer) { clearInterval(mic.partialTimer); mic.partialTimer = null; }
  mic.partialSeq++; // 使在途中间结果作废（展示有 seq 守卫，不等待其返回）
  const secs = (Date.now() - mic.t0) / 1000;
  try {
    if (mic.node) mic.node.disconnect();
    if (mic.srcNode) mic.srcNode.disconnect();
    if (mic.ctx) await mic.ctx.close();
  } catch {}
  if (mic.stream) { for (const t of mic.stream.getTracks()) t.stop(); }
  mic.stream = null; mic.ctx = null; mic.node = null; mic.srcNode = null;
  const total = mic.chunks.reduce((n, c) => n + c.length, 0);
  const chunks = mic.chunks;
  mic.chunks = [];
  if (secs < ASR_MIN_S || total < 800) {
    showToast("录音太短（<0.4 秒），未发送识别", 2500);
    hideMicInterim();
    setMicUI();
    return;
  }
  const data = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }
  const wav = encodeWav(data, mic.rate);
  mic.transcribing = true;
  setMicUI();
  try {
    // 查看级接口：关闭匿名访问时须带访问 token（?access=，与 /api/chat 一致）
    const au = withAuth("POST", "/api/asr", null, { "Content-Type": "audio/wav" });
    const resp = await fetch(au.url, {
      method: "POST",
      headers: au.headers,
      body: wav
    });
    const d = await resp.json().catch(() => ({}));
    if (resp.ok && d.ok) {
      const ta = $("question");
      if (d.text && asrAutosend()) {
        // 「识别后自动发送」：定稿立即发送（独立于输入框，框内已有文本保留）
        const keep = ta.value;
        await askQuestion(d.text);
        if (keep.trim()) { ta.value = keep; ta.focus(); }
        showToast("已识别 " + d.text.length + " 字，自动发送", 2500);
      } else {
        const prev = ta.value.replace(/\s+$/, "");
        ta.value = prev ? prev + " " + d.text : d.text;
        ta.focus();
        showToast(d.text ? ("已识别 " + d.text.length + " 字，请确认后发送") : (d.detail || "未识别到语音"), 3000);
      }
    } else {
      showToast("语音识别失败: " + (d.detail || ("HTTP " + resp.status)), 3500);
    }
  } catch (e) {
    showToast("语音识别失败: " + ((e && e.message) || e), 3500);
  } finally {
    mic.transcribing = false;
    hideMicInterim(); // 定稿完成（成功/失败）→ 清除中间预览
    setMicUI();
  }
}
async function micStart() {
  if (mic.recording || mic.transcribing || mic.starting) return;
  mic.starting = true;
  let stream;
  const src = audioSource(); // default | deviceId | tab
  const baseAudio = { channelCount: 1, sampleRate: 16000 };
  try {
    if (src === "tab") {
      // 捕获所选标签页/窗口播放的音频（Chrome；每次录音弹出共享对话框，需勾选「共享音频」）
      const ds = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: true, selfBrowserSurface: "include",
        preferCurrentTab: true, surfaceSwitching: "include"
      });
      for (const t of ds.getVideoTracks()) { try { t.stop(); } catch {} } // 只用音频轨
      if (!ds.getAudioTracks().length) {
        for (const t of ds.getTracks()) t.stop();
        mic.starting = false;
        showToast("未获取到音频：请在共享对话框勾选「共享音频」", 3500);
        return;
      }
      stream = ds;
    } else {
      // 指定输入设备（如立体声混音/虚拟声卡）时关闭 AEC/NS/AGC，避免处理程序音频
      const want = src === "default"
        ? Object.assign({}, baseAudio, { echoCancellation: true, noiseSuppression: true })
        : Object.assign({}, baseAudio, { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: src } });
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: want });
      } catch (e2) {
        if (src !== "default" && /(Overconstrained|NotFound)/i.test(String((e2 && e2.name) || e2))) {
          showToast("音频设备不可用，已改用默认麦克风", 3500);
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else throw e2;
      }
      populateAudioSources(); // 权限到手后补齐设备名称（异步，不阻塞）
    }
  } catch (e) {
    const name = String((e && e.name) || e);
    if (src === "tab" && /NotAllowedError/i.test(name)) {
      mic.starting = false;
      showToast("已取消共享，未开始录音", 2500);
      return;
    }
    const denied = /NotAllowedError|Permission|SecurityError/i.test(name);
    mic.secure = false; // 权限拒绝后保持禁用
    showToast(denied ? "麦克风权限被拒绝（浏览器设置 → 网站设置 → 麦克风）" : "无法访问音频: " + name, 3500);
    setMicUI();
    mic.starting = false;
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
  const workletCode = [
    "class MicCapture extends AudioWorkletProcessor {",
    "  process(inputs) {",
    "    const ch = inputs[0] && inputs[0][0];",
    "    if (ch) {",
    "      const i16 = new Int16Array(ch.length);",
    "      for (let i = 0; i < ch.length; i++) { const s = Math.max(-1, Math.min(1, ch[i])); i16[i] = s < 0 ? s * 32768 : s * 32767; }",
    "      this.port.postMessage(i16.buffer, [i16.buffer]);",
    "    }",
    "    return true;",
    "  }",
    "}",
    "registerProcessor('mic-capture', MicCapture);"
  ].join("\n");
  try {
    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
  } catch (e) {
    try { await ctx.close(); } catch {}
    for (const t of stream.getTracks()) t.stop();
    showToast("音频采集初始化失败: " + ((e && e.message) || e), 3500);
    mic.starting = false;
    return;
  }
  mic.stream = stream;
  mic.ctx = ctx;
  mic.rate = ctx.sampleRate || 16000;
  mic.chunks = [];
  mic.partialSeq = 0; mic.partialBusy = false; hideMicInterim();
  mic.srcNode = ctx.createMediaStreamSource(stream);
  mic.node = new AudioWorkletNode(ctx, "mic-capture");
  mic.node.port.onmessage = (ev) => { if (ev.data) mic.chunks.push(new Int16Array(ev.data)); };
  mic.srcNode.connect(mic.node);
  mic.node.connect(ctx.destination); // worklet 输出静音，连 destination 保证处理循环运行
  mic.recording = true;
  mic.t0 = Date.now();
  mic.timer = setInterval(() => {
    const s = (Date.now() - mic.t0) / 1000;
    if (s >= ASR_MAX_S) { // 硬上限：先自清理 interval 再送识别（防孤儿 interval 持续计数）
      clearInterval(mic.timer);
      mic.timer = null;
      micStop();
      return;
    }
    if (mic.recording) $("btn-mic-label").textContent = fmtMicTime(s);
  }, 500);
  mic.partialTimer = setInterval(partialTick, ASR_PARTIAL_S * 1000);
  $("btn-mic-label").textContent = fmtMicTime(0);
  mic.starting = false;
  setMicUI();
}
document.addEventListener("DOMContentLoaded", async () => {
  $("admin-gate-form").addEventListener("submit", onAdminGateSubmit);
  $("access-gate-form").addEventListener("submit", onAccessGateSubmit);
  $("btn-gen-code").addEventListener("click", genAccessCode);
  $("btn-clean-codes").addEventListener("click", async () => {
    const r = await api("DELETE", "/api/admin/access-codes/expired");
    if (r.status === 200) {
      showToast(r.data.removed > 0 ? "已清理 " + r.data.removed + " 个过期码" : "没有过期码");
      refreshCodeList();
    } else {
      showToast((r.data && r.data.detail) || "清理失败", 2500);
    }
  });
  if (await checkGates()) {
    unlockApp();
    bootApp();
  }
  // 需要门禁时保留 booting（首页隐藏），登录成功后再解锁
});

function onAdminGateSubmit(e) {
  e.preventDefault();
  api("POST", "/api/admin/login", { password: $("admin-pw").value }).then((r) => {
    if (r.status === 200 && r.data && r.data.ok) {
      setAuth("qa-mini-admin", r.data.token, r.data.expires_at);
      hideGates();
      unlockApp();
      updateAdminUI();
      showToast(r.data.initialized ? "管理密码已初始化" : "管理登录成功");
      bootApp();
    } else {
      $("admin-gate-err").textContent = (r.data && r.data.detail) || ("HTTP " + r.status);
    }
  }).catch(() => {
    $("admin-gate-err").textContent = "网络错误，请重试";
  });
}

function onAccessGateSubmit(e) {
  e.preventDefault();
  api("POST", "/api/access/login", { code: $("access-code").value.trim() }).then((r) => {
    if (r.status === 200 && r.data && r.data.ok) {
      if (!r.data.anonymous) setAuth("qa-mini-access", r.data.token, r.data.expires_at);
      hideGates();
      unlockApp();
      updateAdminUI();
      bootApp();
    } else {
      $("access-gate-err").textContent = (r.data && r.data.detail) || ("HTTP " + r.status);
    }
  }).catch(() => {
    $("access-gate-err").textContent = "网络错误，请重试";
  });
}

async function genAccessCode() {
  const custom = $("sec-code-custom").value.trim();
  const hours = parseFloat($("sec-code-hours").value);
  const count = parseInt($("sec-code-count").value, 10);
  const body = { code: custom || undefined, hours: isNaN(hours) ? undefined : hours };
  if (!custom && !isNaN(count) && count > 1) body.count = count; // 批量随机（自定义码固定 1 个）
  const r = await api("POST", "/api/admin/access-codes", body);
  const es = r.data && r.data.entries;
  if (r.status === 201 && Array.isArray(es) && es.length) {
    showToast(es.length > 1
      ? "已生成 " + es.length + " 个：" + es.map((x) => x.code).join("、") + "（各 " + (isNaN(hours) ? 8 : hours) + " 小时有效）"
      : "已生成 " + es[0].code + "（有效至 " + fmtTime(es[0].expires_at) + "）", 4500);
    $("sec-code-custom").value = "";
    $("sec-code-count").value = "1";
    refreshCodeList();
  } else {
    showToast((r.data && r.data.detail) || "生成失败", 3000);
  }
}

function bootApp() {
  connectEvents();
  // 管理端：SSE 广播不带 token，主动拉一次含 token 的会话列表（会话设置用）
  if (ADMIN_ROUTE && getAdminToken()) {
    api("GET", "/api/sessions", undefined, { asAdmin: true }).then((r) => {
      if (r.status === 200 && r.data && Array.isArray(r.data.sessions)) {
        for (const s of r.data.sessions) if (s.token) sessions.set(s.id, s);
        renderSessionList();
      }
    });
  }
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
  $("width-mode").addEventListener("change", () => {
  widthMode = $("width-mode").value;
  applyWidthMode();
  try { localStorage.setItem("qa-mini-width", widthMode); } catch {}
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
  $("line-mode").addEventListener("change", () => {
    lineState.mode = $("line-mode").value;
    applyLineMode();
  });
  $("line-val").addEventListener("change", () => {
    let v = parseFloat($("line-val").value);
    if (isNaN(v)) v = 1.65;
    v = Math.max(1, Math.min(2.5, Math.round(v * 100) / 100));
    lineState.val = v;
    lineState.mode = "custom";
    $("line-mode").value = "custom";
    applyLineMode();
  });
  $("btn-send").addEventListener("click", sendQuestion);
  $("btn-cancel").addEventListener("click", () => {
    const last = currentSid ? lastActive.get(currentSid) : null;
    if (last) cancelQa(last);
  });
  // 语音输入：点击开始/停止；http 非安全上下文时按钮已禁用（title 说明）
  $("btn-mic").addEventListener("click", () => {
    if (mic.transcribing) return;
    if (mic.recording) { micStop(); return; }
    if (!mic.secure) {
      showToast("麦克风需要 https 访问（当前为 http 地址，浏览器禁止录音）", 3500);
      return;
    }
    micStart();
  });
  // 语音输入：识别后是否自动发送（本地偏好，默认勾选 = 立即发送）
  const asrAuto = $("asr-autosend");
  asrAuto.checked = asrAutosend();
  asrAuto.addEventListener("change", () => {
    try { localStorage.setItem(ASR_AUTOSEND_KEY, asrAuto.checked ? "1" : "0"); } catch {}
  });
  // 语音输入：音频源选择（默认麦克风 / 指定输入设备 / 捕获标签页或窗口音频）
  const audioSel = $("audio-source");
  audioSel.value = audioSource();
  audioSel.addEventListener("change", () => {
    try { localStorage.setItem(AUDIO_SOURCE_KEY, audioSel.value); } catch {}
  });
  if (mic.secure) {
    populateAudioSources();
    try { navigator.mediaDevices.addEventListener("devicechange", populateAudioSources); } catch {}
  }
  setMicUI();
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
  $("sd-proto-test").addEventListener("click", testSessionProto);
  // 协议配置任一字段输入 → 既有测试指纹失效（需重新测试）
  $("sd-proto-fields").addEventListener("input", () => {
    sdProtoTested = null;
    if ($("sd-proto-test-state").classList.contains("ok")) setProtoTestState("", "");
    refreshProtoTestGate();
  });
  $("sd-regen-token").addEventListener("click", regenToken);
  $("sd-copy-sid").addEventListener("click", () => copyText($("sd-session-id").value, "会话 ID 已复制"));
  $("sd-copy-token").addEventListener("click", () => copyText($("sd-token").value, "token 已复制"));
  $("sd-copy-snippet").addEventListener("click", () => copyText($("sd-snippet").value, "asr-tool 配置片段已复制"));
  $("sd-copy-body").addEventListener("click", () => copyText($("sd-snippet-body").value, "body 值已复制"));
  $("sd-reset").addEventListener("click", resetCurrentSession);
  // asr-tool 对接区块：默认收起，点击展开/折叠（会话设置表单对非 asr-tool 用户只保留 名称/协议/续接）
  $("sd-asr-toggle").addEventListener("click", () => {
    const nowHidden = $("sd-asr-extra").classList.toggle("hidden");
    $("sd-asr-toggle").setAttribute("aria-expanded", String(!nowHidden));
  });
  // 切换协议立即刷新协议配置字段（未保存前只改渲染，不落库）；旧协议的测试结果作废
  $("sd-protocol").addEventListener("change", () => {
    const s = curSession();
    if (!s) return;
    sdProtoTested = null;
    renderSessionProtoFields(s, $("sd-protocol").value);
    setProtoTestState("", "");
    refreshProtoTestGate();
  });
  $("sd-delete").addEventListener("click", deleteCurrentSession);
  $("btn-settings").addEventListener("click", async () => {
    $("settings").classList.remove("hidden");
    fillSettingsForm(true);
  });
  $("btn-close-settings").addEventListener("click", () => $("settings").classList.add("hidden"));
  // 点击抽屉外部自动收起（点击来自打开按钮的不处理，避免与打开动作冲突；
  // 会话列表项点击视为相关区域：会话设置抽屉跟随刷新内容而非收起，见 switchSession）
  for (const [drawerSel, openerSel] of [["#settings", "#btn-settings"], ["#session-drawer", "#btn-session"]]) {
    document.addEventListener("click", (e) => {
      const dr = document.querySelector(drawerSel);
      if (!dr || dr.classList.contains("hidden")) return;
      if (dr.contains(e.target)) return;
      if (e.target instanceof Element && openerSel && e.target.closest(openerSel)) return;
      if (drawerSel === "#session-drawer" && e.target instanceof Element && e.target.closest(".session-item")) return;
      dr.classList.add("hidden");
    });
  }
  $("btn-save-config").addEventListener("click", saveSettings);
  // 语音输入「测试连接」：用表单当前草稿值探测（未填字段回退已存配置）
  $("btn-asr-test").addEventListener("click", async () => {
    const btn = $("btn-asr-test");
    const state = $("asr-test-state");
    btn.disabled = true;
    state.className = "save-state";
    state.textContent = "测试中…";
    const draft = {
      url: $("cfg-asr-url").value,
      api_key: $("cfg-asr-api_key").value,
      model: $("cfg-asr-model").value,
      language: $("cfg-asr-language").value,
      timeout: $("cfg-asr-timeout").value
    };
    try {
      const h = { "Content-Type": "application/json" };
      const t = getAdminToken();
      if (t) h["X-Admin-Token"] = t;
      const resp = await fetch("/api/asr/test", { method: "POST", headers: h, body: JSON.stringify({ asr: draft }) });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) {
        state.className = "save-state ok";
        state.textContent = data.detail || "已连接";
      } else {
        state.className = "save-state err";
        state.textContent = data.detail || ("HTTP " + resp.status);
      }
    } catch (err) {
      state.className = "save-state err";
      state.textContent = "测试失败: " + ((err && err.message) || err);
    } finally {
      btn.disabled = false;
    }
  });
  $("cfg-sec-anonymous").addEventListener("change", applyAnonymousToggle);
  $("btn-save-adminpw").addEventListener("click", saveAdminPassword);
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

  // 滚动跟随：用户滚动时刷新「↓ 最新」浮钮；点击平滑回底
  chatEl.addEventListener("scroll", () => updateToLatestBtn(), { passive: true });
  if (btnToLatest) btnToLatest.addEventListener("click", () => scrollToBottom(true));

  // PWA：注册 service worker（离线外壳；/api 与 SSE 在 sw.js 中直通网络不缓存）
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
}
