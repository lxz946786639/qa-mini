<script setup lang="ts">
// 系统设置（P7：移植自旧前端「⚙ 设置」抽屉，仅 admin 控制台可达）
// 协议全局默认（config.protocols）/ 语音输入 ASR（config.asr + /api/asr/test 草稿探测）。
// PUT /api/config 深合并：清空字段保存 = 清除该字段。
// P8.41 布局重构：配置分类改为 el-tabs 分类页签切换（各自独立保存）。
// P8.44：「访问控制」页签移除（匿名访问开关退役：首屏与匿名问答恒公开；
// config.security.allow_anonymous 字段保留兼容、不再生效）。
// P8.43 协议启用状态：每协议卡片「启用协议」开关（config.protocols.<p>.enabled，
// 缺省 = 启用；停用后该协议智能体提问被拒，智能体管理端同步标注「已停用」）。
// P8.81 配置体系重构：本页面仅承载「连接级」共享配置（URL/公共认证/通用参数）；
// 身份级字段（ragflow.chat_id / openai.model / dify.api_key）不再作全局预设——
// 改由「智能体管理」逐智能体必填（v8 迁移把旧全局值回填到各智能体后已清空全局）。
// 卡片显示配置完整性徽标；generic 卡提供「测试连接」（全局配置即可完整探测）。
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../../api";

interface ProtoForm { url: string; api_key: string; chat_id: string; model: string; body: string; user: string; }
const emptyProto = (): ProtoForm => ({ url: "", api_key: "", chat_id: "", model: "", body: "", user: "" });

const form = reactive({
  protocols: { openai: emptyProto(), dify: emptyProto(), generic: emptyProto(), ragflow: emptyProto() } as Record<string, ProtoForm>,
  asr: { url: "", api_key: "", model: "", language: "", timeout: 60 }
});
// P8.43：协议启用状态（全局；protoEnabled[p] !== false = 启用）
const protoEnabled = reactive<Record<string, boolean>>({ openai: true, dify: true, generic: true, ragflow: true });

const PROTO_NAMES: Record<string, string> = {
  openai: "OpenAI 兼容",
  dify: "编排引擎（Dify）",
  generic: "通用",
  ragflow: "知识引擎（RAGFlow）"
};
// P8.81: 仅连接级字段；身份级字段（chat_id/model/dify.api_key）移入智能体级必填配置
const PROTO_FIELDS: Record<string, { key: keyof ProtoForm; label: string; secret?: boolean; body?: boolean; hint?: string }[]> = {
  ragflow: [
    { key: "url", label: "服务地址 URL" },
    { key: "api_key", label: "API Key", secret: true, hint: "知识库 Chat ID 在「智能体管理」中按智能体必填配置，不再作全局预设" }
  ],
  dify: [
    { key: "url", label: "服务地址 URL" },
    { key: "user", label: "User 标识（请求 user 字段）", hint: "应用 Key（API Key）在「智能体管理」中按智能体必填配置，不再作全局预设" }
  ],
  openai: [
    { key: "url", label: "服务地址 URL（OpenAI 兼容）" },
    { key: "api_key", label: "API Key", secret: true, hint: "模型在「智能体管理」中按智能体必填配置，不再作全局预设" }
  ],
  generic: [
    { key: "url", label: "服务地址 URL" },
    { key: "api_key", label: "API Key", secret: true },
    { key: "body", label: "请求体模板（{question} 占位）", body: true }
  ]
};

function protoVal(p: string, k: string) { return String(form.protocols[p][k as keyof ProtoForm] ?? ""); }
function setProto(p: string, k: string, v: string) { (form.protocols[p] as Record<string, string>)[k] = v; }

