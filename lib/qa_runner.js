"use strict";
// QA 编排（多会话版）：
//  - QaRunner：每会话一个实例，负责该会话的问答流 / 历史 / 取消 / 后端会话状态。
//    所有广播载荷都带 session_id —— 同一会话在多个浏览器同时实时输出。
//  - SessionManager：会话列表（创建/改名/换协议/删除/重置）+ runner 路由 + 列表广播。
//  - 历史环形缓冲：每会话最近 100 条（新→旧），随 data/sessions.json 持久化。

const crypto = require("crypto");
const { QaError, CancelledError } = require("./sse");
const { streamOpenAI } = require("./protocols/openai");
const { streamDify, buildQuery } = require("./protocols/dify");
const { streamGeneric, buildGenericBody } = require("./protocols/generic");
const { streamRagflow } = require("./protocols/ragflow");
const { PROTOCOLS, sessionView, newSession, generateToken, generateSessionId, resolveProtocolConfig, sanitizeProtocolConfig } = require("./config");

// 界面显示名（技术名称对外隐藏：dify→编排引擎，ragflow→知识引擎；协议 key 不变）
const PROTOCOL_NAMES = {
  openai: "OpenAI 兼容",
  dify: "编排引擎",
  generic: "第三方通用",
  ragflow: "知识引擎"
};

const HISTORY_MAX = 100;

// 生成时长（秒，1 位小数）：finished_at - started_at（均为服务端时间，无时钟偏差）
function durationS(rec) {
  if (!rec || !rec.started_at || !rec.finished_at) return null;
  const ms = Date.parse(rec.finished_at) - Date.parse(rec.started_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 100) / 10;
}

// 对外视图：附加 duration_s（历史/在途/done 事件统一）
function recView(rec) {
  return Object.assign({}, rec, { duration_s: durationS(rec) });
}

class QaRunner {
  constructor({ sessionId, session, getConfig, persist, broadcast, onActivity }) {
    this.sessionId = sessionId;
    this.session = session; // 会话对象引用：dify/ragflow 状态与 history 直接读写
    this.getConfig = getConfig; // () => cfg
    this.persist = persist; // () => 持久化会话列表
    this.broadcast = broadcast; // (event, payload) => void
    this.onActivity = onActivity || null; // 问答开始/结束时回调（广播会话列表）
    this.active = new Map(); // id -> { record, ctrl, cancelled }
  }

  activeCount() { return this.active.size; }
  activeIds() { return [...this.active.keys()]; }
  activeLatest() {
    const ids = this.activeIds();
    return ids.length ? ids[ids.length - 1] : null;
  }
  activeRecords() {
    const out = [];
    for (const item of this.active.values()) out.push(item.record);
    return out;
  }

  // 对应 EchoScribe 的「清空」：重置本会话后端对话（dify conversation / ragflow session）。
  // 先取消在途问答：否则其流式回传稍后把旧会话 ID 经 onMeta 写回，
  // 抵消重置 → 下次提问仍续接旧上下文（用户感知「重置没生效」）。
  reset() {
    this.cancelAll();
    this.session.dify_conversation_id = "";
    this.session.ragflow_session_id = "";
    this.session.updated_at = new Date().toISOString();
    this.persist();
    this.broadcast("session_reset", { session_id: this.sessionId });
    if (this.onActivity) this.onActivity();
  }

  cancel(id) {
    const item = this.active.get(id);
    if (!item) return false;
    item.cancelled = true;
    item.ctrl.abort();
    return true;
  }

  cancelAll() {
    for (const id of this.activeIds()) this.cancel(id);
  }

