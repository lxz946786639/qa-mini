
<script setup lang="ts">
// 访问码管理（列表来自 GET /api/config → security.access_codes；生成/延期/失效/清理过期）
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fmtDateTime } from "../../utils/formatTime";
import { api } from "../../api";

interface Code { code: string; created_at: string; expires_at: string; }
const list = ref<Code[]>([]);
const loading = ref(true);
const form = reactive({ mode: "random" as "random" | "custom", custom: "", hours: 8, count: 1 });

function expired(c: Code): boolean {
  return new Date(c.expires_at).getTime() < Date.now();
}
async function load() {
  loading.value = true;
  const { ok, data } = await api<{ security?: { access_codes?: Code[] } }>("/api/config");
  if (ok) list.value = (data.security?.access_codes || []).slice().sort((a, b) => b.expires_at.localeCompare(a.expires_at));
  loading.value = false;
}
async function add() {
  const body: Record<string, any> = { hours: Number(form.hours) || 8 };
  if (form.mode === "custom") body.code = form.custom.trim();
  else body.count = Number(form.count) || 1;
  const r = await api("/api/admin/access-codes", { body });
  if (r.ok) {
    ElMessage.success(r.data.entries.length > 1 ? "已生成 " + r.data.entries.length + " 个码" : "已生成：" + (r.data.entry && r.data.entry.code));
    load();
  } else ElMessage.error(r.data.detail || "生成失败");
}
async function renew(c: Code) {
  try {
    const { value } = await ElMessageBox.prompt("延期时长（小时，上限 720）", "延期访问码 " + c.code, {
      inputValue: "8", confirmButtonText: "延期", cancelButtonText: "取消",
      inputPattern: /^\d+$/, inputErrorMessage: "请输入正整数"
    });
    const r = await api("/api/admin/access-codes/" + encodeURIComponent(c.code) + "/renew", { body: { hours: Number(value) } });
    if (r.ok) ElMessage.success("已延期");
    else ElMessage.error(r.data.detail || "延期失败");
    load();
  } catch { /* 取消 */ }
}
async function invalidate(c: Code) {
  try {
    await ElMessageBox.confirm("失效访问码 " + c.code + "？该码已签发的登录凭证将全部吊销。", "失效访问码", { confirmButtonText: "失效", cancelButtonText: "取消", type: "warning" });
  } catch { return; }
  const r = await api("/api/admin/access-codes/" + encodeURIComponent(c.code), { method: "DELETE" });
  if (r.ok) ElMessage.success("已失效");
  else ElMessage.error(r.data.detail || "操作失败");
  load();
}
async function cleanExpired() {
  const r = await api("/api/admin/access-codes/expired", { method: "DELETE" });
  if (r.ok) ElMessage.success("已清理 " + (r.data.removed || 0) + " 个过期码");
  load();
}
onMounted(load);
</script>

<template>
  <div>
    <div class="tab-bar">
      <span class="tab-note">
        共 {{ list.length }} 个有效码
        <el-button v-if="list.some(expired)" link type="danger" size="small" @click="cleanExpired">（含 {{ list.filter(expired).length }} 个已过期，一键清理）</el-button>
      </span>
    </div>
    <div class="code-gen">
      <el-radio-group v-model="form.mode" size="small">
        <el-radio-button value="random">随机生成</el-radio-button>
        <el-radio-button value="custom">指定码</el-radio-button>
      </el-radio-group>
      <el-input v-if="form.mode === 'custom'" v-model="form.custom" placeholder="6 位数字" maxlength="6" style="width: 120px" size="small" />
      <el-input-number v-else v-model="form.count" :min="1" :max="10" size="small" style="width: 90px" />
      <el-select v-model="form.hours" size="small" style="width: 130px">
        <el-option :value="1" label="1 小时" />
        <el-option :value="8" label="8 小时" />
        <el-option :value="24" label="24 小时" />
        <el-option :value="72" label="3 天" />
        <el-option :value="168" label="7 天" />
      </el-select>
      <el-button type="primary" size="small" @click="add">生成</el-button>
    </div>
    <el-table v-loading="loading" :data="list">
      <el-table-column label="访问码" min-width="160">
        <template #default="{ row }"><b>{{ row.code }}</b></template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="200">
        <template #default="{ row }">{{ fmtDateTime(row.created_at) || "—" }}</template>
      </el-table-column>
      <el-table-column label="到期时间" min-width="200">
        <template #default="{ row }">
          <span :class="{ danger: expired(row) }">{{ fmtDateTime(row.expires_at) }}</span>
          <el-tag v-if="expired(row)" type="danger" size="small" style="margin-left: 6px">已过期</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="renew(row)">延期</el-button>
          <el-button size="small" type="danger" plain @click="invalidate(row)">失效</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
