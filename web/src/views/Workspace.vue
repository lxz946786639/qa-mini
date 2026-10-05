
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
import { useSessionsStore, RecordView } from "../stores/sessions";
import { useSse } from "../composables/useSse";
import { useTheme } from "../composables/useTheme";
import { Menu, Sunny, Moon, Plus, Close, MoreFilled, Headset, SetUp, Microphone } from "@element-plus/icons-vue";
import { useMic } from "../composables/useMic";
import { renderMarkdown } from "../utils/markdown";
import AudioPanel from "../components/AudioPanel.vue";
import SessionSettings from "../components/SessionSettings.vue";

// 工作区（P5）：某智能体下「我的会话」列表 + 流式问答（SSE 按主体作用域投递）
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const sess = useSessionsStore();

const agentCode = computed(() => String(route.params.code || ""));
// 过滤用智能体 id（服务端会话归属键）：id ≠ code（播种/新建均为随机 id），
// 必须取 /api/agents/:code 返回的 agent.id，不能用路由 code 直接比对（P7.7 修复：
// 此前用 code 比对 sessions.agent_id(id) 导致侧栏恒空 + 每次进页面自动补建会话）
const agentId = ref<string | null>(null);
const agentName = ref("…");
const agentProto = ref("");
const agentErr = ref("");
const listLoading = ref(true);

// P7.2 布局对齐旧版：左固定会话栏（252px）+ 主列（header / main / footer）；
// 内容列宽沿用 --qa-maxw（窄 860 / 宽 1180 / 铺满，「⚙ 显示」记忆于 localStorage）
const PROTO_NAMES: Record<string, string> = { openai: "OpenAI 兼容", dify: "编排引擎", generic: "第三方通用", ragflow: "知识引擎" };
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
  const size = fontState.mode === "custom" ? Math.min(28, Math.max(12, Math.round(fontState.px || 15))) : (FONT_SIZES[fontState.mode] || 15);
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
  return /^\d+$/.test(d) ? d + "（旧版序号编码）" : d;
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
        c.html = renderMarkdown(c.answer);
      }
    }
  });
}

function rebuildCards() {
  const hist = [...(sess.detail?.history || [])].reverse(); // API 新→旧 → 旧→新
  cards.value = hist.map((r) => ({ ...r, html: renderMarkdown(r.answer || ""), live: r.answer || "" }));
  nextTick(() => scrollBottom(true));
}

