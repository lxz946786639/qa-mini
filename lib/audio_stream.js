"use strict";
// 电脑输出音频流式接收（EchoScribe「持续推流」模式）：
//  - 帧协议：[u32BE payload_len][payload]，payload = Deflate(PCM16LE 16kHz 单声道)
//    （Deflate 为 zlib 包装格式：Python zlib.compress / Node zlib.inflateSync 互通）
//  - 正常帧 = 200ms 音频 = 6400B 原始 PCM；实际传输约 8-16KB/s
//  - 每「会话 × 设备」一份环形缓冲（audio_stream.max_buffer_s，默认 120s ≈ 3.8MB），
//    capture 时取尾部 N 秒组 WAV → 复用 lib/asr.js transcribe() → 自动提问（source=remote_audio）
//  - 全部 SSE 事件带 session_id（红线）；data 事件 1s 节流
//  - 无帧超时（audio_stream.idle_clean_s，默认 60s）→ 自动移除该设备流
//    （客户端断线/停止后的兜底清理；正常推送时 EchoScribe 静默期也发全零
//     占位帧，实际不会触发）

const zlib = require("zlib");

const RATE = 16000;                 // 固定 16kHz（与网页麦克风/ASR 同采样率）
const BYTES_PER_SEC = RATE * 2;      // PCM16 单声道 = 32KB/s
const FRAME_MAX = 1024 * 1024;       // 单帧上限（压缩后 len 与解压后 PCM 各限 1MB，协议违例阈值）
const IDLE_CLEAN_MS = 60 * 1000;     // 空闲清理默认值：60s 无帧移除（可被 config.audio_stream.idle_clean_s 覆盖）
const MAX_DEVICES_PER_SESSION = 8;   // 每会话设备流上限（防滥用）
const DATA_EMIT_MS = 1000;           // SSE data 事件节流

const DEFAULTS_STREAM = {
  max_buffer_s: 120,
  min_capture_s: 5,
  default_capture_s: 30,
  max_capture_s: 60,
  idle_clean_s: 60
};

function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 44 字节标准 WAV 头（16k / 16bit / mono）
function buildWav(pcm16) {
  const dataLen = pcm16.length;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);      // fmt chunk size
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // 单声道
  buf.writeUInt32LE(RATE, 24);    // 采样率
  buf.writeUInt32LE(RATE * 2, 28);// byte rate
  buf.writeUInt16LE(2, 32);       // block align
  buf.writeUInt16LE(16, 34);      // 位深
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  pcm16.copy(buf, 44);
  return buf;
}

// 帧协议解析器：喂请求体字节流，逐帧抽出 [u32BE len][Deflate(PCM16)] 并解压，
// 每帧回调 onFrame(pcmBuf)。协议违例（len 超限 / 解压失败 / PCM 字节数为奇数）
// 抛出带 protocol=true 的 Error（调用方断开该流，不影响同会话其他流）。
function createFrameParser(onFrame) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 4) {
        const len = pending.readUInt32BE(0);
        if (len > FRAME_MAX) {
          const e = new Error("单帧过大: " + len + " 字节（上限 " + FRAME_MAX + "）");
          e.protocol = true;
          throw e;
        }
        if (pending.length < 4 + len) break; // 等后续字节
        const payload = pending.subarray(4, 4 + len);
        pending = pending.subarray(4 + len);
        let pcm;
        try {
          pcm = zlib.inflateSync(payload);
        } catch (e2) {
          const e = new Error("帧解压失败: " + (e2 && e2.message || e2));
          e.protocol = true;
          throw e;
        }
        if (pcm.length === 0 || (pcm.length & 1) === 1 || pcm.length > FRAME_MAX) {
          const e = new Error("帧数据非法（须为 1-1MB 偶数字节的 PCM16）");
          e.protocol = true;
          throw e;
        }
        onFrame(pcm);
      }
      return pending;
    }
  };
}

class AudioStreamManager {
  constructor({ getConfig, broadcast }) {
    this.getConfig = getConfig;
    this.broadcast = broadcast;
    this.streams = new Map(); // sid -> Map(device -> st)
    this._lastDataEmit = new Map(); // sid|device -> ms（SSE data 节流）
    this._timer = setInterval(() => this.sweepIdle(), 10 * 1000);
    if (this._timer.unref) this._timer.unref();
  }

  // 当前生效的音频流配置（config.audio_stream 深覆盖默认）
  cfg() {
    const c = (this.getConfig && this.getConfig()) || {};
    return { ...DEFAULTS_STREAM, ...(isObj(c.audio_stream) ? c.audio_stream : {}) };
  }

  _find(sid, device) {
    const m = this.streams.get(sid);
    return m ? m.get(device) : null;
  }

  hasStream(sid, device) {
    return Boolean(this._find(sid, device));
  }

  anyStreams(sid) {
    const m = this.streams.get(sid);
    return Boolean(m && m.size > 0);
  }

  // 建立（或复用）设备流；超限返回 { ok:false, error }
  startStream(sid, device) {
    let m = this.streams.get(sid);
    if (!m) {
      m = new Map();
      this.streams.set(sid, m);
    }
    if (!m.has(device) && m.size >= MAX_DEVICES_PER_SESSION) {
      return { ok: false, error: "该会话已有 " + m.size + " 个推流设备（上限 " + MAX_DEVICES_PER_SESSION + "）" };
    }
    let st = m.get(device);
    if (!st) {
      st = {
        device,
        started_at: Date.now(),
        last_frame_at: 0,
        bytes: 0,
        frames: 0,
        ring: [],       // [{ data: Buffer(PCM16), t: ms }] 时间升序
        ringBytes: 0
      };
      m.set(device, st);
    }
    this._emit(sid, device, "started");
    return { ok: true, st };
  }

