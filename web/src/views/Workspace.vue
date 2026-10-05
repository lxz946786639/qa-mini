
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
import { useSessionsStore, RecordView } from "../stores/sessions";
import { useSse } from "../composables/useSse";
import { renderMarkdown } from "../utils/markdown";

// 工作区（P5）：某智能体下「我的会话」列表 + 流式问答（SSE 按主体作用域投递）
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const sess = useSessionsStore();

const agentCode = computed(() => String(route.params.code || ""));
const agentName = ref("…");
const agentProto = ref("");
const agentErr = ref("");
const listLoading = ref(true);

interface Card extends RecordView { html: string; live: string; }
const cards = ref<Card[]>([]);      // 展示序：旧→新（历史反转 + 在途追加）
const input = ref("");
const sending = ref(false);
const chatEl = ref<HTMLElement | null>(null);

const agentSessions = computed(() => sess.agentSessions(agentCode.value));
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

// 顶层 SSE 订阅（setup 执行时注册生命周期；仅本主体可见会话的事件会送达）
const sse = useSse({
  sessions: onListEvent,
  qa_start: onQaStart,
  delta: onDelta,
  done: onDone,
  record_removed: (d: any) => { if (String(d.session_id) === sess.currentSid) { sess.open(sess.currentSid).then(rebuildCards); } },
  session_reset: (d: any) => { if (String(d.session_id) === sess.currentSid) { sess.open(sess.currentSid).then(rebuildCards); } }
});

async function loadAgent() {
  listLoading.value = true;
  const { ok, data } = await api<{ ok: boolean; agent?: { name: string; protocol: string }; detail?: string }>(
    "/api/agents/" + encodeURIComponent(agentCode.value)
  );
  if (!ok) { agentErr.value = data.detail || "智能体不存在或已停用"; listLoading.value = false; return; }
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
  <div class="landing">
    <header class="topbar">
      <div class="brand">
        <router-link to="/" class="brand">
          <span class="brand-mark">回</span>
          <span class="brand-text">EchoAnswer · 回响答</span>
        </router-link>
      </div>
      <nav class="topnav">
        <span class="agent-pill">{{ agentName }}<em>{{ agentProto }}</em></span>
        <span class="sse-dot" :class="sseDot" title="SSE 连接状态"></span>
        <span v-if="auth.isAuthed" class="user-chip">{{ auth.displayName || "用户" }}</span>
        <router-link v-else to="/login" class="topnav-link">登录</router-link>
      </nav>
    </header>

    <div class="ws-layout">
      <aside class="ws-side">
        <div class="ws-side-head">
          <span>会话（{{ agentSessions.length }}）</span>
          <el-button size="small" type="primary" plain @click="createSession">＋ 新建</el-button>
        </div>
        <div v-if="listLoading" class="ws-side-empty">加载中…</div>
        <div v-else-if="!agentSessions.length" class="ws-side-empty">
          该智能体下还没有会话
        </div>
        <ul v-else class="ws-sess-list">
          <li
            v-for="s in agentSessions"
            :key="s.id"
            :class="{ on: s.id === sess.currentSid }"
            @click="openSession(s.id)"
          >
            <div class="ws-sess-name">
              <span class="ws-sess-title">{{ s.name || "未命名会话" }}</span>
              <span v-if="s.active" class="ws-sess-live" title="有在途问答">●</span>
              <span class="ws-sess-menu" @click.stop>
                <el-dropdown trigger="click" @command="(cmd: string) => cmd === 'rename' ? renameSession(s.id, s.name) : deleteSession(s.id, s.name || s.id)">
                  <span class="ws-sess-ellipsis">⋯</span>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="rename">重命名</el-dropdown-item>
                      <el-dropdown-item command="del" divided>删除</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </span>
            </div>
            <div class="ws-sess-meta">
              <span class="ws-sess-last">{{ s.last_question ? "「" + s.last_question.slice(0, 18) + (s.last_question.length > 18 ? "…" : "」") : "空会话" }}</span>
              <span class="ws-sess-time">{{ fmtTime(s.last_at || s.updated_at) }}</span>
            </div>
          </li>
        </ul>
      </aside>

      <main ref="chatEl" class="ws-main">
        <div v-if="agentErr" class="ws-err">{{ agentErr }}</div>
        <div v-else-if="!sess.currentSid" class="ws-empty-main">
          <p>左侧选择或新建一个会话开始问答</p>
          <el-button v-if="auth.isAuthed" type="primary" @click="createSession">新建会话</el-button>
          <router-link v-else to="/login" class="login-back">先登录 →</router-link>
        </div>
        <template v-else>
          <div v-if="!cards.length" class="ws-empty-chat">
            <p>这里还没有问答记录</p>
            <p class="ws-empty-dim">输入问题，按 Enter 发送（Shift+Enter 换行）</p>
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
                <em class="src">{{ c.source === "push" ? "语音推送" : "网页" }}</em>
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
                    {{ c.ok ? "完成" : (c.detail || "失败") }}
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

        <div class="ws-inputbar">
          <textarea
            v-model="input"
            class="ws-input"
            rows="2"
            placeholder="输入问题…（Enter 发送，Shift+Enter 换行）"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <el-button type="primary" :loading="sending" :disabled="!input.trim()" @click="send">发送</el-button>
        </div>
      </main>
    </div>
  </div>
</template>
