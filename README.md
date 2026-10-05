# EchoAnswer — Web 端语音问答展示

Node.js + HTML 实现的 Web 端便捷聊天/问答展示项目，对接 **EchoScribe（回响笔）**
（原名 asr-live，仓库 github.com/bumblebee-code-gh/asr-tool，dev 分支）的四种问答协议，并提供 HTTP 接口
接收 EchoScribe **推送模式**发来的语音识别文本，以该文本为提问调用对应协议的问答，
在浏览器中**实时流式**展示答案（Markdown 渲染）。

> **命名**：英文主名 **EchoAnswer**，中文名「回响答」，产品全称「EchoAnswer（问答智能体）」；
> 原名 **QA Mini**（v58 整体改名 2026-10-05）。分工：EchoScribe（回响笔）采集转写 →
> EchoAnswer（回响答）问答展示。

**多会话**：左侧会话列表，每个会话有独立的 **token**、**会话 ID**、协议与问答历史。
EchoScribe 推送时同时携带 token 与 session_id 定位会话；同一会话 ID 在多个浏览器
打开时，问题与答案**实时同步**流式显示。

```
EchoScribe (桌面端, 推送模式)
  采集停止 → POST /api/push {"token":"kaasr_…","session_id":"…","text":"识别文本"}
                        │
                        ▼
┌─────────────────── EchoAnswer (本服务, Node.js 零依赖) ───────────────────┐
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
  浏览器 http://<host>:8787/  ←  会话侧栏 + 时间线（语音推送 / 网页 来源徽标）
```

## 快速开始

```powershell
# 需要 Node.js >= 18（无 npm 依赖，无需 npm install）
cd D:\AiCode\qa-mini
npm start            # 或 node server.js
```

启动后：

- Web 界面：http://127.0.0.1:8787/（现役界面）
- 新代前端（v59 P4）：http://127.0.0.1:8787/app/（落地页 + 登录；智能体工作区 P5 起逐步接管，见 doc/01 §7）
- 推送接口：`POST http://<本机IP>:8787/api/push`（EchoScribe 填这里）
- 配置：config.json（协议级配置，首次运行自动生成；内置默认为空模板——
  首次启动请在网页「⚙ 设置」填入后端 url/api_key/chat_id 并保存）
- 会话：SQLite 数据库 data/echoanswer.db（Node 内置 node:sqlite，零依赖；
  **旧库自动升级到 v2 schema：先备份 data/backup/，数据保留**，见 doc/02 §3）；
  首次运行自动创建「默认会话」，并迁移 config.json `push.token` 作为其 token ——
  旧 EchoScribe 配置无需改动；旧 data/sessions.json 会在首次运行时自动一次性
  迁入数据库，旧文件归档为 .bak-<时间戳>）

## 文档

| 文档 | 内容 |
|---|---|
| [doc/01-项目设计文档](./doc/01-项目设计文档.md) | 架构 / 会话模型 / 协议设计 / 存储 schema / 前端设计 / 测试与安全 |
| [doc/02-配置说明](./doc/02-配置说明.md) | config.json 全字段 / 会话级配置 / EchoScribe 对接 / 环境变量 |
| [doc/03-部署说明](./doc/03-部署说明.md) | docker-compose 部署（推荐）/ 运维 / 备份 / 升级 / 常见问题 |
| [doc/04-101服务器部署说明](./doc/04-101服务器部署说明.md) | 172.16.30.101 实际部署记录（端口 8790） |
| [doc/05-功能模块工作量报价单](./doc/05-功能模块工作量报价单.md) | 按功能模块报价（人天/金额）、阶段计划、验收标准 |
| [AGENTS.md](./AGENTS.md) | AI 协作规范：代码修改必须同步更新 doc/ 文档

## EchoScribe 对接（零代码改动）

EchoScribe 的「第三方接口」配置（echoscribe.toml `[third_party]`）改为**推送模式**，
把识别文本推送到本服务即可（本服务收到后自动发起问答并在网页展示）：

```
[third_party]
url = "http://127.0.0.1:8787/api/push"     # 本服务的推送接口（局域网用本机 IP）
body = "{\"token\":\"kaasr_791b…\",\"session_id\":\"8b14dd80\"}"
auto_send = true            # 停止采集后自动推送
qa_enabled = false          # 必须是推送模式（问答模式下 EchoScribe 自己发问、不会推送）
```

