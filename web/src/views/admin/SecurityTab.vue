<script setup lang="ts">
// P8.61 安全监控重构（依据 doc/重构安全监控.md，纯前端 UI/UX 重构，后端 API / 安全规则零改动）：
// 信息架构 = 安全态势（5 卡）→ 24h 安全活动趋势 → 风险告警 / 风险态势 → IP 安全活动 → 安全事件（筛选 + 时间线）；
// 封禁入口统一：「IP 管理」Drawer（搜索 / 全部·生效中·已过期 / 解封）+「封禁 IP」二级弹窗（时长预设 + 自定义、
// 原因预设 + 备注、提交前风险提示）+「IP 详情」Drawer（状态 / 活动概览 / 风险信息 / 封禁信息）；
// 任何封禁操作成功后统一 load(true) 刷新：态势 / 告警 / Top IP / 封禁列表 / 事件同步更新。
// 数据源：GET /api/admin/security?days=N[&fresh=1]（30s 缓存）+ /events（加载更多）+ /bans CRUD。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { CircleCheck, Lock, Plus, Refresh, Search, Unlock, View } from "@element-plus/icons-vue";
import { useTheme } from "../../composables/useTheme";
import { fmtDateTime } from "../../utils/formatTime";
import { DASH_COLORS, disposeChart, hexAlpha, initChart, softTooltip, themeOf } from "../../composables/useEcharts";
import type { Chart } from "../../composables/useEcharts";

interface SecAlert { level: "high" | "medium"; type: string; ip: string | null; count: number; last_at: string | null; detail: string; }
interface TopIp { ip: string; events: number; logins: number; fails: number; qa24h: number; last_at: string | null; banned: boolean; }
interface Ban { ip: string; reason: string; created_by: string | null; created_by_name: string; created_at: string; expires_at: string | null; permanent: boolean; active: boolean; }
interface SecEvent { id: number; actor_type: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; detail: Record<string, unknown>; ip: string; user_agent: string; created_at: string; }
interface SecData {
  ok: boolean; days: number;
  summary: { qa_today: number; logins_today: number; fails_today: number; events_24h: number; alerts: number; bans_active: number; bans_total: number; qa_24h: number; error_rate_24h: number; };
  hour24: { h: string; logins: number; fails: number; qa: number }[];
  daily: { date: string; qa: number; ok: number; logins: number; fails: number }[];
  alerts: SecAlert[];
  top_ips: TopIp[];
  bans: Ban[];
  events: SecEvent[];
}

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "账号登录",
  "auth.login_failed": "登录失败（账号）",
  "admin.login": "管理员登录",
  "admin.login_failed": "登录失败（管理员）",
  "access.login": "访问码登录",
  "access.login_failed": "登录失败（访问码）",
  "access.kick": "一键踢出",
  "security.ban": "IP 封禁",
  "security.unban": "解除封禁",
  "security.auto_ban": "自动封禁"
};
const TYPE_LABEL: Record<string, string> = {
  login_brute: "登录爆破",
  qa_burst: "提问高频",
  code_guess: "无效码猜测",
  error_spike: "错误激增"
};
const TYPE_ORDER = ["login_brute", "qa_burst", "code_guess", "error_spike"];
const ACTOR_LABEL: Record<string, string> = { admin: "管理员", user: "用户", code: "访问码", system: "系统", anon: "匿名" };
const EVENT_FILTERS: { k: string; label: string }[] = [
  { k: "all", label: "全部" },
  { k: "login", label: "登录" },
  { k: "code", label: "访问码" },
  { k: "kick", label: "踢出" },
  { k: "ban", label: "封禁" },
  { k: "unban", label: "解封" },
  { k: "auto", label: "自动封禁" }
];
const ACTION_FILTER: Record<string, string> = {
  "auth.login": "login", "auth.login_failed": "login",
  "admin.login": "login", "admin.login_failed": "login",
  "access.login": "code", "access.login_failed": "code",
  "access.kick": "kick",
  "security.ban": "ban", "security.unban": "unban", "security.auto_ban": "auto"
};
const EV_TONE: Record<string, string> = {
  "auth.login": "ok", "admin.login": "ok", "access.login": "ok",
  "auth.login_failed": "bad", "admin.login_failed": "bad", "access.login_failed": "bad",
  "access.kick": "warn", "security.ban": "bad", "security.auto_ban": "bad", "security.unban": "info"
};
const DUR_OPTS: { k: string; label: string }[] = [
  { k: "60", label: "1 小时" },
  { k: "1440", label: "24 小时" },
  { k: "10080", label: "7 天" },
  { k: "0", label: "永久" },
  { k: "custom", label: "自定义" }
];
const REASON_PRESETS = ["登录爆破", "高频请求", "无效访问码", "异常行为", "管理员手动封禁", "其他"];

const { lightTheme } = useTheme();
const days = ref(7);
const auto = ref(true);
const loading = ref(false);
const error = ref("");
const data = ref<SecData | null>(null);
const updatedAt = ref("");

const elTrend = ref<HTMLDivElement | null>(null);
let charts: Record<string, Chart> = {};
let timer: number | null = null;

