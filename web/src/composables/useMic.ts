
// 语音输入（P5.5 移植自 public/app.js）：麦克风 → WAV 16-bit PCM → POST /api/asr
// 约束：getUserMedia/AudioWorklet 需安全上下文（https 或 127.0.0.1/localhost），
// 经 http 访问时禁用并在标题说明。硬上限 60s 自动送识别；<0.4s 丢弃；
// 1.5s 中间识别（前缀重提，忙则跳过、不排队，失败静默）；定稿 = 自动发送或填入输入框。
import { onBeforeUnmount, ref } from "vue";

const ASR_MAX_S = 60;
const ASR_MIN_S = 0.4;
const ASR_PARTIAL_S = 1.5;
const AUTOSEND_KEY = "echoanswer-asr-autosend";

function readAutosend(): boolean {
  try {
    const v = localStorage.getItem(AUTOSEND_KEY);
    return v === null ? true : v === "1";
  } catch { return true; }
}

// 16-bit PCM 单声道 WAV 封装（44 字节 RIFF 头）
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true);
  return new Uint8Array(buf);
}

export interface MicState {
  secure: boolean;
  recording: boolean;
  transcribing: boolean;
  timeLabel: string;
  interim: string;
  autosend: boolean;
}

export function useMic(opts: {
  onFinal: (text: string, detail: string) => void | Promise<void>;
  onToast: (msg: string) => void;
}) {
  const st = ref<MicState>({
    secure: !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    recording: false, transcribing: false, timeLabel: "0:00", interim: "", autosend: readAutosend()
  });
  let starting = false;
  let timer: number | null = null;
  let partialTimer: number | null = null;
  let t0 = 0;
  let stream: MediaStream | null = null;
  let actx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let srcNode: MediaStreamAudioSourceNode | null = null;
  let rate = 16000;
  let chunks: Int16Array[] = [];
  let partialSeq = 0;
  let partialBusy = false;

  function fmtMicTime(s: number): string {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return m + ":" + String(ss).padStart(2, "0");
  }
  function title(): string {
    if (!st.value.secure) return "麦克风需要 https 访问（当前为 http 地址或浏览器不支持）";
    if (st.value.transcribing) return "语音识别中…";
    if (st.value.recording) return "再点一次停止录音";
    return "语音输入：点击开始/停止录音，识别后填入输入框";
  }

  async function partialTick() {
    if (!st.value.recording || st.value.transcribing || partialBusy) return;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total < 800) return;
    partialBusy = true;
    const seq = ++partialSeq;
    try {
      const data = new Int16Array(total);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }
      const wav = encodeWav(data, rate);
      const resp = await fetch("/api/asr", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      const d: any = await resp.json().catch(() => ({}));
      if (resp.ok && d.ok && d.text && st.value.recording && seq === partialSeq) {
        st.value.interim = "…" + d.text;
      }
    } catch { /* 中间识别失败静默忽略 */ }
    finally { partialBusy = false; }
  }

  function cleanup() {
    if (timer) { clearInterval(timer); timer = null; }
    if (partialTimer) { clearInterval(partialTimer); partialTimer = null; }
    try { if (node) node.disconnect(); if (srcNode) srcNode.disconnect(); } catch { /* 已断 */ }
    if (actx) { try { actx.close(); } catch { /* 已关 */ } }
    if (stream) { for (const t of stream.getTracks()) t.stop(); }
    stream = null; actx = null; node = null; srcNode = null;
  }

  async function micStop() {
    if (!st.value.recording) return;
    st.value.recording = false;
    starting = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (partialTimer) { clearInterval(partialTimer); partialTimer = null; }
    partialSeq++; // 使在途中间结果作废
    const secs = (Date.now() - t0) / 1000;
    cleanup();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const took = chunks;
    chunks = [];
    st.value.timeLabel = "0:00";
    if (secs < ASR_MIN_S || total < 800) {
      opts.onToast("录音太短（<0.4 秒），未发送识别");
      st.value.interim = "";
      return;
    }
    const data = new Int16Array(total);
    let off = 0;
    for (const c of took) { data.set(c, off); off += c.length; }
    const wav = encodeWav(data, rate);
    st.value.transcribing = true;
    try {
      const resp = await fetch("/api/asr", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      const d: any = await resp.json().catch(() => ({}));
      if (resp.ok && d.ok) {
        await opts.onFinal(d.text || "", d.detail || "");
      } else {
        opts.onToast("语音识别失败: " + (d.detail || ("HTTP " + resp.status)));
      }
    } catch (e: any) {
      opts.onToast("语音识别失败: " + ((e && e.message) || e));
    } finally {
      st.value.transcribing = false;
      st.value.interim = "";
    }
  }

  async function micStart() {
    if (st.value.recording || st.value.transcribing || starting) return;
    starting = true;
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
      });
    } catch (e: any) {
      const denied = /NotAllowedError|Permission|SecurityError/i.test(String((e && e.name) || e));
      st.value.secure = false; // 权限拒绝后保持禁用
      opts.onToast(denied ? "麦克风权限被拒绝（浏览器设置 → 网站设置 → 麦克风）" : "无法访问麦克风: " + ((e && e.message) || e));
      starting = false;
      return;
    }
    const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx({ sampleRate: 16000 });
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* 忽略 */ } }
    const workletCode = [
      "class MicCapture extends AudioWorkletProcessor {",
      "  process(inputs) {",
      "    const ch = inputs[0] && inputs[0][0];",
      "    if (ch) {",
      "      const i16 = new Int16Array(ch.length);",
      "      for (let i = 0; i < ch.length; i++) { const s = Math.max(-1, Math.min(1, ch[i])); i16[i] = s < 0 ? s * 32768 : s * 32767; }",
      "      this.port.postMessage(i16.buffer, [i16.buffer]);",
      "    }",
      "    return true;",
      "  }",
      "}",
      "registerProcessor('mic-capture', MicCapture);"
    ].join("\n");
    try {
      const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);
    } catch (e: any) {
      try { ctx.close(); } catch { /* 已关 */ }
      for (const t of s.getTracks()) t.stop();
      opts.onToast("音频采集初始化失败: " + ((e && e.message) || e));
      starting = false;
      return;
    }
    stream = s; actx = ctx;
    rate = ctx.sampleRate || 16000;
    chunks = [];
    partialSeq = 0; partialBusy = false;
    st.value.interim = "";
    srcNode = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "mic-capture");
    node.port.onmessage = (ev: MessageEvent) => { if (ev.data) chunks.push(new Int16Array(ev.data)); };
    srcNode.connect(node);
    node.connect(ctx.destination); // worklet 输出静音，连 destination 保证处理循环运行
    st.value.recording = true;
    t0 = Date.now();
    st.value.timeLabel = fmtMicTime(0);
    timer = window.setInterval(() => {
      const s2 = (Date.now() - t0) / 1000;
      if (s2 >= ASR_MAX_S) {
        if (timer) { clearInterval(timer); timer = null; }
        micStop();
        return;
      }
      if (st.value.recording) st.value.timeLabel = fmtMicTime(s2);
    }, 500);
    partialTimer = window.setInterval(partialTick, ASR_PARTIAL_S * 1000);
    starting = false;
  }

  // 点击切换：录音中 → 停止送识别；否则 → 开始
  async function toggle() {
    if (!st.value.secure) {
      opts.onToast("麦克风需要 https 访问（当前为 http 地址或浏览器不支持）");
      return;
    }
    if (st.value.recording) { await micStop(); return; }
    await micStart();
  }

  // 强制停止（如组件卸载/切会话）；不送识别
  function stopAll() {
    if (st.value.recording) {
      st.value.recording = false;
      starting = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (partialTimer) { clearInterval(partialTimer); partialTimer = null; }
      partialSeq++;
      cleanup();
      chunks = [];
      st.value.timeLabel = "0:00";
      st.value.interim = "";
    }
  }

  onBeforeUnmount(stopAll);

  return { st, title, toggle, stopAll };
}
