
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";

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

onMounted(async () => {
  if (auth.loaded && auth.isAuthed) router.replace(backTarget());
});
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <span class="brand-mark">回</span>
        <span>EchoAnswer · 回响答</span>
      </div>
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
      <router-link to="/" class="login-back">← 返回落地页</router-link>
    </div>
  </div>
</template>
