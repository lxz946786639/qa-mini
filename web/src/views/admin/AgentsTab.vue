
<script setup lang="ts">
// 智能体管理（P3 多智能体：每智能体一个协议；config 空字段 = 回退全局协议默认）
// P8.81 配置体系重构：身份级字段（ragflow.chat_id / openai.model / dify.api_key）必填，
// 不再依赖全局预设（全局仅保留连接级默认）；界面显示配置来源（自定义/继承全局/未配置）
// 与「恢复默认」；对话框与列表提供「测试连接」（POST /api/admin/protocol-test，
// 合并链 = 全局 ← 智能体现有配置 ← 表单草稿，与运行时一致）。
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Cpu } from "@element-plus/icons-vue";
import { AGENT_ICONS, AGENT_ICON_CHOICES, agentIconComponent, normalizeAgentIcon } from "../../utils/agentIcon";
import { api } from "../../api";
import { useRouter } from "vue-router";

interface Agent {
  id: string; code: string; name: string; description: string; icon: string;
  enabled: boolean; sort: number; protocol: string; config: Record<string, any>;
  allow_anon: boolean; allow_code: boolean; allow_user: boolean; // P8.8 访问控制
  protocol_enabled?: boolean; // P8.43 该智能体协议是否全局启用
  config_status?: Record<string, "custom" | "global" | "none">; // P8.81 身份字段来源
  config_complete?: boolean; // P8.81 身份字段是否全部就绪
}
const PROTOCOLS = [
  { value: "ragflow", label: "知识引擎（RAGFlow）" },
  { value: "dify", label: "编排引擎（Dify）" },
  { value: "openai", label: "OpenAI 兼容" },
  { value: "generic", label: "通用 HTTP" }
];
// 各协议 config 表单字段（空 = 回退全局默认；P8.81: required = 身份级字段必填）
const CFG_FIELDS: Record<string, { key: string; label: string; secret?: boolean; required?: boolean }[]> = {
  ragflow: [
    { key: "url", label: "RAGFlow URL" },
    { key: "api_key", label: "API Key（留空 = 继承全局）", secret: true },
    { key: "chat_id", label: "Chat ID（知识库对话）", required: true }
  ],
  dify: [
    { key: "url", label: "Dify URL" },
    { key: "api_key", label: "API Key（应用密钥）", secret: true, required: true },
    { key: "user", label: "User 标识（留空 = 继承全局）" }
  ],
  openai: [
    { key: "url", label: "OpenAI 兼容 URL" },
    { key: "api_key", label: "API Key（留空 = 继承全局）", secret: true },
    { key: "model", label: "模型（如 gpt-4o）", required: true }
  ],
  generic: [
    { key: "url", label: "请求 URL" },
    { key: "api_key", label: "API Key（留空 = 继承全局）", secret: true },
    { key: "body", label: "请求体模板（含 {question} 占位）" }
  ]
};
const STATUS_LABEL: Record<string, string> = { custom: "自定义", global: "继承全局", none: "未配置" };

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
  enabled: true, protocol: "ragflow",
  allow_anon: true, allow_code: true, allow_user: true, // P8.8 访问控制
  config: { url: "", api_key: "", chat_id: "", model: "", body: "", user: "" }
});
const fields = computed(() => CFG_FIELDS[form.protocol] || []);
// P8.81: 全局配置存在性（仅用于「继承全局/未配置」标识，不回显全局值）
const protoGlobalCfg = ref<Record<string, Record<string, boolean>>>({});
// P8.81: 对话框「测试连接」状态
const testSt = reactive({ running: false, text: "", ok: null as boolean | null });

// P8.25：图标 = Element Plus 图标名（项目禁止 emoji 图标）；留空 = 默认图标（Cpu）。
// P8.11 遗留 emoji 值经 normalizeAgentIcon 自动映射（编辑/渲染两处入口）。
const customIcon = computed(() => (form.icon && !AGENT_ICON_CHOICES.includes(form.icon) ? [form.icon] : []));

