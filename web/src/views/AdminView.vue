
<script setup lang="ts">
// 管理台（P6）：用户 / 智能体 / 访问码 / 审计日志。仅 admin 主体可访问。
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
import UsersTab from "./admin/UsersTab.vue";
import AgentsTab from "./admin/AgentsTab.vue";
import CodesTab from "./admin/CodesTab.vue";
import AuditTab from "./admin/AuditTab.vue";
import SystemTab from "./admin/SystemTab.vue";

const auth = useAuthStore();
const checked = ref(false);
// 首启引导（对齐旧版 /admin 首屏）：admin 未初始化时给出「设置管理密码」表单
// （POST /api/admin/login 初始化通道，成功后签发 ea_sid cookie）
const adminSet = ref<boolean | null>(null);
const bsUser = ref("admin");
const bsPw = ref("");
const bsPw2 = ref("");
const bsBusy = ref(false);

onMounted(async () => {
  await auth.me();
  if (!auth.isAdmin) {
    try {
      const r = await fetch("/api/health");
      const d = (await r.json()) as { admin_set?: boolean };
      adminSet.value = !!d.admin_set;
    } catch { adminSet.value = true; }
  }
  checked.value = true;
});

async function bootstrap() {
  if (bsPw.value.length < 4 || bsPw.value.length > 64) { ElMessage.warning("管理密码需 4-64 位字符"); return; }
  if (bsPw.value !== bsPw2.value) { ElMessage.warning("两次输入的密码不一致"); return; }
  bsBusy.value = true;
  try {
    const { ok, data } = await api<{ ok: boolean; initialized?: boolean; detail?: string }>("/api/admin/login", {
      method: "POST",
      body: { username: bsUser.value.trim() || "admin", password: bsPw.value }
    });
    if (ok && data.initialized) {
      ElMessage.success("已初始化并登录");
      await auth.me();
    } else {
      ElMessage.error(data.detail || "初始化失败");
    }
  } finally { bsBusy.value = false; }
}
async function onLogout() {
  await auth.logout();
  ElMessage.success("已退出登录");
}
</script>

<template>
  <div class="landing">
    <header class="topbar">
      <div class="brand">
        <router-link to="/" class="brand">
          <span class="brand-mark">回</span>
          <span class="brand-text">EchoAnswer · 回响答</span>
        </router-link>
        <span class="admin-badge">管理台</span>
      </div>
      <nav class="topnav">
        <router-link to="/" class="topnav-link">← 返回落地页</router-link>
        <span v-if="auth.isAuthed" class="user-chip">{{ auth.displayName || "管理员" }}</span>
        <el-button v-if="auth.isAuthed" size="small" @click="onLogout">退出</el-button>
      </nav>
    </header>
    <main class="admin-main">
      <div v-if="!checked" class="admin-wait">校验身份中…</div>
      <div v-else-if="!auth.isAdmin" class="admin-deny">
        <template v-if="adminSet === false">
          <p>管理密码尚未初始化</p>
          <p class="admin-dim">首次部署：设置管理密码后进入管理台（初始化通道，对齐旧版 /admin 首屏）。</p>
          <div class="admin-bs">
            <el-input v-model="bsUser" size="small" placeholder="管理员用户名（默认 admin）" />
            <el-input v-model="bsPw" size="small" type="password" show-password placeholder="管理密码（4-64 位）" />
            <el-input v-model="bsPw2" size="small" type="password" show-password placeholder="确认密码" />
            <el-button type="primary" size="small" :loading="bsBusy" @click="bootstrap">初始化并进入</el-button>
          </div>
        </template>
        <template v-else>
          <p>当前身份无管理权限</p>
          <p class="admin-dim">管理台仅对 admin 角色开放（账号登录；访问码/匿名身份不可用）。</p>
          <el-button type="primary" size="small" @click="auth.me()">重新校验</el-button>
          <router-link to="/" class="topnav-link">返回落地页</router-link>
        </template>
      </div>
      <el-tabs v-else type="border-card" class="admin-tabs">
        <el-tab-pane label="用户管理" name="users"><UsersTab /></el-tab-pane>
        <el-tab-pane label="智能体管理" name="agents"><AgentsTab /></el-tab-pane>
        <el-tab-pane label="访问码" name="codes"><CodesTab /></el-tab-pane>
        <el-tab-pane label="审计日志" name="audit"><AuditTab /></el-tab-pane>
        <el-tab-pane label="系统设置" name="sys"><SystemTab /></el-tab-pane>
      </el-tabs>
    </main>
  </div>
</template>
