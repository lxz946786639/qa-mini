# QA Mini — Web 端语音问答展示

Node.js + HTML 实现的 Web 端便捷聊天/问答展示项目，对接 **asr-tool**（asr-live，
github.com/bumblebee-code-gh/asr-tool dev 分支）的四种问答协议，并提供 HTTP 接口
接收 asr-tool **推送模式**发来的语音识别文本，以该文本为提问调用对应协议的问答，
在浏览器中**实时流式**展示答案（Markdown 渲染）。

**多会话**：左侧会话列表，每个会话有独立的 **token**、**会话 ID**、协议与问答历史。
asr-tool 推送时同时携带 token 与 session_id 定位会话；同一会话 ID 在多个浏览器
打开时，问题与答案**实时同步**流式显示。

```
asr-tool (桌面端, 推送模式)
  采集停止 → POST /api/push {"token":"kaasr_…","session_id":"…","text":"识别文本"}
                        │
                        ▼
┌─────────────────── QA Mini (本服务, Node.js 零依赖) ───────────────────┐
│  /api/push  token 定位会话 + session_id 校验 → 以 text 为提问           │
│  /api/chat  网页提问（session_id 必填）                                  │
│        └→ 每会话独立 QA 编排（会话续接/历史/取消）                        │
│             ├─ openai   OpenAI 兼容 chat completions (SSE)              │
│             ├─ dify     Dify Chatflow /chat-messages (SSE)              │
│             ├─ generic  第三方通用（JSON 模板 + SSE/JSON/纯文本）         │
│             └─ ragflow  RAGFlow 聊天助手 /chat/completions (SSE)        │
│  /api/events SSE 广播（事件均带 session_id）→ 所有浏览器实时流式渲染      │
└───────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
  浏览器 http://<host>:8787/  ←  会话侧栏 + 时间线（🎤 语音推送 / 💬 网页）
```

## 快速开始

```powershell
# 需要 Node.js >= 18（无 npm 依赖，无需 npm install）
cd D:\AiCode\qa-mini
npm start            # 或 node server.js
```

启动后：

- Web 界面：http://127.0.0.1:8787/
- 推送接口：`POST http://<本机IP>:8787/api/push`（asr-tool 填这里）
- 配置：config.json（协议级配置，首次运行自动生成；内置默认为空模板——
  首次启动请在网页「⚙ 设置」填入后端 url/api_key/chat_id 并保存）
- 会话：SQLite 数据库 data/qa-mini.db（Node 内置 node:sqlite，零依赖；
  首次运行自动创建「默认会话」，并迁移 config.json `push.token` 作为其 token ——
  旧 asr-tool 配置无需改动；旧 data/sessions.json 会在首次运行时自动一次性
  迁入数据库，旧文件归档为 .bak-<时间戳>）

## 文档

| 文档 | 内容 |
|---|---|
| [doc/01-项目设计文档](./doc/01-项目设计文档.md) | 架构 / 会话模型 / 协议设计 / 存储 schema / 前端设计 / 测试与安全 |
| [doc/02-配置说明](./doc/02-配置说明.md) | config.json 全字段 / 会话级配置 / asr-tool 对接 / 环境变量 |
| [doc/03-部署说明](./doc/03-部署说明.md) | docker-compose 部署（推荐）/ 运维 / 备份 / 升级 / 常见问题 |
| [doc/04-101服务器部署说明](./doc/04-101服务器部署说明.md) | 172.16.30.101 实际部署记录（端口 8790） |
| [AGENTS.md](./AGENTS.md) | AI 协作规范：代码修改必须同步更新 doc/ 文档

## asr-tool 对接（零代码改动）

asr-tool 的「第三方接口」配置（config.toml `[third_party]`）改为**推送模式**，
把识别文本推送到本服务即可（本服务收到后自动发起问答并在网页展示）：

```
[third_party]
url = "http://127.0.0.1:8787/api/push"     # 本服务的推送接口（局域网用本机 IP）
body = "{\"token\":\"kaasr_791b…\",\"session_id\":\"8b14dd80\"}"
auto_send = true            # 停止采集后自动推送
qa_enabled = false          # 必须是推送模式（问答模式下 asr-tool 自己发问、不会推送）
```

说明：