// P8.81: 卡片配置完整性徽标（url 必填；api_key 对 ragflow/dify 必填、openai/generic 可选）
function protoBadges(p: string): { text: string; warn: boolean }[] {
  const urlOk = !!protoVal(p, "url").trim();
  const keyOk = !!protoVal(p, "api_key").trim();
  const keyRequired = p === "ragflow" || p === "dify";
  return [
    { text: urlOk ? "URL 已配置" : "URL 未配置", warn: !urlOk },
    { text: keyOk ? "API Key 已配置" : (keyRequired ? "API Key 未配置" : "API Key 留空（可选）"), warn: keyRequired && !keyOk }
  ];
}
// P8.81: generic 卡「测试连接」（全局配置即可完整探测；身份级字段缺失的协议不做全局测试）
const protoTest = reactive<Record<string, { running: boolean; text: string; ok: boolean | null }>>({
  openai: { running: false, text: "", ok: null },
  dify: { running: false, text: "", ok: null },
  generic: { running: false, text: "", ok: null },
  ragflow: { running: false, text: "", ok: null }
});
async function testProto(p: string) {
  protoTest[p].running = true; protoTest[p].ok = null; protoTest[p].text = "";
  try {
    const { data } = await api<any>("/api/admin/protocol-test", { method: "POST", body: { protocol: p, config: protoPayload()[p] } });
    protoTest[p].ok = !!data.ok;
    protoTest[p].text = data.detail || (data.ok ? "已连接" : "连接失败");
  } catch (e: any) {
    protoTest[p].ok = false;
    protoTest[p].text = String((e && e.message) || e);
  } finally { protoTest[p].running = false; }
}

const tab = ref<"proto" | "asr">("proto");
const busy = ref<"" | "proto" | "asr">("");
const asrTest = reactive({ running: false, text: "", ok: null as boolean | null });

onMounted(load);

async function load() {
  const { ok, data } = await api<any>("/api/config");
  if (!ok) { ElMessage.error("读取全局配置失败"); return; }
  const c = data || {};
  for (const p of Object.keys(form.protocols)) {
    const srcp = (c.protocols && c.protocols[p]) || {};
    protoEnabled[p] = srcp.enabled !== false; // P8.43
    for (const fld of PROTO_FIELDS[p]) {
      form.protocols[p][fld.key] = typeof srcp[fld.key] === "string" ? srcp[fld.key] : "";
    }
  }
  const a = (c.asr && typeof c.asr === "object" ? c.asr : {}) as Record<string, any>;
  for (const k of ["url", "api_key", "model", "language"]) form.asr[k] = typeof a[k] === "string" ? a[k] : "";
  form.asr.timeout = typeof a.timeout === "number" ? a.timeout : 60;
}

function protoPayload() {
  const out: Record<string, Record<string, string | boolean>> = {};
  for (const p of Object.keys(form.protocols)) {
    out[p] = { enabled: !!protoEnabled[p] }; // P8.43
    for (const fld of PROTO_FIELDS[p]) out[p][fld.key] = String(form.protocols[p][fld.key] ?? "").trim();
  }
  return out;
}

async function saveProtocols() {
  busy.value = "proto";
  try {
    const { ok, data } = await api<any>("/api/config", { method: "PUT", body: { protocols: protoPayload() } });
    if (ok) ElMessage.success("协议全局默认已保存" + (data.invalidated_sessions ? "（" + data.invalidated_sessions + " 个回退全局会话的后端会话已重置）" : ""));
    else ElMessage.error(data.detail || "保存失败");
  } finally { busy.value = ""; }
}

async function saveAsr() {
  const t = Math.round(form.asr.timeout);
  if (!(t >= 1 && t <= 300)) { ElMessage.warning("读超时需 1-300 秒"); return; }
  busy.value = "asr";
  try {
    const { ok, data } = await api<any>("/api/config", { method: "PUT", body: { asr: { url: form.asr.url, api_key: form.asr.api_key, model: form.asr.model, language: form.asr.language, timeout: t } } });
    if (ok) ElMessage.success("语音输入配置已保存（url 留空 = 停用网页语音输入）");
    else ElMessage.error(data.detail || "保存失败");
  } finally { busy.value = ""; }
}

async function testAsr() {
  asrTest.running = true; asrTest.ok = null; asrTest.text = "";
  try {
    const { data } = await api<any>("/api/asr/test", { method: "POST", body: { asr: { url: form.asr.url, api_key: form.asr.api_key, model: form.asr.model, language: form.asr.language } } });
    asrTest.ok = !!data.ok;
    asrTest.text = data.detail || (data.ok ? "已连接" : "连接失败");
  } catch (e: any) {
    asrTest.ok = false;
    asrTest.text = String((e && e.message) || e);
  } finally { asrTest.running = false; }
}
</script>

