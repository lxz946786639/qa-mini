"use strict";
// 运行时上下文装配（P2）：
//  1) loadConfig（config.json）→ 2) migrations.initDataDir（v2 库 + 一次性迁移/种子）
//  → 3) Store 打开 → 4) 库 → 内存配置反向同步（此后 v2 库为权威源）
//  → 5) 会话缓存装载（JSON 兜底迁移 / 遗留桶默认会话补建）
//  → 6) SessionManager(增量持久化) / EventBus / AudioStream / 监听 / 鉴权 / 访问码
const path = require("path");
const { PROTOCOLS } = require("../lib/config");
const { ANON_CODE } = require("../lib/store");
const { Store } = require("../lib/store");
const { initDataDir } = require("../lib/migrations");
const { EventBus } = require("./services/event_bus");
const { V2SessionManager, loadSessions } = require("./services/session_service");
const { createAuthService } = require("./services/auth_legacy");
const { createAccessCodeService } = require("./services/access_codes");
const { createAudioListenService } = require("./services/audio_listen");
const { AudioStreamManager } = require("../lib/audio_stream");

// 库 → 内存配置：protocol_defaults → config.protocols；system_configs → asr/audio_stream/
// allow_anonymous；access_codes 表 → config.security.access_codes（ANON 特殊码不进旧形态镜像）
function applyDbConfig(ctx) {
  const store = ctx.store;
  const cfg = ctx.config;
  const pd = store.getProtocolDefaults();
  cfg.protocols = Object.assign({}, cfg.protocols);
  for (const p of PROTOCOLS) {
    if (pd[p]) cfg.protocols[p] = Object.assign({}, (cfg.protocols && cfg.protocols[p]) || {}, pd[p]);
  }
  const asr = store.getSystemConfig("asr");
  if (asr && typeof asr === "object") cfg.asr = asr;
  const audioStream = store.getSystemConfig("audio_stream");
  if (audioStream && typeof audioStream === "object") cfg.audio_stream = audioStream;
  const aa = store.getSystemConfig("allow_anonymous");
  cfg.security = Object.assign({}, cfg.security);
  if (typeof aa === "boolean") cfg.security.allow_anonymous = aa;
  cfg.security.access_codes = store.listAccessCodes()
    .filter((c) => c.code !== ANON_CODE)
    .map((c) => ({ code: c.code, created_at: c.created_at, expires_at: c.expires_at }));
}

function buildContext() {
  const cfgmod = require("../lib/config");
  const { config: initialConfig, file: configFile } = cfgmod.loadConfig();
  const dataDirPath = cfgmod.dataDir();
  const mig = initDataDir(dataDirPath, {
    configFile,
    adminUsername: typeof process.env.ECHOANSWER_ADMIN_USERNAME === "string" ? process.env.ECHOANSWER_ADMIN_USERNAME : "",
    adminPassword: typeof process.env.ECHOANSWER_ADMIN_PASSWORD === "string" ? process.env.ECHOANSWER_ADMIN_PASSWORD : ""
  });
  const store = Store.open(mig.dbFile);
  const ctx = {
    config: initialConfig,
    configFile,
    dataDir: dataDirPath,
    dbFile: mig.dbFile,
    store,
    cfgmod,
    publicDir: path.join(__dirname, "..", "public"),
    migration: mig
  };
  applyDbConfig(ctx);

  // P3 首启：v1/v2 存量会话（双轨 user 形态）一次性回填共享桶（幂等）
  const p3n = store.migrateLegacyToShared();
  if (p3n > 0) console.log("[migrate] P3 归属回填：" + p3n + " 个存量会话 → shared 共享桶");

  ctx.bus = new EventBus();
  loadSessions(ctx, cfgmod); // 会话缓存 + 遗留桶 + JSON 兜底 + 默认会话补建
  ctx.manager = new V2SessionManager(ctx);
  ctx.bus.setManager(ctx.manager); // P3：sessions 事件逐连接作用域载荷
  ctx.bus.setSessionLookup((id) => ctx.manager.sessionById(id)); // P3：session_id 事件投递过滤 + agent_id 补齐
  ctx.audioStreams = new AudioStreamManager({
    getConfig: () => ctx.config,
    broadcast: (event, payload) => ctx.bus.emit(event, payload)
  });
  ctx.listen = createAudioListenService(ctx);
  ctx.auth = createAuthService(ctx);
  ctx.codes = createAccessCodeService(ctx, ctx.auth);
  ctx.codes.refreshMirror();
  return ctx;
}

module.exports = { buildContext };