- 请求体 = asr-tool 的 `{**body, "text": 识别文本}`。本服务用 `token` **定位会话**
  （未知 token → 401）；若请求体带 `session_id`，必须与该会话 ID 一致（否则 400）。
  只带 token 不带 session_id 也兼容（按 token 所在会话执行）。
- token / 会话ID 在网页「**会话设置**」中查看与复制（含可直接粘贴的
  config.toml 片段）；重生成 token 后需同步更新 asr-tool 的 body。
- 默认 202 立即返回（asr-tool 视为成功），答案经 /api/events 广播到网页。
- 若希望 asr-tool 同步拿到答案，用 `POST /api/push?sync=true`
  （阻塞至完成，上限 28s，返回 `{ok, answer}`）。
- 每个会话可独立选择协议（ragflow/dify/openai/generic）与是否「续接会话」
  （语音追问带上下文）。

## 多会话

- 左侧会话列表：新建（＋）、切换、查看最近问题与时间；当前会话高亮；
  **按最新对话时间倒序**（刚对话过的会话自动排到最前）。
- 「会话设置」抽屉：名称、协议、续接开关、会话 ID（只读+复制）、token
  （只读+复制+重生成）、asr-tool config.toml 片段（只读+复制）、
  「重置会话」（清空该会话后端上下文）、删除会话。
- 会话数据持久化在 SQLite 数据库 data/qa-mini.db（sessions 表 + records 表；
  token/会话ID/协议/后端会话状态/每会话最近 100 条历史）；
  服务重启后会话与上下文保持。
- 至少保留一个会话：删除最后一个会话时自动补建「默认会话」。
- 同一会话 ID 的多个浏览器：任何一端（含 asr-tool 推送）发起的问答，
  所有端同步实时显示；切换会话时按会话加载历史 + 在途问答。

## 四种问答协议（与 asr-tool 行为一致）

| 协议 | 配置字段 | 请求 | 响应解析 |
|---|---|---|---|
| `openai` | url（完整地址）/ api_key / model | POST chat completions `{messages, stream:true, model?}`，Bearer 可空；上下文→system 消息「参考上下文（最近识别内容）：…」 | SSE `choices[0].delta.content`（兼容 `choices[0].text`）；`[DONE]` 结束 |
| `dify` | url（基址）/ api_key（必填）/ user | POST `{基址}/chat-messages`（自动补路径）`{inputs:{}, query, response_mode:"streaming", user, conversation_id?}`；上下文拼进 query | 按 event 分派：`message`→answer 增量+捕获 conversation_id（多轮续接）；`message_end` 结束；`error` 抛错；其余忽略 |
| `generic` | url（完整地址）/ api_key（可空）/ body（JSON 模板） | 模板中 `{question}`/`{context}` 占位符递归替换 + 顶层注入 question/context；最小模板 `{}` 即可 | 自动识别：SSE / 单 JSON 文档 / 纯文本；答案字段优先级 `choices[0].delta.content` → `choices[0].text` → `data.content/answer/text` → 顶层 `content/answer/text/output` |
| `ragflow` | url（基址）/ api_key（必填）/ chat_id（必填） | 新路径 `POST {基址}/chat/completions`（404 回退一次旧路径 `/chats/{chat_id}/completions`）；无会话先 `POST /chats/{chat_id}/sessions` 建会话（RAGFlow ≤v0.24 必需） | 信封 `{code,message,data}`：`data==true` 结束；code≠0 流内报错；session_id 续接；思考区（start/end_to_think）跳过；delta/cumulative 自动识别（LCP 差分）；reference 文档名去重脚注「**参考来源**：…」 |

