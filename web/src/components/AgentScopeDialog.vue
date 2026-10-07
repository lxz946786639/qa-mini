
<script setup lang="ts">
// P8.40/P8.51 主体权限范围对话框（访问码 / 用户共用）三态：
// all = 允许全部智能体；some = 仅列出的 agent id；none = 不允许任何（最小权限）。
// 保存回调 { mode, ids }：all → ids=[]；some → ids=多选；none → ids=[]。
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

type ScopeMode = "all" | "some" | "none";
interface AgentLite { id: string; code: string; name: string; enabled: boolean; }
const props = defineProps<{
  visible: boolean;
  title: string;
  mode: ScopeMode;
  picked: string[]; // mode=some 时已勾选的 agent id
}>();
const emit = defineEmits<{
  (e: "update:visible", v: boolean): void;
  (e: "save", v: { mode: ScopeMode; ids: string[] }): void;
}>();

const cur = ref<ScopeMode>("all");
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
  cur.value = props.mode;
  picked.value = [...props.picked];
  await ensureAgents();
});
function optionLabel(a: AgentLite): string {
  return a.name + (a.code !== a.name ? "（" + a.code + "）" : "") + (a.enabled ? "" : "（已停用）");
}
function save() {
  if (cur.value === "some" && !picked.value.length) {
    ElMessage.warning("请至少选择一个智能体（或改为「允许全部」）");
    return;
  }
  emit("save", { mode: cur.value, ids: cur.value === "some" ? [...picked.value] : [] });
}
function close() { emit("update:visible", false); }
</script>

<template>
  <el-dialog :model-value="visible" :title="title" width="480px" @update:model-value="close">
    <el-radio-group v-model="cur">
      <el-radio value="all">允许全部智能体</el-radio>
      <el-radio value="some">仅以下智能体</el-radio>
      <el-radio value="none">不允许访问任何智能体</el-radio>
    </el-radio-group>
    <el-select
      v-if="cur === 'some'"
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
    <p v-else-if="cur === 'all'" class="scope-tip">保存后该主体可访问所有智能体（含后续新建的智能体）。</p>
    <p v-else class="scope-tip tip-none">保存后该主体无法访问任何智能体（最小权限；后续可在控制台「权限」按钮放行）。</p>
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
.tip-none {
  color: var(--el-color-danger);
}
</style>
