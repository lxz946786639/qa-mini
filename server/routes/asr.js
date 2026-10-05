"use strict";
// 语音输入：/api/asr（浏览器录 WAV → 转发 ASR 服务 · 查看级）
// /api/asr/test（测试连接 · 管理级）
const { sendJSON, readRawBody, parseJSONBody } = require("../middleware");
const { AsrError, transcribe: asrTranscribe, asrProbe } = require("../../lib/asr");

const ASR_MAX_BYTES = 10 * 1024 * 1024;

function register(router, ctx) {
  const asrSection = () => {
    const a = ctx.config.asr;
    return a && typeof a === "object" && !Array.isArray(a) ? a : {};
  };
  router.exact("POST", "/api/asr", async (req, res, ctx_, urlObj) => {
    if (!ctx.auth.viewerOk(req, urlObj)) return sendJSON(res, 403, { ok: false, detail: "需要访问码" });
    const a = asrSection();
    const url = String(a.url || "").trim();
    if (!url) return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（设置 → 语音输入）" });
    let wav;
    try {
      wav = await readRawBody(req, ASR_MAX_BYTES);
    } catch (e) {
      return sendJSON(res, /过大/.test(e.message || "") ? 413 : 400, { ok: false, detail: e.message || String(e) });
    }
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 WAV 音频（16-bit PCM）" });
    }
    const t0 = Date.now();
    // 客户端断开检测（Node 惯用法：res "close" 且尚未写完 → 断开；req.signal 在
    // 请求体读完后即 aborted，不能用作断开检测）→ 中止对 ASR 的上游推理
    const ac = new AbortController();
    const onClientClose = () => { if (!res.writableFinished) ac.abort(); };
    res.on("close", onClientClose);
    try {
      const text = await asrTranscribe(wav, a, ac.signal);
      return sendJSON(res, 200, {
        ok: true,
        text,
        detail: text ? "" : "（无声/无法识别）",
        duration_s: Math.round((Date.now() - t0) / 100) / 10
      });
    } catch (e) {
      const msg = e instanceof AsrError ? e.message : ("识别请求异常: " + (e && e.message || e));
      return sendJSON(res, 502, { ok: false, detail: "语音识别失败: " + msg });
    } finally {
      res.off("close", onClientClose);
    }
  });
  // /api/asr/test（管理）：body 可带 { asr: {...} } 表单草稿（草稿值探测，未传用已存配置）
  router.exact("POST", "/api/asr/test", async (req, res, ctx_, urlObj) => {
    if (!ctx.auth.isAdmin(req, urlObj)) return sendJSON(res, 401, { ok: false, detail: "需要管理权限" });
    let body = {};
    try { body = await parseJSONBody(req); } catch { body = {}; }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(res, 400, { ok: false, detail: "请求体必须是 JSON 对象" });
    }
    const draft = body.asr;
    const a = { ...asrSection() };
    if (draft && typeof draft === "object" && !Array.isArray(draft)) {
      for (const k of ["url", "api_key", "model", "language"]) {
        if (typeof draft[k] === "string") a[k] = draft[k].trim();
      }
      if (draft.timeout !== undefined && draft.timeout !== "") a.timeout = draft.timeout;
    }
    const url2 = String(a.url || "").trim();
    if (!url2) return sendJSON(res, 400, { ok: false, detail: "ASR 未配置（请填写接口基址）" });
    let probe;
    try {
      probe = await asrProbe(a);
    } catch (e) {
      return sendJSON(res, 502, { ok: false, detail: e instanceof AsrError ? e.message : String(e && e.message || e) });
    }
    const model = String(a.model || "").trim();
    if (model && !probe.models.includes(model)) {
      return sendJSON(res, 200, {
        ok: false,
        detail: "模型不在服务列表（服务提供: " + (probe.models.length ? probe.models.join(", ") : "无") + "）",
        models: probe.models
      });
    }
    return sendJSON(res, 200, {
      ok: true,
      detail: "已连接" + (probe.models.length ? "（模型: " + probe.models.join(", ") + "）" : ""),
      health: probe.health,
      models: probe.models
    });
  });
}
module.exports = { register };
