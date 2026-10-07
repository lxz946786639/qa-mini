// 会话状态（P5 工作区）：列表（按主体作用域 + agent 过滤）/ 详情（历史 + 在途）/ 操作
import { defineStore } from "pinia";
import { api } from "../api";

export interface SessionView {
  id: string;
  name: string;
  protocol: string;
  continue_session: boolean;
  created_at: string;
  updated_at: string;
  qa_count: number;
  active: number;
  last_question: string | null;
  last_at: string | null;
  agent_id: string | null;
  audio_remote: { enabled: boolean; preferred_device: string };
  // P8.47：桶标记（shared / user / code）；user_id / owner_name 仅管理端视图携带
  access_mode?: string;
  user_id?: string | null;
  owner_name?: string | null;
}
export interface RecordView {
  id: string;
  source: string;
  question: string;
  answer: string;
  protocol: string;
  protocol_name: string;
  status: "running" | "done";
  ok: boolean;
  detail: string;
  started_at: string;
  finished_at: string | null;
  duration_s: number | null;
}
interface Detail {
  session: SessionView & { token?: string; protocol_config?: any };
  history: RecordView[];
  running: RecordView[];
}

export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    all: [] as SessionView[], // 主体可见的全部会话（含其他 agent，用于过滤）
    currentSid: null as string | null,
    detail: null as Detail | null
  }),
  getters: {
    agentSessions: (s) => (agentId: string) =>
      s.all.filter((v) => (v.agent_id || null) === agentId),
    current: (s) => (s.currentSid ? s.all.find((v) => v.id === s.currentSid) || null : null)
  },
  actions: {
    async loadList() {
      const { ok, data } = await api<{ sessions: SessionView[] }>("/api/sessions");
      if (ok) this.all = data.sessions || [];
      return ok;
    },
    // SSE sessions 事件 → 直接换列表（服务器已按主体作用域 + 含 agent_id）
    applySseList(list: SessionView[]) {
      this.all = list || [];
    },
    async open(sid: string) {
      this.currentSid = sid;
      // 服务端 full() 形态：{ session: { ...视图, history: RecordView[] }, running: RecordView[] }
      // —— history 嵌套在 session 内（P7.8 修复：此前误按顶层 detail.history 读取，
      // 恒 undefined → 有历史的会话主区也一直显示「本会话暂无问答」）
      const { ok, data } = await api<{
        session: SessionView & { history?: RecordView[]; token?: string; protocol_config?: any };
        running?: RecordView[];
      }>("/api/sessions/" + encodeURIComponent(sid));
      if (ok && data && data.session) {
        this.detail = { session: data.session, history: data.session.history || [], running: data.running || [] };
      } else this.detail = null;
      return ok;
    },
    async create(agentCode: string, name?: string) {
      const { ok, data } = await api<{ ok: boolean; session?: SessionView; detail?: string }>("/api/sessions", {
        body: { agent_code: agentCode, name: name || "" }
      });
      if (ok && data.session) {
        this.currentSid = data.session.id;
        await this.loadList();
        await this.open(data.session.id);
      }
      return { ok, detail: data.detail };
    },
    async rename(sid: string, name: string) {
      const r = await api("/api/sessions/" + encodeURIComponent(sid), { method: "PUT", body: { name } });
      if (r.ok) await this.loadList();
      return r;
    },
    async remove(sid: string) {
      const r = await api("/api/sessions/" + encodeURIComponent(sid), { method: "DELETE" });
      if (r.ok && this.currentSid === sid) {
        this.currentSid = null;
        this.detail = null;
      }
      if (r.ok) await this.loadList();
      return r;
    },
    async ask(sid: string, question: string) {
      return api<{ ok: boolean; qa_id?: string; detail?: string }>("/api/chat", {
        body: { session_id: sid, question }
      });
    },
    async cancel(qaId: string) {
      return api<{ ok: boolean; detail?: string }>("/api/cancel", { body: { id: qaId } });
    },
    async removeRecord(sid: string, qaId: string) {
      return api("/api/sessions/" + encodeURIComponent(sid) + "/history/" + encodeURIComponent(qaId), { method: "DELETE" });
    }
  }
});
