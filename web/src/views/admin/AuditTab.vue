
<script setup lang="ts">
// 审计日志（管理操作留痕：users.create / users.update / agents.create / agents.update / auth.login…）
import { onMounted, ref } from "vue";
import { api } from "../../api";
import { fmtDateTime } from "../../utils/formatTime";

interface Item {
  id: number; actor_type: string; actor_id: string | null; action: string;
  target_type: string | null; target_id: string | null; detail: any; ip: string; created_at: string;
}
const items = ref<Item[]>([]);
const loading = ref(true);
const offset = ref(0);
const LIMIT = 100;

async function load(reset = true) {
  loading.value = true;
  offset.value = reset ? 0 : offset.value + LIMIT;
  const { ok, data } = await api<{ items?: Item[] }>("/api/admin/audit?limit=" + LIMIT + "&offset=" + offset.value);
  if (ok) items.value = reset ? (data.items || []) : items.value.concat(data.items || []);
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
          {{ row.actor_type === "admin" ? "管理员" : row.actor_type }}
          <span class="dim" v-if="row.actor_id">（{{ row.actor_id }}）</span>
        </template>
      </el-table-column>
      <el-table-column label="动作" min-width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="row.action.includes('create') ? 'success' : row.action.includes('update') ? 'warning' : 'info'">{{ row.action }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="目标" min-width="180">
        <template #default="{ row }">{{ row.target_type ? row.target_type + ":" + (row.target_id || "") : "—" }}</template>
      </el-table-column>
      <el-table-column label="详情" min-width="320">
        <template #default="{ row }"><span class="dim">{{ fmtDetail(row.detail) }}</span></template>
      </el-table-column>
      <el-table-column label="IP" prop="ip" min-width="130" />
    </el-table>
    <div class="tab-more">
      <el-button size="small" :loading="loading" :disabled="loading" @click="load(false)">加载更多</el-button>
    </div>
  </div>
</template>
