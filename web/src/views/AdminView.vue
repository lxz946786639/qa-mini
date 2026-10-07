<script setup lang="ts">
// 控制台（P6，路由 /admin；P7.3 布局对齐 Ant Design Admin 参考：左侧纵向导航 + 顶栏标题 + 内容卡片）
// 用户 / 智能体 / 访问码 / 审计日志 / 系统设置。仅 admin 主体可访问。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";
import { useTheme } from "../composables/useTheme";
import { useRouter, useRoute } from "vue-router";
import { Menu, Sunny, Moon, User, Cpu, Key, Document, Setting, Back, Fold, Expand, Monitor } from "@element-plus/icons-vue";
import { LOGO_SVG } from "../utils/brandLogo";
import UsersTab from "./admin/UsersTab.vue";
import AgentsTab from "./admin/AgentsTab.vue";
import CodesTab from "./admin/CodesTab.vue";
import AuditTab from "./admin/AuditTab.vue";
import OnlineTab from "./admin/OnlineTab.vue";
import SystemTab from "./admin/SystemTab.vue";
import AdminBootstrap from "../components/AdminBootstrap.vue";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const checked = ref(false);
// 首启引导（对齐旧版 /admin 首屏）：admin 未初始化时（GET /api/status admin_set=false）
// 显示「设置管理账号」表单（共享组件 AdminBootstrap，/login 首启访问同样展示）
const adminSet = ref<boolean | null>(null);
const { lightTheme, toggleTheme } = useTheme();

// 左侧导航（P7.3）：模块 = 旧 el-tabs 五页签；顶栏标题/副标题随选中项切换
const MENU = [
  { key: "users", icon: User, label: "用户管理", sub: "管理门户登录账号、角色与状态（建号 / 提权降级 / 停用 / 重置密码）" },
  { key: "agents", icon: Cpu, label: "智能体管理", sub: "code / 名称 / 描述 / 协议（创建后锁定）；停用即前端不可见" },
  { key: "codes", icon: Key, label: "访问码", sub: "6 位码：生成 / 启用停用 / 有效期；访问码主体共享会话桶" },
  { key: "online", icon: Monitor, label: "访问控制", sub: "在线访问者（登录用户 / 访问码用户按会话、匿名按长连接；设备指纹 + IP 判定唯一），支持一键下线（会话吊销 / 5 分钟禁入冷却）" },
  { key: "audit", icon: Document, label: "审计日志", sub: "admin 操作留痕（初始化 / 建号 / 改密 / 配置 / 会话重置等）" },
  { key: "sys", icon: Setting, label: "系统设置", sub: "四协议全局默认 + 语音识别 ASR + 安全（匿名访问开关）" }
];
const tab = ref("users");
const activeMeta = computed(() => MENU.find((m) => m.key === tab.value) || MENU[0]);

// 侧栏收起 / 窄屏抽屉（与工作区同款语义）
const sideCollapsed = ref(false);
const sideOpen = ref(false);
function toggleSide() {
  if (window.matchMedia("(max-width: 720px)").matches) sideOpen.value = !sideOpen.value;
  else sideCollapsed.value = !sideCollapsed.value;
}

onMounted(async () => {
  await auth.me();
  if (!auth.isAdmin) {
    try {
      const r = await fetch("/api/status");
      const d = (await r.json()) as { admin_set?: boolean };
      adminSet.value = !!d.admin_set;
    } catch { adminSet.value = true; }
  }
  checked.value = true;
  document.addEventListener("click", onUserDocClick);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onUserDocClick);
});

// ---------- P8.4 顶栏用户名下拉（与首页一致交互） ----------
const CARET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const userMenuOpen = ref(false);
const userWrap = ref<HTMLElement | null>(null);
function onUserDocClick(e: MouseEvent) {
  if (userMenuOpen.value && userWrap.value && !userWrap.value.contains(e.target as Node)) userMenuOpen.value = false;
}

async function onBootstrapDone() {
  // 初始化通道已签发 ea_sid cookie（以 admin 登录）→ 重新取主体进入控制台
  await auth.me();
}
async function onLogout() {
  await auth.logout();
  ElMessage.success("已退出登录");
  // P8.34：登出 → 登录页，并记忆当前页（再次登录回跳原页，Login ?next 机制）
  router.push("/login?next=" + encodeURIComponent(route.fullPath));
}
</script>