async function load() {
  loading.value = true;
  const { ok, data } = await api<{ agents?: Agent[] }>("/api/admin/agents");
  if (ok) agents.value = (data.agents || []).slice().sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
  const cfg = await api<{ protocols?: Record<string, Record<string, any>> }>("/api/config"); // P8.43
  if (cfg.ok && cfg.data.protocols) {
    const st: Record<string, boolean> = {};
    const gm: Record<string, Record<string, boolean>> = {};
    for (const k of Object.keys(cfg.data.protocols)) {
      st[k] = cfg.data.protocols[k].enabled !== false;
      gm[k] = {};
      for (const f of CFG_FIELDS[k] || []) {
        gm[k][f.key] = typeof cfg.data.protocols[k][f.key] === "string" && (cfg.data.protocols[k][f.key] as string).trim() !== "";
      }
    }
    protoState.value = st;
    protoGlobalCfg.value = gm;
  }
  loading.value = false;
}
function openCreate() {
  editing.value = null;
  atTab.value = "basic";
  Object.assign(form, { code: "", name: "", description: "", icon: "", sort: 0, enabled: true, protocol: "ragflow", allow_anon: true, allow_code: true, allow_user: true, config: { url: "", api_key: "", chat_id: "", model: "", body: "", user: "" } });
  testSt.running = false; testSt.text = ""; testSt.ok = null;
  dialog.value = true;
}
function openEdit(a: Agent) {
  editing.value = a.code;
  atTab.value = "basic";
  Object.assign(form, {
    code: a.code, name: a.name, description: a.description, icon: normalizeAgentIcon(a.icon), sort: a.sort,
    enabled: a.enabled, protocol: a.protocol,
    allow_anon: a.allow_anon !== false, allow_code: a.allow_code !== false, allow_user: a.allow_user !== false,
    config: { url: "", api_key: "", chat_id: "", model: "", body: "", user: "", ...a.config }
  });
  testSt.running = false; testSt.text = ""; testSt.ok = null;
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
  // P8.81: 全量提交当前协议字段（与后端逐字段合并语义配对）：
  //  非掩码值原样提交（空串 = 清除该字段、回退全局）；
  //  掩码值（…已设置）提交字面哨兵 = 服务端保留现值（修复旧版掩码 api_key 保存即丢失）。
  const out: Record<string, string> = {};
  for (const f of fields.value) {
    const v = String(form.config[f.key] ?? "");
    out[f.key] = v.includes("…") ? "…已设置" : v;
  }
  return out;
}
// P8.81: 字段配置来源标识（自定义 / 继承全局 / 未配置）
function fieldTag(f: { key: string }): { text: string; type: "success" | "info" | "danger" } {
  const v = String(form.config[f.key] ?? "");
  if (v && !v.includes("…")) return { text: STATUS_LABEL.custom, type: "success" };
  if (v && v.includes("…")) return { text: "自定义（已设置）", type: "success" };
  const g = protoGlobalCfg.value[form.protocol] && protoGlobalCfg.value[form.protocol][f.key];
  return g ? { text: STATUS_LABEL.global, type: "info" } : { text: STATUS_LABEL.none, type: "danger" };
}
// P8.81: 恢复默认 = 清除本智能体该字段的自有值（回退全局）
function resetField(f: { key: string }) { form.config[f.key] = ""; }
// P8.81: 对话框「测试连接」（草稿优先；编辑时未填/掩码字段用智能体现有配置）
async function testConn() {
  testSt.running = true; testSt.ok = null; testSt.text = "";
  try {
    const body: Record<string, any> = { protocol: form.protocol };
    if (editing.value) body.agent_code = editing.value;
    const draft: Record<string, string> = {};
    for (const f of fields.value) {
      const v = String(form.config[f.key] ?? "");
      if (v && !v.includes("…")) draft[f.key] = v; // 掩码 = 保留现值（不进草稿）
    }
    body.config = draft;
    const { data } = await api<any>("/api/admin/protocol-test", { method: "POST", body });
    testSt.ok = !!data.ok;
    testSt.text = data.detail || (data.ok ? "已连接" : "连接失败");
  } catch (e: any) {
    testSt.ok = false;
    testSt.text = String((e && e.message) || e);
  } finally { testSt.running = false; }
}
// P8.81: 列表「测试」= 用该智能体现有配置探测（不经过表单）
async function testAgent(a: Agent) {
  try {
    const { data } = await api<any>("/api/admin/protocol-test", { method: "POST", body: { protocol: a.protocol, agent_code: a.code } });
    if (data.ok) ElMessage.success(a.name + " 连接正常：" + (data.detail || ""));
    else ElMessage.error(a.name + " 连接失败：" + (data.detail || "未知原因"));
  } catch (e: any) {
    ElMessage.error("测试失败：" + String((e && e.message) || e));
  }
}
async function save() {
  // P8.81: 身份级字段必填（掩码 = 已设置，放行；空 = 拦截）
  for (const f of fields.value) {
    if (!f.required) continue;
    const v = String(form.config[f.key] ?? "");
    if (!v.trim()) {
      ElMessage.warning(f.label + " 是必填项（不同智能体应各自配置，避免共用同一后端资源）");
      atTab.value = "protocol";
      return;
    }
  }
  const body: Record<string, any> = {
    name: form.name, description: form.description, icon: form.icon, sort: Number(form.sort) || 0,
    enabled: form.enabled, protocol: form.protocol, config: cfgPayload(),
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
      <el-table-column label="配置状态" min-width="160">
        <template #default="{ row }">
          <template v-if="row.config_complete === false">
            <el-tag size="small" type="danger" effect="plain">身份字段未配置</el-tag>
          </template>
          <template v-else-if="row.config_status && Object.keys(row.config_status).length">
            <el-tag
              v-for="(st, k) in row.config_status"
              :key="k"
              size="small"
              :type="st === 'custom' ? 'success' : st === 'global' ? 'info' : 'danger'"
              effect="plain"
              style="margin-right: 4px"
            >{{ (k === 'chat_id' ? 'Chat' : k === 'model' ? '模型' : 'Key') + '·' + STATUS_LABEL[st] }}</el-tag>
          </template>
          <span v-else class="dim">—</span>
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
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.enabled" size="small" type="primary" plain title="进入该智能体工作区" @click="enterAgent(row)">进入</el-button>
          <el-button size="small" plain title="用该智能体现有配置测试连接" @click="testAgent(row)">测试</el-button>
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
              <el-form-item :label="f.label">
                <div style="display: flex; align-items: center; gap: 8px; width: 100%">
                  <el-input v-model="form.config[f.key]" :type="f.secret ? 'password' : (f.key === 'body' ? 'textarea' : 'text')" :show-password="f.secret" :autosize="f.key === 'body' ? { minRows: 2, maxRows: 6 } : undefined" style="flex: 1" />
                  <el-tag size="small" :type="fieldTag(f).type" effect="plain" style="flex-shrink: 0">{{ fieldTag(f).text }}</el-tag>
                  <el-button v-if="String(form.config[f.key] ?? '')" link size="small" style="flex-shrink: 0" @click="resetField(f)">恢复默认</el-button>
                </div>
                <div v-if="f.required" style="font-size: 12px; color: var(--el-text-color-secondary); margin-top: 2px;">必填：不同智能体应各自配置（留空将与其他智能体共用同一后端资源，无法保存）</div>
              </el-form-item>
            </template>
            <el-form-item>
              <el-button :loading="testSt.running" @click="testConn">测试连接</el-button>
              <span v-if="testSt.text" :class="testSt.ok ? 'ss-ok' : 'ss-bad'" style="margin-left: 8px">{{ testSt.text }}</span>
              <span class="tab-note" style="font-size: 12px; margin-left: 8px">{{ editing ? "按当前表单值测试（留空/已设置字段用该智能体现有配置）" : "按当前表单值测试（留空字段用全局默认）" }}</span>
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
