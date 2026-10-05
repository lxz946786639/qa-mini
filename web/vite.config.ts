import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

// 挂载前缀 /app/：零依赖 Node 服务器把 web/dist 挂在同源的 /app/ 下（P4），
// P7 起根路径切换到本构建产物。开发期 vite dev 代理 /api → 127.0.0.1:8787。
export default defineConfig({
  base: "/app/",
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "EchoAnswer · 回响答",
        short_name: "EchoAnswer",
        description: "多用户、多智能体 AI 语音问答平台",
        lang: "zh-CN",
        start_url: "/app/",
        scope: "/app/",
        display: "standalone",
        background_color: "#0f1216",
        theme_color: "#0f1216",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // 与旧 sw 语义对齐：/api/*（含 SSE）永不缓存
        // 相对路径：SW 位于 /app/sw.js（scope /app/），回退到 /app/index.html
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          { urlPattern: /^.*\/api\/.*$/, handler: "NetworkOnly" }
        ]
      }
    })
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    target: "es2022"
  }
});
