
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import { LOGO_SVG } from "../utils/brandLogo";
import { useAuthStore } from "../stores/auth";
import { useSessionsStore, RecordView, SessionView } from "../stores/sessions";
import { useSse } from "../composables/useSse";
import { useTheme } from "../composables/useTheme";
import { Menu, Sunny, Moon, Plus, Close, MoreFilled, Headset, SetUp, Setting, Microphone, CopyDocument, RefreshRight, Delete, VideoPause, Check, ChatDotRound, Fold, Expand, Share, Lock, ArrowDown, ArrowRight, User, SwitchButton } from "@element-plus/icons-vue";
import { useMic } from "../composables/useMic";
import { renderMarkdown } from "../utils/markdown";
import AudioPanel from "../components/AudioPanel.vue";
import SessionSettings from "../components/SessionSettings.vue";
import ProfileDialog from "../components/ProfileDialog.vue";

// 工作区（P5）：某智能体下「我的会话」列表 + 流式问答（SSE 按主体作用域投递）
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const sess = useSessionsStore();

// P8.52：顶栏品牌位（左上角 Logo）点击 = 刷新本页（替代原跳首屏 router-link）
function reloadPage() { window.location.reload(); }

const agentCode = computed(() => String(route.params.code || ""));
// 过滤用智能体 id（服务端会话归属键）：id ≠ code（播种/新建均为随机 id），
// 必须取 /api/agents/:code 返回的 agent.id，不能用路由 code 直接比对（P7.7 修复：
// 此前用 code 比对 sessions.agent_id(id) 导致侧栏恒空 + 每次进页面自动补建会话）
const agentId = ref<string | null>(null);
const agentName = ref("…");
const agentProto = ref("");
const agentErr = ref("");
const agentNeedLogin = ref(false); // P8.9：未登录遇到入口门控 → 显示「去登录」
const listLoading = ref(true);

// P7.2 布局对齐旧版：左固定会话栏（252px）+ 主列（header / main / footer）；
// 内容列宽沿用 --qa-maxw（窄 860 / 宽 1180 / 铺满，「⚙ 显示」记忆于 localStorage）
const PROTO_NAMES: Record<string, string> = { openai: "OpenAI 兼容", dify: "编排引擎", generic: "第三方通用", ragflow: "知识引擎" };
// P8.47：会话列表桶标记——共享（所有人可见）/ 我的（私有，仅自己+管理）/ 访问码（码桶）
  // P8.47：会话列表桶标记——共享（所有人可见）/ 我的（私有，仅自己+管理）/ 访问码（码桶）
function bucketKey(s: SessionView): string {
  const m = s.access_mode || "shared";
  if (m === "user") return "mine";
  if (m === "code" || m === "access_code") return "code";
  return "shared";
}
function bucketLabel(s: SessionView): string {
  const m = s.access_mode || "shared";
  if (m === "user") return s.owner_name ? "私有·" + s.owner_name : "我的";
  if (m === "code" || m === "access_code") return "访问码";
  return "共享";
}
function bucketTip(s: SessionView): string {
  const m = s.access_mode || "shared";
  if (m === "shared") return "共享会话：所有人（含匿名访客）可见";
  if (m === "user") return s.owner_name ? "私有会话：仅属主 " + s.owner_name + " 与管理员可见" : "私有会话：仅你与管理员可见";
  return "访问码会话：仅该访问码持有者与管理员可见";
}

const sideCollapsed = ref(false); // 桌面：☰ 收起会话栏（旧版 .app.collapsed 语义）
const sideOpen = ref(false);      // 窄屏 ≤720px：会话栏左滑出抽屉
function toggleSide() {
  if (window.matchMedia("(max-width: 720px)").matches) sideOpen.value = !sideOpen.value;
  else sideCollapsed.value = !sideCollapsed.value;
}
function closeMobileSide() { sideOpen.value = false; }
const runningCount = computed(() => cards.value.filter((c) => c.status === "running").length);
const connText = computed(() => (sse.status.value === "open" ? "已连接" : sse.status.value === "error" ? "未连接" : "连接中…"));
const connCls = computed(() => (sse.status.value === "open" ? "conn-on" : sse.status.value === "error" ? "conn-off" : "conn-cx"));
const composerProto = computed(() => {
  const s = currentSession.value;
  if (!s) return "无会话";
const proto = PROTO_NAMES[s.protocol] || s.protocol || "";
  return (proto ? proto + " · " : "") + (s.name || "未命名会话");
});
// P8.54：空会话「查看更多」折叠态（切会话时收起）
const emptyMore = ref(false);
watch(() => sess.currentSid, () => { emptyMore.value = false; });
// 主题（对齐旧版键 echoanswer-theme；useTheme 共享：工作区 / 控制台顶栏 ☀️/🌙）
const { lightTheme, toggleTheme } = useTheme();

interface Card extends RecordView { html: string; live: string; }
const cards = ref<Card[]>([]);      // 展示序：旧→新（历史反转 + 在途追加）
const input = ref("");
const sending = ref(false);
const chatEl = ref<HTMLElement | null>(null);

// ---- P5.5 语音输入（麦克风 → /api/asr，查看级）----
const mic = useMic({
  onFinal: (text, detail) => onVoiceFinal(text, detail),
  onToast: (m) => ElMessage.warning(m)
});
const micTitle = computed(() => (showAudio.value
  ? "音频模式进行中（语音/音频只能二选一）：点「音频」关闭后可用"
  : mic.title()));
