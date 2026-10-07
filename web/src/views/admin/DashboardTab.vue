<script setup lang="ts">
// P8.50 控制台仪表盘重构（依据 doc/重构仪表盘.md）：
// 信息架构 = 核心指标 → 整体趋势 → 活跃行为 → 智能体/协议分析 → 异常/系统状态；
// 数据源仍为 GET /api/admin/stats（业务口径零改动，智能体行新增 icon 字段）；
// ECharts 实例 6 → 3（提问趋势面积图 / 24h 活跃热力图 / 登录·新建会话迷你趋势），
// 排行 / 比例 / 异常 / 状态改轻量 HTML；空态（0/1/少量数据）专门设计。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleCheck, Refresh } from "@element-plus/icons-vue";
import { useTheme } from "../../composables/useTheme";
import { fmtDateTime } from "../../utils/formatTime";
import { agentIconComponent } from "../../utils/agentIcon";
import {
  DASH_COLORS, baseAxis, disposeChart, hexAlpha, initChart, softTooltip, themeOf
} from "../../composables/useEcharts";
import type { Chart } from "../../composables/useEcharts";

interface DayRow { date: string; total: number; ok: number; err: number; admin: number; user: number; code: number; anon: number; logins: number; new_sessions: number; avg_duration_s: number; }
interface AgentRow { id: string; code: string; name: string; icon?: string; questions: number; ok: number; err: number; rate_pct: number; avg_duration_s: number; last_active: string | null; }
interface ProtoRow { name: string; questions: number; ok: number; err: number; rate_pct: number; avg_duration_s: number; enabled: boolean; }
interface StatsData {
  ok: boolean; days: number; generated_at: string;
  summary: {
    records_total: number; records_today: number; records_today_prev: number; records_range: number;
    sessions_total: number; sessions_range: number; users_active: number; codes_active: number; agents_total: number;
    online: { auth_sessions: number; sse: number; groups: number };
    active_qa: number; uptime_s: number; error_rate_range_pct: number; avg_duration_s: number;
  };
  daily: DayRow[];
  hours: { hour: number; count: number }[];
  agents: AgentRow[];
  protocols: ProtoRow[];
  errors: { protocol: string; detail: string; count: number }[];
}

const PROTO_NAMES: Record<string, string> = { openai: "OpenAI 兼容", dify: "编排引擎", generic: "第三方通用", ragflow: "知识引擎" };

const { lightTheme } = useTheme();
const days = ref(7);
const auto = ref(true);
const ident = ref("all"); // 提问趋势身份筛选：all / admin / user / code / anon
const loading = ref(false);
const error = ref("");
const data = ref<StatsData | null>(null);

const elTrend = ref<HTMLDivElement | null>(null);
const elHours = ref<HTMLDivElement | null>(null);
const elVisit = ref<HTMLDivElement | null>(null);
let charts: Record<string, Chart> = {};
let timer: number | null = null;

