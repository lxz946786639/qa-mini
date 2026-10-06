<script setup lang="ts">
// P8 官网首页：4 区块品牌页（Hero / 智能体选择 / 产品矩阵 / 完整工作流）。
// 语义化标签 + 内联 SVG（2px 描边 currentColor）+ 纯 CSS（landing.css，--lp-* 变量双主题）；
// 不使用 Element Plus 组件，不新增任何依赖。
// 保留能力：GET /api/agents 动态列表（loading/错误重试/空态）、未登录提示、登录/控制台/退出。
// 主题与全站共享 useTheme（data-theme；首次访问跟随系统，手动切换后 localStorage 记忆）。
// P8.3：四区块各 100svh 满屏，滚轮「一步一区块」吸附（onWheel 归一，末区块含页脚）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
import { useTheme } from "../composables/useTheme";
import "../landing.css";

interface AgentItem {
  id: string;
  code: string;
  name: string;
  description: string;
  icon: string;
  protocol: string;
  sort: number;
  // P8.9：访问控制（控制台·安全页配置；落地页徽标 + 点击进入前鉴权）
  allow_anon: boolean;
  allow_code: boolean;
  allow_user: boolean;
}

// ---------- 内联 SVG 图标（2px 描边，currentColor） ----------
const S = (inner: string, vb = "0 0 24 24") =>
  '<svg viewBox="' + vb + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + "</svg>";
