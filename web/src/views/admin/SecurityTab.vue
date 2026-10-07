<script setup lang="ts">
// P8.49 控制台安全监控：访问 / 提问监测 + 异常告警 + IP 封禁（手动 / 自动）
// 数据源 GET /api/admin/security?days=N（服务端 30s 缓存；60s 自刷，可关）+ /api/admin/security/events（加载更多）
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh, Lock, Unlock, Plus } from "@element-plus/icons-vue";
import { useTheme } from "../../composables/useTheme";
import { fmtDateTime } from "../../utils/formatTime";
import { DASH_COLORS, baseAxis, disposeChart, initChart, themeOf } from "../../composables/useEcharts";
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
const ACTOR_LABEL: Record<string, string> = { admin: "管理员", user: "用户", code: "访问码", system: "系统", anon: "匿名" };

const { lightTheme } = useTheme();
const days = ref(7);
const auto = ref(true);
const loading = ref(false);
const error = ref("");
const data = ref<SecData | null>(null);
const updatedAt = ref("");

const elHour = ref<HTMLDivElement | null>(null);
let charts: Record<string, Chart> = {};
let timer: number | null = null;

// 封禁对话框
const banDlg = ref(false);
const banIp = ref("");
const banMinutes = ref(60);
const banReason = ref("");
const banSaving = ref(false);

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

