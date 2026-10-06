
<script setup lang="ts">
// P8.33 访问控制：在线访问者（Workspace 长连接注册表；设备指纹 + IP 判定唯一）+ 一键踢出。
// 列：身份 / 设备（浏览器特征 + 识别码，与 P8.29 审计同源解析）/ IP / 连接数 / 在线开始 / 操作。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../../api";
import { fmtDateTime } from "../../utils/formatTime";
import { describeUa, type UaDevice } from "../../utils/uaDevice";

interface Item {
  dev: string; ip: string; ua: string; kind: string; label: string;
  connections: number; connected_at: string;
  devInfo?: UaDevice;
}
const items = ref<Item[]>([]);
const count = ref(0);
const loading = ref(false);

const KIND_TAG: Record<string, string> = { anon: "info", code: "warning", user: "success", admin: "danger", unknown: "info" };
const KIND_ZH: Record<string, string> = { anon: "匿名", code: "访问码", user: "用户", admin: "管理员", unknown: "未知" };

async function load() {
  if (loading.value) return;
  loading.value = true;
  const { ok, data } = await api<{ ok?: boolean; count?: number; online?: Item[] }>("/api/admin/online");
  if (ok) {
    count.value = data.count || 0;
    items.value = (data.online || []).map((it) => (it.ua ? { ...it, devInfo: describeUa(it.ua) } : it));
  }
  loading.value = false;
}
async function kick(it: Item) {
  try {
    await ElMessageBox.confirm(
      "确认下线该访问者？其页面将退出到首页，且 5 分钟内无法重新进入。",
      "下线访问者", { type: "warning", confirmButtonText: "下线", cancelButtonText: "取消" }
    );
  } catch { return; }
  const { ok, data } = await api<{ ok?: boolean; detail?: string; kicked?: number }>("/api/admin/online/kick", { method: "POST", body: { dev: it.dev, ip: it.ip } });
  if (ok) { ElMessage.success("已下线"); load(); }
  else ElMessage.error((data && data.detail) || "下线失败");
}
let timer: number | undefined;
onMounted(() => { load(); timer = window.setInterval(load, 5000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div>
    <div class="tab-bar">
      <span class="tab-note">在线 {{ count }} 个身份（工作区长连接访问者；设备指纹 + IP 判定唯一，5 秒自动刷新）</span>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-table v-loading="loading" :data="items" size="default">
      <el-table-column label="身份" min-width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="KIND_TAG[row.kind] || 'info'">{{ KIND_ZH[row.kind] || row.kind }}</el-tag>
          <span class="dim">{{ row.label }}</span>
        </template>
      </el-table-column>
      <el-table-column label="设备" min-width="215">
        <template #default="{ row }">
          <template v-if="row.devInfo && (row.devInfo.label || row.devInfo.code)">
            <div>{{ row.devInfo.label || "未知设备" }}</div>
            <div class="dim" style="font-family: ui-monospace, Consolas, monospace;">{{ row.devInfo.code }}</div>
          </template>
          <span v-else class="dim">—</span>
        </template>
      </el-table-column>
      <el-table-column label="IP" prop="ip" min-width="120" />
      <el-table-column label="连接数" prop="connections" min-width="80" />
      <el-table-column label="在线开始" min-width="165">
        <template #default="{ row }">{{ fmtDateTime(row.connected_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="110">
        <template #default="{ row }">
          <el-button size="small" type="danger" plain :disabled="row.kind === 'admin'" @click="kick(row)">下线</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
