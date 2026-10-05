<script setup lang="ts">
// 管理账号首启引导（P7.1）：admin 未初始化时（GET /api/status admin_set=false）
// 显示「设置管理账号密码」表单。POST /api/admin/login 初始化通道：创建 admin、
// 签发 ea_sid cookie（成功后调用方已以 admin 登录），emit done 由父级跳转。
// 供 /login（首启访问）与 /admin（管理台首屏）共用。
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const emit = defineEmits<{ (e: "done"): void }>();
const username = ref("admin");
const pw = ref("");
const pw2 = ref("");
const busy = ref(false);

async function submit() {
  const u = username.value.trim() || "admin";
  if (u.length > 32) { ElMessage.warning("用户名不超过 32 位"); return; }
  if (pw.value.length < 4 || pw.value.length > 64) { ElMessage.warning("管理密码需 4-64 位字符"); return; }
  if (pw.value !== pw2.value) { ElMessage.warning("两次输入的密码不一致"); return; }
  busy.value = true;
  try {
    const { ok, data } = await api<{ ok: boolean; initialized?: boolean; detail?: string }>("/api/admin/login", {
      method: "POST",
      body: { username: u, password: pw.value }
    });
    if (ok) { ElMessage.success(data.initialized ? "已初始化并登录" : "登录成功"); emit("done"); }
    else ElMessage.error(data.detail || "初始化失败");
  } finally { busy.value = false; }
}
</script>

<template>
  <el-form label-position="top" class="admin-bs-form" @submit.prevent="submit">
    <el-form-item label="管理员用户名（默认 admin）">
      <el-input v-model="username" autocomplete="username" />
    </el-form-item>
    <el-form-item label="管理密码（4-64 位）">
      <el-input v-model="pw" type="password" show-password autocomplete="new-password" />
    </el-form-item>
    <el-form-item label="确认密码">
      <el-input v-model="pw2" type="password" show-password autocomplete="new-password" @keyup.enter="submit" />
    </el-form-item>
    <el-button type="primary" class="admin-bs-btn" :loading="busy" @click="submit">初始化并进入</el-button>
  </el-form>
</template>