说明：

- 请求体 = EchoScribe 的 `{**body, "text": 识别文本}`。本服务用 `token` **定位会话**
  （未知 token → 401）；若请求体带 `session_id`，必须与该会话 ID 一致（否则 400）。
  只带 token 不带 session_id 也兼容（按 token 所在会话执行）。
- token / 会话ID 在网页「**会话设置**」中查看与复制（含可直接粘贴的
  echoscribe.toml 片段）；重生成 token 后需同步更新 EchoScribe 的 body。
- 默认 202 立即返回（EchoScribe 视为成功），答案经 /api/events 广播到网页。
- 若希望 EchoScribe 同步拿到答案，用 `POST /api/push?sync=true`
  （阻塞至完成，上限 28s，返回 `{ok, answer}`）。
- 每个会话可独立选择协议（ragflow/dify/openai/generic）与是否「续接会话」
  （语音追问带上下文），还可在「会话设置」里单独配置该协议的 url/key 等字段
  （**会话级覆盖**；留空的字段使用「⚙ 设置」中的全局默认；修改后须
  「测试连接」通过才能保存，占位符不显示全局值明文）。

### 持续推流模式（电脑输出音频 → 识别并自动提问）

EchoScribe 另有「**持续推流**」：捕获指定**输出设备**（WASAPI 回环，如 ToDesk 虚拟
声卡）的音频，持续推给本服务（复用既有端口/TLS sidecar，**不新增端口**；帧协议
`[u32BE len][Deflate(PCM 16kHz 单声道)]`，200ms/帧，无损压缩；设备头为
「6位设备码 · 端点名称」，同名虚拟声卡跨机器可区分）。服务端按会话×设备环形
缓存（默认 120s），网页「会话设置」勾选「启用电脑输出音频接收」后，**提问框区**
点「**🎧 音频**」按钮展开设备下拉（与「语音」输入互斥，二选一）→ 交互对齐
EchoScribe：「开始识别」实时显示中间识别 →「停止识别」定稿（自动发送或填入输入框）/
「重新开始」（丢弃并立即重开）/「取消」（丢弃）。另有一键 API
`/api/audio/capture`（截取最近 N 秒 → ASR → 自动提问，来源徽标「🎧 电脑音频」）。
多设备可并存（≤8/会话），断线自动重连。详见 doc/01 §3.5/§7、doc/02 §4.1。

## 多会话

- 左侧会话列表：新建（＋）、切换、查看最近问题与时间；当前会话高亮；
  **按最新对话时间倒序**（刚对话过的会话自动排到最前）。
- 「会话设置」抽屉：名称、协议、**本会话协议配置**（按当前协议逐字段渲染，
  占位符只显示全局是否已配置（不显示明文），留空保存 = 回退全局默认；
  「测试连接」用当前填写值（留空项回退全局）探测后端，**有修改时须测试
  通过才能保存**；全部清空回退全局无需测试；**修改接口基址/Key/Chat ID 会
  自动重置该会话的后端上下文**（下次提问重建）、续接开关；EchoScribe 相关字段
  （会话 ID 只读+复制、token 只读+复制+重生成、echoscribe.toml 片段与 body 值只读+复制）
  默认折叠在「EchoScribe 对接（推送模式）」区块，点击展开；**电脑输出音频**
  （「启用电脑输出音频接收」开关 + 正在接收的设备信息，识别在提问框「🎧 音频」
  按钮，见上「持续推流模式」）；「重置会话」（先取消
  在途问答，再清空该会话后端上下文）、删除会话。
- 会话数据持久化在 SQLite 数据库 data/echoanswer.db（v2 schema：sessions 表 +
  records 表 + users/agents/访问码/审计日志；token/会话ID/协议/后端会话状态/
  每会话最近 100 条历史 + 用户/智能体归属列）；服务重启后会话与上下文保持。
- 至少保留一个会话：删除最后一个会话时自动补建「默认会话」。
- 同一会话 ID 的多个浏览器：任何一端（含 EchoScribe 推送）发起的问答，
  所有端同步实时显示；切换会话时按会话加载历史 + 在途问答。

## 四种问答协议（与 EchoScribe 行为一致）

