import { defineStore } from "pinia";
import { api } from "../api";

// 主体（与服务端 /api/auth/me 对齐）
export interface MeUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
}
export interface MePrincipal {
  kind: "admin" | "user" | "code";
  user: MeUser | null;
  code: string | null;
}
interface MeResponse {
  ok: boolean;
  principal: MePrincipal | null;
  anonymous?: boolean;
  detail?: string;
}

export const useAuthStore = defineStore("auth", {
  state: () => ({
    principal: null as MePrincipal | null,
    anonymous: false,
    loaded: false
  }),
  getters: {
    isAuthed: (s) => !!s.principal,
    isAdmin: (s) => s.principal?.kind === "admin",
    displayName: (s) =>
      s.principal?.user?.display_name ||
      s.principal?.user?.username ||
      (s.principal?.kind === "code" ? "访问码用户" : "")
  },
  actions: {
    async me() {
      const { ok, data } = await api<MeResponse>("/api/auth/me");
      if (ok) {
        this.principal = data.principal ?? null;
        this.anonymous = !!data.anonymous;
      }
      this.loaded = true;
      return this.principal;
    },
    async login(username: string, password: string) {
      return api<{ ok: boolean; detail?: string; user?: MeUser }>("/api/auth/login", {
        body: { username, password }
      });
    },
    async codeLogin(code: string) {
      return api<{ ok: boolean; detail?: string }>("/api/auth/access-code", { body: { code } });
    },
    async logout() {
      const r = await api("/api/auth/logout", { method: "POST", body: {} });
      this.principal = null;
      this.anonymous = true;
      return r;
    },
    // P8.38：被踢出后清空本地主体（会话已服务端吊销，不再调登出接口；
    // 防止登录页「已登录」误判回跳原页造成踢出循环）
    clearAuthed() {
      this.principal = null;
      this.anonymous = true;
    }
  }
});
