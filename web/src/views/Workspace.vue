
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";

// 工作区（P4 占位）：P5 接入 用户私有会话列表 / 聊天 / SSE 作用域 / 语音输入
const route = useRoute();
const auth = useAuthStore();
const agentCode = computed(() => String(route.params.code || ""));
const agentName = ref("…");
const agentErr = ref("");

onMounted(async () => {
  auth.me();
  const { ok, data } = await api<{ ok: boolean; agent?: { name: string }; detail?: string }>(
    "/api/agents/" + encodeURIComponent(agentCode.value)
  );
  if (!ok) {
    agentErr.value = data.detail || "智能体不存在或已停用";
    return;
  }
  agentName.value = data.agent?.name || agentCode.value;
});
</script>

<template>
  <div class="landing">
    <header class="topbar">
      <div class="brand">
        <router-link to="/" class="brand">
          <span class="brand-mark">回</span>
          <span class="brand-text">EchoAnswer · 回响答</span>
        </router-link>
      </div>
      <nav class="topnav">
        <span v-if="auth.isAuthed" class="user-chip">{{ auth.displayName || "用户" }}</span>
        <router-link v-else to="/login" class="topnav-link">登录</router-link>
      </nav>
    </header>
    <main class="main">
      <router-link to="/" class="ws-back">← 返回智能体列表</router-link>
      <div v-if="agentErr" class="ws-err">{{ agentErr }}</div>
      <div v-else class="ws-box">
        <div class="ws-agent">{{ agentName }}</div>
        <h2>工作区建设中</h2>
        <p class="ws-note">
          P5 将在此提供：该智能体下属于你的会话列表（user_id × agent_id 私有桶）、
          实时流式问答、语音输入、会话管理与 EchoScribe 推送目标配置。
        </p>
      </div>
    </main>
  </div>
</template>