| 协议 | 配置字段 | 请求 | 响应解析 |
|---|---|---|---|
| `openai` | url（完整地址）/ api_key / model | POST chat completions `{messages, stream:true, model?}`，Bearer 可空；上下文→system 消息「参考上下文（最近识别内容）：…」 | SSE `choices[0].delta.content`（兼容 `choices[0].text`）；`[DONE]` 结束 |
| `dify` | url（基址）/ api_key（必填）/ user | POST `{基址}/chat-messages`（自动补路径）`{inputs:{}, query, response_mode:"streaming", user, conversation_id?}`；上下文拼进 query | 按 event 分派：`message`→answer 增量+捕获 conversation_id（多轮续接）；`message_end` 结束；`error` 抛错；其余忽略 |
| `generic` | url（完整地址）/ api_key（可空）/ body（JSON 模板） | 模板中 `{question}`/`{context}` 占位符递归替换 + 顶层注入 question/context；最小模板 `{}` 即可 | 自动识别：SSE / 单 JSON 文档 / 纯文本；答案字段优先级 `choices[0].delta.content` → `choices[0].text` → `data.content/answer/text` → 顶层 `content/answer/text/output` |
| `ragflow` | url（基址）/ api_key（必填）/ chat_id（必填） | 新路径 `POST {基址}/chat/completions`（404 回退一次旧路径 `/chats/{chat_id}/completions`）；无会话先 `POST /chats/{chat_id}/sessions` 建会话（RAGFlow ≤v0.24 必需） | 信封 `{code,message,data}`：`data==true` 结束；code≠0 流内报错；session_id 续接；思考区（start/end_to_think）跳过；delta/cumulative 自动识别（LCP 差分）；reference 文档名去重脚注「**参考来源**：…」 |

界面显示名对外隐藏：`dify` → 「编排引擎」、`ragflow` → 「知识引擎」（协议 key、
配置字段、API 参数均不变；错误提示同步使用隐藏名称）。