function saveAutosend() {
  try { localStorage.setItem("echoanswer-asr-autosend", mic.st.value.autosend ? "1" : "0"); } catch { /* 忽略 */ }
}

// ---- P5.5 电脑输出音频（EchoScribe 持续推流；管理视图 token 级）----
const currentSession = computed(() => (sess.detail && sess.detail.session) || null);
// P7.10 对齐旧版：提问框「音频」入口常显，前置条件不满足时点击提示（不再整钮隐藏）
const audioListening = ref(false);
// ---------- 显示偏好（P7 移植自旧前端；localStorage 键沿用 echoanswer-font/-width/-line） ----------
const FONT_SIZES: Record<string, number> = { default: 15, large: 18 };
const fontState = reactive<{ mode: string; px: number }>({
  mode: "default",
  px: 15
});
const widthMode = ref("narrow");
const lineState = reactive<{ mode: string; val: number }>({
  mode: "default",
  val: 1.65
});
function applyPrefs() {
  const root = document.documentElement;
  const size = fontState.mode === "custom" ? Math.min(36, Math.max(12, Math.round(fontState.px || 15))) : (FONT_SIZES[fontState.mode] || 15);
  root.style.setProperty("--qa-size", size + "px");
  root.classList.remove("qa-w-narrow", "qa-w-wide", "qa-w-full");
  root.classList.add("qa-w-" + widthMode.value);
  if (lineState.mode === "custom") root.style.setProperty("--qa-line", String(Math.min(2.5, Math.max(1, lineState.val || 1.65))));
  else if (lineState.mode === "narrow") root.style.setProperty("--qa-line", "1.35");
  else root.style.removeProperty("--qa-line");
  try {
    localStorage.setItem("echoanswer-font", JSON.stringify(fontState));
    localStorage.setItem("echoanswer-width", widthMode.value);
    localStorage.setItem("echoanswer-line", JSON.stringify(lineState));
  } catch {}
}
(function loadPrefs() {
  try {
    const raw = localStorage.getItem("echoanswer-font");
    if (raw) {
      const f = JSON.parse(raw);
      if (f && ["default", "large", "custom"].includes(f.mode)) { fontState.mode = f.mode; if (typeof f.px === "number") fontState.px = f.px; }
    }
    const rw = localStorage.getItem("echoanswer-width");
    if (rw && ["narrow", "wide", "full"].includes(rw)) widthMode.value = rw;
    const rl = localStorage.getItem("echoanswer-line");
    if (rl) {
      const l = JSON.parse(rl);
      if (l && ["default", "narrow", "custom"].includes(l.mode)) { lineState.mode = l.mode; if (typeof l.val === "number") lineState.val = l.val; }
    }
  } catch {}
  applyPrefs();
})();
const showAudio = ref(false);
const audioPanel = ref<InstanceType<typeof AudioPanel> | null>(null);
// 正在推流的会话（SSE audio_stream 事件维护：sid -> { n: 设备数, at: 最近事件 ms }）
// reactive Map：侧栏 🎧 徽章随事件更新（对齐旧版音频流会话徽标）
const audioStreamSessions = reactive(new Map<string, { n: number; at: number }>());
function audioN(sid: string): number {
  return (audioStreamSessions.get(sid) || { n: 0 }).n;
}
function fmtDevName(d: any): string {
  d = String(d == null ? "" : d);
  return d;
}
// P7.10 对齐旧版 onRmtAudioToggle：常显入口 + 前置条件 toast
async function openAudioPanel() {
  if (showAudio.value) { showAudio.value = false; return; }
  if (mic.st.value.recording || mic.st.value.transcribing) {
    ElMessage.warning("语音/音频只能二选一：请先停止语音录音");
    return;
  }
  const s = currentSession.value;
  if (!s || !s.token) {
    ElMessage.warning("查看模式：音频识别不可用（需 EchoScribe 对接）");
    return;
  }
  if (!s.audio_remote || s.audio_remote.enabled !== true) {
    ElMessage.warning("本会话未启用「电脑输出音频接收」（会话设置 → 启用）");
    return;
  }
  showAudio.value = true;
  await nextTick();
  const streams = await audioPanel.value?.refreshDevices();
  if (streams && streams.length === 0) {
    ElMessage.info("无正在接收的设备（请先在 EchoScribe 点「开始推流」）");
  }
}
// P7.10 语音/音频互斥（对齐旧版）：音频面板打开时禁止开始录音
function onMicClick() {
  if (showAudio.value) {
    ElMessage.warning("音频模式进行中：语音/音频只能二选一（先点「音频」关闭）");
    return;
  }
  mic.toggle();
}

// ---- P5.5 会话设置对话框 ----
const settingsOpen = ref(false);
function onSessCommand(cmd: string, s: any) {
  if (cmd === "settings") { openSettings(); return; }
  if (cmd === "rename") { renameSession(s.id, s.name); return; }
  deleteSession(s.id, s.name || s.id);
}
function openSettings() {
  if (!sess.detail) return;
  settingsOpen.value = true;
}
// 对话框内「删除会话」（P7.9，对齐旧抽屉底部危险操作）：关框 + 走侧栏同款删除流程
function onSettingsDelete() {
  const s = currentSession.value;
  settingsOpen.value = false;
  if (s) deleteSession(s.id, s.name || s.id);
}
async function onSettingsSaved() {
  settingsOpen.value = false;
  if (sess.currentSid) { await sess.open(sess.currentSid); rebuildCards(); }
}

