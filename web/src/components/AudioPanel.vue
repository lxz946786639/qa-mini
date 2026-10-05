
<script setup lang="ts">
// 电脑输出音频识别面板（P5.5 移植自 public/app.js「音频」按钮 + 抽屉设备区）：
// 设备下拉（GET /api/audio/stream?token=）+ 开始识别 / 停止识别（定稿）/ 重新开始 / 取消；
// 中间识别走 SSE audio_listen partial（Workspace 转发 handleListenEvent）；
// 定稿 emit finalized(text) → Workspace 按「自动发送」开关处理。
// 仅管理视图（含 token）可用；会话须 audio_remote.enabled = true。
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const props = defineProps<{ session: any }>();
const emit = defineEmits<{ (e: "finalized", text: string): void; (e: "toast", msg: string): void }>();

const S = props.session; // { id, token, audio_remote: { enabled, preferred_device } }

const device = ref("");
const listening = ref(false);
const busy = ref(false);
const interim = ref("");
const streams = ref<any[]>([]);

function fmtDevName(d: any): string {
  d = String(d == null ? "" : d);
  return /^\d+$/.test(d) ? d + "（旧版序号编码）" : d;
}
function fmtBytes(n: any): string {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

async function refreshDevices() {
  const s = props.session;
  if (!s || !s.token) { streams.value = []; return; }
  try {
    const r = await api<{ ok?: boolean; streams?: any[] }>(
      "/api/audio/stream?token=" + encodeURIComponent(s.token)
    );
    if (r.ok) streams.value = r.data.streams || [];
  } catch { streams.value = []; }
  // 保留当前选择；非直播设备禁用（沿用旧语义）
  const prev = device.value;
  const liveList = streams.value.filter((x) => x.ms_since_last_frame != null && x.ms_since_last_frame < 5000);
  const stillOk = streams.value.some((x) => x.device === prev) &&
    (liveList.some((x) => x.device === prev) || !liveList.length);
  device.value = stillOk ? prev : (liveList[0] || streams.value[0] || { device: "" }).device;
}

async function start() {
  if (busy.value || listening.value) return;
  const s = props.session;
  if (!s) return;
  if (!device.value) { ElMessage.warning("无可选音频设备（等 EchoScribe 推流后重试）"); return; }
  busy.value = true;
  try {
    const r = await api("/api/audio/listen", { body: { token: s.token, device: device.value } });
    if (r.ok) {
      listening.value = true;
      interim.value = "识别中…";
    } else ElMessage.error("开始识别失败: " + (r.data.detail || ("HTTP " + r.status)));
  } catch (e: any) {
    ElMessage.error("开始识别失败: " + ((e && e.message) || e));
  } finally { busy.value = false; }
}
async function stop() {
  if (!listening.value) return;
  listening.value = false; // 先行上锁：服务端 SSE stopped 事件不重复定稿
  const s = props.session;
  if (!s) return;
  try {
    const r = await api<{ text?: string }>(
      "/api/audio/listen/stop", { body: { token: s.token, device: device.value } }
    );
    if (r.ok) await finalize(r.data.text || "");
    else { ElMessage.error("停止失败: " + (r.data.detail || ("HTTP " + r.status))); }
  } catch (e: any) {
    ElMessage.error("停止失败: " + ((e && e.message) || e));
  }
}
async function cancelListen() {
  if (!listening.value) return;
  listening.value = false;
  const s = props.session;
  if (!s) return;
  try {
    await api("/api/audio/listen/cancel", { body: { token: s.token, device: device.value } });
  } catch { /* 忽略 */ }
  interim.value = "";
  ElMessage.info("已取消识别（文本已丢弃）");
}
async function restart() {
  if (!listening.value || busy.value) return;
  const s = props.session;
  if (!s) return;
  try {
    await api("/api/audio/listen/cancel", { body: { token: s.token, device: device.value } });
  } catch { /* 忽略 */ }
  listening.value = false;
  interim.value = "";
  await start();
}
async function finalize(text: string) {
  interim.value = "";
  listening.value = false;
  const t = (text || "").trim();
  if (!t) { ElMessage.info("未识别到语音"); return; }
  emit("finalized", t);
}

// Workspace 转发 SSE audio_listen 事件（已按当前会话 + 设备过滤）
function handleListenEvent(d: any) {
  if (!d || !d.state) return;
  if (d.state === "partial") {
    interim.value = "…" + (d.text || "");
  } else if (d.state === "stopped") {
    if (!listening.value) return; // 停止点击响应已处理（定稿文本以响应为准）
    finalize(d.text || "");
  } else if (d.state === "cancelled") {
    if (!listening.value) return;
    listening.value = false;
    interim.value = "";
  } else if (d.state === "stream_stopped") {
    if (listening.value) {
      listening.value = false;
      ElMessage.warning("音频推流已结束，识别自动停止");
      finalize(d.text || "");
      refreshDevices();
    }
  }
}

// 切会话：停止监听（取消在途识别）+ 清空状态
function reset() {
  const s = props.session;
  if (listening.value && s) {
    api("/api/audio/listen/cancel", { body: { token: s.token, device: device.value } }).catch(() => {});
  }
  listening.value = false;
  interim.value = "";
  device.value = "";
  streams.value = [];
}
onMounted(refreshDevices);
onBeforeUnmount(reset);
watch(() => props.session && props.session.id, reset);
function currentDevice() { return device.value; }
defineExpose({ handleListenEvent, refreshDevices, reset, currentDevice });
</script>

<template>
  <div class="audio-panel">
    <div class="ap-row">
      <span class="ap-title">🎧 电脑输出音频（EchoScribe 持续推流）</span>
      <el-select v-model="device" size="small" :disabled="!streams.length" style="width: 240px">
        <el-option v-if="!streams.length" value="" label="无正在接收的设备" disabled />
        <el-option
          v-for="st in streams" :key="st.device" :value="st.device"
          :label="fmtDevName(st.device) + (st.ms_since_last_frame != null && st.ms_since_last_frame < 5000 ? '' : '（已断开）') + ' · ' + fmtBytes(st.total_bytes)"
          :disabled="!(st.ms_since_last_frame != null && st.ms_since_last_frame < 5000)"
        />
      </el-select>
      <span class="ap-hint">在 EchoScribe 点「开始推流」后选择设备</span>
    </div>
    <div class="ap-row">
      <el-button v-if="!listening" size="small" type="primary" :loading="busy" :disabled="busy || !device" @click="start">开始识别</el-button>
      <template v-else>
        <el-button size="small" type="success" @click="stop">停止识别（定稿）</el-button>
        <el-button size="small" :disabled="busy" @click="restart">重新开始</el-button>
        <el-button size="small" type="danger" plain @click="cancelListen">取消</el-button>
      </template>
      <span v-if="interim" class="ap-interim">{{ interim }}</span>
    </div>
  </div>
</template>
