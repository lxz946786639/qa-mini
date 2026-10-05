"use strict";
// 推流音频「实时识别」监听任务（从旧 server.js 原样抽出）：
// /api/audio/listen（+/stop /+cancel）。对齐 EchoScribe 交互：
// start：每 LISTEN_POLL_MS 把「开始→当前」全段重提一次（段进行中中间识别），
//        SSE audio_listen {session_id, device, state:"partial", text, elapsed_s}；
// stop：  停止并做最后一次全段识别，返回定稿 {ok, text, elapsed_s}；
// cancel：丢弃（不做最终识别），广播 state:"cancelled"；
// 自动结束：设备流断开/无帧（state:"stream_stopped"）或满 LISTEN_MAX_S（state:"stopped"）。

const { AsrError, transcribe: asrTranscribe } = require("../../lib/asr");
const { QaError } = require("../../lib/sse");
const { parseJSONBody, sendJSON } = require("../middleware");

const LISTEN_POLL_MS = 2500;
const LISTEN_MAX_S = 120;

function createAudioListenService(ctx) {
  const audioStreams = ctx.audioStreams;
  const asrSection = () => {
    const a = ctx.config.asr;
    return a && typeof a === "object" && !Array.isArray(a) ? a : {};
  };
  const listenJobs = new Map(); // key: sid|device → { sid, device, startTs, text, timer, busy, errors, ac, stopped }
  function listenKey(sid, device) { return sid + "|" + device; }
  function stopListenJob(job, state, text) {
    if (!listenJobs.has(listenKey(job.sid, job.device)) || job.stopped) return;
    job.stopped = true;
    if (job.timer) { clearInterval(job.timer); job.timer = null; }
    if (job.ac) { try { job.ac.abort(); } catch {} job.ac = null; }
    listenJobs.delete(listenKey(job.sid, job.device));
    ctx.bus.emit("audio_listen", {
      session_id: job.sid, device: job.device, state,
      text: text == null ? "" : text,
      elapsed_s: Math.round((Date.now() - job.startTs) / 100) / 10
    });
  }
  async function listenTick(job) {
    if (job.busy) return; // 上一段在途：跳过本 tick（不排队，对齐前端 partialBusy 语义）
    if (!audioStreams.isLive(job.sid, job.device, 8000)) {
      stopListenJob(job, "stream_stopped", job.text); // 推流断开 → 自动结束（携带已识别文本）
      return;
    }
    const secs = (Date.now() - job.startTs) / 1000;
    if (secs >= LISTEN_MAX_S) { // 硬上限：停任务，定稿走 stopped 事件（前端用最后 partial）
      stopListenJob(job, "stopped", job.text);
      return;
    }
    if (secs < 0.5) return;
    job.busy = true;
    job.ac = new AbortController();
    try {
      const wav = audioStreams.captureWav(job.sid, job.device, Math.min(LISTEN_MAX_S, secs));
      if (!wav) return;
      const text = await asrTranscribe(wav, asrSection(), job.ac.signal);
      if (text && text.trim()) {
        job.text = text.trim();
        job.errors = 0;
        ctx.bus.emit("audio_listen", {
          session_id: job.sid, device: job.device, state: "partial",
          text: job.text, elapsed_s: Math.round((Date.now() - job.startTs) / 100) / 10
        });
      } else {
        job.errors++;
        if (job.errors >= 3) stopListenJob(job, "stream_stopped", job.text);
      }
    } catch (e) {
      if (job.ac && !job.ac.signal.aborted) {
        job.errors++;
        if (job.errors >= 3) stopListenJob(job, "stream_stopped", job.text);
      }
    } finally {
      job.busy = false;
      job.ac = null;
    }
  }
  async function resolveListenDevice(token, body) {
    // 鉴权 + 设备解析（与 capture 同语义：缺省 = preferred_device，唯一流自动用之）
    const session = ctx.manager.byToken(token);
    if (!session) return { err: [401, { ok: false, detail: "token 未知" }] };
    const ar = session.audio_remote || {};
    let device = typeof body.device === "string" ? body.device.trim() : "";
    if (!device && typeof ar.preferred_device === "string") device = ar.preferred_device.trim();
    if (!device) {
      const list = audioStreams.listStreams(session.id);
      if (list.length === 1) device = list[0].device;
      else if (!list.length) return { err: [409, { ok: false, detail: "该会话没有正在接收的音频设备（请先在 EchoScribe 开始推流）" }] };
      else return { err: [400, { ok: false, detail: "该会话有多个推流设备，请指定 device（" + list.map((x) => x.device).join(" / ") + "）" }] };
    }
    if (!audioStreams.isLive(session.id, device, 5000)) {
      return { err: [409, { ok: false, detail: "设备未在接收音频（最近 5s 无数据帧）: " + device }] };
    }
    return { session, device };
  }
  async function handleAudioListen(req, res) {
    let body;
    try { body = await parseJSONBody(req); } catch (e) {
      return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
    const r = await resolveListenDevice(token, body);
    if (r.err) return sendJSON(res, r.err[0], r.err[1]);
    const { session, device } = r;
    const a = asrSection();
    if (!String(a.url || "").trim()) return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（设置 → 语音输入）" });
    const key = listenKey(session.id, device);
    if (listenJobs.has(key)) return sendJSON(res, 409, { ok: false, detail: "该设备已有进行中的识别（先停止/取消）" });
    const job = { sid: session.id, device, startTs: Date.now(), text: "", timer: null, busy: false, errors: 0, ac: null };
    listenJobs.set(key, job);
    job.timer = setInterval(() => { listenTick(job); }, LISTEN_POLL_MS);
    listenTick(job); // 立即来一段（0.5s 音频即可出预览）
    return sendJSON(res, 200, { ok: true, session_id: session.id, device, state: "listening" });
  }
  async function handleAudioListenStop(req, res, cancel) {
    let body;
    try { body = await parseJSONBody(req); } catch (e) {
      return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
    const session = ctx.manager.byToken(token);
    if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
    const ar = session.audio_remote || {};
    let device = typeof body.device === "string" ? body.device.trim() : "";
    if (!device && typeof ar.preferred_device === "string") device = ar.preferred_device.trim();
    if (!device) {
      const list = audioStreams.listStreams(session.id);
      if (list.length === 1) device = list[0].device;
      else return sendJSON(res, 400, { ok: false, detail: "请指定 device" });
    }
    const key = listenKey(session.id, device);
    const job = listenJobs.get(key);
    if (!job) return sendJSON(res, 409, { ok: false, detail: "该设备没有进行中的识别" });
    let text = job.text || "";
    if (!cancel) {
      // 定稿：全段最后一次识别（比最后一次 partial 更完整/准确）
      try {
        const secs = (Date.now() - job.startTs) / 1000;
        const wav = secs >= 0.5 ? audioStreams.captureWav(session.id, device, Math.min(LISTEN_MAX_S, secs)) : null;
        if (wav) text = (await asrTranscribe(wav, asrSection(), new AbortController().signal)) || text;
      } catch (e) {
        // 定稿识别失败 → 回退最后 partial（不断流、不报错，与前端体验一致）
        if (!(e instanceof AsrError)) console.error("[audio-listen] 定稿识别失败:", e && e.message || e);
      }
      text = String(text || "").trim();
    }
    stopListenJob(job, cancel ? "cancelled" : "stopped", text);
    return sendJSON(res, 200, {
      ok: true,
      state: cancel ? "cancelled" : "stopped",
      text: cancel ? "" : text,
      elapsed_s: Math.round((Date.now() - job.startTs) / 100) / 10
    });
  }
  // 会话删除时清理其监听任务（与旧版 remove 路径一致）
  function stopForSession(sid) {
    for (const key of [...listenJobs.keys()]) {
      const job = listenJobs.get(key);
      if (job && job.sid === sid) stopListenJob(job, "cancelled", "");
    }
  }
  return { listenJobs, stopListenJob, stopForSession, handleAudioListen, handleAudioListenStop };
}

module.exports = { createAudioListenService, LISTEN_POLL_MS, LISTEN_MAX_S };
