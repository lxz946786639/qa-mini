
<script setup lang="ts">
// 会话设置（P7.9 按重构前 public/ 会话抽屉重排版；P8.7 内容分类为 5 个 tab，
// 缩短弹窗高度；P8.67 行距统一：字段注记并入 label 槽位、token 警示贴控制项下、
// 独立提示不再占 form-item 行距、弹窗体超高内部滚动）：自含 el-dialog（头部/主体/底部）。tab = 基本（名称/问答协议/
// 提问续接）/ 协议配置（修改后需测试通过才能保存，含测试守护）/ EchoScribe（会话ID/
// 推送token/配置片段/body 值，admin 页签）/ 音频（电脑输出音频接收 + 首选设备）/
// 管理（重置后端上下文，admin 页签）；底部 = 保存状态 + 删除会话 + 保存。
// 服务端契约：PUT /api/sessions/:id（admin 或本桶拥有者；protocol_config 按协议分组，
// 空值丢弃 = 回退全局默认；**P8.53 protocol_config 仅管理生效**，非 admin 静默忽略）；
// POST .../protocol-test（管理）；POST .../reset（管理）。
// P8.53：协议配置页签仅 admin 可见（普通用户/访问码/匿名只余 基本/音频 等页签）。
import { computed, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const PROTOCOLS = [
  { value: "ragflow", label: "知识引擎（聊天助手）" },
  { value: "openai", label: "openai · OpenAI 兼容" },
  { value: "dify", label: "编排引擎（对话流）" },
  { value: "generic", label: "generic · 第三方通用" }
];
const CFG_FIELDS: Record<string, { key: string; label: string; secret?: boolean; textarea?: boolean }[]> = {
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
    { key: "body", label: "请求体模板（含 {question} 占位）", textarea: true }
  ]
};

const props = defineProps<{ session: any; isAdmin: boolean; open: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved"): void;
  (e: "delete"): void;
}>();

const form = reactive({
  name: "", protocol: "ragflow", continue_session: true,
  audio_enabled: false, preferred_device: "",
  config: { url: "", api_key: "", chat_id: "", model: "", body: "" }
});
const tab = ref("basic");
const testState = reactive({ running: false, text: "", ok: null as boolean | null });
const saveState = reactive({ text: "", cls: "" });
// 测试守护（对齐旧抽屉 protoDraftKey/protoDraftDirty/protoTested 语义）：
// 当前协议配置草稿 ≠ 已保存值且非空 → 必须先「测试连接」通过（草稿指纹一致）才能保存
const tested = reactive({ proto: "", key: "" });
const fields = computed(() => CFG_FIELDS[form.protocol] || []);

function cfgVals(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields.value) {
    const v = form.config[f.key];
    if (typeof v === "string" && v.trim()) out[f.key] = v.trim();
  }
  return out;
}
function draftKey(proto: string): string {
  const parts: string[] = [];
  for (const f of CFG_FIELDS[proto] || []) {
    const v = form.config[f.key];
    const t = typeof v === "string" ? v.trim() : "";
    if (t) parts.push(f.key + "=" + t);
  }
  return parts.join("|");
}
function savedKey(proto: string): string {
  const saved = (props.session && props.session.protocol_config && props.session.protocol_config[proto]) || {};
  const parts: string[] = [];
  for (const f of CFG_FIELDS[proto] || []) {
    const v = saved[f.key];
    const t = typeof v === "string" ? v.trim() : "";
    if (t) parts.push(f.key + "=" + t);
  }
  return parts.join("|");
}
function cfgDirty(): boolean { return draftKey(form.protocol) !== savedKey(form.protocol); }
function cfgTestedNow(): boolean { return tested.proto === form.protocol && tested.key === draftKey(form.protocol); }

