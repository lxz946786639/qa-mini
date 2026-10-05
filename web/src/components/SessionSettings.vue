
<script setup lang="ts">
// 会话设置（P5.5 移植自 public/app.js 会话抽屉的可配置部分）：
// 名称 / 协议 / 多轮（continue_session）/ 电脑输出音频（audio_remote）/
// 会话级协议覆盖（protocol_config，留空 = 回退全局）/ 协议测试（管理）/
// 推送 token（管理：回显 + 重新生成 + EchoScribe 对接片段）。
import { computed, reactive, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const PROTOCOLS = [
  { value: "ragflow", label: "知识引擎（RAGFlow）" },
  { value: "dify", label: "编排引擎（Dify）" },
  { value: "openai", label: "OpenAI 兼容" },
  { value: "generic", label: "通用 HTTP" }
];
const CFG_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  ragflow: [
    { key: "url", label: "RAGFlow URL" },
    { key: "api_key", label: "API Key", secret: true },
    { key: "chat_id", label: "Chat ID（知识库）" }
  ],
  dify: [
    { key: "url", label: "Dify URL" },
    { key: "api_key", label: "API Key", secret: true }
  ],
  openai: [
    { key: "url", label: "OpenAI 兼容 URL" },
    { key: "api_key", label: "API Key", secret: true },
    { key: "model", label: "模型（如 gpt-4o）" }
  ],
  generic: [
    { key: "url", label: "请求 URL" },
    { key: "api_key", label: "API Key", secret: true },
    { key: "body", label: "请求体模板（含 {question} 占位）" }
  ]
};

const props = defineProps<{ session: any; isAdmin: boolean; open: boolean }>();
const emit = defineEmits<{ (e: "saved"): void; (e: "toast", msg: string): void }>();

const form = reactive({
  name: "", protocol: "ragflow", continue_session: true,
  audio_enabled: false, preferred_device: "",
  config: { url: "", api_key: "", chat_id: "", model: "", body: "" }
});
const testState = reactive({ running: false, text: "", ok: null as boolean | null });
const fields = computed(() => CFG_FIELDS[form.protocol] || []);

watch(() => props.session && props.session.id, () => fill(), { immediate: true });
watch(() => form.protocol, () => {
  form.config = { url: "", api_key: "", chat_id: "", model: "", body: "" };
  const pc = (props.session && props.session.protocol_config) || {};
  const cur = pc[form.protocol] || {};
  for (const f2 of fields.value) {
    const v = cur[f2.key];
    if (typeof v === "string") form.config[f2.key] = v;
  }
});
function fill() {
  const s = props.session;
  if (!s) return;
  form.name = s.name || "";
  form.protocol = s.protocol || "ragflow";
  form.continue_session = s.continue_session !== false;
  const ar = s.audio_remote && typeof s.audio_remote === "object" ? s.audio_remote : {};
  form.audio_enabled = ar.enabled === true;
  form.preferred_device = ar.preferred_device || "";
  form.config = { url: "", api_key: "", chat_id: "", model: "", body: "" };
  const pc = s.protocol_config || {};
  const cur = pc[form.protocol] || {};
  for (const f2 of CFG_FIELDS[form.protocol] || []) {
    const v = cur[f2.key];
    if (typeof v === "string") form.config[f2.key] = v;
  }
  testState.text = ""; testState.ok = null;
}
function cfgPayload(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f2 of fields.value) {
    const v = form.config[f2.key];
    if (typeof v === "string" && v.trim()) out[f2.key] = v.trim();
  }
  return out;
}
async function save() {
  const s = props.session;
  if (!s) return;
  const body: Record<string, any> = {
    name: form.name, protocol: form.protocol, continue_session: form.continue_session,
    audio_remote: { enabled: form.audio_enabled, preferred_device: form.preferred_device },
    protocol_config: { [form.protocol]: cfgPayload() }
  };
  const r = await api("/api/sessions/" + encodeURIComponent(s.id), { method: "PUT", body });
  if (r.ok) { ElMessage.success("会话设置已保存"); emit("saved"); }
  else ElMessage.error(r.data.detail || "保存失败");
}
async function test() {
  const s = props.session;
  if (!s) return;
  testState.running = true; testState.text = ""; testState.ok = null;
  try {
    const r = await api("/api/sessions/" + encodeURIComponent(s.id) + "/protocol-test", {
      method: "POST", body: { protocol: form.protocol, config: cfgPayload() }
    });
    testState.ok = !!r.data.ok;
    testState.text = (r.data && (r.data.detail || ("HTTP " + r.status))) || "";
  } catch (e: any) {
    testState.ok = false;
    testState.text = ((e && e.message) || e) + "";
  } finally { testState.running = false; }
}
async function regenToken() {
  const s = props.session;
  if (!s) return;
  const r = await api("/api/sessions/" + encodeURIComponent(s.id), { method: "PUT", body: { regenerate_token: true } });
  if (r.ok) { ElMessage.success("推送 token 已重新生成"); emit("saved"); }
  else ElMessage.error(r.data.detail || "操作失败");
}
// 会话重置（管理，对齐旧抽屉「重置」）：清后端多轮上下文（ragflow_session_id /
// dify_conversation_id + 在途取消），下次提问重建。
async function resetSession() {
  const s = props.session;
  if (!s) return;
  try {
    await ElMessageBox.confirm("重置将清除本会话的后端多轮上下文（在途问答一并取消），下次提问重建会话。继续？", "重置会话", { type: "warning", confirmButtonText: "重置", cancelButtonText: "取消" });
  } catch { return; }
  const { ok, data } = await api<{ ok: boolean; detail?: string }>("/api/sessions/" + encodeURIComponent(s.id) + "/reset", { method: "POST", body: {} });
  if (ok) ElMessage.success(data.detail || "会话已重置");
  else ElMessage.error(data.detail || "重置失败");
}
const snippet = computed(() => {
  const s = props.session;
  if (!s || !s.token) return "";
  const url = window.location.origin + "/api/push";
  return [
    "[third_party]",
    "url = '" + url + "'",
    "body = '" + JSON.stringify({ token: s.token, session_id: s.id }) + "'",
    "auto_send = true",
    "qa_enabled = false"
  ].join("\n");
});
function copyText(t: string) {
  navigator.clipboard.writeText(t).then(
    () => ElMessage.success("已复制"),
    () => ElMessage.warning("复制失败（浏览器限制）")
  );
}
</script>

