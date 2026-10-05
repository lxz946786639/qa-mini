# AGENTS.md — EchoAnswer AI 协作规范

本文件约束 AI 代理（及人类贡献者）在本仓库修改代码时的行为。**核心规则：
任何影响对外行为/可配置项/部署形态的代码修改，必须在同一次改动中同步更新
`doc/` 下对应文档**；文档与代码不一致视为改动未完成。

## 1. 项目速览

EchoAnswer（回响答）：零依赖 Node.js + 原生前端的 Web 语音问答展示服务。接收 EchoScribe（回响笔）
推送的识别文本，调用 openai/dify/generic/ragflow 四协议问答，多浏览器实时
流式展示。架构细节见 `doc/01-项目设计文档.md`，勿凭记忆假设，改前先读源码。

## 2. 硬性技术约束（违反即错）

1. **零 npm 依赖（根项目）**：Node 后端只用内置模块（http/fs/crypto/path/
   node:sqlite）；**严禁**给根项目 `npm install` 新包。现役前端 public/ 保持
   纯静态（无框架无构建：index.html / app.js / icons.svg / style.css）。
   **唯一例外**：`web/` 新代前端（v59 P4 起，用户批准的架构）是独立 package
   （自带 package.json：Vue3+Vite+TS+Element Plus+Pinia+PWA）——npm 只在
   `web/` 内使用；`web/dist` 构建产物随仓库提交，根服务器直接挂载于 `/app/`
   （零依赖），部署不跑前端构建。
2. **Node ≥ 18（建议 24）**：会话存储依赖 `node:sqlite`（DatabaseSync，
   同步 API）——不要改成异步驱动，不要引入 better-sqlite3。
3. **SSE 事件必须带 `session_id`**：新增广播事件时同步前端 `app.js` 处理。
4. **历史上限 100 条/会话**（环形，新→旧）；改动持久化逻辑必须保持
   `saveAll` 事务整表重写语义或等效一致性。
5. **兼容性红线**：`/api/push` 只带 token（无 session_id）必须继续可用；
   至少保留 1 个会话（删光自动补建「默认会话」）；`PUT /api/config` 保持深合并。
6. 协议客户端行为与 EchoScribe 对齐（超时 10s 连接 / 60s 块间空闲；错误文案
   语义见 doc/01 §4）。修改协议解析必须补充/更新 `tests/mock_backends.js`
   对应形态。
7. **前端渲染先转义后解析**（防 XSS）：改 Markdown 渲染器不得破坏该顺序。
8. 提交前必须跑 `npm test`（tests/run_tests.js，当前 144 项断言全绿，
   含 `node --check` 前端语法护栏）+ `node tests/store_tests.js`（v2 数据层 35 项）；
   测试用 `ECHOANSWER_DATA_DIR` 临时目录隔离，**不得写真实 data/ 目录**。

## 3. 代码-文档同步规则（核心）

`doc/` 文档清单（新增文档主题时必须同步登记本表）：

| 文档 | 覆盖范围 |
|---|---|
| `doc/01-项目设计文档.md` | 架构、目录结构、会话模型、问答流程、协议设计、存储 schema、前端设计、测试与安全 |
| `doc/02-配置说明.md` | config.json 全字段、会话级配置、迁移链、EchoScribe 对接、环境变量、前端 localStorage |
| `doc/03-部署说明.md` | docker-compose 部署/运维/备份/升级、systemd 附录、常见问题、安全建议 |
| `doc/04-101服务器部署说明.md` | 172.16.30.101 实际部署记录（端口/目录/验证结果） |
| `doc/05-功能模块工作量报价单.md` | 16 个功能模块 × 工作量（人天）× 金额报价、阶段计划、验收标准 |

**修改 → 必须同步的文档映射**（命中即改，改完自检"文档描述与代码一致"）：

