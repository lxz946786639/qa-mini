<script setup lang="ts">
// P8 官网首页：4 区块品牌页（Hero / 智能体选择 / 产品矩阵 / 完整工作流）。
// 语义化标签 + 内联 SVG（2px 描边 currentColor）+ 纯 CSS（landing.css，--lp-* 变量双主题）；
// 不使用 Element Plus 组件，不新增任何依赖。
// 保留能力：GET /api/agents 动态列表（loading/错误重试/空态）、未登录提示、登录/控制台/退出。
// 主题与全站共享 useTheme（data-theme；首次访问跟随系统，手动切换后 localStorage 记忆）。
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
  arrowD: S('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  arrowR: S('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  arrowVD: S('<path d="M12 3v20M6.5 17.5 12 23l5.5-5.5"/>', "0 0 24 26"),
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
// 示例卡（真实智能体不足 4 张时补齐；示意场景，进入需登录）
const SAMPLES = [
  { name: "答辩副手", desc: "毕业答辩多轮问答，对话流编排", proto: "dify", icon: "flow" },
  { name: "评审通", desc: "会议评审 / 路演问答，通用协议接入", proto: "generic", icon: "send" },
  { name: "科研助手", desc: "科研答辩多领域知识问答", proto: "ragflow", icon: "flask" }
];

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
  isSample: boolean;
}

// 卡片 = 真实智能体（sort 序，前 4）+ 示例卡补齐至 4；0 个真实卡不补示例
const cards = computed<Card[]>(() => {
  const real: Card[] = agents.value.slice(0, 4).map((a, i) => {
    const p = PROTO[a.protocol] || PROTO.generic;
    return {
      key: a.id, name: a.name, desc: a.description || "（暂无描述）",
      tag: p.label, tagCls: p.cls, icon: p.icon,
      href: "/agents/" + a.code, isDefault: i === 0, isSample: false
    };
  });
  if (!agents.value.length || real.length >= 4) return real;
  const extra: Card[] = SAMPLES.slice(0, 4 - real.length).map((s, i) => {
    const p = PROTO[s.proto];
    return {
      key: "sample-" + i, name: s.name, desc: s.desc,
      tag: p.label, tagCls: p.cls, icon: s.icon,
      href: "/login", isDefault: false, isSample: true
    };
  });
  return [...real, ...extra];
});

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
  router.push(c.href);
}
function viewAll() {
  router.push(auth.isAdmin ? "/admin" : "/login");
}
function goExperience() {
  router.push("/agents/industry-brain");
}
// P8.2 导航：控制台入口（admin → /admin，其余主体 / 未登录 → /login）
function goConsole() {
  router.push(auth.isAdmin ? "/admin" : "/login");
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

// ---------- 滚动提示淡出（一次性） ----------
const scrolled = ref(false);
function onScroll() {
  if (!scrolled.value) {
    scrolled.value = true;
    window.removeEventListener("scroll", onScroll);
  }
}

// ---------- P8.1 滚轮规整 ----------
// 鼠标滚轮大步长（OS「每次滚动行数」偏大 / 整页滚动 / 触控板惯性甩动，
// 单事件位移可达 1200px+）会让一滚「翻过」整个区块。此处只做轻量规整：
// 大 notch → 单步平滑滑动（~24% 视口，上限 220px）+ 惯性尾吸收；
// 触控板像素级细滚（|Δ|<60px 的 deltaMode=0）保持浏览器原生行为不干预；
// 动画期间的大 notch 累计（最多 3 步连滑）；prefers-reduced-motion 时回退原生。
let glideRaf = 0;
let glidePending = 0;
let lastStepAt = 0;
function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }
function wheelStep() { return Math.round(Math.min(220, Math.max(150, window.innerHeight * 0.24))); }
function glideBy(dy: number) {
  if (glideRaf) return;
  const start = window.scrollY;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const end = Math.max(0, Math.min(max, start + dy));
  if (end === start) { glidePending = 0; return; } // 已到滚动边界
  const t0 = performance.now();
  const dur = 380;
  glideRaf = requestAnimationFrame(function tick(now) {
    const t = Math.min(1, (now - t0) / dur);
    window.scrollTo(0, start + (end - start) * easeOutCubic(t));
    if (t < 1) glideRaf = requestAnimationFrame(tick);
    else {
      glideRaf = 0;
      if (glidePending !== 0) {
        const p = Math.max(-3, Math.min(3, glidePending));
        glidePending = 0;
        glideBy(p * wheelStep());
      }
    }
  });
}
function onWheel(e: WheelEvent) {
  const now = performance.now();
  const big = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 60;
  if (glideRaf) { // 动画中：大 notch 累计连滑，其余（惯性尾）吸收
    if (big) glidePending += e.deltaY >= 0 ? 1 : -1;
    e.preventDefault();
    return;
  }
  if (!big && now - lastStepAt < 250) { e.preventDefault(); return; } // 刚滑完的惯性尾
  if (!big) return; // 细滚（触控板）：原生
  e.preventDefault();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.scrollBy(0, Math.max(-320, Math.min(320, e.deltaY)));
    return;
  }
  glidePending = 0;
  lastStepAt = now;
  glideBy(e.deltaY >= 0 ? wheelStep() : -wheelStep());
}

onMounted(() => {
  auth.me();
  load();
  revealInit();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("click", onDocClick);
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("wheel", onWheel);
  document.removeEventListener("click", onDocClick);
  if (glideRaf) cancelAnimationFrame(glideRaf);
  glideRaf = 0;
  glidePending = 0;
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
        <button class="lp-nav-link" type="button" @click="goConsole">控制台</button>
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
      <section id="top" class="lp-hero" :class="{ 'lp-scrolled': scrolled }">
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
          <div class="lp-viz-q">请问 RAGFlow 知识库如何接入我们的业务系统？</div>
          <div class="lp-viz-flow">流式作答</div>
          <div class="lp-viz-card">
            <em>知识引擎 · 流式回答</em>
            <p>
              <span class="lp-type">建议先建立专属知识库并批量导入文档，再在会话中开启知识引擎即可。</span><span class="lp-caret"></span>
            </p>
          </div>
        </div>

        <div class="lp-scroll-cue" aria-hidden="true">
          <span>向下探索</span>
          <span v-html="ICONS.arrowD"></span>
        </div>
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
              <span class="lp-agent-ic" v-html="ICONS[c.icon] || ICONS.mic"></span>
              <span class="lp-tags">
                <span class="lp-tag" :class="c.tagCls">{{ c.tag }}</span>
                <span v-if="c.isSample" class="lp-sample">示例</span>
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
      </section>
    </main>

    <footer class="lp-foot">EchoAnswer v59 · 局域网 AI 问答平台</footer>
  </div>
</template>