function openBan(ip: string) {
  banIp.value = ip;
  banMinutes.value = 60;
  banReason.value = "";
  banDlg.value = true;
}
async function submitBan() {
  const ip = banIp.value.trim();
  if (!ip) { ElMessage.warning("请输入 IP 地址"); return; }
  banSaving.value = true;
  try {
    const r = await fetch("/api/admin/security/bans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, minutes: banMinutes.value, reason: banReason.value.trim() })
    });
    const j = (await r.json()) as { ok: boolean; detail?: string };
    if (!r.ok || !j.ok) throw new Error(j.detail || "HTTP " + r.status);
    ElMessage.success("已封禁 " + ip);
    banDlg.value = false;
    load(true);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    banSaving.value = false;
  }
}
async function unban(b: Ban) {
  try {
    await ElMessageBox.confirm("确认解除 " + b.ip + " 的封禁？", "解除封禁", { type: "warning" });
  } catch { return; }
  try {
    const r = await fetch("/api/admin/security/bans/" + encodeURIComponent(b.ip), { method: "DELETE" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    ElMessage.success("已解除封禁 " + b.ip);
    load(true);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

function actorLabel(ev: SecEvent): string {
  const base = ACTOR_LABEL[ev.actor_type] || ev.actor_type;
  const u = ev.detail && typeof ev.detail.username === "string" ? ev.detail.username : "";
  if (u) return base + " · " + u;
  return base;
}
function targetLabel(ev: SecEvent): string {
  if (ev.action === "security.ban" || ev.action === "security.unban" || ev.action === "security.auto_ban") return ev.target_id || "";
  if (ev.action === "access.kick") return (ev.detail && typeof ev.detail.label === "string" ? ev.detail.label : "") || ev.target_id || "";
  return "";
}

function hourOption() {
  const t = themeOf(document.body);
  const d = data.value!.hour24;
  return {
    color: [DASH_COLORS.admin, DASH_COLORS.error, DASH_COLORS.line],
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, textStyle: { color: t.text } },
    grid: { left: 46, right: 52, top: 18, bottom: 42 },
    xAxis: Object.assign({ type: "category", data: d.map((x) => x.h) }, baseAxis(t)),
    yAxis: [
      Object.assign({ type: "value", name: "登录" }, baseAxis(t)),
      { type: "value", name: "提问", axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false }, axisLabel: { color: t.text }, splitLine: { show: false } }
    ],
    series: [
      { name: "登录成功", type: "bar", stack: "l", barMaxWidth: 14, data: d.map((x) => x.logins) },
      { name: "登录失败", type: "bar", stack: "l", barMaxWidth: 14, data: d.map((x) => x.fails) },
      { name: "提问", type: "line", yAxisIndex: 1, symbolSize: 5, data: d.map((x) => x.qa) }
    ]
  };
}
function renderAll() {
  if (!data.value) return;
  if (elHour.value) {
    if (!charts.hour) charts.hour = initChart(elHour.value);
    charts.hour.setOption(hourOption() as never, true);
  }
}

const cards = computed(() => {
  if (!data.value) return [];
  const s = data.value.summary;
  const high = data.value.alerts.filter((a) => a.level === "high").length;
  return [
    { k: "今日提问", v: String(s.qa_today), unit: "次", warn: false, sub: "24h 错误率 " + s.error_rate_24h + "%" },
    { k: "今日登录", v: String(s.logins_today), unit: "次", warn: s.fails_today > 0, sub: "失败 " + s.fails_today + " 次" },
    { k: "风险告警", v: String(s.alerts), unit: "条", warn: s.alerts > 0, sub: "高危 " + high + " · 24h 事件 " + s.events_24h },
    { k: "封禁 IP", v: String(s.bans_active), unit: "个", warn: s.bans_active > 0, sub: "含过期共 " + s.bans_total + " 条" }
  ];
});
const emptyHour = computed(() => !!data.value && data.value.hour24.every((x) => x.logins === 0 && x.fails === 0 && x.qa === 0));

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
  <div class="sec" v-loading="loading">
    <div class="sec-bar">
      <el-radio-group v-model="days" size="small">
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="14">近 14 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
      </el-radio-group>
      <div class="sec-bar-r">
        <el-button size="small" type="primary" plain :icon="Plus" @click="openBan('')">封禁 IP</el-button>
        <el-switch v-model="auto" size="small" />
        <span class="sec-dim" v-if="auto">自动刷新 60s</span>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="load(true)">刷新</el-button>
        <span class="sec-dim" v-if="updatedAt">更新于 {{ fmtDateTime(updatedAt) }}</span>
      </div>
    </div>

    <el-alert v-if="error" class="sec-err" type="error" show-icon :closable="false"
      :title="'获取安全数据失败：' + error + '（点击重试）'" @click="load(true)" />

    <template v-if="data">
      <el-row :gutter="14" class="sec-cards">
        <el-col :xs="12" :sm="6" :md="6" :lg="6" v-for="c in cards" :key="c.k">
          <div class="sec-card" :class="{ warn: c.warn }">
            <div class="sec-card-v">{{ c.v }}<span class="sec-card-unit" v-if="c.unit">{{ c.unit }}</span></div>
            <div class="sec-card-k">{{ c.k }}</div>
            <div class="sec-card-d sec-dim" v-if="c.sub">{{ c.sub }}</div>
          </div>
        </el-col>
      </el-row>

      <el-row :gutter="14" class="sec-grid">
        <el-col :xs="24" :md="24">
          <div class="sec-panel">
            <div class="sec-ph">近 24 小时安全概览<span class="sec-dim">登录成功 / 失败（堆叠柱）+ 提问（折线）· 本地时区</span></div>
            <div class="sec-chart" ref="elHour"></div>
            <div class="sec-empty" v-if="emptyHour">近 24 小时无访问 / 提问</div>
          </div>
        </el-col>

        <el-col :xs="24" :md="12">
          <div class="sec-panel">
            <div class="sec-ph">风险告警<span class="sec-dim">阈值规则：爆破 ≥5 高危 / ≥3 关注 · 高频 ≥ 阈值 · 错误率 ≥50% 且 ≥10 次</span></div>
            <div v-if="data.alerts.length === 0" class="sec-none">
              <el-empty description="暂无风险告警" :image-size="64" />
            </div>
            <div v-else class="sec-alerts">
              <div class="sec-alert" :class="'lv-' + a.level" v-for="(a, i) in data.alerts" :key="i">
                <el-tag size="small" :type="a.level === 'high' ? 'danger' : 'warning'">{{ a.level === 'high' ? '高危' : '关注' }}</el-tag>
                <div class="sec-alert-body">
                  <div class="sec-alert-t">{{ TYPE_LABEL[a.type] || a.type }}<span v-if="a.ip" class="sec-alert-ip">{{ a.ip }}</span></div>
                  <div class="sec-dim">{{ a.detail }}</div>
                </div>
                <el-button v-if="a.ip" size="small" type="danger" plain @click="openBan(a.ip!)">封禁</el-button>
              </div>
            </div>
          </div>
        </el-col>

        <el-col :xs="24" :md="12">
          <div class="sec-panel">
            <div class="sec-ph">IP 活动<span class="sec-dim">近 7 天审计 ∪ 近 24h 提问 · Top 10</span></div>
            <el-table :data="data.top_ips" size="small" max-height="300" empty-text="暂无 IP 活动">
              <el-table-column prop="ip" label="IP" min-width="120" show-overflow-tooltip />
              <el-table-column prop="events" label="事件" min-width="56" align="right" />
              <el-table-column prop="qa24h" label="提问(24h)" min-width="76" align="right" />
              <el-table-column prop="fails" label="登录失败" min-width="72" align="right">
                <template #default="{ row }"><span :class="{ 'sec-warn': row.fails > 0 }">{{ row.fails }}</span></template>
              </el-table-column>
              <el-table-column label="最近活跃" min-width="148">
                <template #default="{ row }">{{ row.last_at ? fmtDateTime(row.last_at) : "-" }}</template>
              </el-table-column>
              <el-table-column label="状态" min-width="64">
                <template #default="{ row }"><el-tag size="small" :type="row.banned ? 'danger' : 'info'">{{ row.banned ? "已封禁" : "正常" }}</el-tag></template>
              </el-table-column>
              <el-table-column label="操作" min-width="64" fixed="right">
                <template #default="{ row }">
                  <el-button v-if="!row.banned" size="small" type="danger" plain @click="openBan(row.ip)">封禁</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-col>

        <el-col :xs="24" :md="12">
          <div class="sec-panel">
            <div class="sec-ph">封禁管理<span class="sec-dim">生效 + 近 7 天过期 · 手动 / 自动</span></div>
            <el-table :data="data.bans" size="small" max-height="300" empty-text="暂无封禁记录">
              <el-table-column prop="ip" label="IP" min-width="110" show-overflow-tooltip />
              <el-table-column prop="reason" label="原因" min-width="120" show-overflow-tooltip />
              <el-table-column prop="created_by_name" label="操作人" min-width="76" show-overflow-tooltip />
              <el-table-column label="创建时间" min-width="148">
                <template #default="{ row }">{{ fmtDateTime(row.created_at) }}</template>
              </el-table-column>
              <el-table-column label="到期" min-width="112">
                <template #default="{ row }">
                  <span v-if="row.permanent">永久</span>
                  <span v-else class="sec-dim">{{ fmtDateTime(row.expires_at!) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" min-width="60">
                <template #default="{ row }"><el-tag size="small" :type="row.active ? 'danger' : 'info'">{{ row.active ? "生效" : "过期" }}</el-tag></template>
              </el-table-column>
              <el-table-column label="操作" min-width="70" fixed="right">
                <template #default="{ row }">
                  <el-popconfirm v-if="row.active" title="确认解除该 IP 封禁？" confirm-button-text="解除" cancel-button-text="取消" @confirm="unban(row)">
                    <template #reference><el-button size="small" plain :icon="Unlock">解除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-col>

        <el-col :xs="24" :md="24">
          <div class="sec-panel">
            <div class="sec-ph">安全事件<span class="sec-dim">登录 / 踢出 / 封禁 留痕（最近 20 条，可加载更多）</span></div>
            <el-table :data="data.events" size="small" max-height="340" empty-text="暂无安全事件">
              <el-table-column label="时间" min-width="150">
                <template #default="{ row }">{{ fmtDateTime(row.created_at) }}</template>
              </el-table-column>
              <el-table-column label="动作" min-width="120">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.action.includes('failed') || row.action.includes('ban') ? 'danger' : row.action.includes('kick') ? 'warning' : 'success'">
                    {{ ACTION_LABEL[row.action] || row.action }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="主体" min-width="110" show-overflow-tooltip>
                <template #default="{ row }">{{ actorLabel(row) }}</template>
              </el-table-column>
              <el-table-column label="目标" min-width="110" show-overflow-tooltip>
                <template #default="{ row }">{{ targetLabel(row) || "-" }}</template>
              </el-table-column>
              <el-table-column prop="ip" label="来源 IP" min-width="120" show-overflow-tooltip />
            </el-table>
            <div class="sec-more" v-if="data.events.length < 200">
              <el-button size="small" text @click="loadMoreEvents">加载更多</el-button>
            </div>
          </div>
        </el-col>
      </el-row>
    </template>
    <el-empty v-else-if="!loading && !error" description="暂无数据" />

    <el-dialog v-model="banDlg" title="封禁 IP" width="440px" :close-on-click-modal="false">
      <el-form label-width="84px">
        <el-form-item label="IP 地址">
          <el-input v-model="banIp" placeholder="如 203.0.113.7 或 ::1" />
        </el-form-item>
        <el-form-item label="封禁时长">
          <el-select v-model="banMinutes" style="width: 100%">
            <el-option :value="60" label="1 小时" />
            <el-option :value="1440" label="24 小时" />
            <el-option :value="10080" label="7 天" />
            <el-option :value="0" label="永久" />
          </el-select>
        </el-form-item>
        <el-form-item label="原因">
          <el-input v-model="banReason" placeholder="可选，如：疑似扫描 / 恶意提问" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="banDlg = false">取消</el-button>
        <el-button type="danger" :loading="banSaving" @click="submitBan">确认封禁</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sec { display: flex; flex-direction: column; gap: 14px; }
.sec-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.sec-bar-r { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sec-dim { font-size: 12px; opacity: 0.65; }
.sec-err { cursor: pointer; }
.sec-card { border: 1px solid var(--el-border-color-light); border-radius: 10px; padding: 12px 14px; background: var(--el-bg-color); }
.sec-card-v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sec-card-unit { font-size: 12px; font-weight: 400; opacity: 0.65; margin-left: 4px; }
.sec-card-k { font-size: 12px; opacity: 0.75; margin-top: 2px; }
.sec-card-d { font-size: 12px; margin-top: 4px; }
.sec-card.warn .sec-card-v { color: var(--el-color-danger); }
.sec-panel { position: relative; border: 1px solid var(--el-border-color-light); border-radius: 10px; padding: 12px 14px; background: var(--el-bg-color); }
.sec-ph { font-size: 13px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.sec-chart { height: 280px; }
.sec-empty { position: absolute; left: 0; right: 0; top: 46px; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; opacity: 0.6; pointer-events: none; }
.sec-none { padding: 6px 0; }
.sec-alerts { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; }
.sec-alert { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--el-border-color-light); }
.sec-alert.lv-high { border-color: var(--el-color-danger-light-5); background: var(--el-color-danger-light-9); }
.sec-alert.lv-medium { border-color: var(--el-color-warning-light-5); background: var(--el-color-warning-light-9); }
.sec-alert-body { flex: 1; min-width: 0; }
.sec-alert-t { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.sec-alert-ip { font-weight: 400; font-size: 12px; opacity: 0.8; font-family: Consolas, monospace; }
.sec-warn { color: var(--el-color-danger); }
.sec-more { text-align: center; padding-top: 6px; }
</style>