通用规则（与 EchoScribe 一致）：超时 10s 连接 / 60s 块间空闲（长答案不受总时长限制）；
非 2xx → 状态码 + 响应体截断 200 字符；SSE 非法 JSON → 「SSE 解析失败」（已流出内容保留）；
取消 → 保留部分答案「已取消」；空回答 → 「完成（空回答）」。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/push` | **EchoScribe 推送接口**。body=`{token, session_id?, text}`；token 定位会话（未知 401）；带 session_id 时校验一致（不匹配 400）；text 非空（否则 400）。默认 202 `{ok, qa_id, session_id}` 异步执行；`?sync=true` 阻塞至完成（上限 28s）返回 `{ok, answer, detail}`。**鉴权 = token 本身**（高熵随机凭证），开启访问码后也无需另带访问码 |
| POST | `/api/chat` | 网页提问。body `{session_id, question, context?}` → 202 `{ok, qa_id, session_id}` |
| POST | `/api/asr` | **网页语音输入**：请求体 = 原始 WAV 字节（16-bit PCM，≤10MB，超限 413）→ 200 `{ok, text, duration_s}`（text = 识别文本；未识别到内容时为空字符串）。未配置 ASR 或非 WAV → 400；上游失败 → 502。权限同 `/api/chat`（查看级）；客户端断开即中止对 ASR 的上游请求 |
| POST | `/api/asr/test` | ASR 服务**测试连接**（管理）。body `{asr?: {url?, api_key?, model?, language?, timeout?}}`（表单草稿，留空回退已存值）→ 200 `{ok, detail, models, health}`（`ok=false` 时 detail = 模型不在服务列表等警告）；未配置 → 400；不可达 → 502 |
| POST | `/api/audio/stream` | **电脑输出音频推流**（EchoScribe 持续推流）。头 `X-Audio-Token`（会话推送 token，缺失/未知 401；会话未启用接收 403；同设备已有流 409）+ `X-Device-Name`（URL 编码设备名）；body = 连续帧 `[u32BE len][Deflate(PCM 16kHz 单声道)]`（200ms/帧）；长连接 chunked，前置校验（401/403/409）即时响应，成功路径在收完整体后回 200 `{ok, stream:"stopped", bytes, frames}`（nginx 截断约束，见 doc/03 §8）；客户端结束 chunked 体 = 正常停止；60s 空闲/协议违例/客户端断开 → 清理该设备流 |
| POST | `/api/audio/listen`（+ `/stop`、`/cancel`） | **实时识别**（提问框「音频」按钮）。body `{token, device?}`：开始监听，每 2.5s 全段重提一次，SSE `audio_listen`（partial/stopped/cancelled/stream_stopped，均带 session_id）；`/stop` 定稿返回 `{ok, text, elapsed_s}`；`/cancel` 丢弃。同设备已有任务 409，设备未接收 409，ASR 未配置 400 |
| POST | `/api/audio/capture` | **识别并提问**（一键 API）。body `{token, device?, seconds?}`：截取最近 N 秒推流（默认 30，范围 5-60 可配）→ ASR → `QaRunner.start(source:"remote_audio")` → 200 `{ok, text, qa_id, session_id, device, duration_s}`；无设备流 409 / ASR 未配置 400 / 无声 422 / ASR 失败 502 |
| GET | `/api/audio/stream?token=` | 该会话正在接收的设备列表 `{ok, enabled, streams:[{device, bytes, frames, ms_since_last_frame}]}`（会话设置抽屉实时刷新用） |
| GET | `/api/sessions` | 会话列表，**按最新对话时间（updated_at）倒序**（摘要：id/name/token/protocol/continue_session/qa_count/active/last_question/last_at）；P3：按主体作用域（只看可见桶） |
| POST | `/api/sessions` | 新建会话。body `{name?, protocol?, continue_session?, agent_id?/agent_code?}` → 201 会话；P3：管理/登录用户（自身私有桶）/访问码主体（自身码桶），匿名 401 |
| GET | `/api/sessions/:id` | 会话详情 `{session（含历史）, running（在途问答+部分答案）}` |
| PUT | `/api/sessions/:id` | 修改会话。body 可选 `{name?, protocol?, continue_session?, regenerate_token?, protocol_config?, audio_remote?}`（会话级协议覆盖 / 电脑输出音频 `{enabled, preferred_device}`） |
| DELETE | `/api/sessions/:id` | 删除会话（取消在途问答；删光时自动补建「默认会话」） |
| POST | `/api/sessions/:id/reset` | 重置该会话后端上下文（先取消在途问答，再清 dify conversation / ragflow session，对应 EchoScribe「清空」） |
| POST | `/api/sessions/:id/protocol-test` | 会话级协议配置**测试连接**（管理）。body `{protocol?, config?}`（config = 表单草稿，留空项回退全局）→ 200 `{ok, detail}`（ok=false 时 detail = 失败原因，不回显密钥） |
| DELETE | `/api/sessions/:id/history/:qaId` | 删除单条问答记录（广播 `record_removed`，各浏览器同步移除） |
| GET | `/api/events` | SSE 广播（EventSource 自动重连）：连接即推 `sessions` 列表 → `qa_start`/`delta`/`done`（均带 session_id）/`sessions`（列表变更）/`session_reset`/`config` |
| POST | `/api/cancel` | `{id}` 取消在途问答（保留部分答案） |
| POST | `/api/session/reset` | 全量重置（兼容旧接口：重置所有会话） |
| GET | `/api/history` | 全部会话最近 100 条 Q&A 合并（新→旧，含 session_id） |
| GET | `/api/config` | 读取配置（协议级） |
| PUT | `/api/config` | 修改配置（深合并 + 写盘 + 广播；port 变更需重启生效） |
| GET | `/api/health` | 存活 / 会话数 / 在途 QA / 广播客户端数 / asr_configured |
| GET | `/api/status` | 公开状态：`{ok, allow_anonymous, admin_set}`（无敏感信息） |
| POST | `/api/admin/login` | 管理登录 `{password}` → 管理 token（未设密码时输入即初始化；12h；P3 起同时下发 `ea_sid` cookie） |
| POST | `/api/access/login` | 访问码登录 `{code}` → 访问 token（24h，≤码有效期） |
| POST | `/api/admin/access-codes` | 生成访问码 `{code?, hours?, count?}`（6 位；可多个，每个码独立时长，默认 8h；批量随机 1-10 个） |
| POST | `/api/admin/access-codes/:code/renew` | 该访问码延期 `{hours?}`（默认 +8h） |
| DELETE | `/api/admin/access-codes/:code` | 访问码一键失效（已发 token 同步吊销） |
| DELETE | `/api/admin/access-codes/expired` | 清理全部已过期码 |
| POST | `/api/auth/login` | **P3 用户登录** `{username, password}` → 200 + `ea_sid` cookie（HttpOnly/SameSite=Lax，12h，落 DB 可吊销） |
| POST | `/api/auth/access-code` | **P3 访问码登录** `{code}` → 200 + `ea_sid` cookie（无匿名捷径；无效/过期 401） |
| GET | `/api/auth/me` | 当前主体 `{principal（admin/user/code）, anonymous?}` |
| POST | `/api/auth/logout` | 吊销当前 cookie 会话 |
| GET | `/api/agents` | 启用中智能体列表（落地页选择器：code/name/description/protocol/…） |
| GET | `/api/agents/:code` | 智能体详情 + 该主体可见会话 + 协议配置（api_key 脱敏） |
| GET/POST | `/api/admin/users` | 用户列表 / 创建（**仅管理**；用户名 2-32、密码 4-64、role user/admin） |
| PATCH | `/api/admin/users/:id` | 用户修改 `{display_name?, role?, status?, password?}`（不能降级/停用最后一个 active 管理员；停用即吊销其 cookie） |
| GET/POST | `/api/admin/agents` | 智能体列表（含停用）/ 创建 `{code, name, protocol?, config?}`（每智能体一个协议，存 agent_configs） |
| PATCH | `/api/admin/agents/:code` | 智能体修改 `{name?, description?, icon?, prompt?, enabled?, sort?, protocol?, config?}`（协议/配置变更清空该智能体会话后端会话 ID） |
| GET | `/api/admin/audit` | 审计日志（管理操作留痕；`?limit=&offset=` 分页，默认 100 上限 500） |

> **v59（P3）多用户隔离**：会话按桶归属（`user` 私有 (user_id,agent_id) / `code` (access_code_id,agent_id) /
> `shared` 共享——存量会话全在 shared，保留「访问码=共享会话」语义）；会话级端点 IDOR 校验
> （不可见 = 404，写他人桶 = 401）；SSE 按主体作用域投递（一个用户的私有问答绝不广播给
> 其他主体），QA 事件带 `agent_id`。详见 doc/01 §3.4/§6。

## 配置（config.json · 协议级）

```jsonc
{
  "port": 8787,
  "host": "0.0.0.0",
  "push": {
    "token": "kaasr_…",          // 首次启动时迁移为「默认会话」的 token（之后在 data/echoanswer.db 中管理）
    "protocol": "ragflow",
    "continue_session": true
  },
  "protocols": {
    "openai":  { "url": "", "api_key": "", "model": "" },
    "dify":    { "url": "", "api_key": "", "user": "EchoAnswer" },
    "generic": { "url": "", "api_key": "", "body": "{\"question\":\"{question}\"}" },
    "ragflow": { "url": "", "api_key": "", "chat_id": "" }
  },
  "asr": { "url": "", "api_key": "", "model": "", "language": "", "timeout": 60 },  // 网页语音输入所用 ASR 服务（OpenAI 兼容；空 url = 未启用）
  "audio_stream": { "max_buffer_s": 120, "min_capture_s": 5, "default_capture_s": 30, "max_capture_s": 60 }  // 电脑输出音频流（推流缓冲/截取秒数，见 doc/02 §1）
}
```

内置默认为**空模板**（公开仓库安全：代码不含真实 key/token）；首次启动请在
网页「⚙ 设置」抽屉填入后端 url/api_key/chat_id 并保存（PUT /api/config 落盘）。
协议配置为**全局**（所有会话共用 url/key/chat_id），会话只决定走哪个协议。

## Web 界面

- **新代前端（v59 P4 起）**：`/app/` 挂载 web/ 构建产物（Vue3 + Vite + TS + Element
  Plus + Pinia + PWA，独立 package，仅 web/ 用 npm；根项目后端保持零依赖）。P4 =
  落地页（智能体选择器，`GET /api/agents`）+ `/app/login`（账号 / 6 位访问码 →
  `ea_sid` cookie）+ `/app/agents/:code` 工作区（P5：按智能体过滤的「我的会话」+
  流式问答卡片 + SSE 实时事件 + 停止/复制/删除/重新生成 + 语音输入（🎤 麦克风 →
  /api/asr，自动发送开关）+ 电脑输出音频识别面板（EchoScribe 持续推流，管理视图）
  + 会话设置对话框（协议覆盖 / 音频接收 / 推送 token，P5.5））+ `/app/admin` 管理台
  （P6：用户管理 / 智能体管理 / 访问码 / 审计日志四页签，仅 admin 主体）；
  P7 根路径切换到新前端并退役 public/。开发：`cd web && npm install && npm run dev`
  （vite dev 代理 /api → 127.0.0.1:8787）；构建：`npm run build` → `web/dist`
  （构建产物随仓库提交，服务器直接挂载，部署不跑前端构建）。
- **现役界面（/ 根路径）**：
- **访问控制**：右上角「会话设置 / ⚙ 设置」默认隐藏；URL 加 `/admin` + 管理密码
  登录后显示（管理密码首次输入即初始化，之后可在设置中修改）。设置 → 安全 可关闭
  匿名访问，关闭后打开应用需 6 位访问码：**可生成多个，每个码独立有效时长**（默认 8h，
  可自定义/随机、批量 1-10 个、单个延期、一键失效、清理过期）。
  权限模型与端点表见 doc/01 §3.4，字段说明见 doc/02 §7。
- **⚙ 设置抽屉**：顶部单行分段标签——「协议配置」（知识引擎 / 编排引擎 / OpenAI / 通用）、
  「语音输入」（ASR 服务配置 + 测试连接）与「安全配置」（安全），组间细线分隔；宽 880px、
  内容居中。底部「保存配置」
  只作用于协议页；安全页的匿名开关与管理密码修改**即时生效**（各自独立保存）。
  打开时显示**加载遮罩**直至配置拉取完成（保存按钮期间禁用），避免手快时
  看到空白表单。**点击抽屉外部自动收起**（会话设置 / ⚙ 设置通用）；「会话设置」
  打开状态下切换左侧会话时，抽屉内容同步跟随刷新（会话列表项点击不收起抽屉）。
- 左侧：会话列表（＋新建 / 点击切换），显示协议徽标、最近时间与最近问题；最近时间
  按本地日历日显示：今天 hh:mm:ss / 昨天 hh:mm:ss / 前天 hh:mm:ss，更早为
  YYYY-MM-DD hh:mm:ss（有在途问答时显示「生成中…」）。头部 ☰ 可收起/展开（宽桌面状态本地记忆）。响应式：平板/窄屏（≤1024px）自动收起、
  可手动展开；手机（≤720px）改为左侧滑出抽屉，选中会话后自动关闭。
- 主区：当前会话的 Q&A 时间线卡片。问题块（「问」标签 + 左侧高亮条 + 加粗）与
  答案块（「答」标签）样式明确区分；「答」标签与答案内容**首行同行**（换行对齐
  内容左缘，同「问」）；失败时错误详情在答案区红色展示、状态行仅留「请求失败 · Ns」
  摘要。卡片带来源徽标（语音推送 / 网页）、协议标签、时间戳；答案区 Markdown 流式
  渲染（代码块/加粗/斜体/链接/标题/列表/引用，先转义后渲染防 XSS）。答案状态行右侧为**卡片操作行**：停止（生成中）/ 重新生成
  （仅最新一条）/ 复制答案 / 删除记录（各端同步，API：DELETE
  /api/sessions/:id/history/:qaId）。**重新生成** = 删除该条记录并按相同上下文
  重新提问（前端组合现有接口，无新端点）；对更早的记录重新提问会带上其后新增的
  上下文，故不提供。答案状态行显示生成时长（「✔ 完成（689 字 · 12.5s）」，
  字数为中文字数；生成中实时计时「生成中… 3.2s」）。
- 字号：头部「字号」下拉可选 默认（15px）/ 大（18px）/ 自定义（12–28px 数字输入），
  同时作用于问题与答案，选择本地记忆（localStorage）。
- 内容宽度：头部「宽度」下拉三档 —— **窄**（860px，默认）/ **宽**（1180px）/
  **铺满**（撑满主容器，两侧留 16px），作用于问答卡片与底部输入框，本地记忆
  （localStorage）。
- 行间距：头部「行距」下拉 —— **默认**（各元素原行距）/ **窄**（1.35）/
  **自定义**（1.00–2.50 数字输入），作用于问题与答案正文（`--qa-line` 变量；
  代码块与标题保持紧凑行距），本地记忆（localStorage）。
- **语音输入（麦克风 → 文字）**：提问框区「🎤 语音」按钮（图标 + 文字）——点击开始
  录音（红底脉冲 + 秒数计时，**60s 自动停止**；<0.4s 丢弃不送识别）。录音中每 1.5s
  重提「段首→当前」音频前缀做**中间识别**，以 `…` 前缀实时显示在提问框上方预览行
  （EchoScribe 同源流式体验；忙则跳过；**中间结果不入输入框**）。再点停止 →
  浏览器把 16kHz WAV（整段）上传 `/api/asr`，服务端转发「⚙ 设置 → 语音输入」里配置的
  **OpenAI 兼容 ASR 服务**（与 EchoScribe 同源：`/audio/transcriptions`，404/405/400 自动
  回退 `/chat/completions` base64 音频），识别结果**填入输入框待确认发送（不自动
  提问）**；composer 区「识别后自动发送」勾选（本地偏好，**默认勾选**）——定稿结果
  **立即发送**（输入框已有文本保留）；取消勾选则恢复填入输入框待确认。音频源固定
  为默认麦克风（浏览器无法选择输出扬声器回环；从系统播放取声请用立体声混音/虚拟
  声卡，或 EchoScribe「持续推流」把 PC 输出音频推给本服务，见「持续推流模式」）。
  麦克风需**安全上下文**：`http://<IP>` 访问时浏览器禁止录音，按钮自动
  禁用并 tooltip 说明（需 https，见 doc/03 §8 的 compose `tls` profile 自签入口，
  或本机 127.0.0.1/localhost 访问）。
