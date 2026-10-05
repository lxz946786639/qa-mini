
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";
import AdminBootstrap from "../components/AdminBootstrap.vue";

// 登录：账号（用户名+密码 → /api/auth/login）/ 访问码（→ /api/auth/access-code），
// 成功后服务端下发 ea_sid cookie（HttpOnly），/api/auth/me 取主体再跳回。
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const tab = ref("user");
const username = ref("");
const password = ref("");
const code = ref("");
const busy = ref(false);
const error = ref("");
// 首启引导（P7.1）：admin 未初始化（GET /api/status admin_set=false）时，
// 登录页优先显示「设置管理账号密码」表单（初始化后已以 admin 登录 → 直接进应用）
const adminSet = ref<boolean | null>(null); // null = 查询中

function backTarget(): string {
  const n = route.query.next;
  return typeof n === "string" && n.startsWith("/") ? n : "/";
}

async function afterLogin() {
  await auth.me();
  ElMessage.success("登录成功");
  router.replace(backTarget());
}

async function submitUser() {
  error.value = "";
  if (!username.value.trim() || !password.value) {
    error.value = "请输入用户名和密码";
    return;
  }
  busy.value = true;
  try {
    const { ok, data } = await auth.login(username.value.trim(), password.value);
    if (!ok) {
      error.value = data.detail || "登录失败";
      return;
    }
    await afterLogin();
  } finally {
    busy.value = false;
  }
}

async function submitCode() {
  error.value = "";
  if (!/^\d{6}$/.test(code.value.trim())) {
    error.value = "访问码为 6 位数字";
    return;
  }
  busy.value = true;
  try {
    const { ok, data } = await auth.codeLogin(code.value.trim());
    if (!ok) {
      error.value = data.detail || "访问码无效或已过期";
      return;
    }
    await afterLogin();
  } finally {
    busy.value = false;
  }
}

async function onBootstrapDone() {
  // 初始化通道已签发 ea_sid cookie（以 admin 登录）→ 进入应用
  await auth.me();
  ElMessage.success("管理账号已初始化");
  router.replace(backTarget());
}

onMounted(async () => {
  if (auth.loaded && auth.isAuthed) return router.replace(backTarget());
  try {
    const r = await fetch("/api/status");
    const d = (await r.json()) as { admin_set?: boolean };
    adminSet.value = !!d.admin_set;
  } catch { adminSet.value = true; }
});
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <span class="brand-mark">回</span>
        <span>EchoAnswer · 回响答</span>
      </div>
      <template v-if="adminSet === false">
        <h2>初始化管理账号（首次使用）</h2>
        <p class="login-bs-hint">系统尚未设置管理密码。请设置管理账号与密码，成功后将直接以管理员进入应用；
          也可暂不初始化（匿名访问开启时仍可匿名浏览提问，管理入口 <code>/admin</code> 随时可初始化）。</p>
        <AdminBootstrap @done="onBootstrapDone" />
      </template>
      <template v-else-if="adminSet === true">
        <h2>登录</h2>
        <el-tabs v-model="tab">
        <el-tab-pane label="账号登录" name="user">
          <el-form label-position="top" @submit.prevent="submitUser">
            <el-form-item label="用户名">
              <el-input v-model="username" placeholder="用户名" autocomplete="username" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input
                v-model="password"
                type="password"
                placeholder="密码"
                autocomplete="current-password"
                show-password
                @keyup.enter="submitUser"
              />
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="访问码" name="code">
          <el-form label-position="top" @submit.prevent="submitCode">
            <el-form-item label="6 位访问码">
              <el-input
                v-model="code"
                placeholder="如 123456"
                maxlength="6"
                @keyup.enter="submitCode"
              />
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
        <el-alert v-if="error" type="error" :title="error" :closable="false" class="login-err" />
        <el-button
          type="primary"
          class="login-btn"
          :loading="busy"
          @click="tab === 'user' ? submitUser() : submitCode()"
        >
          登 录
        </el-button>
      </template>
      <div v-else class="login-wait">加载中…</div>

      <router-link to="/" class="login-back">← 返回落地页</router-link>
    </div>
  </div>
</template>