  /**
   * 发起一次问答。校验失败抛 QaError(0, detail)（调用方转 4xx）。
   * 返回 { id, promise }：id 同步可用（推送接口立即回 202）。
   */
  start(opts) {
    const cfg = this.getConfig();
    const question = String(opts.question || "").trim();
    if (!question) throw new QaError(0, "问题为空");
    const protocol = opts.protocol || this.session.protocol;
    if (!protocol || !PROTOCOLS.includes(protocol)) {
      throw new QaError(0, "未指定或未知协议: " + protocol);
    }
    // 会话级协议配置覆盖全局（留空回退全局默认，见 config.resolveProtocolConfig）
    const pcfg = resolveProtocolConfig(this.session, cfg, protocol);
    // P8.43: 全局协议停用 → 拒绝提问（智能体管理端同步标注「已停用」）
    if (pcfg.enabled === false) {
      throw new QaError(0, "协议「" + (PROTOCOL_NAMES[protocol] || protocol) + "」已停用，请联系管理员在「系统设置 → 协议全局默认」启用");
    }
    // 前置校验（对应 EchoScribe 发送按钮层校验）
    if (protocol === "dify" && !(pcfg.api_key || "").trim()) {
      throw new QaError(0, "未配置 API Key（编排引擎应用密钥）");
    }
    if (protocol === "ragflow" && !(pcfg.api_key || "").trim()) {
      throw new QaError(0, "未配置 API Key（知识引擎 API 密钥）");
    }
    if (protocol === "ragflow" && !(pcfg.chat_id || "").trim()) {
      throw new QaError(0, "未配置知识引擎 Chat ID");
    }
    if (protocol === "generic") {
      buildGenericBody(pcfg.body, question, opts.context || ""); // 非法模板在此拦截
    }

    if (opts.newSession) {
      this.session.dify_conversation_id = "";
      this.session.ragflow_session_id = "";
    }

    const id = crypto.randomBytes(6).toString("hex");
    const ctrl = new AbortController();
    const record = {
      id,
      session_id: this.sessionId,
      source: opts.source || "web",
      protocol,
      protocol_name: PROTOCOL_NAMES[protocol],
      question,
      answer: "",
      status: "running",
      ok: false,
      detail: "",
      started_at: new Date().toISOString()
    };
    const item = { record, ctrl, cancelled: false };
    this.active.set(id, item);
    this.broadcast("qa_start", {
      session_id: this.sessionId,
      id,
      source: record.source,
      protocol,
      protocol_name: record.protocol_name,
      question
    });
    if (this.onActivity) this.onActivity();
    const promise = this._execute(id, item, opts, pcfg);
    return { id, promise };
  }

  async _execute(id, item, opts, pcfg) {
    const { record, ctrl } = item;
    const protocol = record.protocol;
    const question = record.question;
    const context = String(opts.context || "");

    const onMeta = (m) => {
      if (item.cancelled) return; // 已重置/取消：不再把旧会话 ID 写回会话
      let changed = false;
      if (m.conversation_id && m.conversation_id !== this.session.dify_conversation_id) {
        this.session.dify_conversation_id = m.conversation_id;
        changed = true;
      }
      if (m.session_id && m.session_id !== this.session.ragflow_session_id) {
        this.session.ragflow_session_id = m.session_id;
        changed = true;
      }
      if (changed) this.persist();
    };

    let stream;
    if (protocol === "dify") {
      stream = streamDify(pcfg, buildQuery(question, context), {
        conversationId: this.session.dify_conversation_id,
        signal: ctrl.signal,
        onMeta
      });
    } else if (protocol === "ragflow") {
      stream = streamRagflow(pcfg, buildQuery(question, context), {
        sessionId: this.session.ragflow_session_id,
        signal: ctrl.signal,
        onMeta
      });
    } else if (protocol === "generic") {
      stream = streamGeneric(pcfg, question, { context, signal: ctrl.signal });
    } else {
      stream = streamOpenAI(pcfg, question, { context, signal: ctrl.signal });
    }

    try {
      for await (const delta of stream) {
        if (ctrl.signal.aborted) break;
        record.answer += delta;
        this.broadcast("delta", { session_id: this.sessionId, id, text: delta });
      }
      if (ctrl.signal.aborted) {
        record.ok = false;
        record.detail = item.cancelled ? "已取消" : "已取消（客户端断开）";
      } else if (!record.answer) {
        record.ok = true;
        record.detail = "完成（空回答）";
      } else {
        record.ok = true;
        record.detail = "完成（" + countCJK(record.answer) + " 字）";
      }
    } catch (e) {
      record.ok = false;
      if (e instanceof CancelledError) {
        record.detail = item.cancelled ? "已取消" : "已取消（客户端断开）";
      } else if (e instanceof QaError) {
        record.detail = "请求失败: " + e.detail + (e.status ? " (HTTP " + e.status + ")" : "");
      } else {
        record.detail = "请求失败: " + (e && e.message ? e.message : String(e));
      }
    }

    record.status = "done";
    record.finished_at = new Date().toISOString();
    this.active.delete(id);
    this.session.history.unshift(record);
    if (this.session.history.length > HISTORY_MAX) this.session.history.length = HISTORY_MAX;
    this.session.updated_at = record.finished_at;
    this.persist();
    this.broadcast("done", Object.assign({ session_id: this.sessionId, id, ok: record.ok, detail: record.detail }, { duration_s: durationS(record) }));
    if (this.onActivity) this.onActivity();
    return record;
  }
}