- **电脑输出音频（EchoScribe 持续推流）**：「会话设置」抽屉内启用开关 + 正在接收
  的设备信息（`6位设备码 · 端点名称`/累计字节/最近帧距今，绿点 = 直播中，SSE
  实时刷新；同名虚拟声卡跨机器推流按码区分来源，旧版 EchoScribe 发设备序号时列表
  标注「（旧版序号编码）」）；**识别交互在提问框区**：「🎧 音频」按钮（i-headphones
  图标）展开紧凑面板（设备下拉 + 操作按钮，与「语音」互斥），交互对齐 EchoScribe：
  「开始识别」（待机）/「停止识别（定稿）/ 重新开始 / 取消」（识别中），中间识别
  实时预览（… 前缀，面板内），定稿按「识别后自动发送」直接提问或填入输入框（同「语音」）；
  切换会话自动收起面板并取消在途任务；
  正在推流的会话在列表显示「🎧N」角标；问答卡片来源徽标「🎧 电脑音频」。
- 图标：引入**轻量自托管 SVG 图标库**（`public/icons.svg` sprite，23 枚 Lucide 风格
  2px 描边图标，`<use>` 引用、随主题变色；无 JS 框架/无构建/零依赖），界面不使用 emoji。
- 主题：头部 太阳/月亮 图标按钮切换 浅色/深色 主题，全部组件双主题配色，
  选择本地记忆（localStorage），刷新不闪烁（status bar 颜色随主题联动）。
