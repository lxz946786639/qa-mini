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

- Web 界面：http://127.0.0.1:8787/（新代前端站点根，v59 P7 切根；P8 官网首页四区块：Hero / 智能体选择 / 产品矩阵 / 工作流 → 智能体 → 工作区（首屏导航「控制台」P8.10 仅 admin 可见）；P8.13 区块导航：「立即体验」滚动到智能体区块、「向下探索」可点击、吸附位顶右 / 底右上一 / 下一区块指引；P8.75 动效增强：Hero 入场编排（标题擦入 + 级联 + 回弹）/ 声波行波 / 矩阵连线小圆点（P8.76 回退 P8.75 渐变光带）+ 双卡 hover 按「听/答」角色着色 / 工作流四步顺序点亮 / 导航滑动下划线（reduced-motion 同步关闭））；项目文档 /doc/<文件名>.md）
- 控制台：http://127.0.0.1:8787/admin（仅 admin；未认证自动跳登录页（成功后 ?next 回跳）、已登录非 admin 自动跳首屏；管理密码未初始化时登录页显示首启设置表单）
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
| `ragflow` | url（基址）/ api_key（必填）/ chat_id（必填）/ user（可选，P8.81 续：请求 user 字段，留空 = 不发送；显式建会话时兼作 RAGFlow 会话名，留空 = 默认名 echoanswer） | 新路径 `POST {基址}/chat/completions`（404 回退一次旧路径 `/chats/{chat_id}/completions`）；无会话先 `POST /chats/{chat_id}/sessions` 建会话（RAGFlow ≤v0.24 必需） | 信封 `{code,message,data}`：`data==true` 结束；code≠0 流内报错；session_id 续接；思考区（start/end_to_think）跳过；delta/cumulative 自动识别（LCP 差分）；reference 文档名去重脚注「**参考来源**：…」 |

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
| GET | `/api/sessions` | 会话列表，**按最新对话时间（updated_at）倒序**（摘要：id/name/token/protocol/continue_session/qa_count/active/last_question/last_at/access_mode（**P8.47** 桶标记 shared/user/code；管理端另含 user_id/owner_name））；P3：按主体作用域（只看可见桶） |
| POST | `/api/sessions` | 新建会话。body `{name?, protocol?, continue_session?, agent_id?/agent_code?}` → 201 会话；P3：管理/登录用户（自身私有桶）/访问码主体（自身码桶），匿名 401 |
| GET | `/api/sessions/:id` | 会话详情 `{session（含历史）, running（在途问答+部分答案）}` |
| PUT | `/api/sessions/:id` | 修改会话。body 可选 `{name?, protocol?, continue_session?, regenerate_token?, protocol_config?, audio_remote?}`（会话级协议覆盖：protocol_config 仅管理生效（P8.53，非 admin 提交被静默忽略） / 电脑输出音频 `{enabled, preferred_device}`） |
| DELETE | `/api/sessions/:id` | 删除会话（取消在途问答；删光时自动补建「默认会话」）；无权限 401「您无权限删除（仅会话属主/管理员可删除）」（P8.79） |
| POST | `/api/sessions/:id/reset` | 重置该会话后端上下文（先取消在途问答，再清 dify conversation / ragflow session，对应 EchoScribe「清空」） |
| POST | `/api/sessions/:id/protocol-test` | 会话级协议配置**测试连接**（管理）。body `{protocol?, config?}`（config = 表单草稿；**P8.81** 合并链 = 全局 ← 智能体 ← 草稿，与提问取值一致）→ 200 `{ok, detail}`（ok=false 时 detail = 失败原因，不回显密钥） |
| POST | `/api/admin/protocol-test` | **智能体级测试连接（P8.81）**（管理）。body `{protocol, config?, agent_code?, mode?}`（config = 表单草稿，agent_code = 现有智能体；**P8.81 续 `mode="global"` = 全局级连接探测**：仅连接级配置，ragflow 测地址+Key、dify 测接口可达性（401/403 = 在线）、openai/generic 完整探测，身份级字段不覆盖——系统设置各卡「测试连接（全局配置）」）；同一三层合并链（智能体层仅测试协议 = 智能体协议时参与）+ 前置校验 → 200 `{ok, detail}` |
| DELETE | `/api/sessions/:id/history/:qaId` | 删除单条问答记录（广播 `record_removed`，各浏览器同步移除）；无权限 401「您无权限删除（仅会话属主/管理员可删除）」（P8.79） |
| GET | `/api/events` | SSE 广播（EventSource 自动重连）：连接即推 `sessions` 列表 → `qa_start`/`delta`/`done`（均带 session_id）/`sessions`（列表变更）/`session_reset`/`config`（**P8.33** 带 `?dev=` 设备指纹入在线注册表；踢出冷却期内 403 `evicted`） |
| GET | `/api/events/check` | **P8.33 踢出探针** `?dev=`：仅回答本端 dev+IP 是否处于踢出冷却（无需主体；冷却期 403 `evicted`） |
| POST | `/api/cancel` | `{id}` 取消在途问答（保留部分答案） |
| POST | `/api/session/reset` | 全量重置（兼容旧接口：重置所有会话） |
| GET | `/api/history` | 全部会话最近 100 条 Q&A 合并（新→旧，含 session_id） |
| GET | `/api/config` | 读取配置（协议级） |
| PUT | `/api/config` | 修改配置（深合并 + 写盘 + 广播；port 变更需重启生效） |
| GET | `/api/health` | 存活 / 会话数 / 在途 QA / 广播客户端数 / asr_configured |
| GET | `/api/status` | 公开状态：`{ok, allow_anonymous（P8.44 起恒 true）, admin_set}`（无敏感信息） |
| POST | `/api/admin/login` | 管理登录 `{password}` → 管理 token（未设密码时输入即初始化；12h；P3 起同时下发 `ea_sid` cookie） |
| POST | `/api/access/login` | 访问码登录 `{code}` → 访问 token（24h，≤码有效期） |
| POST | `/api/admin/access-codes` | 生成访问码 `{code?, hours?, count?}`（6 位；可多个，每个码独立时长，默认 8h；批量随机 1-10。**P8.51 新码默认最小权限**：不允许任何智能体，需经权限接口放行 个） |
| POST | `/api/admin/access-codes/:code/renew` | 该访问码延期 `{hours?}`（默认 +8h） |
| DELETE | `/api/admin/access-codes/:code` | 访问码一键失效（已发 token 同步吊销） |
| PATCH | `/api/admin/access-codes/:code` | **P8.40/P8.51 权限范围三态** `{agent_scope: string[] \| null}`（空数组 = 允许全部智能体；null = 不允许任何（最小权限）；非空 = 仅列出的 agent id；范围外访问 = 404/403 门控；镜像经 `GET /api/config` 的 `security.access_codes[].agent_scope` 暴露） |
| DELETE | `/api/admin/access-codes/expired` | 清理全部已过期码 |
| POST | `/api/auth/login` | **P3 用户登录** `{username, password}` → 200 + `ea_sid` cookie（HttpOnly/SameSite=Lax，12h，落 DB 可吊销） |
| POST | `/api/auth/access-code` | **P3 访问码登录** `{code}` → 200 + `ea_sid` cookie（无匿名捷径；无效/过期 401） |
| GET | `/api/auth/me` | 当前主体 `{principal（admin/user/code）, anonymous?}` |
| PUT | `/api/auth/me` | **P8.55 个人设置自助**（账号主体）：`{display_name?, old_password?, new_password?}`（改密码需当前密码校验；访问码/匿名 401） |
| POST | `/api/auth/logout` | 吊销当前 cookie 会话 |
| GET | `/api/agents` | 启用中智能体列表（首屏选择器：code/name/description/protocol/…；P8.9 全量展示含 `allow_anon/allow_code/allow_user` 供访问徽标，门控在入口端点） |
| GET | `/api/agents/:code` | 智能体详情 + 该主体可见会话 + 协议配置（api_key 脱敏；未放行该智能体的主体 → 404） |
| GET/POST | `/api/admin/users` | 用户列表 / 创建（**仅管理**；用户名 2-32、密码 4-64、role user/admin；**P8.51 新建用户默认最小权限**：不允许任何智能体，需经 PATCH 放行） |
| PATCH | `/api/admin/users/:id` | 用户修改 `{display_name?, role?, status?, password?, agent_scope?}`（不能降级/停用最后一个 active 管理员；停用即吊销其 cookie；**P8.40/P8.51** `agent_scope` = 权限范围三态：空数组 = 全部智能体、null = 不允许任何（最小权限）、非空 = 仅列出的智能体；管理员恒全量不受限） |
| GET/POST | `/api/admin/agents` | 智能体列表（含停用）/ 创建 `{code, name, protocol?, config?, allow_anon?, allow_code?, allow_user?}`（每智能体一个协议，存 agent_configs；P8.8 访问控制三开关，默认全放行；**P8.81 身份字段必填**：ragflow.chat_id / openai.model / dify.api_key 留空 → 400 指明字段，协议切换旧协议字段作废重验；列表返回 `config_status`（逐身份字段 custom/global/none）+ `config_complete`，api_key 掩码「…已设置」，保存回传该值 = 保留原值（哨兵）） |
| PATCH | `/api/admin/agents/:code` | 智能体修改 `{name?, description?, icon?, enabled?, sort?, protocol?, config?, allow_anon?, allow_code?, allow_user?}`（P8.8 三开关 = 匿名/访问码/普通用户放行，admin 恒可用，允许匿名 = 超集；协议/配置变更清空该智能体会话后端会话 ID；**P8.81** config 哨兵「…已设置」= 保留原值，空串 = 清空回退全局，缺省键 = 保留） |
| GET | `/api/admin/audit` | 审计日志（管理操作留痕；`?limit=&offset=` 分页，默认 100 上限 500） |
| GET | `/api/admin/stats?days=7&fresh=1` | **仪表盘统计（P8.48）**：访问/提问/活跃/运行多维聚合（每日×身份提问与成功率、每日登录/新建会话、近 7 天按小时活跃、智能体/协议维度、错误 Top8、总量与实时运行情况；**P8.50** agents 行新增 `icon` 字段（仪表盘智能体排行展示用））；`days` 1–90 缺省 7（非整数或 <1 → 400，>90 截断），`fresh=1` 强制重算（缺省 30s 缓存）；仅 admin |
| GET | `/api/admin/security?days=7&fresh=1` | **安全监控总览（P8.49）**：24h 登录成功/失败 + 提问分桶 + 逐日聚合 + 风险告警（登录爆破 ≥5 高危 / ≥3 关注、提问高频、错误激增）+ Top IP（近 7 天审计 ∪ 近 24h 提问）+ 封禁（生效 + 近 7 天过期）+ 最近 20 安全事件；`days` 1–90 缺省 7，`fresh=1` 强制重算（缺省 30s 缓存）；仅 admin |
| GET | `/api/admin/security/events?limit=&offset=` | **安全事件流（P8.49）**：账号/管理员/访问码登录与失败、一键踢出、IP 封禁/解封/自动封禁 留痕；`limit` 1–500 缺省 100 |
| GET | `/api/admin/security/bans` | **封禁列表（P8.49）**：生效 + 近 7 天过期（原因/操作人/到期/生效标记） |
| POST | `/api/admin/security/bans` | **手动封禁（P8.49）** `{ip, minutes（0-43200 缺省 60，0=永久）, reason（≤200）}` → 201；非法 ip/minutes 400、已有生效 409；被封 IP 的 `/api/*` 请求 403（admin 豁免） |
| DELETE | `/api/admin/security/bans/:ip` | **解除封禁（P8.49）** → 200；无记录 404 幂等 |
| GET | `/api/admin/online` | **P8.33/P8.35 在线访问者**（登录用户/访问码按会话、匿名按长连接「设备指纹 + IP」：身份/设备/IP/连接数/在线开始/最近活跃；仅管理） |
| POST | `/api/admin/online/kick` | **P8.33/P8.35 一键踢出**：`{session_id}` 会话目标（evicted + 会话吊销，无冷却）或 `{dev, ip}` 设备目标（evicted + cookie 吊销 + 5 分钟禁入冷却）；已不在线 404 / admin 400；仅管理） |

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
    "ragflow": { "url": "", "api_key": "", "chat_id": "", "user": "" }
  },
  "asr": { "url": "", "api_key": "", "model": "", "language": "", "timeout": 60 },  // 网页语音输入所用 ASR 服务（OpenAI 兼容；空 url = 未启用）
  "audio_stream": { "max_buffer_s": 120, "min_capture_s": 5, "default_capture_s": 30, "max_capture_s": 60 }  // 电脑输出音频流（推流缓冲/截取秒数，见 doc/02 §1）
}
```

内置默认为**空模板**（公开仓库安全：代码不含真实 key/token）；首次启动请在
网页「⚙ 设置」抽屉填入后端 url/api_key/chat_id 并保存（PUT /api/config 落盘）。
协议配置为**全局**（所有会话共用 url/key/chat_id），会话只决定走哪个协议。

## Web 界面

- **新代前端（v59 P4–P7，站点根）**：web/ 构建产物（Vue3 + Vite + TS + Element
  Plus + Pinia + PWA，独立 package，仅 web/ 用 npm；根项目后端保持零依赖）直接作为
  站点根（P7 切根；旧 `/app/` 挂载与 `public/` 旧前端退役）。路由：`/` 官网首页（P8 四区块：
  Hero / 智能体选择（`GET /api/agents` 全量真实卡，无示例卡）/ 产品矩阵（EchoScribe ×
  EchoAnswer）/ 完整工作流（四步）；landing.css `--lp-*` 双主题 + IO 滚动渐入 +
  P8.75 动效增强（Hero 入场编排 / 声波行波 / 矩阵连线小圆点（P8.76 回退渐变光带）+ 角色着色 hover /
  工作流四步顺序点亮 / 导航 scrollspy 滑动下划线；prefers-reduced-motion 全量关闭）；
  主题首访跟随系统、手动切换持久化）+ `/doc/<文件名>.md` 项目文档静态路由 +
  `/login`（账号 / 6 位访问码 → `ea_sid` cookie；
  管理密码未初始化时先显示「初始化管理账号」表单，初始化后直接以 admin 进入）+
  `/agents/:code` 工作区（P5：按智能体过滤的「我的会话」+ 流式问答卡片 + SSE 实时事件 +
  停止/复制（问题/答案）/删除/重新生成（确认，含错误卡；P8.79：无权限被拒时透传服务端原因「您无权限删除…」，不再通用「删除失败」）/ 输入框底部「停止」/ 上滑「↓ 最新」
  浮钮 + 流式自动跟随 / 生成中实时秒数（P8.12 会话窗口交互对齐重构前）+ P8.14 卡片样式对齐旧版（问/答单卡 / 来源·协议胶囊徽章 / 「完成（N 字）」/ 图标化操作按钮 / 流式光标 / 发送纸飞机）；P7.2 布局对齐旧版 + P8.5/P8.6 满宽顶栏对齐首页
  （官网同款 logo + 「EchoAnswer · 智能体名」左上角（P8.15）、右侧 = 显示/会话设置 ghost 按钮 +
  主题/控制台/用户名下拉「退出」，会话栏下移至顶栏之下，头部右缘 ☰ 收起为 44px 窄栏），
  左固定会话栏 252px + 主列滚动区/composer，卡片与输入框按 860/1180/铺满 同宽居中，
  窄屏会话栏抽屉；**P8.72 移动端专项**（≤720px）：顶栏两行规整 + 汉堡打开会话列表抽屉（遮罩点外关闭）、卡片/输入框 12px 左右边距（窄/宽/铺满一致）、问题行换行修复、composer 两行、控制台顶栏单行紧凑 + 导航抽屉可收起、定宽对话框缩至屏宽；**P8.73**：移动端顶栏按钮纯图标化（高度再降）、卡片状态行单行、「重新生成」仅最新卡片显示；
  **P8.74**：系统设置表单行移动端改「标签置顶 / 输入框满宽」（原固定标签致输入框过短；P8.77 修正覆盖块规则顺序，标签左对齐生效）；**P8.78**：移动端首页排版优化（产品矩阵双卡加行距原贴在一起 / 工作流 chevron 行距放宽 / 「上一区块」边缘钮移至左下底角避免遮挡区块标题与标语）；
  P7.7 修复：侧栏过滤改用智能体 id（与服务端会话归属一致）；P7.8 修复：主区
  历史卡片读取 `session.history` 嵌套字段）+ 语音输入（P5.5：🎤 麦克风 → /api/asr，60s/
  0.4s/1.5s 中间识别，自动发送开关）+ 电脑输出音频识别面板（P5.5：EchoScribe 持续
  推流，设备下拉/开始/停止定稿/重新开始/取消，管理视图；提问框「音频」入口仅对启用
  「电脑输出音频接收」的会话显示（P8.69，原 P7.10 常显 + 前置条件提示改会话级门控）、
  语音/音频双向互斥、识别中…状态）+ 会话设置对话框（P5.5；
  P7.9 按重构前旧抽屉重排版，P8.7 内容分类为 5 个 tab 缩短弹窗：基本（名称/协议/
  续接）/ 协议配置（修改后需测试通过才能保存）/ EchoScribe（会话 ID / 推送 token
  回显·重生成 / 配置片段 / body 值，均可复制，管理页签）/ 音频（含首选设备）/ 管理
  （重置后端上下文，管理页签）；底部 保存状态 + 删除会话 + 保存；**P8.67 表单行距统一**：字段注记并入 label、token 警示贴控制项、独立指引不占表单行距、弹窗体超高内部滚动）+ 显示偏好
  （P7：字号 / 内容宽度 / 行间距，顶栏「⚙ 显示」，
  localStorage 键沿用旧版；P8.65 顶栏「仅阅读」开关：收起底部输入框不占空间，echoanswer-readonly 记忆）+ 主题切换 ☀️/🌙（P7.4：Element Plus 组件变量全量映射项目色板，
  深色/浅色双色调，对话框/表格/下拉/输入/标签全适配；P7.6 移除 EP html.dark
  官方暗色机制修复浅色残留深色）+ 顶栏右侧统一（P8.4：无描边主题按钮 +「控制台」
  + 用户名下拉「退出」，与官网首页同排版/交互）+ 图标（P7.5：全站 emoji 换 Element Plus
  图标库 @element-plus/icons-vue）+ `/admin` 控制台（P6，Ant Design Admin 风格左侧导航布局：仪表盘（**P8.48 默认页签，P8.50 信息架构重构**：五层结构——五张核心指标卡（今日提问 / 在线访客 / 期间提问 / 成功率 / 平均响应，含环比与 sparkline）+ 提问趋势面积折线（身份切换：全部 / 管理员 / 用户 / 访问码 / 匿名，成功率作头部文字）+ 系统状态（服务正常 + 2×4 网格）+ 智能体使用（单智能体摘要卡 / 多智能体 Top5 排行 + 点击详情）+ 用户活跃（24h 热力图 + 登录 / 新建会话迷你趋势）+ 协议使用（四协议比例条 + 启用状态，停用灰色）+ 系统异常（无错误 = 健康态，否则错误数 / 率 + Top5）+ 智能体明细表；ECharts 三图 + 轻量 HTML、空态设计、统一主题视觉；近 7/14/30 天 + 60s 自动刷新（可关、无全页闪烁）+ 手动刷新）/ 用户 / 智能体 / 访问码 / 审计日志 /
  系统设置七页签（**P8.39 当前页签写入 URL `?tab=`，刷新保持对应菜单页；默认「仪表盘」不带参数**；**P8.41 系统设置内三类配置分 tab**：协议全局默认 / 语音输入 ASR / 访问控制，各 tab 独立保存；**P8.43 协议启用状态**：协议全局默认各协议卡片「启用协议」开关，停用后该协议智能体提问被拒（400「已停用」）、智能体管理列表加红色「已停用」标签、新建/改选停用协议被拒；**P8.81 系统预设重构**：协议全局默认仅连接级（身份字段 chat_id/model/api_key 移智能体级必填，表单行改提示文案 + 各卡片 URL/Key 配置状态徽标；generic 卡片「测试连接」）；智能体管理增「配置状态」列 +「测试」操作 + 每字段配置来源标签（自定义/继承全局/未配置）与「恢复默认」+ 保存必填校验；三层解析 全局 ← 智能体（仅会话协议 = 智能体协议时参与）← 会话（逐字段非空胜）；**P8.33/P8.35 新增「访问控制」**：在线访问者列表（登录用户 / 访问码用户按会话统计、匿名按长连接；设备指纹 + IP 判定唯一，5 秒自动刷新）+ 一键踢出（会话目标 = 会话吊销、设备目标 = 5 分钟禁入冷却；目标页提示并跳登录页，重新登录后 `?next` 回跳原页），踢出动作审计留痕 `access.kick`）；**P8.49 新增「安全监控」/ P8.61 重构**：访问/提问监测（安全态势 5 卡 + 24h 安全活动趋势图）+ 风险告警（登录爆破 / 提问高频 / 无效码猜测 / 错误激增，高危红/关注橙分级；查看 IP → 详情 → 封禁，一键封禁快捷操作）+ 风险态势（按类型分布）+ IP 安全活动排行（风险等级 / 状态 / 查看·封禁|解封）+ 安全事件留痕（登录/访问码/踢出/封禁/解封/自动封禁筛选 + 时间线，最近 20 + 加载更多）；封禁入口统一「IP 管理」Drawer（搜索 / 全部·生效中·已过期 / 解封）+「封禁 IP」二级弹窗（任意 IP / 时长预设+自定义 / 原因预设+备注 / 提交前风险提示）+「IP 详情」Drawer（状态/活动/风险/封禁信息），`?tab=security`，仅 admin 主体），仅 admin 主体；**管理密码未初始化时显示首启「设置管理密码」表单**，
  对齐旧版 /admin 首屏；P8.8 智能体新增/编辑对话框分类为 tab（基本/协议/安全；**P8.81** 协议 tab：身份字段必填 + 每字段来源标签（自有值 + 上层无默认 = 不标记「自定义」）/「恢复默认」（仅上层有默认值时显示）/「测试连接」+ 留空（继承）字段 placeholder 回显上层值（密钥 = 同长度圆点）），
  安全页 = 访问控制三开关（允许匿名访问 / 允许访问码访问 / 允许普通用户登录访问，
  不同访问方式会话落独立桶互不可见，全关 = 仅管理员）；P8.9 首页智能体卡片随控制台
  配置动态展示 + 访问徽标（无需登录 / 需登录 / 需访问码 / 仅管理员），当前主体无权
  进入时点击 → 登录页（`?next` 登录成功回跳），工作区被门控且未登录 → 「去登录」
  按钮）。开发：`cd web && npm install && npm run dev`（vite dev
  代理 /api → 127.0.0.1:8787）；构建：`npm run build` → `web/dist`（构建产物随仓库
  提交，服务器直接挂载，部署不跑前端构建）。
- **旧前端（P7 退役）**：原根路径纯静态界面（`public/` 目录：index.html / app.js /
  icons.svg / style.css）已删除，能力全量迁移到新代前端与控制台：

  | 旧功能 | 新位置 |
  |---|---|
  | ⚙ 设置抽屉（协议全局配置 / 语音输入 ASR / 安全配置） | 控制台「系统设置」模块（协议全局默认 protocols（**P8.43 含各协议「启用协议」开关**；**P8.81 仅连接级**——身份字段移智能体级必填（**P8.81 续 RAGFlow 卡增连接级 User 标识**，同 Dify），**P8.81 续各卡「测试连接（全局配置）」**= 全局级连接探测（身份字段不覆盖）） / ASR + 测试连接；**P8.44 移除匿名访问开关**） |
  | 管理密码首次初始化（/admin 首屏输入即初始化） | `/admin` 控制台首启引导 + `/login` 首启表单（管理密码未设置时两处均显示「设置管理账号」表单，POST /api/admin/login 初始化通道，成功后直接以 admin 登录） |
  | 会话设置抽屉（token/会话ID/EchoScribe 片段/重置） | 工作区会话设置对话框（⋯ → 设置；管理视图含 token 回显/重新生成/toml 片段/重置后端上下文） |
  | 🎤 语音输入 / 🎧 电脑输出音频 / 多浏览器同步 / PWA | 工作区（P5.5 移植，见上条） |
  | 字号 / 内容宽度 / 行间距（localStorage） | 工作区顶栏「⚙ 显示」（localStorage 键沿用 echoanswer-font / -width / -line，旧偏好继续生效） |
  | 访问码（自愿以码主体进入：码私有桶 + 权限范围） | `/login` 访问码登录（**P8.46 登录页双页签：访问码在前、默认显示，账号登录第二**）；码的生成/管理在「访问码」页签（**P8.44**：首屏与匿名问答恒公开，码不再是强制门禁） |

- **访问控制**：控制台 `/admin` 仅 admin 角色（账号登录；访问码/匿名不可用）。
  **P8.44 移除匿名访问开关**（「系统设置」仅留协议全局默认 / 语音输入 ASR 两页签）：
  首屏与匿名问答恒公开，访问码为自愿入口（码私有桶 + 权限范围）：**可生成多个，每个码
  独立有效时长**（默认 8h，可自定义/随机、批量 1-10 个、单个延期、一键失效、清理
  过期）。权限模型与端点表见 doc/01 §3.4，字段说明见 doc/02 §7。

## 测试

```powershell
npm test           # node tests/run_tests.js
```

- `tests/mock_backends.js`：5 个本地 mock 服务（18701-18704 协议 + 18707 ASR），
  覆盖 SSE 全事件流 / 思考区 / 引用 / cumulative + ##0$$ / 404 回退 / 建会话 /
  error 事件 / 401 / 空回答 / 慢速流 / 静默流 等形态，及 ASR 的
  `/health` / `/v1/models` / transcriptions / chat 回退路径。
- `tests/run_tests.js`：**172 项**断言 —— 协议客户端单测（含超时/取消/错误）+ **P8.81 配置体系重构**（三层优先级 / 身份字段必填 400 / 智能体级测试端点 / v8 回填行为保持）+ **全局级连接探测（mode=global）** +
  真实 server 全链路（会话迁移/创建/CRUD/token 重生成/删除保护、push
  token+session_id 校验与兼容、chat session_id 必填、四协议链路、双客户端
  广播含 session_id、配置深合并落盘、跨会话历史合并、stall/黑洞/拒绝、
  **P3 多用户隔离**：cookie 登录/me/登出、用户创建仅管理、用户私有桶跨主体
  不可见（列表/读/chat 404）、SSE principal 作用域（私有事件不外泄 + agent_id
  补齐）、访问码私有桶、IDOR 写保护（他人桶 401）、智能体 API（列表/详情/管理
  CRUD）、审计日志留痕（含访问码登录/登出 + 设备指纹，P8.29）、最后 active 管理员守护、访问码失效吊销 cookie、
  **P8.33/P8.35 访问控制**（在线列表设备 + IP 分组 / 踢出 evicted + 断流 / 冷却期探针 + 重建长连接 403 / 码会话吊销 / 管理员不可踢 / 离线 404 / 审计 access.kick / **P8.35** 访问码·用户会话无长连接在线 / 会话踢出吊销 cookie 无冷却 / 管理员会话 400 / 已吊销 404）、
  **P8.48 仪表盘统计**（GET /api/admin/stats 鉴权 401 / days 缺省 7·999 截断 90·0→400 / 四主体分桶聚合差值法 + 协议·智能体维度 + 错误注入）、
  **P8.49 安全监控**（/api/admin/security 鉴权 401 / days 边界 / 手动封禁 XFF 假 IP → 公开 API 403 拦截 + admin 豁免 + 非法 400 / 重复 409 / 解封 200→404 幂等 / 10 次登录爆破自动封禁 + 再登录 403 + 审计 security.auto_ban / 安全事件流动作集合与分页）、
  **ASR 语音输入**：全链路/未配置/非 WAV/404 回退/上游 500/10MB 413/
  测试连接含鉴权/SSE 广播脱敏/客户端断开中止上游（lib 级 + E2E）、
  **电脑输出音频流**：node 模拟推流端（chunked POST + Deflate 帧）覆盖
  401/403/200 建流/SSE started-data-stopped/capture 全链路（ASR→自动提问
  source=remote_audio）/409-400 边界/双设备隔离/坏帧只断单流/断连清理/
  删会话清流/帧解析器+WAV+环形淘汰单测）。
- `tests/store_tests.js`：**47 项** v2/v3/v4/v5/v6/v7/v8 数据层单测（`node tests/store_tests.js`，含 P8.8 v2→v3 迁移、P8.10 v3→v4 回填、P8.29 v4→v5 审计设备指纹列、P8.40 v5→v6 权限范围列、P8.49 v6→v7 ip_bans 表、P8.81 v7→v8 身份字段回填 + 全局清空）：
  会话 CRUD/桶语义/历史 100 上限/访问码状态机/管理员迁移/审计日志 + P8.49 ip_bans CRUD（覆盖语义 / 过期判定 / 永久 / 7 天窗口列表）。
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