watch(() => props.session && props.session.id, () => { fill(); }, { immediate: true });
watch(() => form.protocol, () => {
  form.config = { url: "", api_key: "", chat_id: "", model: "", body: "" };
  const pc = (props.session && props.session.protocol_config) || {};
  const cur = pc[form.protocol] || {};
  for (const f of fields.value) {
    const v = cur[f.key];
    if (typeof v === "string") form.config[f.key] = v;
  }
  tested.proto = ""; tested.key = ""; // 切协议 = 草稿重置，需重新测试
  testState.text = ""; testState.ok = null;
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
  for (const f of CFG_FIELDS[form.protocol] || []) {
    const v = cur[f.key];
    if (typeof v === "string") form.config[f.key] = v;
  }
  tested.proto = ""; tested.key = "";
  testState.text = ""; testState.ok = null;
  saveState.text = ""; saveState.cls = "";
}
function hhmmss(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
async function save() {
  const s = props.session;
  if (!s) return;
  // 旧抽屉守护：协议配置有修改（且非全空）但未经测试（或测试后又有改动）→ 先测试
  if (draftKey(form.protocol) !== "" && cfgDirty() && !cfgTestedNow()) {
    saveState.text = "协议配置有修改，请先测试"; saveState.cls = "err";
    ElMessage.warning("协议配置有修改，请先点「测试连接」并通过后再保存");
    return;
  }
  saveState.text = "保存中…"; saveState.cls = "";
  const body: Record<string, any> = {
    name: form.name, protocol: form.protocol, continue_session: form.continue_session,
    audio_remote: { enabled: form.audio_enabled, preferred_device: form.preferred_device }
  };
  // P8.53：协议配置仅管理可改 —— 非 admin 不提交 protocol_config（服务端亦忽略）
  if (props.isAdmin) body.protocol_config = { [form.protocol]: cfgVals() };
  try {
    const r = await api<{ ok: boolean; detail?: string }>(
      "/api/sessions/" + encodeURIComponent(s.id), { method: "PUT", body }
    );
    if (r.ok) {
      saveState.text = "已保存 " + hhmmss(new Date()); saveState.cls = "ok";
      ElMessage.success("会话设置已保存");
      emit("saved");
    } else {
      saveState.text = "保存失败"; saveState.cls = "err";
      ElMessage.error(r.data.detail || "保存失败");
    }
  } catch (e: any) {
    saveState.text = "保存失败"; saveState.cls = "err";
    ElMessage.error(((e && e.message) || e) + "");
  }
}
async function test() {
  const s = props.session;
  if (!s) return;
  testState.running = true; testState.text = ""; testState.ok = null;
  try {
    const r = await api("/api/sessions/" + encodeURIComponent(s.id) + "/protocol-test", {
      method: "POST", body: { protocol: form.protocol, config: cfgVals() }
    });
    testState.ok = !!r.data.ok;
    testState.text = (r.data && (r.data.detail || ("HTTP " + r.status))) || "";
    if (testState.ok) { tested.proto = form.protocol; tested.key = draftKey(form.protocol); }
  } catch (e: any) {
    testState.ok = false;
    testState.text = ((e && e.message) || e) + "";
  } finally { testState.running = false; }
}
async function regenToken() {
  const s = props.session;
  if (!s) return;
  try {
    await ElMessageBox.confirm("重新生成后旧 token 立即失效，EchoScribe 等对接方需同步更新 body。继续？", "重新生成推送 token", {
      type: "warning", confirmButtonText: "重生成", cancelButtonText: "取消"
    });
  } catch { return; }
  const r = await api("/api/sessions/" + encodeURIComponent(s.id), { method: "PUT", body: { regenerate_token: true } });
  if (r.ok) { ElMessage.success("推送 token 已重新生成"); emit("saved"); }
  else ElMessage.error(r.data.detail || "操作失败");
}
// 会话重置（管理，对齐旧抽屉「重置会话（清空后端上下文）」）：清后端多轮上下文
// （ragflow_session_id / dify_conversation_id + 在途取消），已显示记录保留。
async function resetSession() {
  const s = props.session;
  if (!s) return;
  try {
    await ElMessageBox.confirm("重置将清空本会话的后端对话上下文（等同 EchoScribe「清空」，已显示记录保留；在途问答一并取消），下次提问重建。继续？", "重置会话", {
      type: "warning", confirmButtonText: "重置", cancelButtonText: "取消"
    });
  } catch { return; }
  const { ok, data } = await api<{ ok: boolean; detail?: string }>("/api/sessions/" + encodeURIComponent(s.id) + "/reset", { method: "POST", body: {} });
  if (ok) ElMessage.success(data.detail || "会话已重置");
  else ElMessage.error(data.detail || "重置失败");
}
function removeSession() {
  emit("delete");
}
// 推送对接（对齐旧抽屉 asrSnippet / asrBody：TOML 单引号字面量，可直接粘贴）
const pushUrl = computed(() => window.location.origin + "/api/push");
const pushBody = computed(() => {
  const s = props.session;
  if (!s || !s.token) return "";
  return '{"token":"' + s.token + '","session_id":"' + s.id + '"}';
});
const NL = String.fromCharCode(10); // 换行符（避免源码转义歧义）
const snippet = computed(() => {
  if (!pushBody.value) return "";
  return [
    "[third_party]",
    "url = '" + pushUrl.value + "'",
    "body = '" + pushBody.value + "'",
    "auto_send = true",
    "qa_enabled = false"
  ].join(NL);
});
function copyText(t: string, tip?: string) {
  navigator.clipboard.writeText(t).then(
    () => ElMessage.success(tip || "已复制"),
    () => ElMessage.warning("复制失败（浏览器限制）")
  );
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="ss-dialog"
    title="会话设置"
    width="640px"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="() => emit('close')"
  >
    <div v-if="session" class="ss-body">
      <!-- P8.7：内容分类为 tab（基本 / 协议配置 / EchoScribe / 音频 / 管理），缩短弹窗高度 -->
      <el-tabs v-model="tab" class="ss-tabs">
        <el-tab-pane label="基本" name="basic">
          <el-form label-position="top">
            <el-form-item label="会话名称（≤40）">
              <el-input v-model="form.name" maxlength="40" show-word-limit placeholder="给这个会话起个名字" />
            </el-form-item>
            <el-form-item label="问答协议">
              <el-select v-model="form.protocol">
                <el-option v-for="p in PROTOCOLS" :key="p.value" :label="p.label" :value="p.value" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-switch v-model="form.continue_session" active-text="提问续接本会话（语音追问带上下文）" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <!-- P8.53：会话级协议配置仅管理可改（普通用户/访问码/匿名不展示该页签） -->
        <el-tab-pane v-if="isAdmin" label="协议配置" name="protocol">
          <el-form label-position="top">
            <p class="ss-small ss-pane-note">本会话协议配置：留空 = 回退全局默认；修改后需测试通过才能保存（仅管理可改）。</p>
            <template v-for="f in fields" :key="f.key">
              <el-form-item :label="f.label">
                <el-input
                  v-model="form.config[f.key]"
                  :type="f.secret ? 'password' : (f.textarea ? 'textarea' : 'text')"
                  :show-password="f.secret"
                  :autosize="f.textarea ? { minRows: 2, maxRows: 6 } : undefined"
                  :placeholder="f.secret ? '留空 = 回退全局默认' : ''"
                />
              </el-form-item>
            </template>
            <el-form-item v-if="isAdmin">
              <el-button size="small" :loading="testState.running" @click="test">测试连接（当前草稿值）</el-button>
              <span v-if="testState.ok !== null" :class="testState.ok ? 'ss-ok' : 'ss-bad'">{{ testState.text }}</span>
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane v-if="isAdmin" label="EchoScribe" name="push">
          <el-form label-position="top">
            <el-form-item>
              <template #label>会话 ID<span class="ss-label-note">（EchoScribe 推送请求体需同时携带）</span></template>
              <el-input :model-value="session.id" readonly class="ss-mono">
                <template #append><el-button @click="copyText(session.id, '会话 ID 已复制')">复制</el-button></template>
              </el-input>
            </el-form-item>
            <el-form-item label="推送 token">
              <el-input :model-value="session.token || ''" type="password" readonly show-password class="ss-mono">
                <template #append>
                  <el-button @click="copyText(session.token || '', '推送 token 已复制')">复制</el-button>
                  <el-button type="danger" plain @click="regenToken">重生成</el-button>
                </template>
              </el-input>
              <span class="ss-small ss-warn ss-warn-line">重新生成后旧 token 立即失效，对接方需同步更新 body</span>
            </el-form-item>
            <el-form-item>
              <template #label>EchoScribe 配置片段<span class="ss-label-note">（echoscribe.toml · 推送模式，可直接粘贴）</span></template>
              <pre class="ss-pre">{{ snippet }}</pre>
              <el-button size="small" @click="copyText(snippet, 'EchoScribe 配置片段已复制')">复制片段</el-button>
            </el-form-item>
            <el-form-item>
              <template #label>body 值<span class="ss-label-note">（EchoScribe 设置页「第三方接口 body」直接粘贴）</span></template>
              <pre class="ss-pre">{{ pushBody }}</pre>
              <el-button size="small" @click="copyText(pushBody, 'body 值已复制')">复制 body</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="音频" name="audio">
          <el-form label-position="top">
            <el-form-item>
              <el-switch v-model="form.audio_enabled" active-text="启用电脑输出音频接收（EchoScribe「持续推流」到本会话）" />
            </el-form-item>
            <el-form-item label="首选设备（可空 = 首个推流设备）">
              <el-input v-model="form.preferred_device" placeholder="如 Speakers (Realtek Audio)" />
            </el-form-item>
            <p class="ss-small ss-plain-note">推流中的设备识别操作见底部 composer「音频」面板</p>
          </el-form>
        </el-tab-pane>
        <el-tab-pane v-if="isAdmin" label="管理" name="advanced">
          <el-form label-position="top">
            <el-form-item>
              <el-button size="small" plain @click="resetSession">重置会话（清空后端上下文）</el-button>
              <span class="ss-warn">等同 EchoScribe「清空」，已显示记录保留；在途问答一并取消，下次提问重建</span>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </div>
    <template #footer>
      <div class="ss-footer">
        <span :class="['ss-save-state', saveState.cls]">{{ saveState.text }}</span>
        <div class="ss-footer-btns">
          <el-button type="danger" plain @click="removeSession">删除会话</el-button>
          <el-button type="primary" @click="save">保存</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>