<template>
  <div class="sys-wrap">
    <el-tabs v-model="tab" class="sys-tabs">
      <el-tab-pane label="协议全局默认" name="proto">
    <section class="sys-sec">
      <p class="tab-note">此处仅配置「连接级」共享默认（服务地址/公共认证/通用参数）；知识库 Chat ID、模型、Dify 应用 Key 等身份级配置在「智能体管理」中按智能体必填。生效优先级：会话级覆盖 &gt; 智能体配置 &gt; 全局默认。</p>
      <div v-for="(fields, p) in PROTO_FIELDS" :key="p" class="sys-proto">
        <div class="sys-proto-name">
          {{ PROTO_NAMES[p] }}
          <span v-for="(b, bi) in protoBadges(p)" :key="bi" :class="b.warn ? 'ss-bad' : 'ss-ok'" style="font-size: 12px; font-weight: normal; margin-left: 8px;">{{ b.text }}</span>
        </div>
        <div class="sys-row">
          <label>启用协议</label>
          <el-switch v-model="protoEnabled[p]"></el-switch>
        </div>
        <p v-if="protoEnabled[p] === false" class="danger" style="font-size: 12px; margin: 0 0 8px;">该协议已停用：使用该协议的智能体无法提问（智能体管理端同步标注「已停用」，新建/改选该协议被拒）</p>
        <div v-for="f in fields" :key="f.key" class="sys-row">
          <label>{{ f.label }}<span v-if="f.hint" class="tab-note" style="display: block; margin-top: 2px; font-size: 12px;">{{ f.hint }}</span></label>
          <el-input
            v-if="f.body"
            :model-value="protoVal(p, f.key)"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            @update:model-value="(v: string) => setProto(p, f.key, v)"
          ></el-input>
          <el-input
            v-else
            :model-value="protoVal(p, f.key)"
            :type="f.secret ? 'password' : 'text'"
            :show-password="!!f.secret"
            @update:model-value="(v: string) => setProto(p, f.key, v)"
          ></el-input>
        </div>
      </div>
      <div class="sys-row">
        <label></label>
        <el-button :loading="protoTest.generic.running" @click="testProto('generic')">测试连接（通用协议·全局配置）</el-button>
        <span v-if="protoTest.generic.text" :class="protoTest.generic.ok ? 'ss-ok' : 'ss-bad'">{{ protoTest.generic.text }}</span>
      </div>
      <el-button type="primary" :loading="busy === 'proto'" @click="saveProtocols">保存协议全局默认</el-button>
      <span class="tab-note">保存后 ragflow/dify 的 url/api_key 变化（含启用/停用切换）会自动重置「继承全局」会话的后端会话；智能体自有配置的会话不受影响。</span>
    </section>
      </el-tab-pane>

      <el-tab-pane label="语音输入 ASR" name="asr">
    <section class="sys-sec">
      <p class="tab-note">网页语音输入与电脑音频识别共用同一 ASR 配置；URL 留空 = 停用网页语音输入。</p>
      <div class="sys-row">
        <label>服务地址 URL（OpenAI 兼容，空 = 停用）</label>
        <el-input v-model="form.asr.url"></el-input>
      </div>
      <div class="sys-row">
        <label>API Key</label>
        <el-input v-model="form.asr.api_key" type="password" show-password></el-input>
      </div>
      <div class="sys-row">
        <label>模型</label>
        <el-input v-model="form.asr.model"></el-input>
      </div>
      <div class="sys-row">
        <label>语言（空 = 自动检测）</label>
        <el-input v-model="form.asr.language"></el-input>
      </div>
      <div class="sys-row">
        <label>读超时（秒 1-300）</label>
        <el-input-number v-model="form.asr.timeout" :min="1" :max="300" style="width: 160px"></el-input-number>
      </div>
      <div class="sys-row">
        <el-button :loading="asrTest.running" @click="testAsr">测试连接（草稿值）</el-button>
        <span v-if="asrTest.text" :class="asrTest.ok ? 'ss-ok' : 'ss-bad'">{{ asrTest.text }}</span>
      </div>
      <el-button type="primary" :loading="busy === 'asr'" @click="saveAsr">保存语音输入配置</el-button>
    </section>
      </el-tab-pane>

    </el-tabs>
  </div>
</template>