<template>
  <div class="adm-app" :class="{ 'side-collapsed': sideCollapsed, 'sidebar-open': sideOpen }">
    <!-- 左侧导航（品牌 + 模块菜单 + 返回首屏） -->
    <aside class="adm-side">
      <div class="adm-brand">
        <div class="adm-brand-row">
          <router-link to="/" class="brand">
            <span class="adm-brand-logo" v-html="LOGO_SVG"></span>
            <span class="brand-text">EchoAnswer</span>
          </router-link>
          <!-- P8.31：收起/展开移入侧栏品牌行（Fold/Expand 语义图标，与工作区会话列表同款） -->
          <button class="ws-side-toggle" :title="sideCollapsed ? '展开控制台导航' : '收起控制台导航'" @click="toggleSide">
            <el-icon v-if="sideCollapsed"><Expand /></el-icon><el-icon v-else><Fold /></el-icon>
          </button>
        </div>
        <span class="adm-brand-sub">回响答 · 控制台</span>
      </div>
      <ul class="adm-nav">
        <li v-for="m in MENU" :key="m.key" :class="{ on: m.key === tab }" :title="m.label" @click="tab = m.key">
          <el-icon class="adm-ic"><component :is="m.icon" /></el-icon><span class="adm-nav-lb">{{ m.label }}</span>
        </li>
      </ul>
      <div class="adm-side-foot">
        <router-link to="/" class="adm-home" @click="sideOpen = false"><el-icon><Back /></el-icon><span class="adm-nav-lb">返回首屏</span></router-link>
      </div>
    </aside>

    <div class="adm-col">
      <header class="adm-top">
        <!-- P8.31：顶栏汉堡 = 仅窄屏（≤720px）抽屉开关；桌面收起/展开在侧栏内（Fold/Expand） -->
        <button class="adm-head-menu" title="打开导航" @click="toggleSide"><el-icon><Menu /></el-icon></button>
        <div class="adm-top-tt">
          <div class="adm-top-title">{{ activeMeta.label }}</div>
          <div class="adm-top-sub">{{ activeMeta.sub }}</div>
        </div>
        <div class="adm-top-right">
          <!-- P8.4：与首页一致的顶栏右侧（主题 / 控制台 / 用户名下拉「退出」） -->
          <button class="prefs-btn prefs-btn-theme" :title="lightTheme ? '切换深色主题' : '切换浅色主题'" @click="toggleTheme"><el-icon><Moon v-if="lightTheme" /><Sunny v-else /></el-icon></button>
          <router-link to="/admin" class="topnav-link is-active">控制台</router-link>
          <div v-if="auth.isAuthed" class="user-wrap" ref="userWrap">
            <button type="button" class="user-btn" aria-haspopup="menu" :aria-expanded="userMenuOpen ? 'true' : 'false'" @click="userMenuOpen = !userMenuOpen" @keydown.esc="userMenuOpen = false">{{ auth.displayName || '管理员' }}<span class="user-caret" v-html="CARET_SVG" aria-hidden="true"></span></button>
            <div v-if="userMenuOpen" class="user-menu" role="menu">
              <button type="button" class="user-menu-item" role="menuitem" @click="onLogout">退出</button>
            </div>
          </div>
        </div>
      </header>

      <main class="adm-body">
        <div v-if="!checked" class="admin-wait">校验身份中…</div>
        <div v-else-if="!auth.isAdmin" class="admin-deny">
          <template v-if="adminSet === false">
            <p>管理密码尚未初始化</p>
            <p class="admin-dim">首次部署：设置管理账号密码后进入控制台（初始化通道，对齐旧版 /admin 首屏）。</p>
            <AdminBootstrap @done="onBootstrapDone" />
          </template>
          <template v-else>
            <p>当前身份无管理权限</p>
            <p class="admin-dim">控制台仅对 admin 角色开放（账号登录；访问码/匿名身份不可用）。</p>
            <el-button type="primary" size="small" @click="auth.me()">重新校验</el-button>
            <router-link to="/" class="topnav-link"><el-icon><Back /></el-icon>返回首屏</router-link>
          </template>
        </div>
        <div v-else class="adm-card">
          <UsersTab v-if="tab === 'users'" />
          <AgentsTab v-else-if="tab === 'agents'" />
          <CodesTab v-else-if="tab === 'codes'" />
          <OnlineTab v-else-if="tab === 'online'" />
          <AuditTab v-else-if="tab === 'audit'" />
          <SystemTab v-else-if="tab === 'sys'" />
        </div>
      </main>
    </div>
  </div>
</template>