  // 追加一帧解压后的 PCM16；返回 false = 流已不存在（已被清理）
  feed(sid, device, pcmBuf) {
    const st = this._find(sid, device);
    if (!st) return false;
    const now = Date.now();
    st.last_frame_at = now;
    st.frames += 1;
    st.bytes += pcmBuf.length;
    this._pushRing(st, pcmBuf, now);
    const key = sid + "|" + device;
    const last = this._lastDataEmit.get(key) || 0;
    if (now - last >= DATA_EMIT_MS) {
      this._lastDataEmit.set(key, now);
      this._emit(sid, device, "data");
    }
    return true;
  }

  // 环形缓冲：按字节总量淘汰最旧，再按时间裁剪（帧稀疏时仍只保留 max_buffer_s 内）
  _pushRing(st, buf, now) {
    const maxBytes = Math.max(1, this.cfg().max_buffer_s) * BYTES_PER_SEC;
    st.ring.push({ data: buf, t: now });
    st.ringBytes += buf.length;
    while (st.ringBytes > maxBytes && st.ring.length > 1) {
      st.ringBytes -= st.ring[0].data.length;
      st.ring.shift();
    }
    const cutoff = now - Math.max(1, this.cfg().max_buffer_s) * 1000;
    while (st.ring.length > 1 && st.ring[0].t < cutoff) {
      st.ringBytes -= st.ring[0].data.length;
      st.ring.shift();
    }
  }

  // 取最近 seconds 秒 PCM（不足则返回全部；无数据返回 null）
  capturePcm(sid, device, seconds) {
    const st = this._find(sid, device);
    if (!st || !st.ring.length) return null;
    const need = Math.max(1, Math.floor(seconds)) * BYTES_PER_SEC;
    const parts = [];
    let total = 0;
    for (let i = st.ring.length - 1; i >= 0 && total < need; i--) {
      parts.unshift(st.ring[i].data);
      total += st.ring[i].data.length;
    }
    if (!parts.length) return null;
    let pcm = Buffer.concat(parts);
    if (pcm.length > need) pcm = pcm.slice(pcm.length - need);
    return pcm;
  }

  captureWav(sid, device, seconds) {
    const pcm = this.capturePcm(sid, device, seconds);
    return pcm ? buildWav(pcm) : null;
  }

  // 最近一帧距今（ms）；无帧 = Infinity
  lastFrameAgeMs(sid, device) {
    const st = this._find(sid, device);
    if (!st || !st.last_frame_at) return Infinity;
    return Date.now() - st.last_frame_at;
  }

  isLive(sid, device, maxAgeMs) {
    const age = this.lastFrameAgeMs(sid, device);
    return age !== Infinity && age <= maxAgeMs;
  }

  // 抽屉/列表用摘要（无敏感信息）
  listStreams(sid) {
    const m = this.streams.get(sid);
    if (!m) return [];
    const now = Date.now();
    return [...m.values()].map((st) => ({
      device: st.device,
      started_at: new Date(st.started_at).toISOString(),
      last_frame_at: st.last_frame_at ? new Date(st.last_frame_at).toISOString() : null,
      ms_since_last_frame: st.last_frame_at ? now - st.last_frame_at : null,
      bytes: st.bytes,
      frames: st.frames
    }));
  }

  // 停止设备流（幂等）；SSE stopped
  stopStream(sid, device) {
    const m = this.streams.get(sid);
    if (!m) return false;
    const st = m.get(device);
    if (!st) return false;
    m.delete(device);
    if (!m.size) this.streams.delete(sid);
    this._lastDataEmit.delete(sid + "|" + device);
    this._emit(sid, device, "stopped");
    return true;
  }

  // 会话删除 → 全清
  removeSession(sid) {
    const m = this.streams.get(sid);
    if (!m) return;
    for (const device of [...m.keys()]) this.stopStream(sid, device);
    this.streams.delete(sid);
  }

  // 空闲清理：idle_clean_s（config.audio_stream.idle_clean_s，默认 60s）无帧
  // 的设备流移除（客户端停止/断网兜底；正常推送时 EchoScribe 静默期也发
  // 全零占位帧，实际不会触发）
  sweepIdle() {
    const now = Date.now();
    const cleanS = Number(this.cfg().idle_clean_s);
    const cleanMs = (Number.isFinite(cleanS) && cleanS >= 1) ? cleanS * 1000 : IDLE_CLEAN_MS;
    for (const [sid, m] of [...this.streams.entries()]) {
      for (const [device, st] of [...m.entries()]) {
        if (st.last_frame_at && now - st.last_frame_at > cleanMs) {
          this.stopStream(sid, device);
        }
      }
      if (!m.size) this.streams.delete(sid);
    }
  }

  _emit(sid, device, state) {
    if (!this.broadcast) return;
    const st = this._find(sid, device);
    this.broadcast("audio_stream", {
      session_id: sid,
      device,
      state,
      bytes: st ? st.bytes : 0,
      frames: st ? st.frames : 0,
      last_frame_at: st && st.last_frame_at ? new Date(st.last_frame_at).toISOString() : null
    });
  }

  close() {
    if (this._timer) clearInterval(this._timer);
  }
}

module.exports = {
  AudioStreamManager,
  createFrameParser,
  buildWav,
  RATE,
  BYTES_PER_SEC,
  FRAME_MAX,
  MAX_DEVICES_PER_SESSION,
  DEFAULTS_STREAM
};
