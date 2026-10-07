
<script setup lang="ts">
// 智能体管理（P3 多智能体：每智能体一个协议；config 空字段 = 回退全局协议默认）
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Cpu } from "@element-plus/icons-vue";
import { AGENT_ICONS, AGENT_ICON_CHOICES, agentIconComponent, normalizeAgentIcon } from "../../utils/agentIcon";
import { api } from "../../api";
import { useRouter } from "vue-router";

interface Agent {
  id: string; code: string; name: string; description: string; icon: string;
  enabled: boolean; sort: number; prompt: string; protocol: string; config: Record<string, any>;
  allow_anon: boolean; allow_code: boolean; allow_user: boolean; // P8.8 访问控制
  protocol_enabled?: boolean; // P8.43 该智能体协议是否全局启用
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

const router = useRouter();
const agents = ref<Agent[]>([]);
const loading = ref(true);
// P8.43：全局协议启用状态（GET /api/config；=== false = 停用）
const protoState = ref<Record<string, boolean>>({});
const dialog = ref(false);
const editing = ref<string | null>(null); // code 或 null=新建
const atTab = ref("basic"); // P8.8 对话框 tab（基本/协议/安全）
const form = reactive({
  code: "", name: "", description: "", icon: "", sort: 0,
  enabled: true, protocol: "ragflow", prompt: "",
  allow_anon: true, allow_code: true, allow_user: true, // P8.8 访问控制
  config: { url: "", api_key: "", chat_id: "", model: "", body: "" }
});
const fields = computed(() => CFG_FIELDS[form.protocol] || []);

// P8.25：图标 = Element Plus 图标名（项目禁止 emoji 图标）；留空 = 默认图标（Cpu）。
// P8.11 遗留 emoji 值经 normalizeAgentIcon 自动映射（编辑/渲染两处入口）。
const customIcon = computed(() => (form.icon && !AGENT_ICON_CHOICES.includes(form.icon) ? [form.icon] : []));

async function load() {
  loading.value = true;
  const { ok, data } = await api<{ agents?: Agent[] }>("/api/admin/agents");
  if (ok) agents.value = (data.agents || []).slice().sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
  const cfg = await api<{ protocols?: Record<string, { enabled?: boolean }> }>("/api/config"); // P8.43
  if (cfg.ok && cfg.data.protocols) {
    const st: Record<string, boolean> = {};
    for (const k of Object.keys(cfg.data.protocols)) st[k] = cfg.data.protocols[k].enabled !== false;
    protoState.value = st;
  }
  loading.value = false;
}
function openCreate() {
  editing.value = null;
  atTab.value = "basic";
  Object.assign(form, { code: "", name: "", description: "", icon: "", sort: 0, enabled: true, protocol: "ragflow", prompt: "", allow_anon: true, allow_code: true, allow_user: true, config: { url: "", api_key: "", chat_id: "", model: "", body: "" } });
  dialog.value = true;
}
function openEdit(a: Agent) {
  editing.value = a.code;
  atTab.value = "basic";
  Object.assign(form, {
    code: a.code, name: a.name, description: a.description, icon: normalizeAgentIcon(a.icon), sort: a.sort,
    enabled: a.enabled, protocol: a.protocol, prompt: a.prompt,
    allow_anon: a.allow_anon !== false, allow_code: a.allow_code !== false, allow_user: a.allow_user !== false,
    config: { url: "", api_key: "", chat_id: "", model: "", body: "", ...a.config }
  });
  dialog.value = true;
}
function accessLabel(a: Agent): string {
  // P8.8 列表徽标：当前放行范围（admin 恒可用，不在此列示）
  if (a.allow_anon) return "全部";
  const parts: string[] = [];
  if (a.allow_code) parts.push("访问码");
  if (a.allow_user) parts.push("用户登录");
  return parts.length ? parts.join(" + ") : "仅管理员";
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
    enabled: form.enabled, protocol: form.protocol, prompt: form.prompt, config: cfgPayload(),
    allow_anon: form.allow_anon, allow_code: form.allow_code, allow_user: form.allow_user // P8.8
  };
  let r;
  if (editing.value) r = await api("/api/admin/agents/" + encodeURIComponent(editing.value), { method: "PATCH", body });
  else r = await api("/api/admin/agents", { body: Object.assign({ code: form.code }, body) });
  if (r.ok) { ElMessage.success("已保存"); dialog.value = false; load(); }
  else ElMessage.error(r.data.detail || "保存失败");
}
async function toggleEnabled(a: Agent) {
  const r = await api("/api/admin/agents/" + encodeURIComponent(a.code), { method: "PATCH", body: { enabled: !a.enabled } });
  if (r.ok) { ElMessage.success(a.enabled ? "已停用（首屏不再展示）" : "已启用"); load(); }
  else ElMessage.error(r.data.detail || "操作失败");
}
// P8.36：启用智能体 = 操作栏「进入」快捷入口（直达该智能体工作区）
function enterAgent(a: Agent) {
  router.push("/agents/" + encodeURIComponent(a.code));
}
onMounted(load);
</script>

