import { createRouter, createWebHistory } from "vue-router";

// history 模式：服务器对 /app/ 下未知路径做 SPA fallback（回 index.html）
export const router = createRouter({
  history: createWebHistory(), // P7：站点根
  routes: [
    { path: "/", name: "landing", component: () => import("./views/Landing.vue") },
    { path: "/login", name: "login", component: () => import("./views/Login.vue") },
    { path: "/agents/:code", name: "workspace", component: () => import("./views/Workspace.vue") },
    { path: "/admin", name: "admin", component: () => import("./views/AdminView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" }
  ]
});