async function load(fresh = false) {
  loading.value = true;
  error.value = "";
  try {
    const r = await fetch("/api/admin/stats?days=" + days.value + (fresh ? "&fresh=1" : ""), { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    data.value = (await r.json()) as StatsData;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + "d " + h + "h " + m + "m";
  if (h > 0) return h + "h " + m + "m";
  return m + "m " + (sec % 60) + "s";
}
function round1(x: number): number { return Math.round(x * 10) / 10; }

// ---- 第一层：核心指标卡（5 张；数字中性、变化绿/红、sparkline 极轻）----
interface Kpi { k: string; v: string; unit?: string; d?: string; dCls?: "good" | "bad"; sub?: string; spark?: number[]; }
const rangeErr = computed(() => (data.value ? data.value.daily.reduce((s, x) => s + x.err, 0) : 0));
const ratePct = computed(() => {
  if (!data.value || !data.value.summary.records_range) return null;
  return Math.round((100 - data.value.summary.error_rate_range_pct) * 10) / 10;
});
const kpis = computed<Kpi[]>(() => {
  if (!data.value) return [];
  const s = data.value.summary;
  const d = data.value.daily;
  const todayRow = d[d.length - 1];
  const online = s.online.auth_sessions + s.online.groups;
  const out: Kpi[] = [];
  // 今日提问（较昨日 + 期间提问 sparkline）
  const spark = d.map((x) => x.total);
  let dd: string | undefined, dcls: "good" | "bad" | undefined, sub: string | undefined;
  if (s.records_today_prev > 0) {
    const pct = Math.round(((s.records_today - s.records_today_prev) / s.records_today_prev) * 100);
    dd = (pct >= 0 ? "↑ " : "↓ ") + Math.abs(pct) + "%"; dcls = pct >= 0 ? "good" : "bad"; sub = "较昨日";
  } else {
    sub = s.records_today > 0 ? "昨日 0 次" : "较昨日持平";
  }
  out.push({ k: "今日提问", v: String(s.records_today), unit: "次", d: dd, dCls: dcls, sub, spark });
  // 在线访客（实时）
  out.push({ k: "在线访客", v: String(online), sub: "实时 · 会话 " + s.online.auth_sessions + " · SSE " + s.online.sse });
  // 期间提问
  out.push({ k: "期间提问", v: String(s.records_range), unit: "次", sub: "近 " + data.value.days + " 天 · 新建会话 " + s.sessions_range });
  // 成功率
  if (ratePct.value !== null) {
    const bad = s.error_rate_range_pct > 10;
    out.push({ k: "成功率", v: ratePct.value.toFixed(1), unit: "%", sub: "期间错误 " + rangeErr.value + " 次", d: bad ? "异常" : "正常", dCls: bad ? "bad" : "good" });
  } else {
    out.push({ k: "成功率", v: "—", sub: "期间无提问" });
  }
  // 平均响应（今日 vs 期间平均；sparkline = 每日均值）
  const avgSpark = d.map((x) => x.avg_duration_s);
  if (s.avg_duration_s > 0) {
    let dd2: string | undefined, dcls2: "good" | "bad" | undefined;
    if (todayRow && todayRow.avg_duration_s > 0) {
      const diff = round1(todayRow.avg_duration_s - s.avg_duration_s);
      if (Math.abs(diff) >= 0.1) { dd2 = (diff > 0 ? "↑ " : "↓ ") + Math.abs(diff) + "s"; dcls2 = diff > 0 ? "bad" : "good"; }
    }
    out.push({ k: "平均响应", v: String(s.avg_duration_s), unit: "s", d: dd2, dCls: dcls2, sub: dd2 ? "较期间均值" : "期间均值", spark: avgSpark });
  } else {
    out.push({ k: "平均响应", v: "—", sub: "期间无完成记录" });
  }
  return out;
});
// sparkline → SVG 点列（100×26 viewBox，0 = 底）
function sparkPts(vals: number[]): string {
  const max = Math.max(...vals, 1);
  const n = vals.length;
  return vals.map((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * 100 : 50;
    const y = 25 - (v / max) * 22;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
}
function hasSpark(vals?: number[]): boolean {
  return !!vals && vals.some((v) => v > 0);
}

// ---- 第二层：提问趋势（主图）+ 系统状态 ----
const IDENTS: [string, string][] = [["all", "全部"], ["admin", "管理员"], ["user", "用户"], ["code", "访问码"], ["anon", "匿名"]];
const IDENT_KEY: Record<string, keyof DayRow> = { all: "total", admin: "admin", user: "user", code: "code", anon: "anon" };
function trendOption() {
  const t = themeOf(document.body);
  const d = data.value!.daily;
  const key = IDENT_KEY[ident.value] || "total";
  const name = (IDENTS.find((x) => x[0] === ident.value) || IDENTS[0])[1];
  return {
    color: [t.accent],
    tooltip: Object.assign({ trigger: "axis", axisPointer: { type: "line", lineStyle: { color: t.axis } } }, softTooltip(t)),
    grid: { left: 30, right: 12, top: 14, bottom: 24 },
    xAxis: Object.assign({ type: "category", boundaryGap: false, data: d.map((x) => x.date.slice(5)),
      axisLabel: { color: t.sub, interval: Math.max(0, Math.ceil(d.length / 10) - 1) } }, baseAxis(t)),
    yAxis: { type: "value", minInterval: 1, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.sub },
      splitLine: { lineStyle: { color: t.axis, type: "dashed", opacity: 0.4 } } },
    series: [{
      name: name + "提问", type: "line", smooth: 0.25, symbol: "circle", symbolSize: 5,
      showSymbol: d.length <= 14, lineStyle: { width: 2, color: t.accent }, itemStyle: { color: t.accent },
      areaStyle: { color: hexAlpha(t.accent, 0.13) },
      data: d.map((x) => x[key] as number)
    }]
  };
}

// ---- 第三层：24h 活跃热力（近 7 天固定口径）+ 登录/新建迷你趋势 ----
function hoursOption() {
  const t = themeOf(document.body);
  const h = data.value!.hours;
  const max = h.reduce((m, x) => Math.max(m, x.count), 0);
  return {
    tooltip: Object.assign({ formatter: (p: { value: [number, number, number] }) => String(p.value[0]).padStart(2, "0") + ":00 · " + p.value[2] + " 次提问" }, softTooltip(t)),
    grid: { left: 2, right: 2, top: 2, bottom: 2 },
    xAxis: { type: "category", data: h.map((x) => String(x.hour).padStart(2, "0")), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.sub, fontSize: 10, formatter: (v: string) => (Number(v) % 6 === 0 ? v : "") }, splitLine: { show: false } },
    yAxis: { type: "category", data: ["活跃"], show: false },
    visualMap: { type: "continuous", min: 0, max: Math.max(max, 1), show: false,
      inRange: { color: [hexAlpha(t.accent, 0.06), t.accent] } },
    series: [{ type: "heatmap", data: h.map((x, i) => [i, 0, x.count]),
      itemStyle: { borderColor: t.overlay, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { shadowBlur: 4, shadowColor: "rgba(0,0,0,0.25)" } } }]
  };
}
function visitOption() {
  const t = themeOf(document.body);
  const d = data.value!.daily;
  return {
    color: [t.accent, DASH_COLORS.user],
    tooltip: Object.assign({ trigger: "axis" }, softTooltip(t)),
    grid: { left: 4, right: 4, top: 4, bottom: 2 },
    xAxis: { type: "category", boundaryGap: false, data: d.map((x) => x.date.slice(5)), show: false },
    yAxis: { type: "value", show: false, splitLine: { show: false } },
    series: [
      { name: "登录", type: "line", smooth: 0.25, showSymbol: false, lineStyle: { width: 1.5 }, itemStyle: { color: t.accent }, data: d.map((x) => x.logins) },
      { name: "新建会话", type: "line", smooth: 0.25, showSymbol: false, lineStyle: { width: 1.5 }, itemStyle: { color: DASH_COLORS.user }, data: d.map((x) => x.new_sessions) }
    ]
  };
}

// ---- 智能体（单 = 摘要卡；多 = Top5 排行 + 选中详情）----
const topAgents = computed(() => (data.value ? data.value.agents.slice(0, 5) : []));
const selAgentKey = ref("");
const selAgent = computed<AgentRow | null>(() => {
  if (!data.value) return null;
  return data.value.agents.find((a) => (a.id || a.name) === selAgentKey.value) || data.value.agents[0] || null;
});
function agentKey(a: AgentRow): string { return a.id || a.name; }
function agentBarW(a: AgentRow): string {
  const max = topAgents.value.reduce((m, x) => Math.max(m, x.questions), 0);
  return max ? Math.max(3, Math.round((a.questions / max) * 100)) + "%" : "0%";
}

// ---- 协议（比例条；停用 = 灰点，仅错误用红）----
function protoBarW(p: ProtoRow): string {
  const max = data.value?.protocols.reduce((m, x) => Math.max(m, x.questions), 0) || 0;
  return max ? Math.max(3, Math.round((p.questions / max) * 100)) + "%" : "0%";
}

// ---- 异常（0 = 健康态；否则 Top5 紧凑排行）----
const topErrors = computed(() => (data.value ? data.value.errors.slice(0, 5) : []));
function errBarW(c: number): string {
  const max = topErrors.value.reduce((m, x) => Math.max(m, x.count), 0);
  return max ? Math.max(6, Math.round((c / max) * 100)) + "%" : "0%";
}

// ---- 渲染 ----
function renderOne(key: string, el: HTMLDivElement | null, opt: unknown) {
  if (!el) return;
  if (!charts[key]) charts[key] = initChart(el);
  charts[key].setOption(opt as never, true);
}
function renderAll() {
  if (!data.value) return;
  renderOne("trend", elTrend.value, trendOption());
  renderOne("hours", elHours.value, hoursOption());
  renderOne("visit", elVisit.value, visitOption());
}
const emptyTrend = computed(() => !!data.value && data.value.daily.every((x) => x.total === 0));
const emptyHours = computed(() => !!data.value && data.value.hours.every((x) => x.count === 0));
const emptyVisit = computed(() => !!data.value && data.value.daily.every((x) => x.logins === 0 && x.new_sessions === 0));
const emptyAgents = computed(() => !!data.value && data.value.agents.length === 0);
const totalErr = rangeErr; // ComputedRef 直接复用（勿套 computed()）

function startTimer() {
  stopTimer();
  if (auto.value) timer = window.setInterval(() => { if (!document.hidden) load(); }, 60000);
}
function stopTimer() {
  if (timer !== null) { window.clearInterval(timer); timer = null; }
}
watch(days, load);
watch(ident, () => { if (data.value) renderOne("trend", elTrend.value, trendOption()); });
watch([lightTheme, data], () => { if (data.value) renderAll(); }, { flush: "post" });
watch(auto, startTimer);
onMounted(() => { load(); startTimer(); });
onBeforeUnmount(() => {
  stopTimer();
  for (const k of Object.keys(charts)) disposeChart(charts[k]);
  charts = {};
});
</script>

<template>
  <div class="dash" v-loading="loading && !data">
    <div class="dash-bar">
      <el-radio-group v-model="days" size="small">
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="14">近 14 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
      </el-radio-group>
      <div class="dash-bar-r">
        <el-switch v-model="auto" size="small" />
        <span class="dash-dim" v-if="auto">自动刷新 60s</span>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="load(true)">刷新</el-button>
        <span class="dash-dim" v-if="data">更新于 {{ fmtDateTime(data.generated_at) }}</span>
      </div>
    </div>

    <el-alert v-if="error" class="dash-err" type="error" show-icon :closable="false"
      :title="'获取统计失败：' + error + '（点击重试）'" @click="load(true)" />

    <template v-if="data">
      <!-- 第一层：核心指标 -->
      <div class="kpi-grid">
        <div class="kpi" v-for="c in kpis" :key="c.k">
          <div class="kpi-k">{{ c.k }}</div>
          <div class="kpi-v">{{ c.v }}<span class="kpi-unit" v-if="c.unit">{{ c.unit }}</span></div>
          <div class="kpi-d">
            <span v-if="c.d" :class="c.dCls === 'good' ? 'd-good' : c.dCls === 'bad' ? 'd-bad' : 'dash-dim'">{{ c.d }}</span>
            <span class="dash-dim" v-if="c.sub">{{ c.sub }}</span>
          </div>
          <svg v-if="hasSpark(c.spark)" class="kpi-spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
            <polygon :points="'0,26 ' + sparkPts(c.spark!) + ' 100,26'" class="kpi-spark-area" />
            <polyline :points="sparkPts(c.spark!)" class="kpi-spark-line" />
          </svg>
        </div>
      </div>

      <!-- 第二层：提问趋势（主图）+ 系统状态 -->
      <div class="row-trend">
        <div class="panel">
          <div class="panel-h">
            <span class="panel-t">提问趋势</span>
            <span class="panel-sub">近 {{ data.days }} 天</span>
            <span class="panel-sub rate-chip" v-if="ratePct !== null">成功率 {{ ratePct.toFixed(1) }}%</span>
            <div class="seg">
              <button v-for="opt in IDENTS" :key="opt[0]" type="button" class="seg-i"
                :class="{ on: ident === opt[0] }" @click="ident = opt[0]">{{ opt[1] }}</button>
            </div>
          </div>
          <div class="c-trend" ref="elTrend"></div>
          <div class="panel-empty" v-if="emptyTrend">期间暂无提问</div>
        </div>
        <div class="panel status">
          <div class="panel-h">
            <span class="panel-t">系统状态</span>
            <span class="live"><span class="live-dot"></span>服务正常</span>
          </div>
          <div class="stat-grid">
            <div class="stat"><span class="stat-k">运行时长</span><b>{{ fmtUptime(data.summary.uptime_s) }}</b></div>
            <div class="stat"><span class="stat-k">在线访客</span><b>{{ data.summary.online.auth_sessions + data.summary.online.groups }}</b></div>
            <div class="stat"><span class="stat-k">进行中 QA</span><b>{{ data.summary.active_qa }}</b></div>
            <div class="stat"><span class="stat-k">SSE 连接</span><b>{{ data.summary.online.sse }}</b></div>
            <div class="stat"><span class="stat-k">活跃用户</span><b>{{ data.summary.users_active }}</b></div>
            <div class="stat"><span class="stat-k">有效访问码</span><b>{{ data.summary.codes_active }}</b></div>
            <div class="stat"><span class="stat-k">智能体</span><b>{{ data.summary.agents_total }}</b></div>
            <div class="stat"><span class="stat-k">期间提问</span><b>{{ data.summary.records_range }}</b></div>
          </div>
        </div>
      </div>

      <!-- 第三层：智能体使用 + 用户活跃 -->
      <div class="row-eq">
        <div class="panel">
          <div class="panel-h">
            <span class="panel-t">智能体使用</span>
            <span class="panel-sub">期间提问量 · Top {{ Math.min(5, topAgents.length) }}（点击行查看详情）</span>
          </div>
          <div v-if="emptyAgents" class="panel-block-empty">暂无提问数据</div>
          <template v-else>
            <!-- 单智能体：摘要卡 -->
            <div class="agent-solo" v-if="topAgents.length === 1">
              <div class="agent-solo-head">
                <el-icon :size="30" class="agent-ic-solo"><component :is="agentIconComponent(topAgents[0].icon)" /></el-icon>
                <div>
                  <div class="agent-solo-name">{{ topAgents[0].name }}</div>
                  <div class="dash-dim agent-solo-code">{{ topAgents[0].code || "-" }}</div>
                </div>
              </div>
              <div class="agent-solo-m">
                <div><b>{{ topAgents[0].questions }}</b><span>提问</span></div>
                <div><b :class="{ 'd-bad': topAgents[0].rate_pct < 80 }">{{ topAgents[0].rate_pct }}%</b><span>成功率</span></div>
                <div><b>{{ topAgents[0].avg_duration_s }}s</b><span>平均响应</span></div>
              </div>
              <div class="dash-dim agent-solo-last">最近活跃：{{ topAgents[0].last_active ? fmtDateTime(topAgents[0].last_active) : "-" }}</div>
            </div>
            <!-- 多智能体：Top5 排行 + 选中详情 -->
            <template v-else>
              <div class="agent-list">
                <div class="agent-row" v-for="(a, i) in topAgents" :key="a.id || i"
                  :class="{ sel: (a.id || a.name) === agentKey(selAgent!) }" @click="selAgentKey = agentKey(a)">
                  <span class="agent-rank">{{ i + 1 }}</span>
                  <el-icon :size="16" class="agent-ic"><component :is="agentIconComponent(a.icon)" /></el-icon>
                  <span class="agent-name" :title="a.name">{{ a.name }}</span>
                  <div class="agent-bar"><div class="agent-bar-i" :style="{ width: agentBarW(a) }" /></div>
                  <span class="agent-q">{{ a.questions }}</span>
                  <span class="agent-rate" :class="{ 'd-bad': a.rate_pct < 80 }">{{ a.rate_pct }}%</span>
                </div>
              </div>
              <div class="agent-detail" v-if="selAgent">
                <span>提问 <b>{{ selAgent.questions }}</b></span>
                <span>成功率 <b :class="{ 'd-bad': selAgent.rate_pct < 80 }">{{ selAgent.rate_pct }}%</b></span>
                <span>平均响应 <b>{{ selAgent.avg_duration_s }}s</b></span>
                <span>最近活跃 <b>{{ selAgent.last_active ? fmtDateTime(selAgent.last_active) : "-" }}</b></span>
              </div>
            </template>
          </template>
        </div>
        <div class="panel">
          <div class="panel-h">
            <span class="panel-t">用户活跃</span>
            <span class="panel-sub">24h 分布 · 近 7 天（本地时区）</span>
          </div>
          <div class="c-hours" ref="elHours"></div>
          <div class="panel-block-empty small" v-if="emptyHours">近 7 天暂无提问</div>
          <div class="visit-legend">
            <span><i class="dot dot-a"></i>登录</span>
            <span><i class="dot dot-b"></i>新建会话</span>
            <span class="visit-sum dash-dim">期间登录 {{ data.daily.reduce((s, x) => s + x.logins, 0) }} 次 · 新建会话 {{ data.daily.reduce((s, x) => s + x.new_sessions, 0) }} 次</span>
          </div>
          <div class="c-visit" ref="elVisit" v-show="!emptyVisit"></div>
          <div class="panel-block-empty small" v-if="emptyVisit">期间无登录 / 新建会话记录</div>
        </div>
      </div>

      <!-- 第四层：协议使用 + 系统异常 -->
      <div class="row-eq">
        <div class="panel">
          <div class="panel-h">
            <span class="panel-t">协议使用</span>
            <span class="panel-sub">期间提问量 · 启用状态</span>
          </div>
          <div class="proto-list">
            <div class="proto-row" v-for="p in data.protocols" :key="p.name" :class="{ off: !p.enabled }">
              <span class="proto-dot" :class="{ on: p.enabled }"></span>
              <span class="proto-name">{{ PROTO_NAMES[p.name] || p.name }}<span class="proto-off" v-if="!p.enabled">已停用</span></span>
              <div class="proto-bar"><div class="proto-bar-i" v-if="p.questions > 0 && p.enabled" :style="{ width: protoBarW(p) }" /></div>
              <span class="proto-q">{{ p.questions }}<span class="dash-dim"> 次</span></span>
              <span class="proto-rate" :class="{ 'd-bad': p.questions > 0 && p.rate_pct < 80 }">{{ p.questions > 0 ? p.rate_pct + "%" : "—" }}</span>
              <span class="proto-dur dash-dim">{{ p.questions > 0 ? p.avg_duration_s + "s" : "—" }}</span>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-h">
            <span class="panel-t">系统异常</span>
            <span class="panel-sub">近 {{ data.days }} 天</span>
          </div>
          <div class="err-ok" v-if="totalErr === 0">
            <el-icon :size="34" class="err-ok-ic"><CircleCheck /></el-icon>
            <div>
              <b>当前暂无异常</b>
              <div class="dash-dim">期间无错误记录</div>
            </div>
          </div>
          <template v-else>
            <div class="err-head">
              <span class="err-total">{{ totalErr }} 次错误</span>
              <span class="dash-dim">错误率 {{ data.summary.error_rate_range_pct }}%</span>
            </div>
            <div class="err-list">
              <div class="err-row" v-for="(e, i) in topErrors" :key="i" :title="e.detail + '（' + (PROTO_NAMES[e.protocol] || e.protocol) + '）'">
                <span class="err-name">{{ e.detail }}</span>
                <div class="err-bar"><div :style="{ width: errBarW(e.count) }" /></div>
                <span class="err-n">{{ e.count }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 第五层：智能体明细 -->
      <div class="panel" v-if="!emptyAgents">
        <div class="panel-h">
          <span class="panel-t">智能体明细</span>
          <span class="panel-sub">近 {{ data.days }} 天 · 全部有提问记录的智能体</span>
        </div>
        <el-table :data="data.agents" size="small" class="dash-table">
          <el-table-column prop="name" label="智能体" min-width="110" show-overflow-tooltip />
          <el-table-column prop="code" label="code" min-width="90" show-overflow-tooltip />
          <el-table-column prop="questions" label="提问" min-width="64" align="right" />
          <el-table-column label="成功率" min-width="72" align="right">
            <template #default="{ row }"><span :class="{ 'd-bad': row.rate_pct < 80 }">{{ row.rate_pct }}%</span></template>
          </el-table-column>
          <el-table-column label="均耗时" min-width="70" align="right">
            <template #default="{ row }">{{ row.avg_duration_s }}s</template>
          </el-table-column>
          <el-table-column label="最近活跃" min-width="148">
            <template #default="{ row }">{{ row.last_active ? fmtDateTime(row.last_active) : "-" }}</template>
          </el-table-column>
        </el-table>
      </div>
    </template>
    <el-empty v-else-if="!loading && !error" description="暂无数据" />
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 14px; }
.dash-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dash-bar-r { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dash-dim { font-size: 12px; opacity: 0.65; }
.dash-err { cursor: pointer; }
.dash-table { margin-top: 4px; }

/* 第一层：核心指标卡 */
.kpi-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
@media (max-width: 1200px) { .kpi-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 767px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
.kpi { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 12px 14px 10px; }
.kpi-k { font-size: 12px; color: var(--el-text-color-secondary); }
.kpi-v { font-size: 24px; font-weight: 650; margin-top: 4px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.kpi-unit { font-size: 12px; font-weight: 400; color: var(--el-text-color-secondary); margin-left: 3px; }
.kpi-d { font-size: 12px; margin-top: 5px; min-height: 17px; display: flex; gap: 5px; align-items: baseline; }
.d-good { color: var(--el-color-success); font-weight: 600; }
.d-bad { color: var(--el-color-danger); font-weight: 600; }
.kpi-spark { width: 100%; height: 26px; margin-top: 6px; display: block; }
.kpi-spark-line { fill: none; stroke: var(--el-color-primary); stroke-width: 1.5; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }
.kpi-spark-area { fill: var(--el-color-primary); opacity: 0.08; }

/* 内容区块（轻边框、统一圆角） */
.row-trend { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; }
.row-eq { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 1200px) { .row-trend, .row-eq { grid-template-columns: 1fr; } }
.panel { position: relative; background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 14px 16px; min-width: 0; }
.panel-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.panel-t { font-size: 13.5px; font-weight: 600; }
.panel-sub { font-size: 12px; color: var(--el-text-color-secondary); }
.rate-chip { padding: 1px 8px; border-radius: 10px; background: var(--el-fill-color-light); }
.panel-empty { position: absolute; left: 0; right: 0; top: 44px; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--el-text-color-secondary); pointer-events: none; }
.panel-block-empty { padding: 34px 0; text-align: center; font-size: 12px; color: var(--el-text-color-secondary); }
.panel-block-empty.small { padding: 10px 0; }

/* 提问趋势身份切换 */
.seg { margin-left: auto; display: inline-flex; gap: 2px; padding: 2px; background: var(--el-fill-color-light); border-radius: 9px; }
.seg-i { border: none; background: transparent; padding: 3px 9px; font-size: 12px; color: var(--el-text-color-secondary); border-radius: 7px; cursor: pointer; transition: all .15s; }
.seg-i:hover { color: var(--el-text-color-primary); }
.seg-i.on { background: var(--el-bg-color); color: var(--el-color-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }

/* 图表尺寸 */
.c-trend { height: 300px; }
.c-hours { height: 52px; }
.c-visit { height: 60px; margin-top: 2px; }
@media (max-width: 767px) { .c-trend { height: 240px; } }

/* 系统状态 */
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--el-color-success); margin-left: auto; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--el-color-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--el-color-success) 18%, transparent); }
.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-k { font-size: 12px; color: var(--el-text-color-secondary); }
.stat b { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* 智能体使用 */
.agent-solo { display: flex; flex-direction: column; gap: 12px; padding: 6px 2px 4px; }
.agent-solo-head { display: flex; align-items: center; gap: 12px; }
.agent-ic-solo { color: var(--el-color-primary); }
.agent-solo-name { font-size: 16px; font-weight: 600; }
.agent-solo-code { font-size: 12px; }
.agent-solo-m { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.agent-solo-m div { display: flex; flex-direction: column; gap: 2px; background: var(--el-fill-color-light); border-radius: 10px; padding: 10px 12px; }
.agent-solo-m b { font-size: 18px; font-variant-numeric: tabular-nums; }
.agent-solo-m span { font-size: 12px; color: var(--el-text-color-secondary); }
.agent-solo-last { font-size: 12px; }
.agent-list { display: flex; flex-direction: column; gap: 6px; }
.agent-row { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 10px; cursor: pointer; transition: background .15s; }
.agent-row:hover { background: var(--el-fill-color-light); }
.agent-row.sel { background: var(--el-fill-color-light); outline: 1px solid var(--el-color-primary-light-7); }
.agent-rank { width: 18px; font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; text-align: center; flex: none; }
.agent-ic { color: var(--el-color-primary); flex: none; }
.agent-name { width: 108px; flex: none; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-bar { flex: 1; height: 8px; border-radius: 4px; background: var(--el-fill-color-light); overflow: hidden; min-width: 40px; }
.agent-bar-i { height: 100%; border-radius: 4px; background: var(--el-color-primary); opacity: 0.85; }
.agent-q { width: 44px; flex: none; text-align: right; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.agent-rate { width: 46px; flex: none; text-align: right; font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.agent-detail { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--el-border-color-lighter); font-size: 12px; color: var(--el-text-color-secondary); }
.agent-detail b { color: var(--el-text-color-primary); font-variant-numeric: tabular-nums; margin-left: 2px; }

/* 用户活跃 */
.visit-legend { display: flex; align-items: center; gap: 14px; margin-top: 10px; font-size: 12px; color: var(--el-text-color-secondary); }
.visit-legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.dot-a { background: var(--el-color-primary); }
.dot-b { background: #5ad8a6; }
.visit-sum { margin-left: auto; }

/* 协议使用 */
.proto-list { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 2px; }
.proto-row { display: flex; align-items: center; gap: 9px; }
.proto-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--el-border-color); flex: none; }
.proto-dot.on { background: var(--el-color-success); }
.proto-name { width: 116px; flex: none; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.proto-off { font-size: 11px; color: var(--el-text-color-secondary); padding: 0 6px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.proto-row.off { opacity: 0.55; }
.proto-bar { flex: 1; height: 8px; border-radius: 4px; background: var(--el-fill-color-light); overflow: hidden; }
.proto-bar-i { height: 100%; border-radius: 4px; background: var(--el-color-primary); opacity: 0.85; }
.proto-q { width: 52px; flex: none; text-align: right; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.proto-rate { width: 46px; flex: none; text-align: right; font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.proto-dur { width: 40px; flex: none; text-align: right; font-variant-numeric: tabular-nums; }

/* 系统异常 */
.err-ok { display: flex; align-items: center; gap: 14px; padding: 22px 6px; }
.err-ok-ic { color: var(--el-color-success); }
.err-ok b { font-size: 14px; display: block; margin-bottom: 3px; }
.err-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.err-total { font-size: 15px; font-weight: 600; color: var(--el-color-danger); font-variant-numeric: tabular-nums; }
.err-list { display: flex; flex-direction: column; gap: 8px; }
.err-row { display: flex; align-items: center; gap: 9px; }
.err-name { width: 148px; flex: none; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.err-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--el-fill-color-light); overflow: hidden; }
.err-bar > div { height: 100%; border-radius: 3px; background: var(--el-color-danger); opacity: 0.75; }
.err-n { width: 26px; flex: none; text-align: right; font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
</style>