const agentSessions = computed(() => (agentId.value ? sess.agentSessions(agentId.value) : []));
// SSE 连接状态徽标（sse 在下方顶层声明：useSse 注册组件生命周期）
const sseDot = computed(() => ({
  "dot-open": sse.status.value === "open",
  "dot-err": sse.status.value === "error",
  "dot-cx": sse.status.value === "connecting"
}));

let raf = 0;
function scheduleRender(card: Card) {
  card.live = card.live; // no-op keep
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    for (const c of cards.value) {
      if (c.answer !== c.live) {
        c.answer = c.live;
        c.html = renderMarkdown(c.answer) + (c.status === "running" ? "<span class=\"md-cursor\"></span>" : "");
      }
    }
    scrollBottom(false); // P8.12 对齐旧版：流式输出中贴近底部时自动跟随（不打断上滑阅读）
  });
}
const showToLatest = ref(false); // P8.12：上滑阅读时显示「↓ 最新」浮钮（对齐旧版）
function isNearBottom(): boolean {
  const el = chatEl.value;
  return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}
function onChatScroll() {
  showToLatest.value = cards.value.length > 0 && !isNearBottom();
}

function rebuildCards() {
  const hist = [...(sess.detail?.history || [])].reverse(); // API 新→旧 → 旧→新
  cards.value = hist.map((r) => ({ ...r, html: renderMarkdown(r.answer || ""), live: r.answer || "" }));
  nextTick(() => scrollBottom(true));
}

function scrollBottom(force = false) {
  const el = chatEl.value;
  if (!el) return;
  // P8.12 对齐旧版：force（切会话/新提问/浮钮）平滑；流式跟随时 instant
  if (force || isNearBottom()) el.scrollTo({ top: el.scrollHeight, behavior: force ? "smooth" : "instant" });
  showToLatest.value = cards.value.length > 0 && !isNearBottom();
}

function runningCard(qaId: string): Card | undefined {
  return cards.value.find((c) => c.id === qaId && c.status === "running");
}

function onQaStart(d: any) {
  if (String(d.session_id) !== sess.currentSid) return;
  cards.value.push({
    id: d.id, source: d.source || "web", question: d.question, answer: "", live: "",
    protocol: "", protocol_name: d.protocol_name || "", status: "running",
    ok: false, detail: "", started_at: new Date().toISOString(), finished_at: null,
    duration_s: null, html: ""
  });
  nextTick(() => scrollBottom(true));
}
function onDelta(d: any) {
  if (String(d.session_id) !== sess.currentSid) return;
  const c = runningCard(d.id);
  if (c) { c.live += d.text; scheduleRender(c); }
}
async function onDone(d: any) {
  if (String(d.session_id) !== sess.currentSid) return;
  await sess.open(sess.currentSid); // 服务端为准：history 已含该条
  rebuildCards();
}
async function onListEvent(d: any) {
  sess.applySseList(d.sessions || []);
}

// 定稿（语音 / 音频共用）：「识别后自动发送」= 立即发送（输入框原文保留）；否则填入输入框待确认
async function onVoiceFinal(text: string, detail: string) {
  if (text && mic.st.value.autosend) {
    const keep = input.value;
    await sendQuestionOnly(text);
    if (keep.trim()) input.value = keep;
    ElMessage.success("已识别 " + text.length + " 字，自动发送");
  } else if (text) {
    const prev = input.value.replace(/\s+$/, "");
    input.value = prev ? prev + " " + text : text;
    ElMessage.success("已识别 " + text.length + " 字，请确认后发送");
  } else {
    ElMessage.info(detail || "未识别到语音");
  }
}
function onAudioStreamEvent(d: any) {
  if (!d || !d.session_id) return;
  const now = Date.now();
  const sid = String(d.session_id);
  if (d.state === "started") {
    const v = audioStreamSessions.get(sid) || { n: 0, at: now };
    v.n += 1; v.at = now;
    audioStreamSessions.set(sid, v);
    if (sid === sess.currentSid) ElMessage.info("设备开始推流: " + fmtDevName(d.device));
  } else if (d.state === "data") {
    const v = audioStreamSessions.get(sid) || { n: 0, at: now };
    if (v.n < 1) v.n = 1;
    v.at = now;
    audioStreamSessions.set(sid, v);
  } else if (d.state === "stopped") {
    const v = audioStreamSessions.get(sid);
    if (v) {
      v.n -= 1; v.at = now;
      if (v.n <= 0) audioStreamSessions.delete(sid);
      else audioStreamSessions.set(sid, v);
    }
    if (sid === sess.currentSid) ElMessage.info("设备停止推流: " + fmtDevName(d.device));
  }
  // 音频面板开着（当前会话）→ 设备增删时刷新下拉
  if (showAudio.value && sid === sess.currentSid) audioPanel.value && audioPanel.value.refreshDevices();
}
function onAudioListenEvent(d: any) {
  if (!d || String(d.session_id) !== sess.currentSid) return;
  const p = audioPanel.value;
  if (!p || !showAudio.value) return;
  const cur = p.currentDevice ? p.currentDevice() : "";
  if (d.device && d.device !== cur) return; // 只处理本面板所选设备
  p.handleListenEvent(d);
}

