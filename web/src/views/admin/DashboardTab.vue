<script setup lang="ts">
// P8.48 控制台仪表盘：访问 / 提问 / 活跃 / 运行 多维图表
// 数据源 GET /api/admin/stats?days=N（服务端 30s 缓存；实时块 60s 自刷，可关）
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Refresh } from "@element-plus/icons-vue";
import { useTheme } from "../../composables/useTheme";
import { fmtDateTime } from "../../utils/formatTime";
import { DASH_COLORS, baseAxis, disposeChart, initChart, themeOf } from "../../composables/useEcharts";
import type { Chart } from "../../composables/useEcharts";

interface DayRow { date: string; total: number; ok: number; err: number; admin: number; user: number; code: number; anon: number; logins: number; new_sessions: number; avg_duration_s: number; }
interface AgentRow { id: string; code: string; name: string; questions: number; ok: number; err: number; rate_pct: number; avg_duration_s: number; last_active: string | null; }
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

const { lightTheme } = useTheme();
const days = ref(7);
const auto = ref(true);
const loading = ref(false);
const error = ref("");
const data = ref<StatsData | null>(null);

const elTrend = ref<HTMLDivElement | null>(null);
const elVisit = ref<HTMLDivElement | null>(null);
const elHours = ref<HTMLDivElement | null>(null);
const elAgents = ref<HTMLDivElement | null>(null);
const elProtocols = ref<HTMLDivElement | null>(null);
const elErrors = ref<HTMLDivElement | null>(null);
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
function truncate(v: string, n: number): string { return v.length > n ? v.slice(0, n) + "…" : v; }

// ---- 各图 option（主题色从容器 CSS 变量读取）----
function trendOption() {
  const t = themeOf(document.body);
  const d = data.value!.daily;
  return {
    color: [DASH_COLORS.admin, DASH_COLORS.user, DASH_COLORS.code, DASH_COLORS.anon, DASH_COLORS.line],
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, textStyle: { color: t.text } },
    grid: { left: 46, right: 52, top: 18, bottom: 42 },
    xAxis: Object.assign({ type: "category", data: d.map((x) => x.date.slice(5)) }, baseAxis(t)),
    yAxis: [
      Object.assign({ type: "value", name: "次数" }, baseAxis(t)),
      { type: "value", name: "成功率", min: 0, max: 100, axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false }, axisLabel: { color: t.text, formatter: "{value}%" }, splitLine: { show: false } }
    ],
    series: [
      { name: "管理", type: "bar", stack: "q", barMaxWidth: 28, data: d.map((x) => x.admin) },
      { name: "用户", type: "bar", stack: "q", barMaxWidth: 28, data: d.map((x) => x.user) },
      { name: "访问码", type: "bar", stack: "q", barMaxWidth: 28, data: d.map((x) => x.code) },
      { name: "匿名", type: "bar", stack: "q", barMaxWidth: 28, data: d.map((x) => x.anon) },
      { name: "成功率", type: "line", yAxisIndex: 1, symbolSize: 5, data: d.map((x) => (x.total ? round1(((x.total - x.err) / x.total) * 100) : null)) }
    ]
  };
}
function visitOption() {
  const t = themeOf(document.body);
  const d = data.value!.daily;
  return {
    color: [DASH_COLORS.code, DASH_COLORS.user],
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, textStyle: { color: t.text } },
    grid: { left: 42, right: 18, top: 18, bottom: 42 },
    xAxis: Object.assign({ type: "category", data: d.map((x) => x.date.slice(5)) }, baseAxis(t)),
    yAxis: Object.assign({ type: "value" }, baseAxis(t)),
    series: [
      { name: "登录", type: "bar", barMaxWidth: 18, data: d.map((x) => x.logins) },
      { name: "新建会话", type: "bar", barMaxWidth: 18, data: d.map((x) => x.new_sessions) }
    ]
  };
}
function hoursOption() {
  const t = themeOf(document.body);
  const h = data.value!.hours;
  const max = h.reduce((m, x) => (x.count > m.count ? x : m), h[0]);
  return {
    color: [DASH_COLORS.line],
    tooltip: { trigger: "axis", formatter: (ps: { name: string; value: number }[]) => ps[0].name + " 时 · " + ps[0].value + " 次提问" },
    grid: { left: 42, right: 18, top: 30, bottom: 24 },
    xAxis: Object.assign({ type: "category", data: h.map((x) => String(x.hour)) }, baseAxis(t)),
    yAxis: Object.assign({ type: "value" }, baseAxis(t)),
    series: [{ name: "提问", type: "bar", barMaxWidth: 16, data: h.map((x) => x.count),
      markPoint: max.count > 0 ? { data: [{ type: "max", name: "峰值" }], symbolSize: 40, label: { color: "#fff", fontSize: 10 } } : { data: [] } }]
  };
}
function agentsOption() {
  const t = themeOf(document.body);
  const list = data.value!.agents.slice(0, 5).reverse();
  return {
    color: [DASH_COLORS.admin],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 118, right: 34, top: 10, bottom: 22 },
    xAxis: Object.assign({ type: "value" }, baseAxis(t)),
    yAxis: Object.assign({ type: "category", data: list.map((a) => a.name), axisLabel: { color: t.text, formatter: (v: string) => truncate(v, 8) } }, baseAxis(t)),
    series: [{ name: "提问", type: "bar", barMaxWidth: 16, data: list.map((a) => a.questions) }]
  };
}
function protocolsOption() {
  const t = themeOf(document.body);
  const list = data.value!.protocols.filter((p) => p.questions > 0);
  return {
    color: DASH_COLORS.pie,
    tooltip: { trigger: "item", formatter: "{b}: {c} 次 ({d}%)" },
    legend: { bottom: 0, textStyle: { color: t.text } },
    series: [{ type: "pie", radius: ["38%", "62%"], center: ["50%", "44%"], label: { color: t.text },
      data: list.map((x) => ({ name: x.name, value: x.questions })) }]
  };
}
function errorsOption() {
  const t = themeOf(document.body);
  const list = data.value!.errors.slice(0, 8).reverse();
  return {
    color: [DASH_COLORS.error],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps: { name: string; value: number }[]) => {
        const row = data.value!.errors.find((e) => e.detail === ps[0].name);
        return (row ? row.protocol + " · " : "") + ps[0].name + "<br/>" + ps[0].value + " 次";
      } },
    grid: { left: 140, right: 34, top: 10, bottom: 22 },
    xAxis: Object.assign({ type: "value" }, baseAxis(t)),
    yAxis: Object.assign({ type: "category", data: list.map((e) => e.detail), axisLabel: { color: t.text, formatter: (v: string) => truncate(v, 16) } }, baseAxis(t)),
    series: [{ name: "错误", type: "bar", barMaxWidth: 14, data: list.map((e) => e.count) }]
  };
}