<template>
  <div v-if="session" class="ss-body">
    <el-form label-position="top">
      <el-form-item label="会话名称（≤40）">
        <el-input v-model="form.name" />
      </el-form-item>
      <el-form-item label="协议">
        <el-select v-model="form.protocol">
          <el-option v-for="p in PROTOCOLS" :key="p.value" :label="p.label" :value="p.value" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-switch v-model="form.continue_session" active-text="多轮上下文（continue_session）" />
      </el-form-item>

      <div class="ss-section">电脑输出音频接收（EchoScribe 持续推流）</div>
      <el-form-item>
        <el-switch v-model="form.audio_enabled" active-text="启用本会话音频接收" />
      </el-form-item>
      <el-form-item label="首选设备（可空 = 首个推流设备）">
        <el-input v-model="form.preferred_device" placeholder="如 Speakers (Realtek Audio)" />
      </el-form-item>

      <div class="ss-section">会话级协议配置（留空 = 回退全局默认）</div>
      <template v-for="f2 in fields" :key="f2.key">
        <el-form-item :label="f2.label">
          <el-input v-model="form.config[f2.key]" :type="f2.secret ? 'password' : (f2.key === 'body' ? 'textarea' : 'text')" :show-password="f2.secret" :autosize="f2.key === 'body' ? { minRows: 2, maxRows: 6 } : undefined" />
        </el-form-item>
      </template>
      <el-form-item v-if="isAdmin">
        <el-button size="small" :loading="testState.running" @click="test">测试连接（当前草稿值）</el-button>
        <span v-if="testState.ok !== null" :class="testState.ok ? 'ss-ok' : 'ss-bad'">{{ testState.text }}</span>
      </el-form-item>

      <template v-if="isAdmin">
        <div class="ss-section">推送对接（EchoScribe / 旧版代码查看器）</div>
        <el-form-item label="会话推送 token（只读）">
          <el-input :model-value="session.token || ''" readonly>
            <template #append><el-button @click="copyText(session.token || '')">复制</el-button></template>
          </el-input>
        </el-form-item>
        <el-form-item>
          <el-button size="small" type="danger" plain @click="regenToken">重新生成推送 token</el-button>
          <span class="ss-warn">旧对接方需同步新 token；重新生成后旧 token 立即失效</span>
        </el-form-item>
        <el-form-item label="echoscribe.toml 片段（只读）">
          <pre class="ss-pre">{{ snippet }}</pre>
          <el-button size="small" @click="copyText(snippet)">复制片段</el-button>
        </el-form-item>
        <el-form-item>
          <el-button size="small" plain @click="resetSession">重置会话后端上下文</el-button>
          <span class="ss-warn">清除 RAGFlow/Dify 多轮会话（在途问答一并取消），下次提问重建</span>
        </el-form-item>
      </template>
    </el-form>
  </div>
</template>