- **PWA（移动端）**：`/manifest.webmanifest` + service worker（`/sw.js`）——
  手机/平板浏览器「添加到主屏幕」后可全屏离线启动；离线时首页与静态资源走
  缓存，**问答 API 与 SSE 永远走网络（不缓存）**；静态资源更新需递增
  `sw.js` 中 `CACHE` 版本号。
- 一键复制：问题块右下角「⧉ 复制」复制问题原文；卡片操作行「⧉ 复制」复制答案
  原文（生成中可复制已出内容），点击后短暂显示「✔ 已复制」。
- 滚动跟随：答案生成时自动跟随到底部（仅当已贴近底部，不打断上滑阅读）；
  上滑阅读时右下角出现「↓ 最新」浮钮，点击平滑回底。
- 底部：当前会话协议徽标 + 提问框（Enter 发送 / Shift+Enter 换行）+ 语音（🎤 麦克风
  输入）/ 发送 / 停止。
- 顶部：在途答案计数、「会话设置」（token/会话ID/EchoScribe 片段/重置/删除）、「⚙ 设置」。
- 多浏览器同步：所有事件经 /api/events 广播并带 session_id，其他浏览器发起的提问
  与语音推送同样实时显示；切换会话时按会话恢复历史 + 在途问答。
- 卡片操作行的停止按钮可单独停止该问答；底部「停止」取消最新在途问答。
- 手机（≤720px）：会话列表为左侧滑出抽屉；平板/窄屏（≤1024px）自动收起侧栏（☰ 可展开）。

