<script setup lang="ts">
// P8.55 个人设置对话框：用户显示名 + 修改密码（PUT /api/auth/me 自助；仅账号主体可见入口）
// 服务端契约：PUT /api/auth/me { display_name?, old_password?, new_password? }
//   - display_name：字符串 ≤32（trim）
//   - 修改密码：需 old_password 校验（错 = 403）+ new_password 4-64 位
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void; (e: "saved"): void }>();
const auth = useAuthStore();
const user = auth.principal?.user || null;

const form = ref({ display_name: "", old_password: "", new_password: "", confirm_password: "" });
function reset() {
  form.value = {
    display_name: user ? user.display_name || "" : "",
    old_password: "", new_password: "", confirm_password: ""
  };
}
watch(() => props.open, (v) => { if (v) reset(); });

const saving = ref(false);
async function save() {
  if (!user || saving.value) return;
  if (form.value.new_password !== "" || form.value.old_password !== "" || form.value.confirm_password !== "") {
    if (!form.value.old_password) { ElMessage.warning("修改密码需填写当前密码"); return; }
    if (form.value.new_password.length < 4 || form.value.new_password.length > 64) {
      ElMessage.warning("新密码需 4-64 位字符"); return;
    }
    if (form.value.new_password !== form.value.confirm_password) {
      ElMessage.warning("两次输入的新密码不一致"); return;
    }
  }
  const body: Record<string, any> = { display_name: form.value.display_name };
  const pwChanged = form.value.old_password !== "" || form.value.new_password !== "";
  if (pwChanged) {
    body.old_password = form.value.old_password;
    body.new_password = form.value.new_password;
  }
  saving.value = true;
  try {
    const r = await api<{ ok: boolean; detail?: string; user?: { display_name: string } }>(
      "/api/auth/me", { method: "PUT", body }
    );
    if (r.ok) {
      if (r.data.user && auth.principal && auth.principal.user) {
        auth.principal.user.display_name = r.data.user.display_name || "";
      }
      ElMessage.success("个人设置已保存");
      if (pwChanged) ElMessage.info("密码已更新，其他设备下次登录将使用新密码");
      emit("saved");
      emit("update:open", false);
    } else {
      ElMessage.error(r.data.detail || "保存失败");
    }
  } catch (e: any) {
    ElMessage.error(((e && e.message) || e) + "");
  } finally {
    saving.value = false;
  }
}
function close() { emit("update:open", false); }
</script>

<template>
  <el-dialog
    :model-value="open"
    title="个人设置"
    width="440px"
    append-to-body
    @update:model-value="(v) => (v ? reset() : close())"
  >
    <el-form label-position="top">
      <el-form-item label="显示名（他人可见，默认 = 用户名）">
        <el-input v-model="form.display_name" maxlength="32" show-word-limit placeholder="默认为用户名" clearable />
      </el-form-item>
      <el-form-item label="当前密码（留空 = 不改密码）">
        <el-input v-model="form.old_password" type="password" show-password placeholder="修改密码时必填" clearable />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="form.new_password" type="password" show-password placeholder="4-64 位字符" clearable />
      </el-form-item>
      <el-form-item label="确认新密码">
        <el-input v-model="form.confirm_password" type="password" show-password placeholder="再次输入新密码" clearable />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