function scrollBottom(force = false) {
  const el = chatEl.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
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

async function loadAgent() {
  listLoading.value = true;
  const { ok, data } = await api<{ ok: boolean; agent?: { id: string; name: string; protocol: string }; detail?: string }>(
    "/api/agents/" + encodeURIComponent(agentCode.value)
  );
  if (!ok) { agentErr.value = data.detail || "智能体不存在或已停用"; listLoading.value = false; return; }
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

async function deleteCard(rec: RecordView) {
  try {
    await ElMessageBox.confirm("删除这条记录？", "删除记录", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" });
  } catch { return; }
  const r = await sess.removeRecord(sess.currentSid!, rec.id);
  if (r.ok) ElMessage.success("已删除");
  else ElMessage.error("删除失败");
}

async function regen(rec: RecordView) {
  // 与现役界面一致：删该条记录 + 用同一问题重发
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
  // 与现役界面一致：仅最新一条非生成中的记录可重新生成
  const last = cards.value[cards.value.length - 1];
  return !!last && last.id === c.id && last.status === "done" && last.ok;
}

function copyText(t: string) {
  navigator.clipboard.writeText(t).then(() => ElMessage.success("已复制"));
}

function fmtTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

onMounted(async () => {
  auth.me();
  await loadAgent();
  if (!agentErr.value) await initSessions();
});
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
});
</script>

<template>
  <div class="ws-app" :class="{ 'side-collapsed': sideCollapsed, 'sidebar-open': sideOpen }">
    <!-- 左侧会话栏（P7.2 对齐旧版 #sidebar：252px 全高左固定；≤720px 左滑出抽屉） -->
    <aside class="ws-side">
      <div class="ws-side-head">
        <span class="ws-side-title">会话列表</span>
        <span class="ws-side-actions">
          <el-button size="small" type="primary" plain class="ws-side-new" :icon="Plus" @click="createSession">新建</el-button>
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

    <!-- 主列（对齐旧版 .main-col：header / main#chat / footer composer） -->
    <div class="ws-col">
      <header class="ws-head">
        <button class="ws-head-menu" title="收起 / 展开会话列表" @click="toggleSide"><el-icon><Menu /></el-icon></button>
        <router-link to="/" class="brand">
          <span class="brand-mark">回</span>
          <span class="brand-text">EchoAnswer</span>
          <span class="ws-head-sub">回响答 · 语音问答 · 流式展示</span>
        </router-link>
        <div class="ws-head-right">
          <span class="agent-pill">{{ agentName }}<em>{{ PROTO_NAMES[agentProto] || agentProto }}</em></span>
          <span v-if="runningCount > 0" class="ws-active-pill" title="在途问答">生成中 {{ runningCount }}</span>
          <el-popover placement="bottom-end" :width="300" trigger="click">
            <template #reference>
              <button class="prefs-btn" title="显示偏好（本地记忆）"><el-icon><SetUp /></el-icon>显示</button>
            </template>
            <div class="prefs-box">
              <div class="prefs-row">
                <label>字号</label>
                <el-select v-model="fontState.mode" size="small" @change="applyPrefs">
                  <el-option label="默认（15px）" value="default" />
                  <el-option label="大（18px）" value="large" />
                  <el-option label="自定义" value="custom" />
                </el-select>
                <el-input-number v-if="fontState.mode === 'custom'" v-model="fontState.px" :min="12" :max="28" size="small" controls-position="right" @change="applyPrefs" />
              </div>
              <div class="prefs-row">
                <label>内容宽度</label>
                <el-select v-model="widthMode" size="small" @change="applyPrefs">
                  <el-option label="窄（860px）" value="narrow" />
                  <el-option label="宽（1180px）" value="wide" />
                  <el-option label="铺满" value="full" />
                </el-select>
              </div>
              <div class="prefs-row">
                <label>行间距</label>
                <el-select v-model="lineState.mode" size="small" @change="applyPrefs">
                  <el-option label="默认" value="default" />
                  <el-option label="窄（1.35）" value="narrow" />
                  <el-option label="自定义" value="custom" />
                </el-select>
                <el-input-number v-if="lineState.mode === 'custom'" v-model="lineState.val" :min="1" :max="2.5" :step="0.05" :precision="2" size="small" controls-position="right" @change="applyPrefs" />
              </div>
            </div>
          </el-popover>
          <button class="prefs-btn" :title="lightTheme ? '切换深色主题' : '切换浅色主题'" @click="toggleTheme"><el-icon><Moon v-if="lightTheme" /><Sunny v-else /></el-icon></button>
          <span v-if="auth.isAuthed" class="user-chip">{{ auth.displayName || '用户' }}</span>
          <router-link v-else to="/login" class="topnav-link">登录</router-link>
          <el-button v-if="auth.isAdmin && currentSession" size="small" @click="openSettings">会话设置</el-button>
          <router-link v-if="auth.isAdmin" to="/admin" class="topnav-link">控制台</router-link>
        </div>
      </header>

      <main ref="chatEl" class="ws-main">
        <div v-if="agentErr" class="ws-err">{{ agentErr }}</div>
        <div v-else-if="!sess.currentSid" class="ws-empty-main">
          <p>左侧选择或新建一个会话开始问答</p>
          <el-button v-if="auth.isAuthed" type="primary" @click="createSession">新建会话</el-button>
          <router-link v-else to="/login" class="login-back">先登录 →</router-link>
        </div>
        <template v-else>
          <div v-if="!cards.length" class="ws-empty-chat">
            <h3>本会话暂无问答</h3>
            <p>在下方输入问题，按 <code>Enter</code> 发送，答案实时流式显示；<br>或用 <b>EchoScribe 推送模式</b>把语音识别结果自动推送到本会话。</p>
            <p v-if="currentSession" class="ws-empty-proto">当前会话：{{ composerProto }}</p>
            <p class="ws-empty-dim">EchoScribe 对接：打开「会话设置」复制 echoscribe.toml 片段（token + 会话ID）。推送接口 <code>POST /api/push</code></p>
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
              <span class="meta">
                <em class="proto">{{ c.protocol_name || c.protocol || (c.status === 'running' ? '处理中' : '') }}</em>
                <em class="src">{{ c.source === 'push' ? '语音推送' : '网页' }}</em>
                <em class="tm">{{ fmtTime(c.started_at) }}</em>
              </span>
            </div>
            <div class="a-block">
              <span class="tag tag-a">答</span>
              <div class="a-body md" v-html="c.html"></div>
              <div class="a-status">
                <template v-if="c.status === 'running'">
                  <span class="st st-run">生成中…</span>
                  <button class="st-btn" @click="cancelQa(c.id)">停止</button>
                </template>
                <template v-else>
                  <span class="st" :class="c.ok ? 'st-ok' : 'st-err'">
                    {{ c.ok ? '完成' : (c.detail || '失败') }}
                    <template v-if="c.duration_s != null"> · {{ c.duration_s }}s</template>
                  </span>
                  <span class="st-btns">
                    <template v-if="c.ok && c.answer">
                      <button class="st-btn" @click="copyText(c.answer)">复制</button>
                      <button class="st-btn" :disabled="!canRegen(c)" @click="regen(c)">重新生成</button>
                    </template>
                    <button class="st-btn" @click="deleteCard(c)">删除</button>
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
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <div v-if="mic.st.value.interim" class="mic-interim">… {{ mic.st.value.interim }}</div>
          <div class="ws-composer-bar">
            <span class="ws-composer-proto" title="当前会话与协议（协议在「会话设置」中修改）">{{ composerProto }}</span>
            <div class="ws-composer-actions">
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
              <el-button type="primary" :loading="sending" :disabled="!input.trim()" @click="send">发送</el-button>
            </div>
          </div>
        </div>
      </footer>
    </div>

    <SessionSettings
      :session="currentSession"
      :is-admin="auth.isAdmin"
      :open="settingsOpen"
      @close="settingsOpen = false"
      @saved="onSettingsSaved"
      @delete="onSettingsDelete"
    />
  </div>
</template>
