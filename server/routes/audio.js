"use strict";
// 电脑输出音频（EchoScribe 持续推流）：
//  POST /api/audio/stream   长连接推流（凭据 = X-Audio-Token，handler 内校验）
//  POST /api/audio/capture  截取最近 N 秒 → ASR → 自动提问（凭据 = body.token）
//  POST /api/audio/listen(+stop/cancel)  实时识别（凭据 = body.token）
//  GET  /api/audio/stream   该会话正在接收的设备列表（凭据 = ?token=）
const { sendJSON, parseJSONBody } = require("../middleware");
const { AsrError, transcribe: asrTranscribe } = require("../../lib/asr");
const { QaError } = require("../../lib/sse");
const { createFrameParser } = require("../../lib/audio_stream");

function register(router, ctx) {
  const asrSection = () => {
    const a = ctx.config.asr;
    return a && typeof a === "object" && !Array.isArray(a) ? a : {};
  };

  // ---- POST /api/audio/stream：电脑输出音频推流（长连接 · chunked POST）----
  // 头：X-Audio-Token（会话推送 token，与 /api/push 同源鉴权）+ X-Device-Name（URL 编码输出设备名）
  // 体：[u32BE len][Deflate(PCM16LE 16kHz 单声道)] 帧流（EchoScribe 每 200ms 一帧）
  // 响应语义（关键）：前置校验错误（401/403/409）仅凭请求头即时响应；
  // 成功路径必须在收完整体后回 200——nginx（proxy_request_buffering off）在上游
  // 响应完成时会截断客户端未发完的 body（实测：提前 200 导致后续帧全部丢失，
  // 详见 doc/03 §8），因此 200 携带流结束时的统计摘要 {bytes, frames}。
  // 流进行中的实时反馈走 SSE audio_stream 事件（started/data/stopped，均带 session_id）。
  // 客户端正常停止 = 结束 chunked 体（req "end"）；断网/崩溃 = socket "close" → 自动清理。
  // 协议违例（单帧超限 / 解压失败）→ 400，仅断开该设备流，不影响同会话其他流。
  router.exact("POST", "/api/audio/stream", async (req, res) => {
    const token = String(req.headers["x-audio-token"] || "").trim();
    if (!token) return sendJSON(res, 401, { ok: false, detail: "缺少 X-Audio-Token 头" });
    const session = ctx.manager.byToken(token);
    if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
    if (!(session.audio_remote && session.audio_remote.enabled === true)) {
      return sendJSON(res, 403, { ok: false, detail: "该会话未启用输出音频接收（会话设置 → 电脑输出音频 → 启用）" });
    }
    let device = String(req.headers["x-device-name"] || "").trim();
    try {
      device = decodeURIComponent(device);
    } catch {
      device = String(req.headers["x-device-name"] || "").trim();
    }
    if (!device) device = "unknown-device";
    if (device.length > 128) device = device.slice(0, 128);

    const started = ctx.audioStreams.startStream(session.id, device);
    if (!started.ok) return sendJSON(res, 409, { ok: false, detail: started.error });

    const parser = createFrameParser((pcm) => {
      if (!ctx.audioStreams.feed(session.id, device, pcm)) {
        // 流已被空闲清理/会话删除：停止继续读体
        req.destroy();
      }
    });
    let finished = false;
    let protoErr = null;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (err) protoErr = err;
      const entry = (ctx.audioStreams.listStreams(session.id) || []).find((s) => s.device === device);
      const bytes = entry ? entry.bytes : 0;
      const frames = entry ? entry.frames : 0;
      ctx.audioStreams.stopStream(session.id, device); // SSE audio_stream stopped（幂等）
      if (!res.headersSent) {
        try {
          sendJSON(res, protoErr ? 400 : 200, protoErr
            ? { ok: false, detail: "帧格式错误: " + protoErr }
            : { ok: true, stream: "stopped", session_id: session.id, device, bytes, frames });
        } catch {
          // 连接已断开，响应不可达——不影响清理
        }
      }
      if (!req.readableEnded) {
        try { req.destroy(); } catch {}
      }
    };
    req.on("end", () => finish());
    req.on("error", (e) => {
      console.error("[audio-stream] 读取异常 " + session.id + "/" + device + ": " + (e && e.message || e));
      finish();
    });
    req.on("close", () => { if (!req.readableEnded) finish(); });
    try {
      for await (const chunk of req) {
        if (finished) break;
        try {
          parser.push(chunk);
        } catch (e) {
          if (e && e.protocol) {
            console.error("[audio-stream] 协议违例，断开 " + session.id + "/" + device + ": " + e.message);
            finish(e.message);
          } else {
            console.error("[audio-stream] 读取异常 " + session.id + "/" + device + ": " + (e && e.message || e));
            finish();
          }
          break;
        }
      }
    } catch {
      // 连接已断开（req.destroy 等）——按结束处理
    }
    finish();
  });

  // ---- POST /api/audio/capture：截取最近 N 秒推流 → ASR → 自动提问（source=remote_audio）----
  router.exact("POST", "/api/audio/capture", async (req, res) => {
    let body;
    try {
      body = await parseJSONBody(req);
    } catch (e) {
      return sendJSON(res, 400, { ok: false, detail: e.__badBody ? e.message : String(e.message || e) });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
    const session = ctx.manager.byToken(token);
    if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });

    const scfg = ctx.audioStreams.cfg();
    let seconds = Number(body.seconds);
    if (!Number.isFinite(seconds)) seconds = scfg.default_capture_s;
    if (!Number.isFinite(seconds) || seconds < scfg.min_capture_s || seconds > scfg.max_capture_s) {
      return sendJSON(res, 400, {
        ok: false,
        detail: "seconds 须在 " + scfg.min_capture_s + "-" + scfg.max_capture_s + " 之间（当前 " + seconds + "）"
      });
    }
    const ar = session.audio_remote || {};
    let device = typeof body.device === "string" ? body.device.trim() : "";
    if (!device && typeof ar.preferred_device === "string") device = ar.preferred_device.trim();
    if (!device) {
      const list = ctx.audioStreams.listStreams(session.id);
      if (list.length === 1) device = list[0].device;
      else if (!list.length) return sendJSON(res, 409, { ok: false, detail: "该会话没有正在接收的音频设备（请先开始推流）" });
      else return sendJSON(res, 400, { ok: false, detail: "该会话有多个推流设备，请指定 device（" + list.map((x) => x.device).join(" / ") + "）" });
    }
    if (!ctx.audioStreams.isLive(session.id, device, 5000)) {
      return sendJSON(res, 409, { ok: false, detail: "设备未在接收音频（最近 5s 无数据帧）: " + device });
    }
    const a = asrSection();
    if (!String(a.url || "").trim()) {
      return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（设置 → 语音输入）" });
    }
    const wav = ctx.audioStreams.captureWav(session.id, device, seconds);
    if (!wav) return sendJSON(res, 409, { ok: false, detail: "环形缓冲中无音频数据" });

    const t0 = Date.now();
    let text;
    try {
      text = await asrTranscribe(wav, a, new AbortController().signal);
    } catch (e2) {
      const msg = e2 instanceof AsrError ? e2.message : ("识别请求异常: " + (e2 && e2.message || e2));
      return sendJSON(res, 502, { ok: false, detail: "语音识别失败: " + msg });
    }
    if (!text || !text.trim()) {
      return sendJSON(res, 422, { ok: false, detail: "（无声/无法识别）", text: "" });
    }
    text = text.trim();
    let started;
    try {
      started = ctx.manager.runnerFor(session).start({
        question: text,
        source: "remote_audio",
        newSession: !session.continue_session
      });
    } catch (e3) {
      return sendJSON(res, 400, { ok: false, detail: e3 instanceof QaError ? e3.detail : String(e3.message || e3) });
    }
    return sendJSON(res, 200, {
      ok: true,
      text,
      qa_id: started.id,
      session_id: session.id,
      device,
      duration_s: Math.round((Date.now() - t0) / 100) / 10
    });
  });

  // ---- 实时识别：开始 / 停止（定稿）/ 取消（丢弃）----
  router.exact("POST", "/api/audio/listen", (req, res) => ctx.listen.handleAudioListen(req, res));
  router.exact("POST", "/api/audio/listen/stop", (req, res) => ctx.listen.handleAudioListenStop(req, res, false));
  router.exact("POST", "/api/audio/listen/cancel", (req, res) => ctx.listen.handleAudioListenStop(req, res, true));

  // ---- GET /api/audio/stream?token=：该会话正在接收的设备列表（抽屉实时刷新用）----
  router.exact("GET", "/api/audio/stream", (req, res, ctx_, urlObj) => {
    const token = (urlObj.searchParams.get("token") || "").trim();
    if (!token) return sendJSON(res, 401, { ok: false, detail: "token 必填" });
    const session = ctx.manager.byToken(token);
    if (!session) return sendJSON(res, 401, { ok: false, detail: "token 未知" });
    return sendJSON(res, 200, {
      ok: true,
      session_id: session.id,
      enabled: Boolean(session.audio_remote && session.audio_remote.enabled),
      streams: ctx.audioStreams.listStreams(session.id)
    });
  });
}
module.exports = { register };
