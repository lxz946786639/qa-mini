
<script setup lang="ts">
// 智能体管理（P3 多智能体：每智能体一个协议；config 空字段 = 回退全局协议默认）
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../../api";

interface Agent {
  id: string; code: string; name: string; description: string; icon: string;
  enabled: boolean; sort: number; prompt: string; protocol: string; config: Record<string, any>;
}
const PROTOCOLS = [
  { value: "ragflow", label: "知识引擎（RAGFlow）" },
  { value: "dify", label: "编排引擎（Dify）" },
  { value: "openai", label: "OpenAI 兼容" },
  { value: "generic", label: "通用 HTTP" }
];
// 各协议 config 表单字段（空 = 回退全局默认）
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

const agents = ref<Agent[]>([]);
const loading = ref(true);
const dialog = ref(false);
const editing = ref<string | null>(null); // code 或 null=新建
const form = reactive({
  code: "", name: "", description: "", icon: "", sort: 0,
  enabled: true, protocol: "ragflow", prompt: "",
  config: { url: "", api_key: "", chat_id: "", model: "", body: "" }
});
const fields = computed(() => CFG_FIELDS[form.protocol] || []);

async function load() {
  loading.value = true;
  const { ok, data } = await api<{ agents?: Agent[] }>("/api/admin/agents");
  if (ok) agents.value = (data.agents || []).slice().sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
  loading.value = false;
}
function openCreate() {
  editing.value = null;
  Object.assign(form, { code: "", name: "", description: "", icon: "", sort: 0, enabled: true, protocol: "ragflow", prompt: "", config: { url: "", api_key: "", chat_id: "", model: "", body: "" } });
  dialog.value = true;
}
function openEdit(a: Agent) {
  editing.value = a.code;
  Object.assign(form, {
    code: a.code, name: a.name, description: a.description, icon: a.icon, sort: a.sort,
    enabled: a.enabled, protocol: a.protocol, prompt: a.prompt,
    config: { url: "", api_key: "", chat_id: "", model: "", body: "", ...a.config }
  });
  dialog.value = true;
}
function cfgPayload(): Record<string, string> {
  // 只提交该协议的字段；掩码值（…已设置）不回传（留空 = 不变）
  const out: Record<string, string> = {};
  for (const f of fields.value) {
    const v = form.config[f.key];
    if (typeof v === "string" && v && !v.includes("…")) out[f.key] = v;
  }
  return out;
}
async function save() {
  const body: Record<string, any> = {
    name: form.name, description: form.description, icon: form.icon, sort: Number(form.sort) || 0,
    enabled: form.enabled, protocol: form.protocol, prompt: form.prompt, config: cfgPayload()
  };
  let r;
  if (editing.value) r = await api("/api/admin/agents/" + encodeURIComponent(editing.value), { method: "PATCH", body });
  else r = await api("/api/admin/agents", { body: Object.assign({ code: form.code }, body) });
  if (r.ok) { ElMessage.success("已保存"); dialog.value = false; load(); }
  else ElMessage.error(r.data.detail || "保存失败");
}
async function toggleEnabled(a: Agent) {
  const r = await api("/api/admin/agents/" + encodeURIComponent(a.code), { method: "PATCH", body: { enabled: !a.enabled } });
  if (r.ok) { ElMessage.success(a.enabled ? "已停用（落地页不再展示）" : "已启用"); load(); }
  else ElMessage.error(r.data.detail || "操作失败");
}
onMounted(load);
</script>

<template>
  <div>
    <div class="tab-bar">
      <span class="tab-note">共 {{ agents.length }} 个智能体（停用后落地页隐藏，已有会话不受影响）</span>
      <el-button type="primary" size="small" @click="openCreate">＋ 新建智能体</el-button>
    </div>
    <el-table v-loading="loading" :data="agents">
      <el-table-column label="图标" width="70">
        <template #default="{ row }"><span class="agent-ic">{{ row.icon || "🎙️" }}</span></template>
      </el-table-column>
      <el-table-column label="名称" min-width="160">
        <template #default="{ row }">
          <b>{{ row.name }}</b>
          <div class="sub">{{ row.code }}</div>
        </template>
      </el-table-column>
      <el-table-column label="协议" width="130">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ row.protocol }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="排序" prop="sort" width="70" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? "启用" : "停用" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="描述" min-width="180">
        <template #default="{ row }"><span class="dim">{{ row.description || "—" }}</span></template>
      </el-table-column>
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" :type="row.enabled ? 'danger' : 'success'" plain @click="toggleEnabled(row)">{{ row.enabled ? "停用" : "启用" }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editing ? '编辑智能体：' + editing : '新建智能体'" width="560px">
      <el-form label-position="top">
        <template v-if="!editing">
          <el-form-item label="Code（2-32 位小写字母/数字/-/_，创建后不可改）">
            <el-input v-model="form.code" placeholder="如 legal-qa" />
          </el-form-item>
        </template>
        <el-form-item label="名称（≤40）">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="描述（≤200）">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="图标（表情符号，可空）">
          <el-input v-model="form.icon" placeholder="🎙️" style="max-width: 120px" />
        </el-form-item>
        <el-form-item label="协议（每智能体一个）">
          <el-select v-model="form.protocol" :disabled="!!editing">
            <el-option v-for="p in PROTOCOLS" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
        </el-form-item>
        <template v-for="f in fields" :key="f.key">
          <el-form-item :label="f.label + '（留空 = 回退全局默认' + (f.key === 'api_key' && editing ? '；已设置项不回显）' : '）')">
            <el-input v-model="form.config[f.key]" :type="f.secret ? 'password' : (f.key === 'body' ? 'textarea' : 'text')" :show-password="f.secret" :autosize="f.key === 'body' ? { minRows: 2, maxRows: 6 } : undefined" />
          </el-form-item>
        </template>
        <el-form-item label="系统提示词 Prompt（≤4000，可空 = 回退全局）">
          <el-input v-model="form.prompt" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="排序（小者优先）">
          <el-input-number v-model="form.sort" :min="0" :max="999" />
        </el-form-item>
        <el-form-item>
          <el-switch v-model="form.enabled" active-text="启用（落地页展示）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
