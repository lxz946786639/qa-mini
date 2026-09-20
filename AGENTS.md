# AGENTS.md — QA Mini AI 协作规范

本文件约束 AI 代理（及人类贡献者）在本仓库修改代码时的行为。**核心规则：
任何影响对外行为/可配置项/部署形态的代码修改，必须在同一次改动中同步更新
`doc/` 下对应文档**；文档与代码不一致视为改动未完成。

## 1. 项目速览

QA Mini：零依赖 Node.js + 原生前端的 Web 语音问答展示服务。接收 asr-tool
推送的识别文本，调用 openai/dify/generic/ragflow 四协议问答，多浏览器实时
流式展示。架构细节见 `doc/01-项目设计文档.md`，勿凭记忆假设，改前先读源码。

## 2. 硬性技术约束（违反即错）

1. **零 npm 依赖**：只用 Node 内置模块（http/fs/crypto/path/node:sqlite）。
   禁止 `npm install` 新包；前端禁止引入框架/构建步骤（public/ 纯静态三件套）。
2. **Node ≥ 18（建议 24）**：会话存储依赖 `node:sqlite`（DatabaseSync，
   同步 API）——不要改成异步驱动，不要引入 better-sqlite3。
3. **SSE 事件必须带 `session_id`**：新增广播事件时同步前端 `app.js` 处理。
4. **历史上限 100 条/会话**（环形，新→旧）；改动持久化逻辑必须保持
   `saveAll` 事务整表重写语义或等效一致性。
5. **兼容性红线**：`/api/push` 只带 token（无 session_id）必须继续可用；
   至少保留 1 个会话（删光自动补建「默认会话」）；`PUT /api/config` 保持深合并。
6. 协议客户端行为与 asr-tool 对齐（超时 10s 连接 / 60s 块间空闲；错误文案
   语义见 doc/01 §4）。修改协议解析必须补充/更新 `tests/mock_backends.js`
   对应形态。
7. **前端渲染先转义后解析**（防 XSS）：改 Markdown 渲染器不得破坏该顺序。
8. 提交前必须跑 `npm test`（tests/run_tests.js，当前 98 项断言全绿）；
   测试用 `QA_MINI_DATA_DIR` 临时目录隔离，**不得写真实 data/ 目录**。

## 3. 代码-文档同步规则（核心）

`doc/` 文档清单（新增文档主题时必须同步登记本表）：

| 文档 | 覆盖范围 |
|---|---|
| `doc/01-项目设计文档.md` | 架构、目录结构、会话模型、问答流程、协议设计、存储 schema、前端设计、测试与安全 |
| `doc/02-配置说明.md` | config.json 全字段、会话级配置、迁移链、asr-tool 对接、环境变量、前端 localStorage |
| `doc/03-部署说明.md` | docker-compose 部署/运维/备份/升级、systemd 附录、常见问题、安全建议 |
| `doc/04-101服务器部署说明.md` | 172.16.30.101 实际部署记录（端口/目录/验证结果） |

**修改 → 必须同步的文档映射**（命中即改，改完自检"文档描述与代码一致"）：

| 代码改动 | 必须同步 |
|---|---|
| `server.js` 增删改路由 / 请求响应字段 / 状态码语义 | 01 §3.3/§6 相关 + 02（如涉及配置）+ README「HTTP API」表 |
| `lib/qa_runner.js` 协议请求/解析/超时/错误语义 / 会话状态字段 | 01 §4/§5 对应协议行；新协议 → 01+02+README 协议表 |
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
server.js        唯一入口：HTTP 路由 + SSE + 静态服务（勿拆成多服务）
lib/config.js    配置 + SQLite 存储（唯一允许碰 data/ 文件的模块）
lib/qa_runner.js 会话管理（SessionManager + QaRunner，会话隔离边界）
lib/protocols/   四协议客户端（openai/dify/generic/ragflow），行为与 asr-tool 对齐
lib/sse.js       QaError（协议错误载体）
public/          纯静态前端：index.html / app.js / style.css
tests/           mock 后端 + 全量测试 + 真实 e2e（不进镜像）
docker/          容器化定义（Dockerfile / docker-compose.yml）
doc/             项目文档（本规范守护对象）
data/ config.json 运行时生成，不手工维护、不提交公开仓库（含真实 key）
```

## 5. 本地验证流程（每次改动后）

```bash
node --check server.js lib/*.js public/app.js   # 语法
npm test                                        # 98 项断言全绿
# 前端改动：静态文件按请求读盘，浏览器刷新即生效，无需重启；
# server.js/lib 改动：重启 node server.js 后 curl /api/health
```

## 6. 安全红线

- 不向任何输出/文档写入 config.json 中的完整 API Key（文档用 `kaasr_…` 截断式）；
- 不在代码中硬编码本机 IP/端口作为默认（默认值语义见 02 §1）；
- 删除/重置类接口保持现有确认语义（前端 confirm + 服务端 404 幂等）。