class SessionManager {
  constructor({ getConfig, getSessions, saveAll, broadcast }) {
    this.getConfig = getConfig; // () => cfg
    this.getSessions = getSessions; // () => [session 对象]
    this.saveAll = saveAll; // () => 持久化整个会话列表
    this.broadcast = broadcast;
    this.runners = new Map(); // sid -> QaRunner
  }

  sessionById(id) {
    return this.getSessions().find((s) => s.id === id) || null;
  }

  byToken(token) {
    return this.getSessions().find((s) => s.token && s.token === token) || null;
  }

  runnerFor(session) {
    let r = this.runners.get(session.id);
    if (!r) {
      r = new QaRunner({
        sessionId: session.id,
        session,
        getConfig: this.getConfig,
        persist: () => this.saveAll(),
        broadcast: this.broadcast,
        onActivity: () => this.broadcastSessions()
      });
      this.runners.set(session.id, r);
    }
    return r;
  }

  list(includeToken, includeUser) {
    // 按最新对话时间倒序（updated_at：提问/完成/重置/删记录均刷新），同时间按创建时间倒序
    const arr = [...this.getSessions()].sort(
      (a, b) =>
        String(b.updated_at || "").localeCompare(String(a.updated_at || "")) ||
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );
    return arr.map((s) => {
      const r = this.runners.get(s.id);
      return sessionView(s, r ? r.activeCount() : 0, includeToken, includeUser);
    });
  }

  full(id, includeToken) {
    const s = this.sessionById(id);
    if (!s) return null;
    const r = this.runners.get(id);
    const session = Object.assign({}, s, { history: (s.history || []).map(recView) });
    if (!includeToken) {
      delete session.token;
      delete session.protocol_config;
    }
    return {
      session,
      running: (r ? r.activeRecords() : []).map(recView)
    };
  }

  create(opts) {
    const arr = this.getSessions();
    const taken = new Set(arr.map((s) => s.id));
    const s = newSession(opts);
    if (taken.has(s.id)) s.id = generateSessionId(taken);
    arr.push(s);
    this.saveAll();
    this.broadcastSessions();
    return s;
  }