// 顶层 SSE 订阅（setup 执行时注册生命周期；仅本主体可见会话的事件会送达）
const sse = useSse({
  sessions: onListEvent,
  qa_start: onQaStart,
  delta: onDelta,
  done: onDone,
  record_removed: (d: any) => { if (String(d.session_id) === sess.currentSid) { sess.open(sess.currentSid).then(rebuildCards); } },
  session_reset: (d: any) => { if (String(d.session_id) === sess.currentSid) { sess.open(sess.currentSid).then(rebuildCards); } },
  audio_stream: onAudioStreamEvent,
  audio_listen: onAudioListenEvent
});

// 切会话：收起音频面板（面板内部 watch 会取消在途识别并清空状态）
watch(() => sess.currentSid, () => { showAudio.value = false; });

function goLogin() {
  router.push({ path: "/login", query: { next: route.fullPath } });
}

// P8.37：一键分享 = 复制当前智能体链接（分享出去后他人直接打开；无权限时自动先进登录页再回跳）
const shared = ref(false);
let sharedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyToClipboard(t: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch { /* 回退下方 execCommand */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}
async function shareAgent() {
  // 只复制智能体根链接（不带 ?sid：会话按主体桶隔离，他人无此会话，带上反而误导）
  const url = location.origin + "/agents/" + encodeURIComponent(agentCode.value);
  const ok = await copyToClipboard(url);
  shared.value = ok;
  ElMessage[ok ? "success" : "error"](ok ? "链接已复制，发送给他人即可打开" : "复制失败，请手动复制地址栏链接");
  if (sharedTimer) clearTimeout(sharedTimer);
  sharedTimer = setTimeout(() => { shared.value = false; }, 2000);
}

async function loadAgent() {
  listLoading.value = true;
  const { ok, data } = await api<{ ok: boolean; agent?: { id: string; name: string; protocol: string }; detail?: string }>(
    "/api/agents/" + encodeURIComponent(agentCode.value)
  );
  if (!ok) {
    listLoading.value = false;
    // P8.9：入口门控 404（智能体不存在/停用 或 当前主体未被放行，不泄露存在性）
    if (!auth.isAuthed) {
      // P8.37：匿名直访智能体链接 → 自动跳登录页（?next 记忆本页，登录成功回跳，替代原红色提示页）
      router.replace({ path: "/login", query: { next: route.fullPath } });
      return;
    }
    agentNeedLogin.value = false;
    agentErr.value = "该智能体不存在 / 已停用，或当前账号未被放行（可在 控制台·智能体管理·安全 中调整访问控制）";
    return;
  }
  agentId.value = data.agent?.id || null;
  agentName.value = data.agent?.name || agentCode.value;
  agentProto.value = data.agent?.protocol || "";
}

async function initSessions() {
  listLoading.value = true;
  await sess.loadList();
  listLoading.value = false;
  const mine = agentSessions.value;
  const qSid = typeof route.query.sid === "string" ? route.query.sid : "";
  const target = (qSid && mine.find((v) => v.id === qSid)) || mine[0];
  if (target) await openSession(target.id);
  else if (auth.isAuthed) await createSession();
}

async function openSession(sid: string) {
  const ok = await sess.open(sid);
  if (ok) {
    closeMobileSide();
    rebuildCards();
    const url = "/agents/" + encodeURIComponent(agentCode.value) + "?sid=" + sid;
    router.replace(url);
  }
}

async function createSession() {
  try {
    const { value } = await ElMessageBox.prompt("新会话名称（可留空）", "新建会话", {
      confirmButtonText: "创建", cancelButtonText: "取消", inputValidator: () => true
    });
    const r = await sess.create(agentCode.value, value || "");
    if (r.ok) ElMessage.success("会话已创建");
    else ElMessage.error(r.detail || "创建失败");
  } catch { /* 取消 */ }
}

async function renameSession(sid: string, cur: string) {
  try {
    const { value } = await ElMessageBox.prompt("会话名称", "重命名", { inputValue: cur, confirmButtonText: "保存", cancelButtonText: "取消" });
    const r = await sess.rename(sid, value || "会话");
    if (!r.ok) ElMessage.error("重命名失败");
  } catch { /* 取消 */ }
}

async function deleteSession(sid: string, name: string) {
  try {
    await ElMessageBox.confirm("删除会话「" + name + "」？历史一并删除，不可恢复。", "删除会话", {
      confirmButtonText: "删除", cancelButtonText: "取消", type: "warning"
    });
  } catch { return; }
  const r = await sess.remove(sid);
  if (r.ok) {
    ElMessage.success("已删除");
    const rest = agentSessions.value[0];
    if (rest) await openSession(rest.id);
    else { cards.value = []; router.replace("/agents/" + encodeURIComponent(agentCode.value)); }
  } else ElMessage.error("删除失败");
}

async function send() {
  const q = input.value.trim();
  const sid = sess.currentSid;
  if (!q || !sid || sending.value) return;
  if (!auth.isAuthed) { ElMessage.warning("请先登录或输入访问码"); router.push("/login"); return; }
  sending.value = true;
  input.value = "";
  try {
    const r = await sess.ask(sid, q);
    if (!r.ok) {
      ElMessage.error(r.data.detail || "提问失败");
      input.value = q;
    }
  } finally {
    sending.value = false;
  }
}

async function cancelQa(qaId: string) {
  const r = await sess.cancel(qaId);
  if (!r.ok) ElMessage.warning(r.data.detail || "取消失败");
}
// P8.12 对齐旧版：输入框底部「停止」（仅当前会话有在途问题时可用）
const currentRunningId = computed(() => cards.value.find((c) => c.status === "running")?.id || "");
async function stopCurrent() {
  if (currentRunningId.value) await cancelQa(currentRunningId.value);
}
// P8.12 对齐旧版：生成中实时计时「生成中… Xs」（最终时长以服务端 duration_s 为准）
const nowTick = ref(Date.now());
let tickTimer: number | null = null;
watch(runningCount, (n) => {
  if (n > 0 && tickTimer == null) tickTimer = window.setInterval(() => (nowTick.value = Date.now()), 250);
  if (n === 0 && tickTimer != null) { clearInterval(tickTimer); tickTimer = null; }
});
function runElapsed(c: Card): string {
  const s = (nowTick.value - new Date(c.started_at).getTime()) / 1000;
  if (!(s >= 0)) return "0.0";
  return s < 10 ? s.toFixed(1) : String(Math.round(s));
}

async function deleteCard(rec: RecordView) {
  try {
    await ElMessageBox.confirm("删除这条问答记录？（各端同步删除，不可恢复）", "删除记录", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" });
  } catch { return; }
  const r = await sess.removeRecord(sess.currentSid!, rec.id);
  if (r.ok) ElMessage.success("已删除");
  else ElMessage.error("删除失败");
}

async function regen(rec: RecordView) {
  // 与旧版一致：删该条记录 + 用同一问题重发（先确认）
  try {
    await ElMessageBox.confirm("重新生成回答？\n将删除这条记录，并按相同上下文重新提问。", "重新生成", { confirmButtonText: "重新生成", cancelButtonText: "取消", type: "warning" });
  } catch { return; }
  const r = await sess.removeRecord(sess.currentSid!, rec.id);
  if (!r.ok) { ElMessage.error("重新生成失败"); return; }
  await sendQuestionOnly(rec.question);
}

async function sendQuestionOnly(q: string) {
  const sid = sess.currentSid;
  if (!sid) return;
  sending.value = true;
  try { const r = await sess.ask(sid, q); if (!r.ok) ElMessage.error(r.data.detail || "提问失败"); }
  finally { sending.value = false; }
}

function canRegen(c: Card): boolean {
  // P8.12 对齐旧版：仅最新一条非生成中的记录可重新生成（含错误卡；
  // 更早的记录重提问会带上其后新增的上下文，故不提供）
  const last = cards.value[cards.value.length - 1];
  return !!last && last.id === c.id && last.status === "done";
}

const copiedKey = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function markCopied(key: string) {
  copiedKey.value = key;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copiedKey.value = ""), 1400);
}
function copyText(t: string, key?: string) {
  // P8.12 对齐旧版：无内容提示 + 非安全上下文（http 局域网 IP）execCommand 降级
  if (!t) { ElMessage.info("暂无可复制内容"); return; }
  const done = () => { if (key) markCopied(key); ElMessage.success("已复制"); }
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch { ElMessage.error("复制失败"); }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fallback);
  else fallback();
}
function copyQ(c: Card) { copyText(c.question, c.id + ":q"); }
function copyA(c: Card) { copyText(c.answer, c.id + ":a"); }

function fmtTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
// P8.14 对齐旧版：卡片元信息时间 = HH:MM:SS（会话列表仍用 MM-DD HH:MM）
function fmtCardTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
// P8.14 对齐旧版：来源徽章（网页 / 语音推送 / 电脑音频）
function srcCls(source: string): string {
  return source === "push" ? "b-push" : source === "remote_audio" ? "b-remote" : "b-web";
}
function srcName(source: string): string {
  return source === "push" ? "语音推送" : source === "remote_audio" ? "电脑音频" : "网页";
}

// ---------- P8.4 顶栏用户名下拉（与首页一致交互） ----------
const SEND_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>';
const CARET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const userMenuOpen = ref(false);
const profileOpen = ref(false); // P8.55 个人设置对话框
const userWrap = ref<HTMLElement | null>(null);
function onUserDocClick(e: MouseEvent) {
  if (userMenuOpen.value && userWrap.value && !userWrap.value.contains(e.target as Node)) userMenuOpen.value = false;
}
async function onLogout() {
  userMenuOpen.value = false;
  await auth.logout();
  ElMessage.success("已退出登录");
  // P8.34：登出 → 登录页，并记忆当前页（再次登录回跳原页，Login ?next 机制）
  router.push("/login?next=" + encodeURIComponent(route.fullPath));
}

onMounted(async () => {
  await auth.me(); // P8.37：主体确认后再做入口门控判断（匿名自动跳登录依赖准确身份）
  await loadAgent();
  if (!agentErr.value) await initSessions();
  document.addEventListener("click", onUserDocClick);
  chatEl.value?.addEventListener("scroll", onChatScroll, { passive: true });
});
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  if (tickTimer != null) { clearInterval(tickTimer); tickTimer = null; }
  if (copiedTimer) clearTimeout(copiedTimer);
  if (sharedTimer) clearTimeout(sharedTimer);
  document.removeEventListener("click", onUserDocClick);
  chatEl.value?.removeEventListener("scroll", onChatScroll);
});
</script>

