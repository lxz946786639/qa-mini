
<script setup lang="ts">
// 用户管理（管理员创建制；停用 → cookie 会话全吊销；不能移除最后一个 active 管理员）
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fmtDateTime } from "../../utils/formatTime";
import { api } from "../../api";
import AgentScopeDialog from "../../components/AgentScopeDialog.vue";

interface U {
  id: string; username: string; display_name: string;
  role: "admin" | "user"; status: "active" | "disabled";
  created_at: string; last_login_at: string | null;
  agent_scope?: string[] | null;
}
const users = ref<U[]>([]);
const loading = ref(true);
const dialog = ref(false);
const form = ref({ username: "", password: "", display_name: "", role: "user" });

async function load() {
  loading.value = true;
  const { ok, data } = await api<{ users?: U[] }>("/api/admin/users");
  if (ok) users.value = data.users || [];
  loading.value = false;
}
async function create() {
  const r = await api("/api/admin/users", { body: { ...form.value } });
  if (r.ok) {
    ElMessage.success("用户已创建");
    dialog.value = false;
    const wasAdmin = form.value.role === "admin";
    form.value = { username: "", password: "", display_name: "", role: "user" };
    load();
    const u: U = r.data.user;
    if (u && !wasAdmin) {
      // P8.51 最小权限：新建用户默认不允许任何智能体 → 自动弹窗引导分配
      scopeTarget.value = u;
      scopeMode.value = "none";
      scopePicked.value = [];
      scopeDlg.value = true;
    } else ElMessage.info("管理员恒全量，无需配置权限范围");
  }
  else ElMessage.error(r.data.detail || "创建失败");
}
async function patch(u: U, p: Record<string, string>, label: string) {
  const r = await api("/api/admin/users/" + encodeURIComponent(u.id), { method: "PATCH", body: p });
  if (r.ok) ElMessage.success(label + "成功");
  else ElMessage.error(r.data.detail || "操作失败");
  load();
}
async function toggleRole(u: U) {
  const to = u.role === "admin" ? "user" : "admin";
  await patch(u, { role: to }, (to === "admin" ? "提升为管理员" : "降级为普通用户"));
}
async function toggleStatus(u: U) {
  if (u.status === "active") {
    try {
      await ElMessageBox.confirm("停用「" + u.username + "」？其登录凭证（cookie）将全部吊销。", "停用用户", { confirmButtonText: "停用", cancelButtonText: "取消", type: "warning" });
    } catch { return; }
  }
  await patch(u, { status: u.status === "active" ? "disabled" : "active" }, u.status === "active" ? "停用" : "启用");
}
async function resetPw(u: U) {
  try {
    const { value } = await ElMessageBox.prompt("新密码（4-64 位）", "重置密码：" + u.username, {
      confirmButtonText: "重置", cancelButtonText: "取消",
      inputType: "password", inputValidator: (v) => (v && v.length >= 4 ? true : "密码需 4-64 位")
    });
    await patch(u, { password: value }, "密码重置");
  } catch { /* 取消 */ }
}
// P8.40/P8.51 权限范围三态（全部 / 仅指定 / 无（最小权限）；管理员恒全量）
const scopeDlg = ref(false);
const scopeTarget = ref<U | null>(null);
const scopeMode = ref<"all" | "some" | "none">("all");
const scopePicked = ref<string[]>([]);
function scopeOf(u: U): { mode: "all" | "some" | "none"; ids: string[] } {
  const s = u.agent_scope;
  if (s === null || s === undefined) return { mode: "all", ids: [] };
  if (!s.length) return { mode: "none", ids: [] };
  return { mode: "some", ids: [...s] };
}
function openScope(u: U) {
  const s = scopeOf(u);
  scopeTarget.value = u;
  scopeMode.value = s.mode;
  scopePicked.value = s.ids;
  scopeDlg.value = true;
}
async function saveScope(v: { mode: "all" | "some" | "none"; ids: string[] }) {
  const u = scopeTarget.value;
  if (!u) return;
  const body: any = v.mode === "all" ? { agent_scope: [] } : v.mode === "none" ? { agent_scope: null } : { agent_scope: v.ids };
  const r = await api("/api/admin/users/" + encodeURIComponent(u.id), { method: "PATCH", body: body });
  if (r.ok) {
    ElMessage.success(v.mode === "all" ? "已允许全部智能体" : v.mode === "none" ? "已设为不允许任何智能体（最小权限）" : "权限范围已更新（" + v.ids.length + " 个智能体）");
    scopeDlg.value = false;
    load();
  }
  else ElMessage.error(r.data.detail || "保存失败");
}
onMounted(load);
</script>

<template>
  <div>
    <div class="tab-bar">
      <span class="tab-note">共 {{ users.length }} 个用户</span>
      <el-button type="primary" size="small" @click="dialog = true">＋ 新建用户</el-button>
    </div>
    <el-table v-loading="loading" :data="users" size="default">
      <el-table-column prop="username" label="用户名" min-width="140" />
      <el-table-column prop="display_name" label="显示名" min-width="140" />
      <el-table-column label="角色" min-width="110">
        <template #default="{ row }">
          <el-tag :type="row.role === 'admin' ? 'warning' : 'info'" size="small">{{ row.role === "admin" ? "管理员" : "普通用户" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" min-width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">{{ row.status === "active" ? "启用" : "停用" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="权限" min-width="130">
        <template #default="{ row }">
          <el-tag v-if="row.role === 'admin'" type="warning" size="small">全部（管理员）</el-tag>
          <el-tag v-else-if="row.agent_scope && row.agent_scope.length" type="warning" size="small">{{ row.agent_scope.length + " 个智能体" }}</el-tag>
          <el-tag v-else-if="row.agent_scope" type="danger" size="small">无（最小权限）</el-tag>
          <el-tag v-else type="success" size="small">全部</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="170">
        <template #default="{ row }">{{ fmtDateTime(row.created_at) || "—" }}</template>
      </el-table-column>
      <el-table-column prop="last_login_at" label="最近登录" min-width="170">
        <template #default="{ row }">{{ row.last_login_at ? fmtDateTime(row.last_login_at) : "—" }}</template>
      </el-table-column>
      <el-table-column label="操作" width="295" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="toggleRole(row)">{{ row.role === "admin" ? "降级" : "提权" }}</el-button>
          <el-button size="small" :type="row.status === 'active' ? 'danger' : 'success'" plain @click="toggleStatus(row)">{{ row.status === "active" ? "停用" : "启用" }}</el-button>
          <el-button size="small" @click="resetPw(row)">重置密码</el-button>
          <el-button size="small" :disabled="row.role === 'admin'" :title="row.role === 'admin' ? '管理员可访问全部智能体' : ''" @click="openScope(row)">权限</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" title="新建用户" width="420px">
      <el-form label-position="top">
        <el-form-item label="用户名（2-32 位字母/数字/_/-/.）">
          <el-input v-model="form.username" placeholder="如 zhangsan" />
        </el-form-item>
        <el-form-item label="密码（4-64 位）">
          <el-input v-model="form.password" type="password" show-password placeholder="初始密码" />
        </el-form-item>
        <el-form-item label="显示名（可空）">
          <el-input v-model="form.display_name" placeholder="默认为用户名" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role">
            <el-option label="普通用户" value="user" />
            <el-option label="管理员" value="admin" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <AgentScopeDialog
      v-model:visible="scopeDlg"
      :title="'用户 ' + (scopeTarget ? scopeTarget.username : '') + ' · 权限范围'"
      :mode="scopeMode"
      :picked="scopePicked"
      @save="saveScope"
    />
  </div>
</template>