  update(id, patch) {
    const s = this.sessionById(id);
    if (!s) return null;
    // 变更前的生效协议配置（用于判断后端上下文是否失效）
    const cfg = this.getConfig();
    const protoBefore = s.protocol;
    const mergedBefore = resolveProtocolConfig(s, cfg, protoBefore);
    if (typeof patch.name === "string" && patch.name.trim()) s.name = patch.name.trim().slice(0, 40);
    if (patch.protocol && PROTOCOLS.includes(patch.protocol)) s.protocol = patch.protocol;
    if (typeof patch.continue_session === "boolean") s.continue_session = patch.continue_session;
    if (patch.protocol_config !== undefined) {
      // 按协议 key 合并：只覆盖提交中出现的协议，其余协议的会话保留不变；
      // 提交 {} = 清除该协议全部会话覆盖（回退全局默认）
      const sc = sanitizeProtocolConfig(patch.protocol_config);
      if (sc) {
        if (!s.protocol_config || typeof s.protocol_config !== "object") s.protocol_config = {};
        for (const [proto, fields] of Object.entries(sc)) s.protocol_config[proto] = fields;
      }
    }
    if (patch.audio_remote !== undefined) {
      // 电脑输出音频接收：{ enabled: 布尔, preferred_device: ≤128 字符字符串 }
      // 非对象忽略；仅接受已知字段（enabled 必须布尔，preferred_device 必须字符串）
      const ar = patch.audio_remote;
      if (ar && typeof ar === "object" && !Array.isArray(ar)) {
        const cur = s.audio_remote && typeof s.audio_remote === "object"
          ? s.audio_remote
          : { enabled: false, preferred_device: "" };
        const next = Object.assign({}, cur);
        if (typeof ar.enabled === "boolean") next.enabled = ar.enabled;
        if (typeof ar.preferred_device === "string") next.preferred_device = ar.preferred_device.trim().slice(0, 128);
        s.audio_remote = next;
      }
    }
    // 协议切换或生效配置（url/api_key/chat_id 等）变化 → 已保存的后端会话状态
    // （ragflow_session_id / dify_conversation_id）属于旧配置，必须清空：
    // 下次提问按新配置建新会话（否则 RAGFlow 回「Session does not belong to this chat!」）
    if (s.protocol !== protoBefore) {
      s.dify_conversation_id = "";
      s.ragflow_session_id = "";
    } else {
      const mergedAfter = resolveProtocolConfig(s, cfg, s.protocol);
      const sameStr = (a, b) => String(a || "") === String(b || "");
      if (s.protocol === "ragflow" &&
          (!sameStr(mergedBefore.url, mergedAfter.url) || !sameStr(mergedBefore.api_key, mergedAfter.api_key) || !sameStr(mergedBefore.chat_id, mergedAfter.chat_id))) {
        s.ragflow_session_id = "";
      }
      if (s.protocol === "dify" &&
          (!sameStr(mergedBefore.url, mergedAfter.url) || !sameStr(mergedBefore.api_key, mergedAfter.api_key))) {
        s.dify_conversation_id = "";
      }
    }
    if (patch.regenerate_token === true) s.token = generateToken();
    s.updated_at = new Date().toISOString();
    this.saveAll();
    this.broadcastSessions();
    return s;
  }

  // 外部直接修改会话对象后调用（如全局配置变更导致后端会话状态失效）
  save() {
    this.saveAll();
    this.broadcastSessions();
  }

  remove(id) {
    const arr = this.getSessions();
    const idx = arr.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    const r = this.runners.get(id);
    if (r) r.cancelAll();
    this.runners.delete(id);
    arr.splice(idx, 1);
    if (!arr.length) {
      // 至少保留一个会话
      arr.push(newSession({ name: "默认会话" }));
    }
    this.saveAll();
    this.broadcastSessions();
    return true;
  }

  reset(id) {
    const s = this.sessionById(id);
    if (!s) return false;
    this.runnerFor(s).reset();
    return true;
  }

  // 删除单条历史记录（广播 record_removed，多端同步移除）
  removeRecord(id, qaId) {
    const s = this.sessionById(id);
    if (!s) return false;
    const idx = (s.history || []).findIndex((r) => r.id === qaId);
    if (idx < 0) return false;
    s.history.splice(idx, 1);
    s.updated_at = new Date().toISOString();
    this.saveAll();
    this.broadcast("record_removed", { session_id: id, id: qaId });
    this.broadcastSessions();
    return true;
  }

  resetAll() {
    for (const s of this.getSessions()) this.runnerFor(s).reset();
  }

  cancelAny(id) {
    for (const r of this.runners.values()) if (r.cancel(id)) return true;
    return false;
  }

  activeIds() {
    const out = [];
    for (const r of this.runners.values()) for (const x of r.activeIds()) out.push(x);
    return out;
  }

  // 全部会话历史合并（新→旧），供 /api/history
  mergedHistory() {
    const all = [];
    for (const s of this.getSessions()) {
      for (const rec of s.history || []) all.push(rec);
    }
    all.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
    return all.map(recView);
  }

  broadcastSessions() {
    this.broadcast("sessions", { sessions: this.list() });
  }
}

// 统计中文字数（CJK 统一表意文字；不含标点/字母/数字/空白）
function countCJK(text) {
  let n = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) n++;
  }
  return n;
}

module.exports = { QaRunner, SessionManager, PROTOCOL_NAMES, HISTORY_MAX, countCJK };
