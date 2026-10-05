
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Microphone } from "@element-plus/icons-vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";

// 落地页：智能体选择器（GET /api/agents 启用中列表）
interface AgentItem {
  id: string;
  code: string;
  name: string;
  description: string;
  icon: string;
  protocol: string;
  sort: number;
}

const router = useRouter();
const auth = useAuthStore();
const agentPath = (code: string) => "/agents/" + code;
const agents = ref<AgentItem[]>([]);
const loading = ref(true);
const error = ref("");

const PROTO_NAME: Record<string, string> = {
  ragflow: "知识引擎",
  dify: "编排引擎",
  openai: "OpenAI",
  generic: "通用"
};

async function load() {
  loading.value = true;
  error.value = "";
  const { ok, data } = await api<{ ok: boolean; agents?: AgentItem[]; detail?: string }>("/api/agents");
  loading.value = false;
  if (!ok) {
    error.value = data.detail || "加载智能体列表失败";
    return;
  }
  agents.value = (data.agents || []).slice().sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
}

async function onLogout() {
  await auth.logout();
  ElMessage.success("已退出登录");
}

onMounted(() => {
  auth.me();
  load();
});
</script>

<template>
  <div class="landing">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">回</span>
        <span class="brand-text">EchoAnswer · 回响答</span>
      </div>
      <nav class="topnav">
        <template v-if="auth.isAuthed">
          <span class="user-chip">
            {{ auth.displayName || "用户" }}
            <em v-if="auth.isAdmin">管理</em>
          </span>
          <router-link v-if="auth.isAdmin" to="/admin" class="topnav-link">控制台</router-link>
          <el-button size="small" @click="onLogout">退出</el-button>
        </template>
        <template v-else>
          <router-link to="/login" class="topnav-link">登录</router-link>
        </template>
      </nav>
    </header>

    <main class="main">
      <section class="hero">
        <h1>选择智能体，开始问答</h1>
        <p>多用户 · 多智能体 · 会话隔离</p>
      </section>

      <el-alert
        v-if="!auth.loaded || (!auth.isAuthed && !auth.anonymous)"
        type="info"
        :closable="false"
        show-icon
        title="未登录：仅可浏览公开信息。登录账号或使用访问码进入工作区（私有会话按用户/访问码隔离）。"
        class="guest-bar"
      />

      <div v-if="loading" class="grid">
        <el-skeleton v-for="n in 3" :key="n" animated class="agent-card-sk" />
      </div>

      <el-alert v-else-if="error" type="error" :title="error" :closable="false" class="grid-err">
        <template #default>
          <el-button size="small" @click="load">重试</el-button>
        </template>
      </el-alert>

      <div v-else-if="!agents.length" class="empty">
        <p>暂无可用智能体</p>
        <p class="empty-dim">请联系管理员在「控制台」创建并启用智能体。</p>
      </div>

      <div v-else class="grid">
        <router-link
          v-for="a in agents"
          :key="a.id"
          :to="agentPath(a.code)"
          class="agent-card"
        >
          <div class="agent-icon"><span v-if="a.icon">{{ a.icon }}</span><el-icon v-else class="agent-icon-ui"><Microphone /></el-icon></div>
          <div class="agent-body">
            <div class="agent-name">
              {{ a.name }}
              <el-tag size="small" effect="plain" class="proto-tag">{{ PROTO_NAME[a.protocol] || a.protocol }}</el-tag>
            </div>
            <div class="agent-desc">{{ a.description || "（暂无描述）" }}</div>
          </div>
          <div class="agent-go">进入工作区 →</div>
        </router-link>
      </div>
    </main>

    <footer class="foot">EchoAnswer v59 · 局域网 AI 问答平台</footer>
  </div>
</template>
