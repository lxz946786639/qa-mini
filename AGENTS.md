# AGENTS.md — EchoAnswer AI 协作规范

本文件约束 AI 代理（及人类贡献者）在本仓库修改代码时的行为。**核心规则：
任何影响对外行为/可配置项/部署形态的代码修改，必须在同一次改动中同步更新
`doc/` 下对应文档**；文档与代码不一致视为改动未完成。

## 1. 项目速览

EchoAnswer（回响答）：零依赖 Node.js + Vue3 前端（构建产物随仓库提交，P7 起即站点根）
的 Web 语音问答展示服务。接收 EchoScribe（回响笔）
推送的识别文本，调用 openai/dify/generic/ragflow 四协议问答，多浏览器实时
流式展示。架构细节见 `doc/01-项目设计文档.md`，勿凭记忆假设，改前先读源码。

## 2. 硬性技术约束（违反即错）

1. **零 npm 依赖（根项目）**：Node 后端只用内置模块（http/fs/crypto/path/
   node:sqlite）；**严禁**给根项目 `npm install` 新包。旧前端 `public/` 已于 P7
   退役（目录删除，能力全量迁移至 web/）。
   **唯一前端**：`web/` 新代前端（v59 P4 起，用户批准的架构）是独立 package
   （自带 package.json：Vue3+Vite+TS+Element Plus+Pinia+PWA）——npm 只在
   `web/` 内使用；`web/dist` 构建产物随仓库提交，根服务器以其为**站点根**
   （P7 切根，零依赖；SPA fallback 无扩展名 → index.html，/api/* 未命中 404），
   部署不跑前端构建。
2. **Node ≥ 18（建议 24）**：会话存储依赖 `node:sqlite`（DatabaseSync，
   同步 API）——不要改成异步驱动，不要引入 better-sqlite3。
3. **SSE 事件必须带 `session_id`**：新增广播事件时同步前端 `web/src`
   （Workspace `useSse` 事件映射）处理。
4. **历史上限 100 条/会话**（环形，新→旧）；改动持久化逻辑必须保持
   `saveAll` 事务整表重写语义或等效一致性。
5. **兼容性红线**：`/api/push` 只带 token（无 session_id）必须继续可用；
   至少保留 1 个会话（删光自动补建「默认会话」）；`PUT /api/config` 保持深合并。
6. 协议客户端行为与 EchoScribe 对齐（超时 10s 连接 / 60s 块间空闲；错误文案
   语义见 doc/01 §4）。修改协议解析必须补充/更新 `tests/mock_backends.js`
   对应形态。
7. **前端渲染先转义后解析**（防 XSS）：改 Markdown 渲染器不得破坏该顺序。
8. 提交前必须跑 `npm test`（tests/run_tests.js，当前 151 项断言全绿，
   含前端构建产物完整性护栏）+ `node tests/store_tests.js`（v2/v3/v4 数据层 42 项）；
   测试用 `ECHOANSWER_DATA_DIR` 临时目录隔离，**不得写真实 data/ 目录**。
9. **禁止使用 emoji 图标（P8.25）**：界面图标字形一律使用 UI 框架图标集
   （Element Plus 图标）或官网首页内联 SVG；智能体图标字段 `agents.icon` 存
   Element Plus 图标名（映射/归一化在 `web/src/utils/agentIcon.ts`），模板/样式
   中不得再引入 emoji 字形作为图标。

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
| `web/src` 用户可见功能（UI 入口/交互/快捷键/断点） | 01 §7 前端设计；用户文档口径同时更新 README「Web 界面」 |
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
lib/migrations.js v1→v2→v3→v4→v5→v6 数据迁移（重命名/备份/播种/归属回填，user_version；v3 = agents 访问控制列；v4 = P8.10 管理员新建会话回填管理员私有桶，无 DDL；v5 = P8.29 audit_logs.user_agent；v6 = P8.40 users/access_codes.agent_scope 权限范围）
lib/qa_runner.js 会话管理（SessionManager + QaRunner，会话隔离边界）
lib/protocols/   四协议客户端（openai/dify/generic/ragflow），行为与 EchoScribe 对齐
lib/sse.js       QaError（协议错误载体）
lib/store.js     v2 数据层（唯一允许碰 data/ 库文件的模块；node:sqlite：
                 sessions/records/users/agents/访问码/cookie 会话(auth_sessions)/审计日志；
                 P8.21 normalizeLegacyFinished 启动归一化遗留空 finished_at）
public/          （P7 已退役：旧纯静态前端目录已删除，能力全量迁移至 web/）
web/             新代前端（v59 P4 起，独立 package；P7 起即站点根）：Vue3+Vite+TS+Element Plus+Pinia+PWA；
                 src/（views: Landing(P8 官网首页四区块：Hero/智能体选择/产品矩阵/工作流，
                 landing.css --lp-* 双主题 + 内联 SVG + IO 渐入)/Login/Workspace(P5 工作区 + P5.5 语音输入/
                 音频识别/会话设置 + P7 显示偏好 + P7.2 布局对齐旧版会话窗口 + P8.12 会话窗口交互对齐旧版：问题复制/输入框底部停止/重新生成确认（含错误卡）/「↓ 最新」浮钮 + 流式自动跟随/生成中实时秒数（后端配套：recordFromRow 回读补齐 status 字段）+ P8.14 卡片样式对齐旧版（问/答单卡/胶囊徽章/完成（N 字）/图标按钮/流式光标/发送图标）+ P8.15 顶栏品牌位 =「EchoAnswer · 智能体名」+ P8.30 会话栏头部：新建改图标按钮、收起/展开 Fold/Expand 语义图标 + P8.34 三视图登出统一跳登录页（?next 记忆原页，登录成功回跳原页）
                 + P8.37 顶栏一键分享（Share 图标按钮，复制智能体链接，非安全上下文 execCommand 回退）
                 + 匿名直访被门控智能体 → 自动跳登录页（?next 登录成功回跳；已登录无权 → 友好提示卡））)/
                 AdminView(P6 控制台：左侧导航 + 顶栏标题/副标题 + 内容卡片，Ant Design Admin 风格；
                 users/agents/codes/audit/sys 五模块 + P7 首启引导；
                 P8.25 智能体图标改 Element Plus 图标点选（emoji 禁用，遗留 emoji 自动映射）；
                 P8.26 控制台四表格列宽均衡（全 min-width 比例伸展）；
                 P8.27 品牌波形 logo 四处统一（utils/brandLogo.ts 单一来源，「回」字砖移除）；
                 P8.28 时间展示统一 yyyy-MM-dd HH:mm:ss（utils/formatTime.ts）；
                 P8.31 侧栏收起对齐会话列表（Fold/Expand 移入品牌行，收起 = 44px 图标窄轨）；
                 P8.32 UI 文案「落地页」统一更名「首屏」，返回符号统一 EP Back 图标；
                 P8.36 智能体管理「操作」栏：启用智能体提供「进入」快捷入口（直达该智能体工作区 /agents/<code>）；
                 P8.40 用户管理/访问码「权限范围」（共享组件 components/AgentScopeDialog.vue：允许全部 /
                 仅以下智能体多选 agent id；列表「权限」列徽标；管理员恒全量且按钮禁用；PATCH /api/admin/users/:id
                 与新增 PATCH /api/admin/access-codes/:code 承载 agent_scope））；
                 /login 首启表单同源组件)/Login(P7.1 首启引导)；
                 components: AudioPanel/SessionSettings/AdminBootstrap(首启管理账号)；
                 stores: auth/sessions；composables: useSse/useMic/useTheme(主题共享)；
                 utils: markdown 先转义后解析 / agentIcon(P8.25 EP 图标名映射) / brandLogo(P8.27) / formatTime(P8.28)；landing.css P8 首页双主题变量）
                 根服务器含 P8 /doc/*.md 文档静态路由（server/routes/static.js）
                 + dist/（构建产物随仓库提交，根服务器以站点根提供）；npm 仅限本目录
tests/           mock 后端 + 全量测试 + 真实 e2e（不进镜像）
docker/          容器化定义（Dockerfile / docker-compose.yml / tls 可选 https sidecar）
doc/             项目文档（本规范守护对象）
data/ config.json 运行时生成，不手工维护、不提交公开仓库（含真实 key）
```

## 5. 本地验证流程（每次改动后）

```bash
node --check server.js server/*.js server/services/*.js server/routes/*.js lib/*.js   # 语法
npm test                                        # 151 项断言全绿
node tests/store_tests.js                       # 42 项数据层单测全绿
# 前端改动：cd web && npm run build（产物 dist/ 随仓库提交）后浏览器刷新；
# 前端版本号：web/src/version.ts（APP_VERSION，首页页脚显示 EchoAnswer vNN）每次用户可见更新 +1；
# server.js/lib 改动：重启 node server.js 后 curl /api/health
```

## 6. 安全红线

- 不向任何输出/文档写入 config.json 中的完整 API Key（文档用 `kaasr_…` 截断式）；
- 不在代码中硬编码本机 IP/端口作为默认（默认值语义见 02 §1）；
- 删除/重置类接口保持现有确认语义（前端 confirm + 服务端 404 幂等）。