通用规则（与 asr-tool 一致）：超时 10s 连接 / 60s 块间空闲（长答案不受总时长限制）；
非 2xx → 状态码 + 响应体截断 200 字符；SSE 非法 JSON → 「SSE 解析失败」（已流出内容保留）；
取消 → 保留部分答案「已取消」；空回答 → 「完成（空回答）」。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/push` | **asr-tool 推送接口**。body=`{token, session_id?, text}`；token 定位会话（未知 401）；带 session_id 时校验一致（不匹配 400）；text 非空（否则 400）。默认 202 `{ok, qa_id, session_id}` 异步执行；`?sync=true` 阻塞至完成（上限 28s）返回 `{ok, answer, detail}` |
| POST | `/api/chat` | 网页提问。body `{session_id, question, context?}` → 202 `{ok, qa_id, session_id}` |
| GET | `/api/sessions` | 会话列表，**按最新对话时间（updated_at）倒序**（摘要：id/name/token/protocol/continue_session/qa_count/active/last_question/last_at） |
| POST | `/api/sessions` | 新建会话。body `{name?, protocol?, continue_session?}` → 201 会话 |
| GET | `/api/sessions/:id` | 会话详情 `{session（含历史）, running（在途问答+部分答案）}` |
| PUT | `/api/sessions/:id` | 修改会话。body 可选 `{name?, protocol?, continue_session?, regenerate_token?}` |
| DELETE | `/api/sessions/:id` | 删除会话（取消在途问答；删光时自动补建「默认会话」） |
| POST | `/api/sessions/:id/reset` | 重置该会话后端上下文（dify conversation / ragflow session，对应 asr-tool「清空」） |
| DELETE | `/api/sessions/:id/history/:qaId` | 删除单条问答记录（广播 `record_removed`，各浏览器同步移除） |
| GET | `/api/events` | SSE 广播（EventSource 自动重连）：连接即推 `sessions` 列表 → `qa_start`/`delta`/`done`（均带 session_id）/`sessions`（列表变更）/`session_reset`/`config` |
| POST | `/api/cancel` | `{id}` 取消在途问答（保留部分答案） |
| POST | `/api/session/reset` | 全量重置（兼容旧接口：重置所有会话） |
| GET | `/api/history` | 全部会话最近 100 条 Q&A 合并（新→旧，含 session_id） |
| GET | `/api/config` | 读取配置（协议级） |
| PUT | `/api/config` | 修改配置（深合并 + 写盘 + 广播；port 变更需重启生效） |
| GET | `/api/health` | 存活 / 会话数 / 在途 QA / 广播客户端数 |
| GET | `/api/status` | 公开状态：`{ok, allow_anonymous, admin_set}`（无敏感信息） |
| POST | `/api/admin/login` | 管理登录 `{password}` → 管理 token（未设密码时输入即初始化；12h） |
| POST | `/api/access/login` | 访问码登录 `{code}` → 访问 token（24h，≤码有效期） |
| POST | `/api/admin/access-codes` | 生成访问码 `{code?, hours?}`（6 位，默认 8h） |
| DELETE | `/api/admin/access-codes/:code` | 访问码一键失效（已发 token 同步吊销） |

## 配置（config.json · 协议级）

```jsonc
{
  "port": 8787,
  "host": "0.0.0.0",
  "push": {
    "token": "kaasr_…",          // 首次启动时迁移为「默认会话」的 token（之后在 data/qa-mini.db 中管理）
    "protocol": "ragflow",
    "continue_session": true
  },
  "protocols": {
    "openai":  { "url": "", "api_key": "", "model": "" },
    "dify":    { "url": "", "api_key": "", "user": "qa-mini" },
    "generic": { "url": "", "api_key": "", "body": "{\"question\":\"{question}\"}" },
    "ragflow": { "url": "", "api_key": "", "chat_id": "" }
  }
}
```

内置默认为**空模板**（公开仓库安全：代码不含真实 key/token）；首次启动请在
网页「⚙ 设置」抽屉填入后端 url/api_key/chat_id 并保存（PUT /api/config 落盘）。
协议配置为**全局**（所有会话共用 url/key/chat_id），会话只决定走哪个协议。

## Web 界面

- **访问控制**：右上角「会话设置 / ⚙ 设置」默认隐藏；URL 加 `/admin` + 管理密码
  登录后显示（管理密码首次输入即初始化，之后可在设置中修改）。设置 → 安全 可关闭
  匿名访问，关闭后打开应用需 6 位访问码（可自定义/随机、默认 8 小时有效、一键失效）。
  权限模型与端点表见 doc/01 §3.4，字段说明见 doc/02 §7。
- 左侧：会话列表（＋新建 / 点击切换），显示协议徽标、最近时间与最近问题；
  头部 ☰ 可收起/展开（宽桌面状态本地记忆）。响应式：平板/窄屏（≤1024px）自动收起、
  可手动展开；手机（≤720px）改为左侧滑出抽屉，选中会话后自动关闭。
- 主区：当前会话的 Q&A 时间线卡片。问题块（「问」标签 + 左侧高亮条 + 加粗）与
  答案块（「答」标签）样式明确区分；卡片带来源徽标（🎤 语音推送 / 💬 网页）、
  协议标签、时间戳；答案区 Markdown 流式渲染（代码块/加粗/斜体/链接/标题/列表/引用，
  先转义后渲染防 XSS）。已完成卡片右上角 🗑 可删除该条记录（各端同步，API：
  DELETE /api/sessions/:id/history/:qaId）。答案状态行显示生成时长
  （「✔ 完成（732 字符 · 12.5s）」；生成中实时计时「生成中… 3.2s」）。
- 字号：头部「字号」下拉可选 默认（15px）/ 大（18px）/ 自定义（12–28px 数字输入），
  同时作用于问题与答案，选择本地记忆（localStorage）。
- 主题：头部 ☀️/🌙 按钮切换 浅色/深色 主题，全部组件双主题配色，
  选择本地记忆（localStorage），刷新不闪烁（status bar 颜色随主题联动）。
- **PWA（移动端）**：`/manifest.webmanifest` + service worker（`/sw.js`）——
  手机/平板浏览器「添加到主屏幕」后可全屏离线启动；离线时首页与静态资源走
  缓存，**问答 API 与 SSE 永远走网络（不缓存）**；静态资源更新需递增
  `sw.js` 中 `CACHE` 版本号。
- 一键复制：问题块右下角「⧉ 复制」复制问题原文；答案状态行右侧「⧉ 复制」
  复制答案原文（生成中可复制已出内容），点击后短暂显示「✔ 已复制」。
- 滚动跟随：答案生成时自动跟随到底部（仅当已贴近底部，不打断上滑阅读）；
  上滑阅读时右下角出现「↓ 最新」浮钮，点击平滑回底。
- 底部：当前会话协议徽标 + 提问框（Enter 发送 / Shift+Enter 换行）+ 发送 / 停止。
- 顶部：在途答案计数、「会话设置」（token/会话ID/asr-tool 片段/重置/删除）、「⚙ 设置」。
- 多浏览器同步：所有事件经 /api/events 广播并带 session_id，其他浏览器发起的提问
  与语音推送同样实时显示；切换会话时按会话恢复历史 + 在途问答。
- 每张卡片右上角 ✕ 可单独停止该问答；底部「停止」取消最新在途问答。
- 手机（≤720px）：会话列表为左侧滑出抽屉；平板/窄屏（≤1024px）自动收起侧栏（☰ 可展开）。

## 测试

```powershell
npm test           # node tests/run_tests.js
```

- `tests/mock_backends.js`：4 个本地 mock 协议服务（18701-18704），覆盖
  SSE 全事件流 / 思考区 / 引用 / cumulative + ##0$$ / 404 回退 / 建会话 /
  error 事件 / 401 / 空回答 / 慢速流 / 静默流 等形态。
- `tests/run_tests.js`：**93 项**断言 —— 协议客户端单测（含超时/取消/错误）+
  真实 server 全链路（会话迁移/创建/CRUD/token 重生成/删除保护、push
  token+session_id 校验与兼容、chat session_id 必填、四协议链路、双客户端
  广播含 session_id、配置深合并落盘、跨会话历史合并、stall/黑洞/拒绝）。
- 环境变量 `QA_MINI_IDLE_TIMEOUT_MS` / `QA_MINI_CONNECT_TIMEOUT_MS`
  可在测试中缩短超时（生产默认 60000 / 10000）；`QA_MINI_DATA_DIR`
  指定会话存储目录（测试用它做隔离）。
- `tests/e2e_local.js`：先 `npm start` 起服务，再运行 `node tests/e2e_local.js`，
  用真实 RAGFlow（127.0.0.1:9380）走 推送（token+session_id）→追问→网页提问→
  错误路径→会话历史 全流程。

## 已知限制

- 同一会话并发多个问答时，后端会话 ID 为后完成者生效（语音场景天然串行，一般无影响）。
- 继承 asr-tool 已知限制：RAGFlow `legacy: true` 时 think 标签不剥离；
  cumulative 极端情形 LCP 差分可能少量丢字/重复；Dify Chatflow Human Input 节点
  的流会挂起（表现为 60s 块间超时）。
- `/api/config` 与 `/api/sessions` 无鉴权（局域网自用）；暴露公网请自行加反向代理鉴权。
- 本目录 config.json / data/qa-mini.db（及 sessions.json.bak-* 归档）内含本机真实 API Key 与推送 token，
  请勿提交到公开仓库。
