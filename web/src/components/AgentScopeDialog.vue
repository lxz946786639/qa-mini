
<script setup lang="ts">
// P8.40 主体权限范围对话框（访问码 / 用户共用）：
// 允许全部智能体（空范围）/ 仅以下智能体（agent id 多选）。保存回调 scope: string[]（[] = 全部）。
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

interface AgentLite { id: string; code: string; name: string; enabled: boolean; }
const props = defineProps<{
  visible: boolean;
  title: string;
  scope: string[] | null; // null/[] = 允许全部
}>();
const emit = defineEmits<{
  (e: "update:visible", v: boolean): void;
  (e: "save", scope: string[]): void;
}>();

const mode = ref<"all" | "pick">("all");
const picked = ref<string[]>([]);
const agents = ref<AgentLite[]>([]);
const agentsLoaded = ref(false);

async function ensureAgents() {
  if (agentsLoaded.value) return;
  const { ok, data } = await api<{ agents?: AgentLite[] }>("/api/admin/agents");
  if (ok) {
    agents.value = data.agents || [];
    agentsLoaded.value = true;
  }
}
watch(() => props.visible, async (v) => {
  if (!v) return;
  mode.value = props.scope && props.scope.length ? "pick" : "all";
  picked.value = [...(props.scope || [])];
  await ensureAgents();
});
function optionLabel(a: AgentLite): string {
  return a.name + (a.code !== a.name ? "（" + a.code + "）" : "") + (a.enabled ? "" : "（已停用）");
}
function save() {
  if (mode.value === "pick" && !picked.value.length) {
    ElMessage.warning("请至少选择一个智能体（或改为「允许全部」）");
    return;
  }
  emit("save", mode.value === "all" ? [] : [...picked.value]);
}
function close() { emit("update:visible", false); }
</script>

<template>
  <el-dialog :model-value="visible" :title="title" width="460px" @update:model-value="close">
    <el-radio-group v-model="mode">
      <el-radio value="all">允许全部智能体</el-radio>
      <el-radio value="pick">仅以下智能体</el-radio>
    </el-radio-group>
    <el-select
      v-if="mode === 'pick'"
      v-model="picked"
      multiple
      filterable
      collapse-tags
      collapse-tags-tooltip
      placeholder="选择可访问的智能体"
      style="width: 100%; margin-top: 12px"
    >
      <el-option v-for="a in agents" :key="a.id" :value="a.id" :label="optionLabel(a)" />
    </el-select>
    <p v-else class="scope-tip">保存后该主体可访问所有智能体（含后续新建的智能体）。</p>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.scope-tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin: 12px 0 0;
}
</style>