<template>
  <div class="ws-app" :class="{ 'side-collapsed': sideCollapsed, 'sidebar-open': sideOpen }">
    <!-- P8.5：满宽顶栏（对齐首页排版：logo + 名称左上角，右侧控制组同款） -->
    <header class="ws-top">
      <div class="ws-top-left">
        <!-- P8.6：品牌与官网首页一致（同款波形 logo + 名称）；P8.52：点击刷新本页（不再跳首屏） -->
        <span class="brand" role="button" tabindex="0" title="刷新本页" @click="reloadPage" @keydown.enter.prevent="reloadPage" @keydown.space.prevent="reloadPage">
          <span class="ws-brand-logo" v-html="LOGO_SVG"></span>
          <!-- P8.15：品牌位直接显示当前智能体名称（替代「回响答」+ 原智能体徽章） -->
          <span class="brand-text">EchoAnswer<em class="brand-agent"> · {{ agentName }}</em></span>
        </span>
        <span v-if="runningCount > 0" class="nav-sep" aria-hidden="true"></span>
        <span v-if="runningCount > 0" class="ws-active-pill" title="在途问答">生成中 {{ runningCount }}</span>
      </div>
      <div class="ws-head-right">
        <el-popover placement="bottom-end" :width="340" trigger="click">
          <template #reference>
            <button class="prefs-btn" title="显示偏好（本地记忆）"><el-icon><SetUp /></el-icon>显示</button>
          </template>
          <div class="prefs-box">
            <div class="prefs-row">
              <label>字号</label>
              <el-select v-model="fontState.mode" size="small" :teleported="false" @change="applyPrefs">
                <el-option label="默认（15px）" value="default" />
                <el-option label="大（18px）" value="large" />
                <el-option label="自定义" value="custom" />
              </el-select>
              <el-input-number v-if="fontState.mode === 'custom'" v-model="fontState.px" :min="12" :max="36" size="small" controls-position="right" @change="applyPrefs" />
            </div>
            <div class="prefs-row">
              <label>内容宽度</label>
              <el-select v-model="widthMode" size="small" :teleported="false" @change="applyPrefs">
                <el-option label="窄（860px）" value="narrow" />
                <el-option label="宽（1180px）" value="wide" />
                <el-option label="铺满" value="full" />
              </el-select>
            </div>
            <div class="prefs-row">
              <label>行间距</label>
              <el-select v-model="lineState.mode" size="small" :teleported="false" @change="applyPrefs">
                <el-option label="默认" value="default" />
                <el-option label="窄（1.35）" value="narrow" />
                <el-option label="自定义" value="custom" />
              </el-select>
              <el-input-number v-if="lineState.mode === 'custom'" v-model="lineState.val" :min="1" :max="2.5" :step="0.05" :precision="2" size="small" controls-position="right" @change="applyPrefs" />
            </div>
          </div>
        </el-popover>
        <button v-if="auth.isAdmin && currentSession" class="prefs-btn" title="会话设置（管理）" @click="openSettings"><el-icon><Setting /></el-icon>会话设置</button>
        <span class="nav-sep" aria-hidden="true"></span>
        <!-- P8.37：一键分享 = 复制当前智能体链接 -->
        <button type="button" class="ws-share-btn" :title="shared ? '链接已复制' : '复制智能体链接（分享）'" @click="shareAgent"><el-icon><Check v-if="shared" /><Share v-else /></el-icon></button>
        <button class="prefs-btn prefs-btn-theme" :title="lightTheme ? '切换深色主题' : '切换浅色主题'" @click="toggleTheme"><el-icon><Moon v-if="lightTheme" /><Sunny v-else /></el-icon></button>
        <router-link v-if="auth.isAdmin" to="/admin" class="topnav-link">控制台</router-link>
        <!-- P8.4：用户名下拉（与首页一致：点击展开「退出」，点外部 / Esc 关闭） -->
        <div v-if="auth.isAuthed" class="user-wrap" ref="userWrap">
          <button type="button" class="user-btn" aria-haspopup="menu" :aria-expanded="userMenuOpen ? 'true' : 'false'" @click="userMenuOpen = !userMenuOpen" @keydown.esc="userMenuOpen = false">{{ auth.displayName || '用户' }}<span class="user-caret" v-html="CARET_SVG" aria-hidden="true"></span></button>
          <div v-if="userMenuOpen" class="user-menu" role="menu">
            <!-- P8.55：个人设置（显示名 / 修改密码；仅账号主体，访问码无 user） -->
            <button v-if="auth.principal?.user" type="button" class="user-menu-item" role="menuitem" @click="userMenuOpen = false; profileOpen = true"><el-icon class="user-menu-ic"><User /></el-icon>个人设置</button>
            <button type="button" class="user-menu-item" role="menuitem" @click="onLogout"><el-icon class="user-menu-ic"><SwitchButton /></el-icon>退出</button>
          </div>
        </div>
        <router-link v-else to="/login" class="topnav-link">登录</router-link>
      </div>
    </header>

    <div class="ws-body">
    <!-- 左侧会话栏（P7.2 对齐旧版 #sidebar；P8.5 下移至满宽顶栏之下；≤720px 左滑出抽屉） -->
    <aside class="ws-side">
      <div class="ws-side-head">
        <span class="ws-side-title">会话列表</span>
        <span class="ws-side-actions">
          <!-- P8.29：新建改图标按钮（与收起/展开同款）；收起/展开用 Fold/Expand 语义图标（原汉堡图标易生歧义） -->
          <button type="button" class="ws-side-new" title="新建会话" @click="createSession"><el-icon><Plus /></el-icon></button>
          <button class="ws-side-toggle" :title="sideCollapsed ? '展开会话列表' : '收起会话列表'" @click="toggleSide">
            <el-icon v-if="sideCollapsed"><Expand /></el-icon><el-icon v-else><Fold /></el-icon>
          </button>
          <button class="ws-side-close" title="关闭会话列表" @click="sideOpen = false"><el-icon><Close /></el-icon></button>
        </span>
      </div>
      <div v-if="listLoading" class="ws-side-empty">加载中…</div>
      <div v-else-if="!agentSessions.length" class="ws-side-empty">该智能体下还没有会话</div>
      <ul v-else class="ws-sess-list">
        <li
          v-for="s in agentSessions"
          :key="s.id"
          :class="{ on: s.id === sess.currentSid }"
          :title="s.name + ' · 会话ID ' + s.id"
          @click="openSession(s.id); closeMobileSide()"
        >
          <div class="ws-sess-name">
            <span class="ws-sess-title">{{ s.name || '未命名会话' }}</span>
            <span v-if="s.active" class="ws-sess-live-dot" title="有在途问答"></span>
            <span class="ws-sess-menu" @click.stop>
              <el-dropdown trigger="click" @command="(cmd: string) => onSessCommand(cmd, s)">
                <span class="ws-sess-ellipsis"><el-icon><MoreFilled /></el-icon></span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-if="s.id === sess.currentSid" command="settings">设置</el-dropdown-item>
                    <el-dropdown-item command="rename">重命名</el-dropdown-item>
                    <el-dropdown-item command="del" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </span>
          </div>
          <div class="ws-sess-meta">
            <span class="ws-badge">{{ PROTO_NAMES[s.protocol] || s.protocol }}</span>
            <span class="ws-badge ws-badge-bucket" :class="'ws-bucket-' + bucketKey(s)" :title="bucketTip(s)">{{ bucketLabel(s) }}</span>
            <span v-if="audioN(s.id) > 0" class="ws-badge ws-badge-audio" :title="'正在接收 ' + audioN(s.id) + ' 个电脑设备的输出音频'"><el-icon><Headset /></el-icon>{{ audioN(s.id) }}</span>
            <span class="ws-sess-time">{{ s.active > 0 ? '生成中…' : (s.last_at ? fmtTime(s.last_at) : fmtTime(s.updated_at)) }}</span>
          </div>
          <div v-if="s.last_question" class="ws-sess-last">{{ s.last_question }}</div>
        </li>
      </ul>
      <div class="ws-side-foot">
        <span class="conn" :class="connCls">{{ connText }}</span>
      </div>
    </aside>

    <!-- 主列（P8.5：顶栏已上移为满宽 .ws-top；本列仅 main#chat / footer composer） -->
    <div class="ws-col">
      <button
        v-if="sess.currentSid && cards.length && showToLatest"
        class="ws-to-latest"
        type="button"
        title="回到底部（最新）"
        @click="scrollBottom(true)"
      >↓ 最新</button>
      <main ref="chatEl" class="ws-main">
        <div v-if="agentErr" class="ws-err">
          <div class="ws-err-card">
            <el-icon class="ws-err-ic"><Lock /></el-icon>
            <b>无权访问该智能体</b>
            <p>{{ agentErr }}</p>
            <div class="ws-err-btns">
              <el-button type="primary" size="small" @click="goLogin">去登录 / 切换账号</el-button>
              <router-link to="/" class="ws-err-home">返回首屏</router-link>
            </div>
          </div>
        </div>
        <div v-else-if="!sess.currentSid" class="ws-empty-main">
          <p>左侧选择或新建一个会话开始问答</p>
          <el-button v-if="auth.isAuthed" type="primary" @click="createSession">新建会话</el-button>
          <router-link v-else to="/login" class="login-back">先登录 →</router-link>
        </div>
        <template v-else>
          <!-- P8.54：空会话提示通俗化，专业对接信息折叠「查看更多」 -->
          <div v-if="!cards.length" class="ws-empty-chat">
            <h3>这个会话还没有问答</h3>
            <p>在下方输入框里输入问题，按 <code>Enter</code> 发送，答案会实时显示在这里。</p>
            <p v-if="currentSession" class="ws-empty-proto">当前会话：{{ composerProto }}</p>
            <div class="ws-empty-more">
              <span class="ws-empty-toggle" role="button" tabindex="0" @click="emptyMore = !emptyMore" @keydown.enter="emptyMore = !emptyMore">
                <el-icon class="ws-empty-toggle-ic"><ArrowDown v-if="emptyMore" /><ArrowRight v-else /></el-icon>
                {{ emptyMore ? "收起" : "查看更多（EchoScribe 对接）" }}
              </span>
              <div v-if="emptyMore" class="ws-empty-detail">
                <p>想把语音设备的识别结果自动推送到这个会话？打开「会话设置」，复制 <code>echoscribe.toml</code> 片段（含 token 与会话ID）到设备配置即可。</p>
                <p class="ws-empty-dim">推送接口 <code>POST /api/push</code>（token + 会话ID）</p>
              </div>
            </div>
          </div>
          <div
            v-for="c in cards"
            :key="c.id"
            class="qcard"
            :class="{ running: c.status === 'running' }"
          >
            <div class="q-block">
              <span class="tag tag-q">问</span>
              <span class="q-text">{{ c.question }}</span>
              <span class="card-meta">
                <em class="badge" :class="srcCls(c.source)">
                  <el-icon class="badge-ic"><ChatDotRound v-if="c.source === 'web'" /><Microphone v-else-if="c.source === 'push'" /><Headset v-else /></el-icon>
                  {{ srcName(c.source) }}
                </em>
                <em class="badge" v-if="c.protocol_name || c.protocol || c.status === 'running'">{{ c.protocol_name || c.protocol || (c.status === 'running' ? '处理中' : '') }}</em>
                <em class="time">{{ fmtCardTime(c.started_at) }}</em>
              </span>
              <button class="q-copy" type="button" :class="{ copied: copiedKey === c.id + ':q' }" title="复制问题" @click="copyQ(c)">
                <el-icon class="btn-ic"><CopyDocument /></el-icon>{{ copiedKey === c.id + ':q' ? '已复制' : '复制' }}
              </button>
            </div>
            <div class="a-block">
              <span class="tag tag-a">答</span>
              <div class="a-body md" v-html="c.html"></div>
              <div class="a-status">
                <template v-if="c.status === 'running'">
                  <span class="st st-run">生成中… {{ runElapsed(c) }}s</span>
                  <button class="st-btn st-danger" @click="cancelQa(c.id)"><el-icon class="btn-ic"><VideoPause /></el-icon>停止</button>
                </template>
                <template v-else>
                  <span class="st" :class="c.ok ? 'st-ok' : 'st-err'">
                    <el-icon class="st-ic"><Check v-if="c.ok" /><Close v-else /></el-icon>
                    {{ c.detail || (c.ok ? '完成' : '失败') }}
                    <template v-if="c.duration_s != null"> · {{ c.duration_s }}s</template>
                  </span>
                  <span class="st-btns">
                    <button v-if="c.ok && c.answer" class="st-btn" :class="{ copied: copiedKey === c.id + ':a' }" @click="copyA(c)">
                      <el-icon class="btn-ic"><CopyDocument /></el-icon>{{ copiedKey === c.id + ':a' ? '已复制' : '复制' }}
                    </button>
                    <button class="st-btn" :disabled="!canRegen(c)" @click="regen(c)"><el-icon class="btn-ic"><RefreshRight /></el-icon>重新生成</button>
                    <button class="st-btn st-danger" @click="deleteCard(c)"><el-icon class="btn-ic"><Delete /></el-icon>删除</button>
                  </span>
                </template>
              </div>
            </div>
          </div>
        </template>
      </main>

      <footer class="ws-foot">
        <div class="ws-composer">
          <AudioPanel
            v-if="showAudio"
            ref="audioPanel"
            :session="currentSession"
            @finalized="(t: string) => onVoiceFinal(t, '')"
            @state="(l: boolean) => (audioListening = l)"
          />
          <textarea
            v-model="input"
            class="ws-input"
            rows="2"
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
            autofocus
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <div v-if="mic.st.value.interim" class="mic-interim">… {{ mic.st.value.interim }}</div>
          <div class="ws-composer-bar">
            <span class="ws-composer-proto" title="当前会话与协议（协议在「会话设置」中修改）">{{ composerProto }}</span>
            <div class="ws-composer-actions">
              <button class="st-btn ws-stop" :disabled="!currentRunningId" @click="stopCurrent"
                title="停止生成（当前会话在途的问题）">停止</button>
              <label class="asr-autosend" title="语音识别定稿后自动发送（无需点「发送」）；不勾选则识别结果填入输入框待确认（默认）">
                <input type="checkbox" v-model="mic.st.value.autosend" @change="saveAutosend"> 识别后自动发送
              </label>
              <button
                class="mic-btn"
                :class="{ rec: mic.st.value.recording, busy: mic.st.value.transcribing }"
                :disabled="mic.st.value.transcribing || showAudio"
                :title="micTitle"
                @click="onMicClick"
              ><el-icon v-if="!mic.st.value.recording"><Microphone /></el-icon>{{ mic.st.value.recording ? mic.st.value.timeLabel : (mic.st.value.transcribing ? '识别中…' : '语音') }}</button>
              <button
                class="mic-btn"
                :class="{ on: showAudio && !audioListening, listening: audioListening }"
                :disabled="audioListening"
                :title="audioListening ? '识别进行中：请用上方面板「停止识别 / 重新开始 / 取消」' : '音频输入：识别 EchoScribe 持续推流到本会话的电脑输出音频'"
                @click="openAudioPanel"
              ><el-icon><Headset /></el-icon>{{ audioListening ? '识别中…' : '音频' }}</button>
              <el-button type="primary" :loading="sending" :disabled="!input.trim()" @click="send">
                <span class="send-ic" v-html="SEND_SVG"></span>发送
              </el-button>
            </div>
          </div>
        </div>
      </footer>
    </div>
    </div>

    <SessionSettings
      :session="currentSession"
      :is-admin="auth.isAdmin"
      :open="settingsOpen"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
      @delete="onSettingsDelete"
    />
    <ProfileDialog :open="profileOpen" @update:open="profileOpen = $event" @saved="() => {}" />
  </div>
</template>