const ICONS: Record<string, string> = {
  logo: S('<path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 10v4"/>'),
  chip: S('<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  flow: S('<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M7.5 12h4l3.5-6M11.5 12l3.5 6"/>'),
  send: S('<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5 21 3z"/>'),
  flask: S('<path d="M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7.5 15h9"/>'),
  mic: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  pen: S('<path d="m14 5 5 5L8 21H3v-5L14 5z"/><path d="m12 7 5 5"/>'),
  chat: S('<path d="M12 4a8 7.2 0 0 1 8 7.2 8 7.2 0 0 1-8 7.2H9.5L5 21v-3.4a7.2 7.2 0 0 1-1-3.4A8 7.2 0 0 1 12 4z"/>'),
  monitor: S('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  vad: S('<path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3"/>'),
  file: S('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  grid: S('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  sync: S('<path d="M4 12a8 8 0 0 1 13.7-5.7M20 12a8 8 0 0 1-13.7 5.7"/><path d="M18 3v4h-4M6 21v-4h4"/>'),
  globe: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>'),
  wave: S('<path d="M4 12h2.5l2-5 3 10 2.5-8 1.5 3H20"/>'),
  ask: S('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.3-1 .8-1 1.7M12 16.5h.01"/>'),
  ans: S('<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.8-.8L4 20.5l1.2-4A8.3 8.3 0 1 1 21 11.5z"/><path d="m9 11.5 2 2 4-4.5"/>'),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: S('<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>'),
  // P8.13：箭头去掉中间竖线，改为双 V 形（chevron）
  arrowD: S('<path d="m6 8 6 6 6-6"/><path d="m6 15 6 6 6-6"/>', "0 0 24 26"),
  arrowR: S('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  arrowVD: S('<path d="m6 8 6 6 6-6"/><path d="m6 15 6 6 6-6"/>', "0 0 24 26"),
  chevU: S('<path d="m6 18 6-6 6 6"/><path d="m6 11 6-6 6 6"/>', "0 0 24 26"),
  chevD: S('<path d="m6 9 6 6 6-6"/>')
};
const waveHeights = [18, 30, 12, 38, 22, 44, 28, 16, 34, 20, 10, 46, 26, 14];

// ---------- 协议 → 标签/图标（三色标签：知识引擎=青 / 编排引擎=紫 / 通用=琥珀） ----------
const PROTO: Record<string, { label: string; cls: string; icon: string }> = {
  ragflow: { label: "知识引擎", cls: "t-kn", icon: "chip" },
  dify: { label: "编排引擎", cls: "t-orch", icon: "flow" },
  openai: { label: "通用", cls: "t-gen", icon: "send" },
  generic: { label: "通用", cls: "t-gen", icon: "send" }
};
const router = useRouter();
const auth = useAuthStore();
const theme = useTheme();

const agents = ref<AgentItem[]>([]);
const loading = ref(true);
const error = ref("");

interface Card {
  key: string;
  name: string;
  desc: string;
  tag: string;
  tagCls: string;
  icon: string;
  href: string;
  isDefault: boolean;
  // P8.9：访问徽标（无需登录 / 需登录 / 需访问码 / 仅管理员）
  access: string;
  accessCls: string;
  // P8.11：控制台配置的表情图标；空 = 按协议取默认 SVG
  iconEmoji: string;
}

// P8.9：访问方式徽标（优先级 匿名 > 用户登录 > 访问码）
function accessBadge(a: AgentItem): { label: string; cls: string } {
  if (a.allow_anon) return { label: "无需登录", cls: "lp-access-anon" };
  if (a.allow_user) return { label: "需登录", cls: "lp-access-login" };
  if (a.allow_code) return { label: "需访问码", cls: "lp-access-code" };
  return { label: "仅管理员", cls: "lp-access-admin" };
}

// P8.9：当前主体是否可进入该智能体（与服务端 agentAllows 同矩阵）
function allowedFor(a: AgentItem): boolean {
  const p = auth.principal;
  if (!p) return !!a.allow_anon;
  if (p.kind === "admin") return true;
  if (p.kind === "user") return !!(a.allow_anon || a.allow_user);
  return !!(a.allow_anon || a.allow_code); // code
}

// P8.11：卡片全部来自控制台智能体配置（GET /api/agents，sort 序，前 4；
// 不再有前端示例卡）；图标优先用控制台配置的表情符号，空 = 协议默认 SVG
const cards = computed<Card[]>(() => agents.value.slice(0, 4).map((a, i) => {
  const p = PROTO[a.protocol] || PROTO.generic;
  const ab = accessBadge(a);
  return {
    key: a.id, name: a.name, desc: a.description || "（暂无描述）",
    tag: p.label, tagCls: p.cls, icon: p.icon,
    href: "/agents/" + a.code, isDefault: i === 0,
    access: ab.label, accessCls: ab.cls,
    iconEmoji: a.icon || ""
  };
}));

const steps = [
  { no: "01", name: "采集", desc: "EchoScribe 采集电脑输出音频，无需虚拟声卡。", icon: "mic" },
  { no: "02", name: "转写", desc: "VAD 分段 + 准流式识别，一句话一段。", icon: "wave" },
  { no: "03", name: "提问", desc: "识别文本推送至 EchoAnswer，成为问题。", icon: "ask" },
  { no: "04", name: "作答", desc: "四协议流式输出，答案实时推到眼前。", icon: "ans" }
];

async function load() {
  loading.value = true;
  error.value = "";
  const { ok, data } = await api<{ ok: boolean; agents?: AgentItem[]; detail?: string }>("/api/agents");
  loading.value = false;
  if (!ok) {
    error.value = data.detail || "加载智能体列表失败";
    return;
  }
  agents.value = (data.agents || []).slice().sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
  await nextTick();
  revealInit();
}

async function onLogout() {
  await auth.logout();
  ElMessage.success("已退出登录");
}

function goCard(c: Card) {
  // P8.9：落地页展示全部智能体；当前主体无权进入 → 先去登录（?next 回跳）
  const a = agents.value.find((x) => x.id === c.key);
  if (a && !allowedFor(a)) {
    ElMessage.info("该智能体需要登录，登录后继续");
    router.push({ path: "/login", query: { next: c.href } });
    return;
  }
  router.push(c.href);
}
function viewAll() {
  router.push(auth.isAdmin ? "/admin" : "/login");
}
// P8.13：立即体验 = 滚动到智能体区块（不再直接跳入某智能体工作区）
function goExperience() {
  scrollTo("agents");
}
function scrollTo(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- 滚动渐入（IO 缺失直接显示） ----------
let io: IntersectionObserver | null = null;
function revealInit() {
  const els = Array.from(document.querySelectorAll<HTMLElement>(".lp-io:not(.lp-in)"));
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("lp-in"));
    return;
  }
  if (!io) {
    io = new IntersectionObserver(
      (ents) => {
        ents.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add("lp-in");
            io!.unobserve(en.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
  }
  els.forEach((el, i) => {
    el.style.transitionDelay = (i % 8) * 55 + "ms";
    io!.observe(el);
  });
}

// ---------- P8.2 用户名下拉（点外部关闭） ----------
const userMenuOpen = ref(false);
const userWrap = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (userMenuOpen.value && userWrap.value && !userWrap.value.contains(e.target as Node)) {
    userMenuOpen.value = false;
  }
}


// ---------- P8.3 满屏区块 + 滚轮区块吸附 ----------
// 四个区块各 100svh 满屏（末区块内含页脚，整页 = 4 × 100svh）。
// 滚轮归一为「一步一区块」：
//  · 任意滚动手势（鼠标 notch / OS 整页滚动 / 触控板细滚累计 ≥45px / 惯性甩动）
//    都只前进或后退一个区块，easeInOutCubic 动画到区块顶（= 吸附位）；
//  · 动画开始 220ms 内的再次滚动缓冲 1 步（快速双击 = 连走两区块），
//    之后的惯性尾全部吸收；连步完成后 320ms 冷却，防一次甩动连翻多区块；
//  · prefers-reduced-motion → 无动画，直接跳区块。
const SNAP_IDS = ["top", "agents", "matrix", "workflow"];
const SNAP_ACC_THRESHOLD = 45;   // 触控板细滚累计阈值（px）
const SNAP_BUFFER_MS = 220;      // 动画开始后的缓冲窗口（连击判定）
const SNAP_COOLDOWN_MS = 320;    // 连步完成后的惯性尾冷却
let snapRaf = 0;
let snapStartAt = 0;
let snapBuffer = 0;
let snapAcc = 0;
let snapCooldownUntil = 0;
function snapSectionTop(i: number) {
  if (i === 0) return 0; // 首区块对齐页面顶（导航在文档流占 60px，scrollY=0 为首屏）
  const el = document.getElementById(SNAP_IDS[i]);
  if (!el) return 0;
  return el.getBoundingClientRect().top + window.scrollY;
}
function snapMaxScroll() {
  return document.documentElement.scrollHeight - window.innerHeight;
}
// 当前视口中点所在的区块索引
function snapIndex() {
  const mid = window.scrollY + window.innerHeight * 0.5;
  let idx = 0;
  for (let i = 0; i < SNAP_IDS.length; i++) {
    if (snapSectionTop(i) <= mid) idx = i;
  }
  return idx;
}
function snapEase(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
}
function snapFinish() {
  const buf = snapBuffer;
  snapBuffer = 0;
  if (buf !== 0) {
    const to = Math.max(0, Math.min(SNAP_IDS.length - 1, snapIndex() + buf));
    if (to !== snapIndex()) { snapAnimate(to); return; } // 缓冲的连步（最多一次）
  }
  snapCooldownUntil = performance.now() + SNAP_COOLDOWN_MS;
}
function snapAnimate(to: number) {
  if (snapRaf) return;
  const start = window.scrollY;
  const end = Math.max(0, Math.min(snapMaxScroll(), snapSectionTop(to)));
  if (end === start || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.scrollTo(0, end);
    snapFinish();
    return;
  }
  const dist = Math.abs(end - start);
  const dur = Math.max(420, Math.min(720, dist / 1.3));
  const t0 = performance.now();
  snapStartAt = t0;
  snapRaf = requestAnimationFrame(function tick(now) {
    const t = Math.min(1, (now - t0) / dur);
    window.scrollTo(0, start + (end - start) * snapEase(t));
    if (t < 1) snapRaf = requestAnimationFrame(tick);
    else {
      snapRaf = 0;
      snapFinish();
    }
  });
}
// ---------- P8.13 区块边缘指引 ----------
// 仅当区块停在吸附位（顶边对齐视口顶 / 末区块停底）时显示：
// 顶右 = 上一区块、底右 = 下一区块（Hero 的「向下探索」按钮自身即其下一区块指引）
const EDGE_TOL = 10; // 吸附位判定容差（px）
const edgeIdx = ref(-1); // 当前停在吸附位的区块索引；-1 = 滚动中
const SEC_LABELS: Record<string, string> = { top: "首页", agents: "智能体", matrix: "产品矩阵", workflow: "工作流" };
function edgeRest() {
  const idx = snapIndex();
  if (Math.abs(window.scrollY - snapSectionTop(idx)) <= EDGE_TOL) { edgeIdx.value = idx; return; }
  if (idx === SNAP_IDS.length - 1 && Math.abs(window.scrollY - snapMaxScroll()) <= EDGE_TOL) { edgeIdx.value = idx; return; }
  edgeIdx.value = -1;
}
let edgeRaf = 0;
function onEdgeScroll() {
  if (edgeRaf) return;
  edgeRaf = requestAnimationFrame(() => { edgeRaf = 0; edgeRest(); });
}
function snapGoNext() { snapAnimate(Math.min(SNAP_IDS.length - 1, snapIndex() + 1)); }
function snapGoPrev() { snapAnimate(Math.max(0, snapIndex() - 1)); }

function onWheel(e: WheelEvent) {
  e.preventDefault(); // 满屏区块页：全部滚轮输入归一为区块步
  const now = performance.now();
  if (snapRaf) {
    if (now - snapStartAt < SNAP_BUFFER_MS) snapBuffer = e.deltaY > 0 ? 1 : -1; // 连击缓冲
    return;
  }
  if (now < snapCooldownUntil) return; // 惯性尾冷却
  snapAcc += e.deltaY;
  if (Math.abs(snapAcc) >= SNAP_ACC_THRESHOLD) {
    const dir = snapAcc > 0 ? 1 : -1;
    snapAcc = 0;
    const from = snapIndex();
    const to = Math.max(0, Math.min(SNAP_IDS.length - 1, from + dir));
    if (to === from) return; // 已到边界
    snapAnimate(to);
  }
}

onMounted(() => {
  auth.me();
  load();
  revealInit();
  window.addEventListener("scroll", onEdgeScroll, { passive: true });
  edgeRest();
  window.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("click", onDocClick);
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onEdgeScroll);
  if (edgeRaf) cancelAnimationFrame(edgeRaf);
  edgeRaf = 0;
  window.removeEventListener("wheel", onWheel);
  document.removeEventListener("click", onDocClick);
  if (snapRaf) cancelAnimationFrame(snapRaf);
  snapRaf = 0;
  snapBuffer = 0;
  snapAcc = 0;
  if (io) io.disconnect();
  io = null;
});
</script>

<template>
  <div class="lp-root">
    <!-- 顶部导航 -->
    <header class="lp-nav">
      <a class="lp-brand" href="/">
        <span v-html="ICONS.logo"></span>
        <span>EchoAnswer 回响答</span>
      </a>
      <nav class="lp-nav-right" aria-label="主导航">
        <div class="lp-nav-links">
          <button class="lp-nav-link" type="button" @click="scrollTo('agents')">智能体</button>
          <button class="lp-nav-link" type="button" @click="scrollTo('matrix')">产品矩阵</button>
          <button class="lp-nav-link" type="button" @click="scrollTo('workflow')">工作流</button>
        </div>
        <span class="lp-nav-sep" aria-hidden="true"></span>
        <button
          class="lp-theme-btn"
          type="button"
          :aria-label="theme.lightTheme ? '切换到深色主题' : '切换到浅色主题'"
          @click="theme.toggleTheme()"
        >
          <span v-html="theme.lightTheme ? ICONS.sun : ICONS.moon"></span>
        </button>
        <button v-if="auth.isAdmin" class="lp-nav-link" type="button" @click="viewAll">控制台</button>
        <div v-if="auth.isAuthed" class="lp-user-wrap" ref="userWrap">
          <button
            class="lp-user-btn"
            type="button"
            aria-haspopup="menu"
            :aria-expanded="userMenuOpen ? 'true' : 'false'"
            @click="userMenuOpen = !userMenuOpen"
            @keydown.esc="userMenuOpen = false"
          >
            {{ auth.displayName || "用户" }}
            <span class="lp-user-caret" v-html="ICONS.chevD"></span>
          </button>
          <div v-if="userMenuOpen" class="lp-user-menu" role="menu" aria-label="用户菜单">
            <button class="lp-user-menu-item" role="menuitem" type="button" @click="onLogout">退出</button>
          </div>
        </div>
        <router-link v-else to="/login" class="lp-login-btn">登录</router-link>
      </nav>
    </header>

    <main>
      <!-- 区块一：Hero（100vh 视口） -->
      <section id="top" class="lp-hero" :class="{ 'lp-scrolled': edgeIdx !== 0 }">
        <div class="lp-hero-copy">
          <h1 class="lp-io">回响答</h1>
          <p class="lp-hero-sub lp-io">一款面向线上答辩的即时问答神器</p>
          <p class="lp-hero-slogan lp-io">
            <span>听得见问题，给得出答案。</span>
            <span class="lp-slogan-2">你只管讲，答案我来。</span>
          </p>
          <div class="lp-hero-ctas lp-io">
            <button class="lp-btn lp-btn-primary" type="button" @click="goExperience">立即体验</button>
            <button class="lp-btn lp-btn-ghost" type="button" @click="scrollTo('matrix')">了解 EchoScribe 回声笔</button>
          </div>
          <p class="lp-hero-meta lp-io">EchoScribe 回声笔 × EchoAnswer 回响答 · 实时听，即时答</p>
          <p class="lp-hero-trust lp-io">高校 · 科研院所 · 企业评审</p>
        </div>

        <div class="lp-viz lp-io" aria-hidden="true">
          <svg class="lp-viz-wave" viewBox="0 0 300 48">
            <rect
              v-for="(h, i) in waveHeights"
              :key="i"
              :x="8 + i * 20"
              :y="24 - h / 2"
              width="6"
              :height="h"
              rx="3"
              fill="currentColor"
              stroke="none"
            />
          </svg>
          <div class="lp-viz-flow">识别文字</div>
          <div class="lp-viz-q">请问你们如何保证回答准确、不编造？</div>
          <div class="lp-viz-flow">流式作答</div>
          <div class="lp-viz-card">
            <em>知识引擎 · 流式回答</em>
            <p>
              <span class="lp-type">建立专属知识库并批量导入文档，知识引擎在会话中实时检索，答案都有出处，不编造。</span><span class="lp-caret"></span>
            </p>
          </div>
        </div>

        <button class="lp-scroll-cue" type="button" aria-label="向下探索：进入智能体区块" @click="snapGoNext()">
          <span>向下探索</span>
          <span v-html="ICONS.arrowD"></span>
        </button>
      </section>

      <!-- 区块二：智能体选择（55–70vh） -->
      <section id="agents" class="lp-section lp-agents">
        <div class="lp-sec-head lp-io">
          <h2>选择智能体，开始问答</h2>
          <p>多用户 · 多智能体 · 会话隔离</p>
        </div>

        <div v-if="loading" class="lp-agent-grid" aria-busy="true">
          <div v-for="n in 4" :key="n" class="lp-skel"></div>
        </div>

        <div v-else-if="error" class="lp-state">
          <p>{{ error }}</p>
          <button class="lp-btn lp-btn-ghost" type="button" @click="load">重试</button>
        </div>

        <div v-else-if="!agents.length" class="lp-state">
          <p>暂无可用智能体</p>
          <small>请联系管理员在「控制台」创建并启用智能体。</small>
        </div>

        <div v-else class="lp-agent-grid">
          <div
            v-for="c in cards"
            :key="c.key"
            class="lp-agent-card lp-io"
            :class="{ 'lp-default': c.isDefault }"
            tabindex="0"
            role="link"
            :aria-label="c.name + '（' + c.tag + '）进入工作区'"
            @click="goCard(c)"
            @keydown.enter.prevent="goCard(c)"
            @keydown.space.prevent="goCard(c)"
          >
            <div class="lp-agent-top">
              <span v-if="c.iconEmoji" class="lp-agent-ic lp-agent-emoji">{{ c.iconEmoji }}</span>
              <span v-else class="lp-agent-ic" v-html="ICONS[c.icon] || ICONS.mic"></span>
              <span class="lp-tags">
                <span class="lp-tag" :class="c.tagCls">{{ c.tag }}</span>
                <span v-if="c.access" class="lp-access" :class="c.accessCls">{{ c.access }}</span>
              </span>
            </div>
            <div class="lp-agent-name">
              {{ c.name }}
              <span v-if="c.isDefault" class="lp-def-mark">默认智能体</span>
            </div>
            <p class="lp-agent-desc">{{ c.desc }}</p>
            <span class="lp-agent-go">进入工作区 <span class="lp-arrow" v-html="ICONS.arrowR"></span></span>
          </div>
        </div>

        <div v-if="!loading && agents.length" class="lp-sec-foot lp-io">
          <p>选一个智能体，开始你的问答。</p>
          <button class="lp-btn lp-btn-soft" type="button" @click="viewAll">查看全部智能体</button>
        </div>
      </section>

      <!-- 区块三：产品矩阵（70–85vh） -->
      <section id="matrix" class="lp-section lp-matrix">
        <div class="lp-sec-head lp-io">
          <h2>一支笔，一个答</h2>
          <p>EchoScribe 回声笔负责听，EchoAnswer 回响答负责答。</p>
        </div>

        <div class="lp-matrix-wrap lp-io">
          <article class="lp-prod-card" data-role="hear">
            <div class="lp-prod-head">
              <span class="lp-prod-ic" v-html="ICONS.pen"></span>
              <h3>EchoScribe 回声笔</h3>
            </div>
            <p class="lp-prod-role-line">实时系统音频转写</p>
            <ul class="lp-prod-list">
              <li><span v-html="ICONS.monitor"></span>采集电脑输出音频，无需虚拟声卡</li>
              <li><span v-html="ICONS.vad"></span>VAD 端点检测，一句话一段</li>
              <li><span v-html="ICONS.file"></span>准流式中间结果 + 定稿落盘</li>
            </ul>
            <span class="lp-role-tag">负责「听」</span>
          </article>

          <div class="lp-matrix-link" aria-hidden="true">
            <span class="lp-line"></span>
            <span class="lp-dot"></span>
          </div>

          <article class="lp-prod-card" data-role="answer">
            <div class="lp-prod-head">
              <span class="lp-prod-ic" v-html="ICONS.chat"></span>
              <h3>EchoAnswer 回响答</h3>
            </div>
            <p class="lp-prod-role-line">Web 端语音问答展示</p>
            <ul class="lp-prod-list">
              <li><span v-html="ICONS.grid"></span>四种问答协议，流式输出答案</li>
              <li><span v-html="ICONS.sync"></span>多会话隔离，多端实时同步</li>
              <li><span v-html="ICONS.globe"></span>浏览器即开即用，零部署</li>
            </ul>
            <span class="lp-role-tag">负责「答」</span>
          </article>

          <div class="lp-matrix-link-v" aria-hidden="true">
            <span v-html="ICONS.arrowVD"></span>
          </div>
        </div>

        <div class="lp-matrix-note lp-io">
          <p class="lp-note-1">回声笔转写的文字 → 回响答变成答案</p>
          <p class="lp-note-2">听得见问题，给得出答案。你只管讲，答案我来。</p>
        </div>

        <div class="lp-sec-foot lp-io">
          <button class="lp-btn lp-btn-soft" type="button" @click="scrollTo('workflow')">了解完整工作流</button>
        </div>
      </section>

      <!-- 区块四：完整工作流（70–85vh） -->
      <section id="workflow" class="lp-section lp-workflow">
        <div class="lp-wf-body">
        <div class="lp-sec-head lp-io">
          <h2>从声音到答案</h2>
          <p>四步闭环，实时流动。</p>
        </div>

        <div class="lp-flow lp-io">
          <template v-for="(s, i) in steps" :key="s.no">
            <div class="lp-step">
              <div class="lp-step-no">{{ s.no }}</div>
              <span class="lp-step-ic" v-html="ICONS[s.icon]"></span>
              <h3>{{ s.name }}</h3>
              <p>{{ s.desc }}</p>
            </div>
            <div v-if="i < steps.length - 1" class="lp-step-arrow" aria-hidden="true">
              <span v-html="ICONS.arrowVD"></span>
            </div>
          </template>
        </div>

        <div class="lp-sec-foot lp-io">
          <p>听得见问题，给得出答案。你只管讲，答案我来。</p>
          <a class="lp-btn lp-btn-soft" href="/doc/03-部署说明.md">查看部署文档</a>
        </div>
        </div>
        <footer class="lp-foot">EchoAnswer v59 · 局域网 AI 问答平台</footer>
      </section>
    </main>

    <!-- P8.13：区块边缘指引（仅在吸附位显示；Hero 用其自身「向下探索」按钮） -->
    <button v-if="edgeIdx >= 1" class="lp-edge lp-edge-top" type="button" @click="snapGoPrev()">
      <span v-html="ICONS.chevU"></span><span>上一区块 · {{ SEC_LABELS[SNAP_IDS[edgeIdx - 1]] }}</span>
    </button>
    <button v-if="edgeIdx >= 1 && edgeIdx < SNAP_IDS.length - 1" class="lp-edge lp-edge-bottom" type="button" @click="snapGoNext()">
      <span>下一区块 · {{ SEC_LABELS[SNAP_IDS[edgeIdx + 1]] }}</span><span v-html="ICONS.arrowD"></span>
    </button>
  </div>
</template>
