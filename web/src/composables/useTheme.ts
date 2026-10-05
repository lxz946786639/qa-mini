// 主题（P7.3 共享）：对齐旧版键 echoanswer-theme（light/dark）→ <html> data-theme。
// 注意：不要用 Element Plus 官方的 html.dark 类机制（与 style.css 的 EP 变量映射
// 特异性冲突，浅色主题会残留深色组件）——本主题机制是唯一入口。
// 工作区与「⚙ 显示」无关，控制台/工作区顶栏共用同一个切换。
import { ref } from "vue";

export function useTheme() {
  const lightTheme = ref(false);
  function apply(v: boolean) {
    if (v) document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }
  try { lightTheme.value = localStorage.getItem("echoanswer-theme") === "light"; } catch { /* 忽略 */ }
  apply(lightTheme.value);
  function toggleTheme() {
    lightTheme.value = !lightTheme.value;
    apply(lightTheme.value);
    try { localStorage.setItem("echoanswer-theme", lightTheme.value ? "light" : "dark"); } catch { /* 忽略 */ }
  }
  return { lightTheme, toggleTheme };
}