<template>
  <div>
    <div class="tab-bar">
      <span class="tab-note">共 {{ agents.length }} 个智能体（停用后首屏隐藏，已有会话不受影响）</span>
      <el-button type="primary" size="small" @click="openCreate">＋ 新建智能体</el-button>
    </div>
    <el-table v-loading="loading" :data="agents">
      <el-table-column label="图标" min-width="70">
        <template #default="{ row }"><el-icon class="agent-ic agent-ic-ui" :size="20"><component :is="agentIconComponent(row.icon)" /></el-icon></template>
      </el-table-column>
      <el-table-column label="名称" min-width="200">
        <template #default="{ row }">
          <b>{{ row.name }}</b>
          <div class="sub">{{ row.code }}</div>
        </template>
      </el-table-column>
      <el-table-column label="协议" min-width="130">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ row.protocol }}</el-tag>
          <el-tag v-if="row.protocol_enabled === false" size="small" type="danger" effect="plain">已停用</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="访问" min-width="130">
        <template #default="{ row }">
          <el-tag size="small" :type="row.allow_anon ? 'success' : (accessLabel(row) === '仅管理员' ? 'danger' : 'warning')" effect="plain">{{ accessLabel(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="排序" prop="sort" min-width="90" />
      <el-table-column label="状态" min-width="100">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? "启用" : "停用" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="描述" min-width="300">
        <template #default="{ row }"><span class="dim">{{ row.description || "—" }}</span></template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.enabled" size="small" type="primary" plain title="进入该智能体工作区" @click="enterAgent(row)">进入</el-button>
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" :type="row.enabled ? 'danger' : 'success'" plain @click="toggleEnabled(row)">{{ row.enabled ? "停用" : "启用" }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editing ? '编辑智能体：' + editing : '新建智能体'" width="600px">
      <!-- P8.8 对话框内容分类为 tab（基本 / 协议 / 安全） -->
      <el-tabs v-model="atTab" class="at-tabs">
        <el-tab-pane label="基本" name="basic">
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
            <el-form-item label="图标（点选；留空 = 默认图标）">
              <div class="at-icon-pick">
                <button type="button" class="at-icon-opt" :class="{ on: form.icon === '' }"
                  title="默认图标" @click="form.icon = ''"><el-icon :size="18"><Cpu /></el-icon></button>
                <button v-for="n in [...AGENT_ICON_CHOICES, ...customIcon]" :key="n" type="button"
                  class="at-icon-opt" :class="{ on: form.icon === n }" :title="n" @click="form.icon = n">
                  <el-icon :size="18"><component :is="AGENT_ICONS[n] || Cpu" /></el-icon>
                </button>
              </div>
              <div class="at-icon-hint">点击选择；再次点击已选项或「默认图标」可取消。图标统一使用 Element Plus 图标集（项目禁止 emoji）；所选图标显示在首页卡片与控制台列表。</div>
            </el-form-item>
            <el-form-item label="排序（小者优先）">
              <el-input-number v-model="form.sort" :min="0" :max="999" />
            </el-form-item>
            <el-form-item>
              <el-switch v-model="form.enabled" active-text="启用（首屏展示）" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="协议" name="protocol">
          <el-form label-position="top">
            <el-form-item label="协议（每智能体一个）">
              <el-select v-model="form.protocol" :disabled="!!editing">
                <el-option
                  v-for="p in PROTOCOLS"
                  :key="p.value"
                  :label="p.label + (protoState[p.value] === false ? '（已停用）' : '')"
                  :value="p.value"
                  :disabled="protoState[p.value] === false"
                />
              </el-select>
            </el-form-item>
            <el-alert
              v-if="editing && protoState[form.protocol] === false"
              type="warning" :closable="false" show-icon style="margin-bottom: 12px"
              title="当前协议已停用"
              description="该智能体的提问会被拒绝，直到在「系统设置 → 协议全局默认」重新启用该协议。"
            />
            <template v-for="f in fields" :key="f.key">
              <el-form-item :label="f.label + '（留空 = 回退全局默认' + (f.key === 'api_key' && editing ? '；已设置项不回显）' : '）')">
                <el-input v-model="form.config[f.key]" :type="f.secret ? 'password' : (f.key === 'body' ? 'textarea' : 'text')" :show-password="f.secret" :autosize="f.key === 'body' ? { minRows: 2, maxRows: 6 } : undefined" />
              </el-form-item>
            </template>
            <el-form-item label="系统提示词 Prompt（≤4000，可空 = 回退全局）">
              <el-input v-model="form.prompt" type="textarea" :rows="3" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="安全" name="security">
          <div class="at-sec">
            <div class="at-sec-row">
              <el-switch v-model="form.allow_anon" />
              <div>
                <div class="at-sec-title">允许匿名访问</div>
                <div class="at-sec-sub">未登录访客可直接查看并使用该智能体；开启后下方两种访问方式天然放行（超集语义）</div>
              </div>
            </div>
            <div class="at-sec-row">
              <el-switch v-model="form.allow_code" :disabled="form.allow_anon" />
              <div>
                <div class="at-sec-title">允许访问码访问</div>
                <div class="at-sec-sub">用 6 位访问码登录的用户可创建并使用会话</div>
              </div>
            </div>
            <div class="at-sec-row">
              <el-switch v-model="form.allow_user" :disabled="form.allow_anon" />
              <div>
                <div class="at-sec-title">允许普通用户登录访问</div>
                <div class="at-sec-sub">用户名/密码登录的普通用户可创建并使用会话（管理员始终可用）</div>
              </div>
            </div>
            <p class="at-sec-note">会话隔离：不同访问方式的会话落独立桶（匿名 = 共享桶、访问码 = 码私有桶、登录用户 = 用户私有桶），彼此互不可见，管理员可见全部。三项全关 = 仅管理员可用。</p>
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