function renderOne(key: string, el: HTMLDivElement | null, opt: unknown) {
  if (!el) return;
  if (!charts[key]) charts[key] = initChart(el);
  charts[key].setOption(opt as never, true);
}
function renderAll() {
  if (!data.value) return;
  renderOne("trend", elTrend.value, trendOption());
  renderOne("visit", elVisit.value, visitOption());
  renderOne("hours", elHours.value, hoursOption());
  renderOne("agents", elAgents.value, agentsOption());
  renderOne("protocols", elProtocols.value, protocolsOption());
  renderOne("errors", elErrors.value, errorsOption());
}

const emptyTrend = computed(() => !!data.value && data.value.daily.every((x) => x.total === 0));
const emptyVisit = computed(() => !!data.value && data.value.daily.every((x) => x.logins === 0 && x.new_sessions === 0));
const emptyHours = computed(() => !!data.value && data.value.hours.every((x) => x.count === 0));
const emptyAgents = computed(() => !!data.value && data.value.agents.length === 0);
const emptyProtocols = computed(() => !!data.value && data.value.protocols.every((x) => x.questions === 0));
const emptyErrors = computed(() => !!data.value && data.value.errors.length === 0);

const cards = computed(() => {
  if (!data.value) return [];
  const s = data.value.summary;
  const todayRow = data.value.daily[data.value.daily.length - 1];
  const delta = s.records_today_prev > 0 ? Math.round(((s.records_today - s.records_today_prev) / s.records_today_prev) * 100) : null;
  return [
    { k: "今日提问", v: String(s.records_today), unit: "次", delta: delta as number | null },
    { k: "今日登录", v: String(todayRow ? todayRow.logins : 0), unit: "次", delta: null as number | null },
    { k: "在线访客", v: String(s.online.auth_sessions + s.online.groups), unit: "", delta: null as number | null, sub: "会话 " + s.online.auth_sessions + " · SSE " + s.online.sse },
    { k: "累计提问", v: String(s.records_total), unit: "次", delta: null as number | null },
    { k: "期间错误率", v: String(s.error_rate_range_pct), unit: "%", delta: null as number | null, warn: s.error_rate_range_pct > 10 },
    { k: "服务运行时长", v: fmtUptime(s.uptime_s), unit: "", delta: null as number | null }
  ];
});

