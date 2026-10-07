
<script setup lang="ts">
// 访问码管理（列表来自 GET /api/config → security.access_codes；生成/延期/失效/清理过期）
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fmtDateTime } from "../../utils/formatTime";
import { api } from "../../api";
import AgentScopeDialog from "../../components/AgentScopeDialog.vue";

interface Code { code: string; created_at: string; expires_at: string; agent_scope?: string[] | null; }
const list = ref<Code[]>([]);
const loading = ref(true);
const form = reactive({ mode: "random" as "random" | "custom", custom: "", hours: 8, count: 1 });

function expired(c: Code): boolean {
  return new Date(c.expires_at).getTime() < Date.now();
}
async function load() {
  loading.value = true;
  const { ok, data } = await api<{ security?: { access_codes?: Code[] } }>("/api/config");
  if (ok) list.value = (data.security?.access_codes || []).slice().sort((a, b) => b.expires_at.localeCompare(a.expires_at));
  loading.value = false;
}
async function add() {
  const body: Record<string, any> = { hours: Number(form.hours) || 8 };
  if (form.mode === "custom") body.code = form.custom.trim();
  else body.count = Number(form.count) || 1;
  const r = await api("/api/admin/access-codes", { body });
  if (r.ok) {
    const codes: string[] = (r.data.entries || []).map((x: any) => x.code);
    if (codes.length) ElMessage.success(codes.length > 1 ? "已生成 " + codes.length + " 个码" : "已生成：" + codes[0]);
    load();
    // P8.51 最小权限：新建码默认不允许任何智能体 → 自动弹窗引导分配
    openScopeForCreated(codes);
  } else ElMessage.error(r.data.detail || "生成失败");
}
async function renew(c: Code) {
  try {
    const { value } = await ElMessageBox.prompt("延期时长（小时，上限 720）", "延期访问码 " + c.code, {
      inputValue: "8", confirmButtonText: "延期", cancelButtonText: "取消",
      inputPattern: /^\d+$/, inputErrorMessage: "请输入正整数"
    });
    const r = await api("/api/admin/access-codes/" + encodeURIComponent(c.code) + "/renew", { body: { hours: Number(value) } });
    if (r.ok) ElMessage.success("已延期");
    else ElMessage.error(r.data.detail || "延期失败");
    load();
  } catch { /* 取消 */ }
}
async function invalidate(c: Code) {
  try {
    await ElMessageBox.confirm("失效访问码 " + c.code + "？该码已签发的登录凭证将全部吊销。", "失效访问码", { confirmButtonText: "失效", cancelButtonText: "取消", type: "warning" });
  } catch { return; }
  const r = await api("/api/admin/access-codes/" + encodeURIComponent(c.code), { method: "DELETE" });
  if (r.ok) ElMessage.success("已失效");
  else ElMessage.error(r.data.detail || "操作失败");
  load();
}
async function cleanExpired() {
  const r = await api("/api/admin/access-codes/expired", { method: "DELETE" });
  if (r.ok) ElMessage.success("已清理 " + (r.data.removed || 0) + " 个过期码");
  load();
}
// P8.40/P8.51 权限范围三态（全部 / 仅指定 / 无（最小权限））；创建后自动弹窗引导分配
const scopeDlg = ref(false);
const scopeTargets = ref<string[]>([]);
const scopeMode = ref<"all" | "some" | "none">("all");
const scopePicked = ref<string[]>([]);
function scopeOf(c: Code): { mode: "all" | "some" | "none"; ids: string[] } {
  const s = c.agent_scope;
  if (s === null || s === undefined) return { mode: "all", ids: [] };
  if (!s.length) return { mode: "none", ids: [] };
  return { mode: "some", ids: [...s] };
}
function openScope(c: Code) {
  const s = scopeOf(c);
  scopeTargets.value = [c.code];
  scopeMode.value = s.mode;
  scopePicked.value = s.ids;
  scopeDlg.value = true;
}
// P8.51：生成后自动打开权限对话框（默认最小权限 = 不允许任何智能体）
function openScopeForCreated(codes: string[]) {
  if (!codes.length) return;
  scopeTargets.value = codes;
  scopeMode.value = "none";
  scopePicked.value = [];
  scopeDlg.value = true;
}
function scopeTitle(): string {
  return scopeTargets.value.length > 1
    ? "新访问码（" + scopeTargets.value.length + " 个）· 权限范围"
    : "访问码 " + (scopeTargets.value[0] || "") + " · 权限范围";
}
async function saveScope(v: { mode: "all" | "some" | "none"; ids: string[] }) {
  for (const code of scopeTargets.value) {
    const body: any = v.mode === "all" ? { agent_scope: [] } : v.mode === "none" ? { agent_scope: null } : { agent_scope: v.ids };
    const r = await api("/api/admin/access-codes/" + encodeURIComponent(code), { method: "PATCH", body: body });
    if (!r.ok) { ElMessage.error(r.data.detail || "保存失败（" + code + "）"); return; }
  }
  ElMessage.success(v.mode === "all" ? "已允许全部智能体" : v.mode === "none" ? "已设为不允许任何智能体（最小权限）" : "权限范围已更新（" + v.ids.length + " 个智能体）");
  scopeDlg.value = false;
  load();
}
onMounted(load);
</script>

