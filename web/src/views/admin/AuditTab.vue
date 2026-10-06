
<script setup lang="ts">
// 审计日志（管理操作留痕：users.create / agents.update / auth.login / access.login …）
// P8.29：动作显示中文；新增「设备」列（浏览器特征 + 识别码）；IP 移到「详情」前；
// 访问码登录/登出留痕（后端配套，detail 中访问码脱敏）
import { onMounted, ref } from "vue";
import { api } from "../../api";
import { fmtDateTime } from "../../utils/formatTime";
import { describeUa, type UaDevice } from "../../utils/uaDevice";

interface Item {
  id: number; actor_type: string; actor_id: string | null; action: string;
  target_type: string | null; target_id: string | null; detail: any; ip: string;
  user_agent: string; created_at: string;
  dev?: UaDevice;
}
const items = ref<Item[]>([]);
const loading = ref(true);
const offset = ref(0);
const LIMIT = 100;

// P8.29：动作码 → 中文（未知码回退原码）
const ACTION_ZH: Record<string, string> = {
  "admin.bootstrap": "管理员初始化",
  "admin.login": "管理员登录",
  "auth.login": "登录",
  "auth.logout": "登出",
  "access.login": "访问码登录",
  "access.logout": "访问码登出",
  "users.create": "新建用户",
  "users.update": "修改用户",
  "agents.create": "新建智能体",
  "agents.update": "修改智能体",
  "codes.create": "新建访问码",
  "codes.update": "修改访问码",
  "codes.delete": "删除访问码",
  "config.update": "修改配置",
  "access.kick": "下线访问者"
};
function actionZh(a: string): string { return ACTION_ZH[a] || a; }
const ACTOR_ZH: Record<string, string> = { admin: "管理员", user: "用户", code: "访问码", system: "系统" };

async function load(reset = true) {
  loading.value = true;
  offset.value = reset ? 0 : offset.value + LIMIT;
  const { ok, data } = await api<{ items?: Item[] }>("/api/admin/audit?limit=" + LIMIT + "&offset=" + offset.value);
  if (ok) {
    const rows = (data.items || []).map((it) => (it.user_agent ? { ...it, dev: describeUa(it.user_agent) } : it));
    items.value = reset ? rows : items.value.concat(rows);
  }
  loading.value = false;
}
function fmtDetail(d: any): string {
  if (!d || typeof d !== "object") return "—";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === "••••" || v === "•••") parts.push(k + " = （已修改）");
    else parts.push(k + " = " + (typeof v === "string" ? v : JSON.stringify(v)));
  }
  return parts.join("，");
}
onMounted(() => load(true));
</script>

<template>
  <div>
    <div class="tab-bar">
      <span class="tab-note">最近 {{ items.length }} 条（每页 {{ LIMIT }}，可继续加载）</span>
      <el-button size="small" :loading="loading" @click="load(true)">刷新</el-button>
    </div>
    <el-table v-loading="loading" :data="items" size="default">
      <el-table-column label="时间" min-width="165">
        <template #default="{ row }">{{ fmtDateTime(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作者" min-width="150">
        <template #default="{ row }">
          {{ ACTOR_ZH[row.actor_type] || row.actor_type }}
          <span class="dim" v-if="row.actor_id">（{{ row.actor_id }}）</span>
        </template>
      </el-table-column>
      <el-table-column label="动作" min-width="130">
        <template #default="{ row }">
          <el-tag size="small" :type="row.action.includes('create') ? 'success' : row.action.includes('update') ? 'warning' : 'info'">{{ actionZh(row.action) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="目标" min-width="170">
        <template #default="{ row }">{{ row.target_type ? row.target_type + ":" + (row.target_id || "") : "—" }}</template>
      </el-table-column>
      <el-table-column label="设备" min-width="215">
        <template #default="{ row }">
          <template v-if="row.dev && (row.dev.label || row.dev.code)">
            <div>{{ row.dev.label || "未知设备" }}</div>
            <div class="dim" style="font-family: ui-monospace, Consolas, monospace;">{{ row.dev.code }}</div>
          </template>
          <span v-else class="dim">—</span>
        </template>
      </el-table-column>
      <el-table-column label="IP" prop="ip" min-width="120" />
      <el-table-column label="详情" min-width="320">
        <template #default="{ row }"><span class="dim">{{ fmtDetail(row.detail) }}</span></template>
      </el-table-column>
    </el-table>
    <div class="tab-more">
      <el-button size="small" :loading="loading" :disabled="loading" @click="load(false)">加载更多</el-button>
    </div>
  </div>
</template>