## 测试

```powershell
npm test           # node tests/run_tests.js
```

- `tests/mock_backends.js`：5 个本地 mock 服务（18701-18704 协议 + 18707 ASR），
  覆盖 SSE 全事件流 / 思考区 / 引用 / cumulative + ##0$$ / 404 回退 / 建会话 /
  error 事件 / 401 / 空回答 / 慢速流 / 静默流 等形态，及 ASR 的
  `/health` / `/v1/models` / transcriptions / chat 回退路径。
- `tests/run_tests.js`：**147 项**断言 —— 协议客户端单测（含超时/取消/错误）+
  真实 server 全链路（会话迁移/创建/CRUD/token 重生成/删除保护、push
  token+session_id 校验与兼容、chat session_id 必填、四协议链路、双客户端
  广播含 session_id、配置深合并落盘、跨会话历史合并、stall/黑洞/拒绝、
  **P3 多用户隔离**：cookie 登录/me/登出、用户创建仅管理、用户私有桶跨主体
  不可见（列表/读/chat 404）、SSE principal 作用域（私有事件不外泄 + agent_id
  补齐）、访问码私有桶、IDOR 写保护（他人桶 401）、智能体 API（列表/详情/管理
  CRUD）、审计日志留痕、最后 active 管理员守护、访问码失效吊销 cookie、
  **ASR 语音输入**：全链路/未配置/非 WAV/404 回退/上游 500/10MB 413/
  测试连接含鉴权/SSE 广播脱敏/客户端断开中止上游（lib 级 + E2E）、
  **电脑输出音频流**：node 模拟推流端（chunked POST + Deflate 帧）覆盖
  401/403/200 建流/SSE started-data-stopped/capture 全链路（ASR→自动提问
  source=remote_audio）/409-400 边界/双设备隔离/坏帧只断单流/断连清理/
  删会话清流/帧解析器+WAV+环形淘汰单测）。