<template>
  <div>
    <div class="tab-bar">
      <span class="tab-note">
        共 {{ list.length }} 个有效码
        <el-button v-if="list.some(expired)" link type="danger" size="small" @click="cleanExpired">（含 {{ list.filter(expired).length }} 个已过期，一键清理）</el-button>
      </span>
    </div>
    <div class="code-gen">
      <el-radio-group v-model="form.mode" size="small">
        <el-radio-button value="random">随机生成</el-radio-button>
        <el-radio-button value="custom">指定码</el-radio-button>
      </el-radio-group>
      <el-input v-if="form.mode === 'custom'" v-model="form.custom" placeholder="6 位数字" maxlength="6" style="width: 120px" size="small" />
      <el-input-number v-else v-model="form.count" :min="1" :max="10" size="small" style="width: 90px" />
      <el-select v-model="form.hours" size="small" style="width: 130px">
        <el-option :value="1" label="1 小时" />
        <el-option :value="8" label="8 小时" />
        <el-option :value="24" label="24 小时" />
        <el-option :value="72" label="3 天" />
        <el-option :value="168" label="7 天" />
      </el-select>
      <el-button type="primary" size="small" @click="add">生成</el-button>
    </div>
    <el-table v-loading="loading" :data="list">
      <el-table-column label="访问码" min-width="160">
        <template #default="{ row }"><b>{{ row.code }}</b></template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="200">
        <template #default="{ row }">{{ fmtDateTime(row.created_at) || "—" }}</template>
      </el-table-column>
      <el-table-column label="到期时间" min-width="200">
        <template #default="{ row }">
          <span :class="{ danger: expired(row) }">{{ fmtDateTime(row.expires_at) }}</span>
          <el-tag v-if="expired(row)" type="danger" size="small" style="margin-left: 6px">已过期</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="权限" min-width="130">
        <template #default="{ row }">
          <el-tag v-if="row.agent_scope && row.agent_scope.length" type="warning" size="small">{{ row.agent_scope.length + " 个智能体" }}</el-tag>
          <el-tag v-else-if="row.agent_scope" type="danger" size="small">无（最小权限）</el-tag>
          <el-tag v-else type="success" size="small">全部</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="210" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openScope(row)">权限</el-button>
          <el-button size="small" @click="renew(row)">延期</el-button>
          <el-button size="small" type="danger" plain @click="invalidate(row)">失效</el-button>
        </template>
      </el-table-column>
    </el-table>
    <AgentScopeDialog
      v-model:visible="scopeDlg"
      :title="scopeTitle()"
      :mode="scopeMode"
      :picked="scopePicked"
      @save="saveScope"
    />
  </div>
</template>