// ---------- 数据加载 ----------
async function load(fresh = false) {
  loading.value = true;
  error.value = "";
  try {
    const r = await fetch("/api/admin/security?days=" + days.value + (fresh ? "&fresh=1" : ""), { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    data.value = (await r.json()) as SecData;
    updatedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
async function loadMoreEvents() {
  if (!data.value) return;
  try {
    const r = await fetch("/api/admin/security/events?limit=20&offset=" + data.value.events.length, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = (await r.json()) as { events: SecEvent[] };
    data.value.events = data.value.events.concat(j.events);
  } catch (e) {
    ElMessage.error("加载更多事件失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

// ---------- 封禁操作（统一入口；成功后全量刷新） ----------
function durText(min: number): string {
  if (min === 0) return "永久";
  if (min < 60) return min + " 分钟";
  if (min < 1440) return (min / 60) + " 小时";
  return Math.round(min / 1440) + " 天";
}
const banDlg = ref(false);
const banIp = ref("");
const banDur = ref("60"); // "60" | "1440" | "10080" | "0" | "custom"
const banCustomMin = ref(60);
const banPreset = ref("管理员手动封禁");
const banNote = ref("");
const banSaving = ref(false);
function openBan(ip: string, preset?: string) {
  banIp.value = ip;
  banDur.value = "60";
  banCustomMin.value = 60;
  banPreset.value = preset && REASON_PRESETS.includes(preset) ? preset : "管理员手动封禁";
  banNote.value = "";
  banDlg.value = true;
}
function banMinutesNow(): number {
  if (banDur.value === "custom") return Math.round(Number(banCustomMin.value) || 0);
  return Number(banDur.value);
}
// 提交前风险提示（仅使用现有 overview 命中：Top IP 活动 / 告警；无数据则不显示，不虚构）
const banRisk = computed(() => {
  const ip = banIp.value.trim();
  if (!ip || !data.value) return null;
  const t = data.value.top_ips.find((x) => x.ip === ip) || null;
  const al = data.value.alerts.filter((a) => a.ip === ip);
  if (!t && al.length === 0) return null;
  return { t, al };
});
async function submitBan() {
  const ip = banIp.value.trim();
  if (!ip) { ElMessage.warning("请输入 IP 地址"); return; }
  const minutes = banMinutesNow();
  if (banDur.value === "custom" && (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200)) {
    ElMessage.warning("自定义时长须为 1–43200 分钟的整数");
    return;
  }
  const reason = (banPreset.value + (banNote.value.trim() ? "：" + banNote.value.trim() : "")).slice(0, 200);
  banSaving.value = true;
  try {
    const r = await fetch("/api/admin/security/bans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, minutes, reason })
    });
    const j = (await r.json()) as { ok: boolean; detail?: string };
    if (!r.ok || !j.ok) throw new Error(j.detail || "HTTP " + r.status);
    ElMessage.success("已封禁 " + ip + "（" + durText(minutes) + "）");
    banDlg.value = false;
    load(true); // 态势 / 告警 / Top IP / 封禁列表 / 事件 统一刷新
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    banSaving.value = false;
  }
}
async function unban(ip: string) {
  try {
    const r = await fetch("/api/admin/security/bans/" + encodeURIComponent(ip), { method: "DELETE" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    ElMessage.success("已解除封禁 " + ip);
    load(true);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// ---------- 第一层：安全态势（5 卡；风险/封禁为处置指标，视觉加权） ----------
interface Kpi { k: string; v: string; unit?: string; sub?: string; risk?: boolean; accent?: boolean; manage?: boolean; spark?: number[]; }
const kpis = computed<Kpi[]>(() => {
  if (!data.value) return [];
  const s = data.value.summary;
  const h = data.value.hour24;
  const login24 = h.reduce((n, x) => n + x.logins, 0);
  const fail24 = h.reduce((n, x) => n + x.fails, 0);
  const high = data.value.alerts.filter((a) => a.level === "high").length;
  return [
    { k: "今日提问", v: String(s.qa_today), unit: "次", sub: "24h 提问 " + s.qa_24h + " · 错误率 " + s.error_rate_24h + "%", spark: data.value.daily.map((x) => x.qa) },
    { k: "登录成功", v: String(login24), unit: "次", sub: "近 24h · 今日 " + s.logins_today },
    { k: "登录失败", v: String(fail24), unit: "次", sub: "近 24h · 今日 " + s.fails_today, risk: fail24 > 0 },
    { k: "风险告警", v: String(s.alerts), unit: "条", sub: "高危 " + high + (high > 0 ? " 条" : " · 无高危"), risk: high > 0, accent: s.alerts > 0 },
    { k: "封禁 IP", v: String(s.bans_active), unit: "个", sub: "近 7 天共 " + s.bans_total + " 条 · 点按管理", accent: true, manage: true }
  ];
});
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

// ---------- 第二层：24h 安全活动趋势 ----------
function trendOption() {
  const t = themeOf(document.body);
  const d = data.value!.hour24;
  return {
    color: [DASH_COLORS.admin, DASH_COLORS.error, DASH_COLORS.user],
    tooltip: Object.assign({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: hexAlpha(t.accent, 0.06) } } }, softTooltip(t)),
    legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: t.sub, fontSize: 12 } },
    grid: { left: 34, right: 34, top: 14, bottom: 34 },
    xAxis: {
      type: "category", data: d.map((x) => x.h),
      axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
      axisLabel: { color: t.sub, fontSize: 11, interval: 3 }
    },
    yAxis: [
      { type: "value", minInterval: 1, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.sub, fontSize: 11 },
        splitLine: { lineStyle: { color: t.axis, type: "dashed", opacity: 0.35 } } },
      { type: "value", axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.sub, fontSize: 11 }, splitLine: { show: false } }
    ],
    series: [
      { name: "登录成功", type: "bar", stack: "login", barMaxWidth: 14, itemStyle: { opacity: 0.75 }, data: d.map((x) => x.logins) },
      { name: "登录失败", type: "bar", stack: "login", barMaxWidth: 14, data: d.map((x) => x.fails) },
      { name: "提问", type: "line", yAxisIndex: 1, smooth: 0.25, symbol: "circle", symbolSize: 4, showSymbol: false,
        lineStyle: { width: 2 }, data: d.map((x) => x.qa) }
    ]
  };
}
const emptyTrend = computed(() => !!data.value && data.value.hour24.every((x) => x.logins === 0 && x.fails === 0 && x.qa === 0));
function renderAll() {
  if (!data.value) return;
  if (elTrend.value) {
    if (!charts.trend) charts.trend = initChart(elTrend.value);
    charts.trend.setOption(trendOption() as never, true);
  }
}

// ---------- 第三层：风险告警 + 风险态势 ----------
const alertByIp = computed(() => {
  const m = new Map<string, "high" | "medium">();
  for (const a of data.value?.alerts || []) {
    if (!a.ip) continue;
    const e = m.get(a.ip);
    if (!e || a.level === "high") m.set(a.ip, a.level);
  }
  return m;
});
const highCount = computed(() => (data.value ? data.value.alerts.filter((a) => a.level === "high").length : 0));
const riskGroups = computed(() => {
  if (!data.value) return [];
  const m = new Map<string, number>();
  for (const a of data.value.alerts) m.set(a.type, (m.get(a.type) || 0) + 1);
  return TYPE_ORDER.filter((tp) => m.has(tp)).map((tp) => ({
    type: tp, label: TYPE_LABEL[tp] || tp, n: m.get(tp)!,
    high: data.value!.alerts.filter((a) => a.type === tp && a.level === "high").length
  }));
});
function riskBarW(n: number): string {
  const max = riskGroups.value.reduce((m, x) => Math.max(m, x.n), 0);
  return max ? Math.max(6, Math.round((n / max) * 100)) + "%" : "0%";
}
function alertPreset(type: string): string {
  return type === "login_brute" ? "登录爆破" : type === "qa_burst" ? "高频请求" : type === "error_spike" ? "异常行为" : "管理员手动封禁";
}

// ---------- 第四层：IP 安全活动（排行视图，不限制封禁管理范围） ----------
function ipRisk(row: TopIp): { label: string; cls: string } {
  if (row.banned) return { label: "已封禁", cls: "rk-ban" };
  const al = alertByIp.value.get(row.ip);
  if (al) return al === "high" ? { label: "高危", cls: "rk-high" } : { label: "关注", cls: "rk-medium" };
  if (row.fails >= 5) return { label: "高危", cls: "rk-high" };
  if (row.fails >= 3) return { label: "关注", cls: "rk-medium" };
  return { label: "正常", cls: "rk-ok" };
}

// ---------- 第五层：安全事件（筛选 + 时间线） ----------
const evFilter = ref("all");
const filteredEvents = computed(() => {
  if (!data.value) return [];
  if (evFilter.value === "all") return data.value.events;
  return data.value.events.filter((e) => ACTION_FILTER[e.action] === evFilter.value);
});
function actorLabel(ev: SecEvent): string {
  const base = ACTOR_LABEL[ev.actor_type] || ev.actor_type;
  const u = ev.detail && typeof ev.detail.username === "string" ? ev.detail.username : "";
  return u ? base + " · " + u : base;
}
function evTone(action: string): string { return EV_TONE[action] || "info"; }
function evDesc(ev: SecEvent): string {
  const d = ev.detail || {};
  switch (ev.action) {
    case "security.ban":
      return "操作人 " + actorLabel(ev) + (typeof d.reason === "string" ? " · " + d.reason : "") + (typeof d.minutes === "number" ? " · " + durText(d.minutes) : "");
    case "security.unban":
      return "操作人 " + actorLabel(ev);
    case "security.auto_ban":
      return "系统自动 · " + (typeof d.reason === "string" ? d.reason : "");
    case "access.kick":
      return (typeof d.label === "string" && d.label ? d.label + " · " : "") + "操作人 " + actorLabel(ev);
    case "auth.login_failed":
    case "admin.login_failed":
      return typeof d.username === "string" ? "账号 " + d.username : "密码错误";
    case "access.login_failed":
      return typeof d.code === "string" ? "访问码 " + d.code : "码无效或过期";
    case "auth.login":
      return typeof d.username === "string" ? "账号 " + d.username : "";
    default:
      return "";
  }
}

// ---------- IP 管理 Drawer ----------
const ipDrawer = ref(false);
const ipSearch = ref("");
const ipFilter = ref("all"); // all / active / expired
const banRows = computed(() => {
  if (!data.value) return [];
  const q = ipSearch.value.trim().toLowerCase();
  return data.value.bans.filter((b) => {
    if (ipFilter.value === "active" && !b.active) return false;
    if (ipFilter.value === "expired" && b.active) return false;
    if (q && !b.ip.toLowerCase().includes(q)) return false;
    return true;
  });
});
const banActiveN = computed(() => (data.value ? data.value.bans.filter((b) => b.active).length : 0));
const banExpiredN = computed(() => (data.value ? data.value.bans.length - banActiveN.value : 0));

// ---------- IP 详情 Drawer ----------
const ipDetail = ref("");
const detailOpen = computed({ get: () => !!ipDetail.value, set: (v: boolean) => { if (!v) ipDetail.value = ""; } });
function openIpDetail(ip: string) { ipDetail.value = ip; }
const detailRow = computed<TopIp | null>(() => (data.value ? data.value.top_ips.find((x) => x.ip === ipDetail.value) || null : null));
const detailBan = computed<Ban | null>(() => (data.value ? data.value.bans.find((b) => b.ip === ipDetail.value) || null : null));
const detailAlerts = computed<SecAlert[]>(() => (data.value ? data.value.alerts.filter((a) => a.ip === ipDetail.value) : []));
const detailStatus = computed(() => {
  if (detailBan.value && detailBan.value.active) return { k: "已封禁", cls: "st-banned" };
  if (detailAlerts.value.some((a) => a.level === "high")) return { k: "风险", cls: "st-risk" };
  if (detailAlerts.value.length > 0) return { k: "关注", cls: "st-warn" };
  return { k: "正常", cls: "st-ok" };
});

// ---------- 生命周期 ----------
function startTimer() {
  stopTimer();
  if (auto.value) timer = window.setInterval(() => { if (!document.hidden) load(); }, 60000);
}
function stopTimer() {
  if (timer !== null) { window.clearInterval(timer); timer = null; }
}
watch(days, () => load());
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
  <div class="sec" v-loading="loading && !data">
    <div class="sec-bar">
      <el-radio-group v-model="days" size="small">
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="14">近 14 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
      </el-radio-group>
      <div class="sec-bar-r">
        <el-button size="small" :icon="Lock" @click="ipDrawer = true">IP 管理</el-button>
        <el-button size="small" type="primary" :icon="Plus" @click="openBan('')">封禁 IP</el-button>
        <el-switch v-model="auto" size="small" />
        <span class="sec-dim" v-if="auto">自动刷新 60s</span>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="load(true)">刷新</el-button>
        <span class="sec-dim" v-if="updatedAt">更新于 {{ fmtDateTime(updatedAt) }}</span>
      </div>
    </div>

    <el-alert v-if="error" class="sec-err" type="error" show-icon :closable="false"
      :title="'获取安全数据失败：' + error + '（点击重试）'" @click="load(true)" />

    <template v-if="data">
      <!-- 第一层：安全态势（普通统计轻量白卡；风险告警 / 封禁 IP = 安全处置指标，视觉加权） -->
      <div class="kpi-grid">
        <div v-for="c in kpis" :key="c.k" class="kpi" :class="{ 'kpi-accent': c.accent, 'kpi-risk': c.risk, 'kpi-click': c.manage }" @click="c.manage && (ipDrawer = true)">
          <div class="kpi-k">{{ c.k }}</div>
          <div class="kpi-v">{{ c.v }}<span class="kpi-unit" v-if="c.unit">{{ c.unit }}</span></div>
          <div class="kpi-d"><span class="sec-dim">{{ c.sub }}</span></div>
          <svg v-if="hasSpark(c.spark)" class="kpi-spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
            <polygon :points="'0,26 ' + sparkPts(c.spark!) + ' 100,26'" class="kpi-spark-area" />
            <polyline :points="sparkPts(c.spark!)" class="kpi-spark-line" />
          </svg>
        </div>
      </div>

      <!-- 第二层：24h 安全活动趋势（登录成功/失败堆叠柱 + 提问量折线；单主图，Y 轴弱化） -->
      <div class="panel">
        <div class="panel-h">
          <span class="panel-t">24h 安全活动趋势</span>
          <span class="panel-sub">登录成功 / 失败（堆叠柱）+ 提问量（折线）· 本地时区</span>
        </div>
        <div class="c-trend" ref="elTrend"></div>
        <div class="panel-empty" v-if="emptyTrend">近 24 小时暂无安全活动</div>
      </div>

      <!-- 第三层：风险告警（高危/关注分级，查看 IP → 详情 → 封禁；一键封禁为快捷操作） + 风险态势 -->
      <div class="row-risk">
        <div class="panel">
          <div class="panel-h">
            <span class="panel-t">风险告警</span>
            <span class="panel-sub">登录爆破 ≥5 高危 / ≥3 关注 · 提问高频 · 错误激增</span>
            <span class="panel-sub risk-chip" v-if="highCount">高危 {{ highCount }}</span>
          </div>
          <div class="risk-empty" v-if="!data.alerts.length">
            <el-icon class="risk-ok-ic"><CircleCheck /></el-icon>
            <div><b>暂无风险告警</b><span class="sec-dim">当前访问行为正常，系统持续监测中</span></div>
          </div>
          <div class="risk-list" v-else>
            <div class="risk-item" :class="a.level === 'high' ? 'ri-high' : 'ri-medium'" v-for="a in data.alerts" :key="a.type + (a.ip || '')">
              <span class="risk-tag" :class="a.level === 'high' ? 'tg-high' : 'tg-medium'">{{ a.level === 'high' ? '高危' : '关注' }}</span>
              <div class="risk-body">
                <div class="risk-t">{{ TYPE_LABEL[a.type] || a.type }}<span class="ip-mono risk-ip" v-if="a.ip">{{ a.ip }}</span></div>
                <div class="risk-d sec-dim">{{ a.detail }}</div>
                <div class="risk-meta sec-dim" v-if="a.last_at">最近发生 {{ fmtDateTime(a.last_at) }}</div>
              </div>
              <template v-if="a.ip">
                <el-button size="small" :icon="View" @click="openIpDetail(a.ip!)">查看 IP</el-button>
                <el-tag v-if="data.bans.some((b) => b.ip === a.ip && b.active)" size="small" type="danger" effect="plain" class="risk-banned">已封禁</el-tag>
                <el-button v-else size="small" type="danger" plain @click="openBan(a.ip!, alertPreset(a.type))">封禁</el-button>
              </template>
            </div>
          </div>
        </div>
        <div class="panel posture">
          <div class="panel-h"><span class="panel-t">风险态势</span><span class="panel-sub">按类型 · 近 24h</span></div>
          <div class="risk-empty" v-if="!riskGroups.length">
            <el-icon class="risk-ok-ic"><CircleCheck /></el-icon>
            <div><b>系统运行平稳</b><span class="sec-dim">近 24h 未触发任何风险规则</span></div>
          </div>
          <template v-else>
            <div class="pg-list">
              <div class="pg-row" v-for="g in riskGroups" :key="g.type">
                <span class="pg-dot" :class="g.high ? 'd-danger' : 'd-warn'"></span>
                <span class="pg-name">{{ g.label }}</span>
                <div class="pg-bar"><div :style="{ width: riskBarW(g.n) }" :class="g.high ? 'd-danger' : 'd-warn'"></div></div>
                <b class="pg-n">{{ g.n }}</b>
              </div>
            </div>
            <div class="pg-foot sec-dim">24h 安全事件 {{ data.summary.events_24h }} 起 · 24h 提问错误率 {{ data.summary.error_rate_24h }}%</div>
          </template>
        </div>
      </div>

      <!-- 第四层：IP 安全活动（高活跃 / 高风险排行视图；封禁管理入口统一在「IP 管理」，不受排行限制） -->
      <div class="panel">
        <div class="panel-h">
          <span class="panel-t">IP 安全活动</span>
          <span class="panel-sub">高活跃 / 高风险 IP 排行 · 可封禁任意 IP（「IP 管理」入口）</span>
        </div>
        <el-table :data="data.top_ips" class="sec-table" empty-text="期间暂无 IP 活动">
          <el-table-column label="IP" min-width="150">
            <template #default="{ row }"><span class="ip-mono">{{ row.ip }}</span></template>
          </el-table-column>
          <el-table-column label="风险等级" width="92">
            <template #default="{ row }"><span class="rk" :class="ipRisk(row).cls">{{ ipRisk(row).label }}</span></template>
          </el-table-column>
          <el-table-column prop="events" label="事件（7d）" width="100" align="right" />
          <el-table-column prop="qa24h" label="提问（24h）" width="100" align="right" />
          <el-table-column prop="fails" label="登录失败（24h）" width="124" align="right">
            <template #default="{ row }"><span :class="{ 'fails-hot': row.fails >= 3 }">{{ row.fails }}</span></template>
          </el-table-column>
          <el-table-column label="最近活动" min-width="150">
            <template #default="{ row }"><span class="sec-dim">{{ row.last_at ? fmtDateTime(row.last_at) : "—" }}</span></template>
          </el-table-column>
          <el-table-column label="当前状态" width="96">
            <template #default="{ row }">
              <el-tag v-if="row.banned" type="danger" size="small">已封禁</el-tag>
              <el-tag v-else size="small" effect="plain">正常</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="172" fixed="right">
            <template #default="{ row }">
              <el-button size="small" :icon="View" @click="openIpDetail(row.ip)">查看</el-button>
              <el-popconfirm v-if="row.banned" title="确定解除该 IP 的封禁？" confirm-button-text="解除" cancel-button-text="取消" width="200" @confirm="unban(row.ip)">
                <template #reference><el-button size="small" type="warning" plain :icon="Unlock">解封</el-button></template>
              </el-popconfirm>
              <el-button v-else size="small" type="danger" plain :icon="Lock" @click="openBan(row.ip)">封禁</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 第五层：安全事件（类型筛选 + 时间线；加载更多） -->
      <div class="panel">
        <div class="panel-h">
          <span class="panel-t">安全事件</span>
          <span class="panel-sub">登录 · 踢出 · 封禁留痕（最近 {{ data.events.length }} 条）</span>
          <div class="seg">
            <button v-for="f in EVENT_FILTERS" :key="f.k" type="button" class="seg-i" :class="{ on: evFilter === f.k }" @click="evFilter = f.k">{{ f.label }}</button>
          </div>
        </div>
        <div class="panel-block-empty" v-if="!filteredEvents.length">当前筛选下暂无安全事件</div>
        <div class="ev-list" v-else>
          <div class="ev-item" :class="'ev-' + evTone(e.action)" v-for="e in filteredEvents" :key="e.id">
            <span class="ev-time sec-dim">{{ fmtDateTime(e.created_at) }}</span>
            <span class="ev-dot"></span>
            <div class="ev-body">
              <div class="ev-t"><span class="ev-act">{{ ACTION_LABEL[e.action] || e.action }}</span><span class="ip-mono ev-ip" v-if="e.ip && e.ip !== '?'">{{ e.ip }}</span></div>
              <div class="ev-d sec-dim" v-if="evDesc(e)">{{ evDesc(e) }}</div>
            </div>
          </div>
        </div>
        <div class="sec-more" v-if="filteredEvents.length > 0 && data.events.length < 200">
          <el-button size="small" text @click="loadMoreEvents">加载更多</el-button>
        </div>
      </div>
    </template>

    <!-- IP 管理 Drawer（统一封禁管理入口：搜索 / 筛选 / 解封 / 新增封禁） -->
    <el-drawer v-model="ipDrawer" size="860px" :close-on-click-modal="false">
      <template #header>
        <div class="dlg-h">
          <div><div class="dlg-t">IP 安全管理</div><div class="dlg-sub sec-dim">管理当前系统的 IP 封禁策略与生效记录（生效 + 近 7 天过期）</div></div>
        </div>
      </template>
      <div class="ipm-top">
        <el-input v-model="ipSearch" placeholder="搜索 IP，如 192.168.1.100" :prefix-icon="Search" clearable class="ipm-search" />
        <div class="ipm-top-r">
          <div class="seg">
            <button type="button" class="seg-i" :class="{ on: ipFilter === 'all' }" @click="ipFilter = 'all'">全部 {{ data ? data.bans.length : 0 }}</button>
            <button type="button" class="seg-i" :class="{ on: ipFilter === 'active' }" @click="ipFilter = 'active'">生效中 {{ banActiveN }}</button>
            <button type="button" class="seg-i" :class="{ on: ipFilter === 'expired' }" @click="ipFilter = 'expired'">已过期 {{ banExpiredN }}</button>
          </div>
          <el-button type="primary" size="small" :icon="Plus" @click="openBan('')">封禁 IP</el-button>
        </div>
      </div>
      <el-table :data="banRows" class="sec-table" empty-text="暂无封禁记录（可点击右上角「封禁 IP」新增）">
        <el-table-column label="IP" min-width="120">
          <template #default="{ row }"><span class="ip-mono">{{ row.ip }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="84">
          <template #default="{ row }">
            <el-tag v-if="row.active" type="danger" size="small">生效中</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">已过期</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="封禁原因" min-width="130" show-overflow-tooltip />
        <el-table-column label="操作人" width="92">
          <template #default="{ row }">{{ row.created_by_name }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="148">
          <template #default="{ row }"><span class="sec-dim">{{ fmtDateTime(row.created_at) }}</span></template>
        </el-table-column>
        <el-table-column label="到期" width="108">
          <template #default="{ row }"><span class="sec-dim">{{ row.permanent ? "永久" : (row.expires_at ? fmtDateTime(row.expires_at) : "—") }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="View" @click="openIpDetail(row.ip)">查看</el-button>
            <el-popconfirm v-if="row.active" title="确定解除该 IP 的封禁？" confirm-button-text="解除" cancel-button-text="取消" width="200" @confirm="unban(row.ip)">
              <template #reference><el-button size="small" type="warning" plain :icon="Unlock">解封</el-button></template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>

    <!-- 封禁 IP 二级弹窗（任意合法 IP；时长预设 + 自定义；原因预设 + 备注；提交前风险提示） -->
    <el-dialog v-model="banDlg" title="封禁 IP" width="480px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="IP 地址" required>
          <el-input v-model="banIp" placeholder="请输入 IPv4 / IPv6 地址，如 192.168.1.100" clearable @keyup.enter="submitBan" />
        </el-form-item>
        <el-form-item label="封禁时长">
          <div class="seg dur-seg">
            <button v-for="o in DUR_OPTS" :key="o.k" type="button" class="seg-i" :class="{ on: banDur === o.k }" @click="banDur = o.k">{{ o.label }}</button>
          </div>
          <div v-if="banDur === 'custom'" class="custom-min">
            <el-input-number v-model="banCustomMin" :min="1" :max="43200" :step="15" size="small" />
            <span class="sec-dim">分钟（1–43200；0 = 永久）</span>
          </div>
        </el-form-item>
        <el-form-item label="封禁原因">
          <el-select v-model="banPreset" class="ban-preset">
            <el-option v-for="p in REASON_PRESETS" :key="p" :label="p" :value="p" />
          </el-select>
          <el-input v-model="banNote" :placeholder="banPreset === '其他' ? '请说明封禁原因' : '备注（可选，将附在原因后）'" maxlength="120" class="ban-note" />
        </el-form-item>
        <el-alert v-if="banRisk" class="ban-risk" type="warning" :closable="false" show-icon title="该 IP 近期存在异常访问行为">
          <div class="ban-risk-d" v-if="banRisk.t">事件 {{ banRisk.t.events }} · 提问(24h) {{ banRisk.t.qa24h }} · 登录失败(24h) {{ banRisk.t.fails }}<template v-if="banRisk.t.last_at"> · 最近活动 {{ fmtDateTime(banRisk.t.last_at) }}</template></div>
          <div class="ban-risk-d" v-for="a in banRisk.al" :key="a.type + a.detail">{{ TYPE_LABEL[a.type] || a.type }}：{{ a.detail }}</div>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="banDlg = false">取消</el-button>
        <el-button type="danger" :loading="banSaving" @click="submitBan">确认封禁</el-button>
      </template>
    </el-dialog>

    <!-- IP 详情 Drawer（状态 / 活动概览 / 风险信息 / 封禁信息 / 快捷操作） -->
    <el-drawer v-model="detailOpen" size="470px" :close-on-click-modal="false">
      <template #header>
        <div class="dlg-h">
          <div><div class="dlg-t">IP 安全详情</div><div class="dlg-ip ip-mono">{{ ipDetail }}</div></div>
          <span class="st" :class="detailStatus.cls">{{ detailStatus.k }}</span>
        </div>
      </template>
      <template v-if="ipDetail">
        <div class="det-sec">
          <div class="det-t sec-dim">活动概览</div>
          <div class="stat-grid">
            <div class="stat"><span class="stat-k">事件（7 天）</span><b>{{ detailRow ? detailRow.events : "—" }}</b></div>
            <div class="stat"><span class="stat-k">提问（24h）</span><b>{{ detailRow ? detailRow.qa24h : "—" }}</b></div>
            <div class="stat"><span class="stat-k">登录失败（24h）</span><b :class="{ 'fails-hot': !!detailRow && detailRow.fails >= 3 }">{{ detailRow ? detailRow.fails : "—" }}</b></div>
            <div class="stat"><span class="stat-k">最近活动</span><b class="stat-sm">{{ detailRow && detailRow.last_at ? fmtDateTime(detailRow.last_at) : "—" }}</b></div>
          </div>
        </div>
        <div class="det-sec">
          <div class="det-t sec-dim">风险信息</div>
          <div class="det-none sec-dim" v-if="!detailAlerts.length">无风险记录</div>
          <div class="det-alerts" v-else>
            <div class="det-al" :class="a.level === 'high' ? 'ri-high' : 'ri-medium'" v-for="a in detailAlerts" :key="a.type + a.detail">
              <span class="risk-tag" :class="a.level === 'high' ? 'tg-high' : 'tg-medium'">{{ a.level === 'high' ? '高危' : '关注' }}</span>
              <div class="det-al-b"><b>{{ TYPE_LABEL[a.type] || a.type }}</b><div class="sec-dim">{{ a.detail }}</div></div>
            </div>
          </div>
        </div>
        <div class="det-sec">
          <div class="det-t sec-dim">封禁信息</div>
          <div class="det-none sec-dim" v-if="!detailBan">未封禁</div>
          <div class="det-ban" v-else>
            <div class="db-row"><span class="sec-dim">状态</span><el-tag :type="detailBan.active ? 'danger' : 'info'" size="small" :effect="detailBan.active ? 'light' : 'plain'">{{ detailBan.active ? '生效中' : '已过期' }}</el-tag></div>
            <div class="db-row"><span class="sec-dim">原因</span><span>{{ detailBan.reason }}</span></div>
            <div class="db-row"><span class="sec-dim">操作人</span><span>{{ detailBan.created_by_name }}</span></div>
            <div class="db-row"><span class="sec-dim">创建</span><span class="sec-dim">{{ fmtDateTime(detailBan.created_at) }}</span></div>
            <div class="db-row"><span class="sec-dim">到期</span><span class="sec-dim">{{ detailBan.permanent ? "永久" : (detailBan.expires_at ? fmtDateTime(detailBan.expires_at) : "—") }}</span></div>
          </div>
        </div>
      </template>
      <template #footer>
        <el-button v-if="detailBan && detailBan.active" type="warning" plain :icon="Unlock" @click="unban(ipDetail); ipDetail = ''" >解除封禁</el-button>
        <el-button v-else type="danger" plain :icon="Lock" @click="openBan(ipDetail)">封禁此 IP</el-button>
      </template>
    </el-drawer>
  </div>
</template>
<style scoped>
.sec { display: flex; flex-direction: column; gap: 14px; }
.sec-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.sec-bar-r { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sec-dim { color: var(--el-text-color-secondary); font-size: 12px; }
.sec-err { cursor: pointer; }
.ip-mono { font-family: Consolas, "Courier New", monospace; font-size: 12px; }

/* ---- 第一层：安全态势卡（普通统计 = 轻量白卡；风险告警 / 封禁 IP = 处置指标，视觉加权） ---- */
.kpi-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
@media (max-width: 1100px) { .kpi-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 720px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
.kpi { position: relative; background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 12px; padding: 14px 16px 10px; overflow: hidden; }
.kpi-click { cursor: pointer; }
.kpi-accent { border-color: color-mix(in srgb, var(--el-color-primary) 45%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--el-color-primary) 7%, var(--el-bg-color)), var(--el-bg-color)); }
.kpi-risk { border-color: color-mix(in srgb, var(--el-color-danger) 55%, transparent); }
.kpi-risk .kpi-v { color: var(--el-color-danger); }
.kpi-k { font-size: 12px; color: var(--el-text-color-secondary); }
.kpi-v { font-size: 24px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
.kpi-unit { font-size: 12px; font-weight: 400; color: var(--el-text-color-secondary); margin-left: 4px; }
.kpi-d { margin-top: 2px; min-height: 16px; }
.kpi-spark { position: absolute; right: 0; bottom: 0; width: 46%; height: 26px; opacity: 0.5; pointer-events: none; }
.kpi-spark-area { fill: color-mix(in srgb, var(--el-color-primary) 14%, transparent); }
.kpi-spark-line { fill: none; stroke: var(--el-color-primary); stroke-width: 1.5; }

/* ---- 面板 ---- */
.panel { background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 12px; padding: 14px 16px; }
.panel-h { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.panel-t { font-size: 14px; font-weight: 600; }
.panel-sub { font-size: 12px; color: var(--el-text-color-secondary); }
.risk-chip { color: var(--el-color-danger); font-weight: 600; }
.c-trend { height: 260px; }
.panel-empty { padding: 26px 0; text-align: center; font-size: 12px; color: var(--el-text-color-secondary); }
.panel-block-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--el-text-color-secondary); }
.row-risk { display: grid; grid-template-columns: 3fr 2fr; gap: 14px; }
@media (max-width: 900px) { .row-risk { grid-template-columns: 1fr; } }

/* ---- 分段选择器（事件筛选 / 封禁筛选 / 时长预设共用） ---- */
.seg { display: inline-flex; gap: 2px; padding: 2px; background: var(--el-fill-color-light); border-radius: 8px; margin-left: auto; flex-wrap: wrap; }
.seg-i { border: none; background: transparent; color: var(--el-text-color-secondary); font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.seg-i.on { background: var(--el-bg-color); color: var(--el-color-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }

/* ---- 风险告警（高危 / 关注 分级） ---- */
.risk-empty { display: flex; align-items: center; gap: 12px; padding: 18px 6px; }
.risk-ok-ic { font-size: 30px; color: var(--el-color-success); }
.risk-empty b { display: block; font-size: 13px; }
.risk-list { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; }
.risk-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--el-border-color-light); }
.ri-high { border-color: var(--el-color-danger-light-5); background: var(--el-color-danger-light-9); }
.ri-medium { border-color: var(--el-color-warning-light-5); background: var(--el-color-warning-light-9); }
.risk-tag { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
.tg-high { background: var(--el-color-danger); color: #fff; }
.tg-medium { background: var(--el-color-warning); color: #fff; }
.risk-body { flex: 1; min-width: 0; }
.risk-t { font-size: 13px; font-weight: 600; }
.risk-ip { font-weight: 400; font-size: 12px; color: var(--el-text-color-secondary); margin-left: 8px; }
.risk-d { font-size: 12px; margin-top: 2px; }
.risk-meta { font-size: 11px; margin-top: 2px; }
.risk-banned { flex: none; }

/* ---- 风险态势（按类型分布，轻量 HTML） ---- */
.pg-list { display: flex; flex-direction: column; gap: 10px; padding: 6px 0 2px; }
.pg-row { display: flex; align-items: center; gap: 10px; }
.pg-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.d-danger { background: var(--el-color-danger); }
.d-warn { background: var(--el-color-warning); }
.pg-name { width: 72px; flex: none; font-size: 12px; }
.pg-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--el-fill-color-light); overflow: hidden; }
.pg-bar > div { height: 100%; border-radius: 3px; }
.pg-n { width: 26px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
.pg-foot { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--el-border-color-light); }

/* ---- IP 安全活动表 ---- */
.rk { font-size: 12px; font-weight: 600; }
.rk-ban { color: var(--el-color-danger); }
.rk-high { color: var(--el-color-danger); }
.rk-medium { color: var(--el-color-warning); }
.rk-ok { color: var(--el-color-success); }
.fails-hot { color: var(--el-color-danger); font-weight: 600; }

/* ---- 安全事件时间线 ---- */
.ev-list { display: flex; flex-direction: column; max-height: 380px; overflow-y: auto; }
.ev-item { display: flex; align-items: flex-start; gap: 10px; padding: 7px 4px; border-bottom: 1px dashed var(--el-border-color-lighter); }
.ev-item:last-child { border-bottom: none; }
.ev-time { width: 148px; flex: none; font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 1px; }
@media (max-width: 720px) { .ev-time { display: none; } }
.ev-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-top: 6px; background: var(--el-color-info); }
.ev-ok .ev-dot { background: var(--el-color-success); }
.ev-bad .ev-dot { background: var(--el-color-danger); }
.ev-warn .ev-dot { background: var(--el-color-warning); }
.ev-info .ev-dot { background: var(--el-color-primary); }
.ev-body { flex: 1; min-width: 0; }
.ev-t { font-size: 13px; }
.ev-act { font-weight: 600; margin-right: 8px; }
.ev-ip { color: var(--el-text-color-secondary); margin-right: 6px; }
.ev-d { font-size: 12px; margin-top: 1px; }
.sec-more { text-align: center; padding-top: 6px; }

/* ---- Drawer / 对话框公共头 ---- */
.dlg-h { display: flex; align-items: flex-start; justify-content: space-between; width: 100%; }
.dlg-t { font-size: 15px; font-weight: 600; }
.dlg-sub { font-size: 12px; margin-top: 2px; }
.dlg-ip { font-size: 15px; margin-top: 2px; }

/* ---- IP 管理 Drawer ---- */
.ipm-top { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.ipm-search { flex: 1; min-width: 200px; }
.ipm-top-r { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ipm-top-r .seg { margin-left: 0; }

/* ---- 封禁 IP 弹窗 ---- */
.dur-seg { margin-bottom: 6px; }
.custom-min { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.ban-preset { width: 100%; margin-bottom: 8px; }
.ban-risk-d { font-size: 12px; line-height: 1.7; }

/* ---- IP 详情 Drawer ---- */
.st { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 12px; }
.st-ok { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.st-warn { background: var(--el-color-warning-light-9); color: var(--el-color-warning); }
.st-risk { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.st-banned { background: var(--el-color-danger); color: #fff; }
.det-sec { margin-bottom: 18px; }
.det-t { font-size: 12px; font-weight: 600; margin-bottom: 8px; letter-spacing: 0.4px; }
.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.stat { background: var(--el-fill-color-lighter); border-radius: 10px; padding: 10px 12px; }
.stat-k { font-size: 11px; color: var(--el-text-color-secondary); display: block; }
.stat b { font-size: 15px; font-variant-numeric: tabular-nums; }
.stat-sm { font-size: 12px !important; }
.det-none { font-size: 12px; }
.det-alerts { display: flex; flex-direction: column; gap: 8px; }
.det-al { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--el-border-color-light); }
.det-al-b { flex: 1; min-width: 0; font-size: 12px; }
.det-ban { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.db-row { display: flex; align-items: center; gap: 10px; }
.db-row > span:first-child { width: 52px; flex: none; font-size: 12px; }
</style>