| 代码改动 | 必须同步 |
|---|---|
| `server.js` 增删改路由 / 请求响应字段 / 状态码语义 | 01 §3.3/§6 相关 + 02（如涉及配置）+ README「HTTP API」表 |
| `lib/qa_runner.js` 协议请求/解析/超时/错误语义 / 会话状态字段 | 01 §4/§5 对应协议行；新协议 → 01+02+README 协议表 |
| `lib/audio_stream.js` 音频流帧协议/环形缓冲/捕获语义 | 01 §3.5/§8 + 02 §1/§4.1 + README（HTTP API 表 + 持续推流模式） |
| `lib/config.js` 存储 schema / 迁移逻辑 / 默认值 | 01 §6 表结构 + 02 §3 迁移链 + README 快速开始 |
| `config.json` 字段 / 环境变量 | 02 §1/§5 字段表（逐字段：默认值/必填/生效方式） |
| `docker/`（Dockerfile、compose、.dockerignore） | 03 对应章节（端口/卷/命令） |
| 部署到 172.16.30.101 的任何变更（端口/目录/方式） | 04 对应记录段落（日期 + 操作 + 验证结果） |
| `public/` 用户可见功能（UI 入口/交互/快捷键/断点） | 01 §7 前端设计；用户文档口径同时更新 README「Web 界面」 |
| `tests/` 新增测试形态 | 01 §8 测试小节（数量/覆盖点） |
| README 与 doc 冲突时 | **以代码为准**，同次改动内修正文档 |

执行要求：

1. 改动前：先读命中的文档小节，确认当前口径；
2. 改动后：在同一回合内更新文档（不要"下次再补"）；
3. 文档更新保持既有风格（中文、表格优先、代码块用实际可运行的命令/配置）；
4. 无法确认影响面时，最小化修改并在回复中说明"哪些文档未动、为什么"。

## 4. 目录与文件职责

```
server.js        根入口（薄）：require server/app.js 启动（唯一入口，勿拆成多服务）
server/          服务端模块化（P2）：app.js 启动装配 / context.js 启动上下文 /
                 router.js 首中路由 / middleware.js 公共件 / services/（会话增量
                 持久化 · SSE 总线（P3 按主体作用域投递）· 鉴权（P3 主体解析 +
                 ea_sid cookie）· principal 桶可见性 · 访问码 · 音频监听 · 配置同步）
                 / routes/（按端点分组的路由模块；P3 会话级端点 IDOR 校验）
lib/asr.js       ASR 语音识别转发客户端（网页语音输入；OpenAI 兼容，与 EchoScribe 同源）
lib/audio_stream.js 电脑输出音频流（EchoScribe 持续推流）：帧解析 + 会话×设备环形缓冲
lib/auth.js      密码哈希（scrypt s1:）/ 令牌 / 限流器（v2 鉴权基座）
lib/config.js    配置加载/深合并/校验 + 旧 JSON 会话兼容（存储已迁 store.js）
lib/migrations.js v1→v2 数据迁移（重命名/备份/播种/归属回填，user_version）
lib/qa_runner.js 会话管理（SessionManager + QaRunner，会话隔离边界）
lib/protocols/   四协议客户端（openai/dify/generic/ragflow），行为与 EchoScribe 对齐
lib/sse.js       QaError（协议错误载体）
lib/store.js     v2 数据层（唯一允许碰 data/ 库文件的模块；node:sqlite：
                 sessions/records/users/agents/访问码/cookie 会话(auth_sessions)/审计日志）
public/          纯静态前端（现役，P7 退役）：index.html / app.js / icons.svg（图标 sprite）/ style.css
web/             新代前端（v59 P4 起，独立 package）：Vue3+Vite+TS+Element Plus+Pinia+PWA；
                 src/（views: Landing/Login/Workspace，stores/auth）+ dist/（构建产物随仓库提交，
                 服务器挂载 /app/，P7 切根）；npm 仅限本目录
tests/           mock 后端 + 全量测试 + 真实 e2e（不进镜像）
docker/          容器化定义（Dockerfile / docker-compose.yml / tls 可选 https sidecar）
doc/             项目文档（本规范守护对象）
data/ config.json 运行时生成，不手工维护、不提交公开仓库（含真实 key）
```

## 5. 本地验证流程（每次改动后）

```bash
node --check server.js server/*.js server/services/*.js server/routes/*.js lib/*.js public/app.js   # 语法
npm test                                        # 144 项断言全绿
node tests/store_tests.js                       # 35 项数据层单测全绿
# 前端改动：静态文件按请求读盘，浏览器刷新即生效，无需重启；
# server.js/lib 改动：重启 node server.js 后 curl /api/health
```

## 6. 安全红线

- 不向任何输出/文档写入 config.json 中的完整 API Key（文档用 `kaasr_…` 截断式）；
- 不在代码中硬编码本机 IP/端口作为默认（默认值语义见 02 §1）；
- 删除/重置类接口保持现有确认语义（前端 confirm + 服务端 404 幂等）。