- `tests/store_tests.js`：**35 项** v2 数据层单测（`node tests/store_tests.js`）：
  会话 CRUD/桶语义/历史 100 上限/访问码状态机/管理员迁移/审计日志。
- 环境变量 `ECHOANSWER_IDLE_TIMEOUT_MS` / `ECHOANSWER_CONNECT_TIMEOUT_MS`
  可在测试中缩短超时（生产默认 60000 / 10000）；`ECHOANSWER_DATA_DIR`
  指定会话存储目录（测试用它做隔离）。
- `tests/e2e_local.js`：先 `npm start` 起服务，再运行 `node tests/e2e_local.js`，
  用真实 RAGFlow（127.0.0.1:9380）走 推送（token+session_id）→追问→网页提问→
  错误路径→会话历史 全流程。

## 已知限制

- 同一会话并发多个问答时，后端会话 ID 为后完成者生效（语音场景天然串行，一般无影响）。
- 继承 EchoScribe 已知限制：RAGFlow `legacy: true` 时 think 标签不剥离；
  cumulative 极端情形 LCP 差分可能少量丢字/重复；Dify Chatflow Human Input 节点
  的流会挂起（表现为 60s 块间超时）。
- **语音输入依赖浏览器麦克风**：`http://<IP>`（非 127.0.0.1）属非安全上下文，
  浏览器禁止录音，🎤 按钮自动禁用（tooltip 说明）；需 https（compose `tls`
  profile 自签入口，见 doc/03 §8）或本机 127.0.0.1/localhost 访问。识别质量
  取决于所配置 ASR 服务；单次录音上限 60s、<0.4s 丢弃。
- **局域网自用 + 多用户隔离（v59 P3）**：会话按桶隔离（user 私有 / code / shared），
  会话级端点 IDOR 校验（不可见 404 / 写他人桶 401），SSE 按主体作用域投递；
  `/api/push` 与音频推流公开（凭证 = 会话推送 token）。暴露公网请自行加反向代理鉴权。
- 本目录 config.json / data/echoanswer.db（及 sessions.json.bak-* 归档）内含本机真实 API Key 与推送 token，
  请勿提交到公开仓库。