function startTimer() {
  stopTimer();
  if (auto.value) timer = window.setInterval(() => { if (!document.hidden) load(); }, 60000);
}
function stopTimer() {
  if (timer !== null) { window.clearInterval(timer); timer = null; }
}
watch(days, load);
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
  <div class="dash" v-loading="loading">
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
      <el-row :gutter="14" class="dash-cards">
        <el-col :xs="12" :sm="8" :md="4" :lg="4" v-for="c in cards" :key="c.k">
          <div class="dash-card" :class="{ warn: c.warn }">
            <div class="dash-card-v">{{ c.v }}<span class="dash-card-unit" v-if="c.unit">{{ c.unit }}</span></div>
            <div class="dash-card-k">{{ c.k }}</div>
            <div class="dash-card-d" v-if="c.delta !== null"><span :class="c.delta >= 0 ? 'up' : 'down'">{{ c.delta >= 0 ? "+" : "-" }}{{ Math.abs(c.delta) }}%</span><span class="dash-dim"> 较昨日</span></div>
            <div class="dash-card-d dash-dim" v-else-if="c.sub">{{ c.sub }}</div>
          </div>
        </el-col>
      </el-row>

      <el-row :gutter="14" class="dash-grid">
        <el-col :xs="24" :md="24">
          <div class="dash-panel">
            <div class="dash-ph">提问趋势<span class="dash-dim">近 {{ days }} 天 · 按身份堆叠 · 折线 = 成功率</span></div>
            <div class="dash-chart" ref="elTrend"></div>
            <div class="dash-empty" v-if="emptyTrend">暂无提问数据</div>
          </div>
        </el-col>
        <el-col :xs="24" :md="12">
          <div class="dash-panel">
            <div class="dash-ph">访问趋势<span class="dash-dim">每日登录 + 新建会话（匿名无历史口径，实时见「访问控制」）</span></div>
            <div class="dash-chart sm" ref="elVisit"></div>
            <div class="dash-empty" v-if="emptyVisit">暂无访问数据</div>
          </div>
        </el-col>
        <el-col :xs="24" :md="12">
          <div class="dash-panel">
            <div class="dash-ph">活跃时段<span class="dash-dim">近 7 天 · 按小时（本地时区）· 峰值标注</span></div>
            <div class="dash-chart sm" ref="elHours"></div>
            <div class="dash-empty" v-if="emptyHours">暂无提问数据</div>
          </div>
        </el-col>
        <el-col :xs="24" :md="12">
          <div class="dash-panel">
            <div class="dash-ph">智能体维度<span class="dash-dim">期间提问量（横向 Top5 + 明细表）</span></div>
            <div class="dash-chart sm" ref="elAgents"></div>
            <div class="dash-empty" v-if="emptyAgents">暂无提问数据</div>
            <el-table v-if="!emptyAgents" :data="data.agents" size="small" class="dash-table" max-height="220">
              <el-table-column prop="name" label="智能体" min-width="110" show-overflow-tooltip />
              <el-table-column prop="code" label="code" min-width="90" show-overflow-tooltip />
              <el-table-column prop="questions" label="提问" min-width="64" align="right" />
              <el-table-column label="成功率" min-width="72" align="right">
                <template #default="{ row }"><span :class="{ warn: row.rate_pct < 80 }">{{ row.rate_pct }}%</span></template>
              </el-table-column>
              <el-table-column label="均耗时" min-width="70" align="right">
                <template #default="{ row }">{{ row.avg_duration_s }}s</template>
              </el-table-column>
              <el-table-column label="最近活跃" min-width="148">
                <template #default="{ row }">{{ row.last_active ? fmtDateTime(row.last_active) : "-" }}</template>
              </el-table-column>
            </el-table>
          </div>
        </el-col>
        <el-col :xs="24" :md="12">
          <div class="dash-panel">
            <div class="dash-ph">协议维度<span class="dash-dim">期间提问占比（饼）+ 成功率 / 启用状态</span></div>
            <div class="dash-chart sm" ref="elProtocols"></div>
            <div class="dash-empty" v-if="emptyProtocols">暂无提问数据</div>
            <el-table v-if="!emptyProtocols" :data="data.protocols" size="small" class="dash-table">
              <el-table-column prop="name" label="协议" min-width="76" />
              <el-table-column prop="questions" label="提问" min-width="64" align="right" />
              <el-table-column label="成功率" min-width="72" align="right">
                <template #default="{ row }"><span :class="{ warn: row.rate_pct < 80 }">{{ row.rate_pct }}%</span></template>
              </el-table-column>
              <el-table-column label="均耗时" min-width="70" align="right">
                <template #default="{ row }">{{ row.avg_duration_s }}s</template>
              </el-table-column>
              <el-table-column label="状态" min-width="64">
                <template #default="{ row }"><el-tag size="small" :type="row.enabled ? 'success' : 'danger'">{{ row.enabled ? "启用" : "已停用" }}</el-tag></template>
              </el-table-column>
            </el-table>
          </div>
        </el-col>
        <el-col :xs="24" :md="12">
          <div class="dash-panel">
            <div class="dash-ph">错误分布<span class="dash-dim">期间错误文案 Top8（tooltip 含协议）</span></div>
            <div class="dash-chart sm" ref="elErrors"></div>
            <div class="dash-empty" v-if="emptyErrors">期间无错误（好消息）</div>
          </div>
        </el-col>
        <el-col :xs="24" :md="12">
          <div class="dash-panel">
            <div class="dash-ph">运行情况<span class="dash-dim">实时 · 与 /api/health 同源</span></div>
            <el-descriptions :column="2" size="small" border class="dash-desc">
              <el-descriptions-item label="服务运行">{{ fmtUptime(data.summary.uptime_s) }}</el-descriptions-item>
              <el-descriptions-item label="进行中 QA">{{ data.summary.active_qa }}</el-descriptions-item>
              <el-descriptions-item label="会话数">{{ data.summary.sessions_total }}</el-descriptions-item>
              <el-descriptions-item label="SSE 连接">{{ data.summary.online.sse }}</el-descriptions-item>
              <el-descriptions-item label="在线访客">{{ data.summary.online.auth_sessions + data.summary.online.groups }}</el-descriptions-item>
              <el-descriptions-item label="均耗时（期间）">{{ data.summary.avg_duration_s }}s</el-descriptions-item>
              <el-descriptions-item label="活跃用户">{{ data.summary.users_active }}</el-descriptions-item>
              <el-descriptions-item label="有效访问码">{{ data.summary.codes_active }}</el-descriptions-item>
              <el-descriptions-item label="智能体数">{{ data.summary.agents_total }}</el-descriptions-item>
              <el-descriptions-item label="期间提问">{{ data.summary.records_range }}</el-descriptions-item>
            </el-descriptions>
          </div>
        </el-col>
      </el-row>
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
.dash-card { border: 1px solid var(--el-border-color-light); border-radius: 10px; padding: 12px 14px; background: var(--el-bg-color); }
.dash-card-v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dash-card-unit { font-size: 12px; font-weight: 400; opacity: 0.65; margin-left: 4px; }
.dash-card-k { font-size: 12px; opacity: 0.75; margin-top: 2px; }
.dash-card-d { font-size: 12px; margin-top: 4px; }
.dash-card .up { color: var(--el-color-success); }
.dash-card .down { color: var(--el-color-danger); }
.dash-card.warn .dash-card-v { color: var(--el-color-danger); }
.dash-panel { position: relative; border: 1px solid var(--el-border-color-light); border-radius: 10px; padding: 12px 14px; background: var(--el-bg-color); }
.dash-ph { font-size: 13px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dash-chart { height: 300px; }
.dash-chart.sm { height: 240px; }
.dash-empty { position: absolute; left: 0; right: 0; top: 46px; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; opacity: 0.6; pointer-events: none; }
.dash-table { margin-top: 10px; }
.dash-desc { margin-top: 2px; }
.dash .warn { color: var(--el-color-danger); }
</style>
