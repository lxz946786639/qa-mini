
<script setup lang="ts">
// 管理台（P6）：用户 / 智能体 / 访问码 / 审计日志。仅 admin 主体可访问。
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";
import UsersTab from "./admin/UsersTab.vue";
import AgentsTab from "./admin/AgentsTab.vue";
import CodesTab from "./admin/CodesTab.vue";
import AuditTab from "./admin/AuditTab.vue";

const auth = useAuthStore();
const checked = ref(false);

onMounted(() => {
  auth.me().then(() => { checked.value = true; });
});
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
        <p>当前身份无管理权限</p>
        <p class="admin-dim">管理台仅对 admin 角色开放（账号登录；访问码/匿名身份不可用）。</p>
        <el-button type="primary" size="small" @click="auth.me()">重新校验</el-button>
        <router-link to="/" class="topnav-link">返回落地页</router-link>
      </div>
      <el-tabs v-else type="border-card" class="admin-tabs">
        <el-tab-pane label="用户管理" name="users"><UsersTab /></el-tab-pane>
        <el-tab-pane label="智能体管理" name="agents"><AgentsTab /></el-tab-pane>
        <el-tab-pane label="访问码" name="codes"><CodesTab /></el-tab-pane>
        <el-tab-pane label="审计日志" name="audit"><AuditTab /></el-tab-pane>
      </el-tabs>
    </main>
  </div>
</template>
