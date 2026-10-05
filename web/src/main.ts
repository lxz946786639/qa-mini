import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
// 注意：不引入 element-plus/theme-chalk/dark/css-vars.css（html.dark 变量块）——
// 本项目主题由 style.css 的 EP 变量映射（:root 深色 / :root[data-theme=light] 浅色）统一控制，
// html.dark 选择器特异性(0,1,1)会覆盖 :root 映射，导致浅色主题下表格/按钮残留深色（P7.6 修复）。
import App from "./App.vue";
import { router } from "./router";
import "./style.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ElementPlus);
app.mount("#app");
