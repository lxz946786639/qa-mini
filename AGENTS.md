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
8. 提交前必须跑 `npm test`（tests/run_tests.js，当前 173 项断言全绿，
   含前端构建产物完整性护栏）+ `node tests/store_tests.js`（v2–v8 数据层 47 项）；
   测试用 `ECHOANSWER_DATA_DIR` 临时目录隔离，**不得写真实 data/ 目录**。
9. **禁止使用 emoji 图标（P8.25）**：界面图标字形一律使用 UI 框架图标集
   （Element Plus 图标）或官网首页内联 SVG；智能体图标字段 `agents.icon` 存
   Element Plus 图标名（映射/归一化在 `web/src/utils/agentIcon.ts`），模板/样式
   中不得再引入 emoji 字形作为图标。

## 3. 代码-文档同步规则（核心）

`doc/` 文档清单（新增文档主题时必须同步登记本表）：

| 文档 | 覆盖范围 |
|---|---|
| `doc/01-项目设计文档.md` | 架构、目录结构、功能模块设计说明（§2.3 M1–M10）、会话模型、问答流程、协议设计、存储 schema、前端设计、测试与安全、修订说明（§10，每次调整必须追加一行） |
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
                 ea_sid cookie）· principal 桶可见性 · 访问码 · 音频监听 · 配置同步 · 安全监控（P8.49 封禁守卫 / 自动封禁 / 总览聚合））
                 / routes/（按端点分组的路由模块；P3 会话级端点 IDOR 校验；P8.49 routes/security.js 安全监控 5 端点）
lib/asr.js       ASR 语音识别转发客户端（网页语音输入；OpenAI 兼容，与 EchoScribe 同源）
lib/audio_stream.js 电脑输出音频流（EchoScribe 持续推流）：帧解析 + 会话×设备环形缓冲
lib/auth.js      密码哈希（scrypt s1:）/ 令牌 / 限流器（v2 鉴权基座）
lib/config.js    配置加载/深合并/校验 + protocolEnabled（P8.43 全局协议启用状态）+ 旧 JSON 会话兼容（存储已迁 store.js）
                 + P8.81 三层解析 resolveProtocolConfig（全局 ← 智能体（仅会话协议 = 智能体协议时
                 参与，PROTOCOL_FIELDS 过滤）← 会话，逐字段非空胜）+ 身份字段 IDENTITY_FIELDS/
                 PROTOCOL_FIELDS + 保存哨兵 AGENT_CFG_KEEP_SENTINEL（「…已设置」= 保留原值）
lib/migrations.js v1→v2→v3→v4→v5→v6→v7→v8 数据迁移（重命名/备份/播种/归属回填，user_version；v3 = agents 访问控制列；v4 = P8.10 管理员新建会话回填管理员私有桶，无 DDL；v5 = P8.29 audit_logs.user_agent；v6 = P8.40 users/access_codes.agent_scope 权限范围；v7 = P8.49 ip_bans IP 封禁表；v8 = P8.81 身份字段回填智能体 + 清全局（DB + config.json，先备份），无 DDL）
lib/qa_runner.js 会话管理（SessionManager + QaRunner，会话隔离边界；P8.81 协议配置 = 三层解析 全局 ← 智能体（协议匹配门控）← 会话，前置校验按合并值）
lib/protocols/   四协议客户端（openai/dify/generic/ragflow），行为与 EchoScribe 对齐
lib/sse.js       QaError（协议错误载体）
lib/store.js     v2 数据层（唯一允许碰 data/ 库文件的模块；node:sqlite：
                 sessions/records/users/agents/访问码/cookie 会话(auth_sessions)/审计日志；
                 P8.21 normalizeLegacyFinished 启动归一化遗留空 finished_at）
public/          （P7 已退役：旧纯静态前端目录已删除，能力全量迁移至 web/）
web/             新代前端（v59 P4 起，独立 package；P7 起即站点根）：Vue3+Vite+TS+Element Plus+Pinia+PWA；
                 src/（views: Landing(P8 官网首页四区块：Hero/智能体选择/产品矩阵/工作流，
                 landing.css --lp-* 双主题 + 内联 SVG + IO 渐入 + P8.72 移动端：超高区块（工作流）区块内自由滚动、滚到边缘才吸附（修手机滚不到区块底；普通区块一步一区块行为不变）+ ≤640px 导航链接隐藏时孤儿分隔线一并隐藏 + P8.75 动效增强（纯 CSS + 现有 JS 钩子，零新依赖：Hero 入场编排（标题 clip-path 擦入 + 级联延迟 + 回弹曲线 + 视觉区自右滑入，revealInit 对 Hero 不设内联 delay）/ 声波行波（逐柱 0.12s 相位）/ 矩阵连线小圆点（P8.76：P8.75 渐变光带按用户反馈回退）+ 双卡 hover 按「听/答」角色着色（P8.76 保留）/ 工作流四步顺序点亮（--lp-on 关键帧离散切换 + transition，与光点同相位）/ 导航 scrollspy 滑动下划线 .lp-nav-ink（跟随吸附区块，JS 量测 offsetLeft/width）；reduced-motion 同步扩展）+ P8.78 移动端排版（≤640px）：矩阵单列双卡加 14px 行距（原贴在一起）+ 卡 padding 18→20 / 列表行距 10→12 + 工作流 chevron 行 gap 6→10 + 「上一区块」边缘钮右上→左下底角（原与区块标题重叠）+ 区块顶 padding 84→74px / 注记 margin 收紧避开底部 dock）)/Login/Workspace(P5 工作区 + P5.5 语音输入/
                 音频识别/会话设置 + P7 显示偏好 + P7.2 布局对齐旧版会话窗口 + P8.12 会话窗口交互对齐旧版：问题复制/输入框底部停止/重新生成确认（含错误卡）/「↓ 最新」浮钮 + 流式自动跟随/生成中实时秒数（后端配套：recordFromRow 回读补齐 status 字段）+ P8.14 卡片样式对齐旧版（问/答单卡/胶囊徽章/完成（N 字）/图标按钮/流式光标/发送图标）+ P8.15 顶栏品牌位 =「EchoAnswer · 智能体名」（P8.52 点击品牌位/左上角 Logo = 刷新本页，不再跳首屏）+ P8.54 空会话提示通俗化（「这个会话还没有问答」+ EchoScribe 对接专业信息默认折叠「查看更多」，style.css .ws-empty-toggle/.ws-empty-detail）+ P8.55 用户名下拉「个人设置」（显示名 + 修改密码对话框 components/ProfileDialog.vue，PUT /api/auth/me 自助；控制台顶栏同款）+ P8.56 下拉菜单项 nowrap 防换行（.user-menu min-width 132px）+「退出」SwitchButton 图标 + P8.59 用户可见界面去除实现生命周期文案（系统设置副标题 P 标签括注、设备名「（旧版序号编码）」提示；代码注释/文档中的 P 标签保留）+ P8.63 显示偏好浮层修复（三个 el-select 改 :teleported=false，点选选项不再触发 popover 点外关闭收起浮层；浮层 300→340px + 自定义数值框定宽 78px 防右缘裁切）+ P8.64 字号自定义上限 28 → 36px + P8.65 仅阅读开关（顶栏右侧，收起底部 composer 不占空间，.ws-col.readonly .ws-foot display:none，localStorage echoanswer-readonly）+ 末卡与输入框间距收紧（ws-main 底 padding 30→10、末卡底距 0、footer 顶 padding 6）+ P8.66 SSE 连接状态点移至顶栏右侧（后 P8.70 移回）+ P8.70 连接状态移回会话列表左下角（.ws-side-foot 恢复；收起窄轨底部仅显示状态点居中，文字 font-size:0；顶栏副本移除）+ P8.71 窄轨状态点落底（收起态 margin-top:auto——列表 display:none 后无 flex:1 撑底）+ P8.68 修复窄轨排版（P8.66 误删分组选择器末行致 title/list/empty 失去 display:none：恢复三规则 display:none，窄轨仅留 + / 展开图标纵排）+ P8.69 提问框「音频」入口会话级门控（仅 audio_remote.enabled 的会话显示，未启用整钮隐藏；openAudioPanel 保留前置条件提示兜底）+ P8.87 会话重置分隔线（重置前最后一条对话卡后渲染 .ws-reset-divider：双横线 + 胶囊「会话已重置 · 以下为新的上下文」；重置时间戳 localStorage echoanswer-reset-mark 按会话持久化，session_reset SSE 落标记）+ P8.72 移动端专项（≤720px）：顶栏汉堡按钮 = 会话列表抽屉唯一入口（原窄屏无入口）+ 抽屉遮罩（点外部关闭、选中会话自动关闭）+ 卡片/输入框统一 12px 左右边距（窄/宽/铺满同口径）+ 问题行 flex-wrap 与 .q-text min-width:0（修中文问题被挤压成单字一行）+ composer 底部两行（协议标签独占一行、操作行左对齐）+ 顶栏两行规整（品牌单行省略、按钮左对齐换行）+ 全局定宽 el-dialog ≤720px 缩至屏宽内 + 体内滚动) + P8.79 删除（记录/会话）与重新生成被拒时透传服务端 detail（无权限 =「您无权限删除（仅会话属主/管理员可删除）」，原通用「删除失败」）) + P8.30 会话栏头部：新建改图标按钮、收起/展开 Fold/Expand 语义图标 + P8.34 三视图登出统一跳登录页（?next 记忆原页，登录成功回跳原页）+ P8.45 登出场景细分：首屏登出保持在首屏、控制台登出返回首屏、工作区登出（及被踢出）仍跳登录页 ?next 回跳
                 + P8.47 会话列表桶标记：侧栏条目标注桶类型（共享 / 我的；管理端「私有·属主」/「访问码」，悬停可见性说明）；
                 列表项含 access_mode，管理端另含 user_id/owner_name）
                 + P8.37 顶栏一键分享（Share 图标按钮，复制智能体链接，非安全上下文 execCommand 回退）
                 + 匿名直访被门控智能体 → 自动跳登录页（?next 登录成功回跳；已登录无权 → 友好提示卡））)/
                 AdminView(P6 控制台：左侧导航 + 顶栏标题/副标题 + 内容卡片，Ant Design Admin 风格；
                 users/agents/codes/online/security/audit/sys 八模块（P8.49 增「安全监控」） + P7 首启引导 +
                 P8.48 仪表盘（默认页签，tab=dash 缺省；views/admin/DashboardTab.vue +
                 composables/useEcharts.ts：ECharts 模块化注册 + EP CSS 变量主题自适应；
                 GET /api/admin/stats?days=7|14|30[&fresh=1] 多维聚合，纯查询无 DDL，30s 缓存；
                 提问趋势/访问趋势/活跃时段/智能体/协议/错误分布 + 运行情况 + 六指标卡；
                 60s 自动刷新可关）；
                 P8.50 仪表盘信息架构重构（五层阅读路径：核心指标五卡（今日提问 / 在线访客 / 期间提问 /
                 成功率 / 平均响应，环比 + sparkline，运行时长移入系统状态）→ 提问趋势（面积折线 +
                 身份切换【全部/管理员/用户/访问码/匿名】，成功率作头部文字）+ 系统状态（绿点 + 2×4 网格：
                 运行时长 / 在线 / 进行中 QA / SSE / 活跃用户 / 访问码 / 智能体 / 期间提问）→ 智能体使用
                 （单智能体 = 摘要卡（图标 / 提问 / 成功率 / 均耗时 / 最近活跃），多 = Top5 排行行（图标 / 比例条）
                 + 点击行选详情，期间无数据 = 空态）+ 用户活跃（24h 热力图（固定近 7 天本地时区）+ 登录 /
                 新建会话迷你双折线 + 期间合计）→ 协议使用（四协议行 ●已启用 / ○未启用（灰色）+ 比例条 +
                 次数 / 成功率 / 均耗时）+ 系统异常（0 = EP CircleCheck 健康态，否则错误数 + 错误率 + Top5）
                 → 智能体明细表；ECharts 实例 6 → 3（趋势 / 热力 / 迷你趋势；useEcharts 增 Heatmap /
                 VisualMap + accent / overlay 主题色 + 统一 softTooltip），排行 / 比例 / 异常 / 状态改轻量 HTML；
                 各模块空态设计；刷新保留旧数据静默更新（无全页闪烁）；数据源不变 GET /api/admin/stats
                 （agents 行新增 icon 字段：store agent 查找 + 路由透传 agents.icon））；
                 P8.49 安全监控（views/admin/SecurityTab.vue：访问/提问监测 + 风险告警（爆破 / 高频 / 无效码 / 错误激增）+ IP 封禁（手动 1h/24h/7d/永久 + 自动封禁 security.auto_ban）与解除 + 安全事件留痕；GET /api/admin/security?days=7|14|30[&fresh=1] + /events 加载更多 + /bans 手动 CRUD（ip_bans 表，v7）；60s 自动刷新可关）；
                 P8.61 安全监控重构（五区信息架构：安全态势 5 卡 → 24h 安全活动趋势（登录成功/失败堆叠柱 + 提问折线）→ 风险告警（高危/关注分级）/风险态势 → IP 安全活动排行（排行 ≠ 封禁管理上限）→ 安全事件（分段筛选 + 时间线）；封禁入口统一：顶栏「IP 管理」Drawer（搜索 / 全部·生效中·已过期 / popconfirm 解封）+「封禁 IP」二级弹窗（任意合法 IP / 时长 1h/24h/7d/永久/自定义 / 原因预设 + 备注 / 提交前风险提示）+「IP 详情」Drawer（状态标 / 活动概览 / 风险 / 封禁信息 + 封禁此 IP / 解除封禁）；封禁/解封后统一 fresh 刷新同步；仅前端重构，API 零改动）+ P8.62 控制台门控改直接跳转（非 admin 不再显示「无管理权限」页：未认证 → /login?next=/admin 登录成功回跳、已登录非 admin → 首屏；Login backTarget：/admin + 非 admin → /；/admin 内首启引导表单移除，首启由登录页承载；纯前端）；
                 P8.72 移动端（≤720px）：顶栏单行紧凑（副标题隐藏，高度 133→47px）+ 导航抽屉遮罩（点外部关闭）+ 点菜单项即收起（修「弹出后无法收起」）；P8.25 智能体图标改 Element Plus 图标点选（emoji 禁用，遗留 emoji 自动映射）；
                 P8.26 控制台四表格列宽均衡（全 min-width 比例伸展）；
                 P8.27 品牌波形 logo 四处统一（utils/brandLogo.ts 单一来源，「回」字砖移除）；
                 P8.28 时间展示统一 yyyy-MM-dd HH:mm:ss（utils/formatTime.ts）；
                 P8.31 侧栏收起对齐会话列表（Fold/Expand 移入品牌行，收起 = 44px 图标窄轨）；
                 P8.32 UI 文案「落地页」统一更名「首屏」，返回符号统一 EP Back 图标；
                 P8.36 智能体管理「操作」栏：启用智能体提供「进入」快捷入口（直达该智能体工作区 /agents/<code>）；
                 P8.40 用户管理/访问码「权限范围」（共享组件 components/AgentScopeDialog.vue：允许全部 /
                 仅以下智能体多选 agent id；列表「权限」列徽标；管理员恒全量且按钮禁用；PATCH /api/admin/users/:id
                 与新增 PATCH /api/admin/access-codes/:code 承载 agent_scope）+ P8.51 权限范围三态 + 最小权限
                 默认（agent_scope：'' = 全部 / '[]' = 无（最小权限）/ '[ids]' = 仅列出；新建用户/访问码默认
                 「无」，创建后前端自动弹出 AgentScopeDialog（三态单选 + 多选）引导分配；PATCH agent_scope 增
                 null = 不允许任何；非数组/未知 id 400；门控 scopeAllows 三态，admin 恒全量）+ P8.58 智能体编辑对话框移除「系统提示词 Prompt」字段（从未被问答流程使用；agents.prompt 保留为 DB 遗留列，不再经 API/UI 暴露）+ P8.81 智能体协议配置：身份字段必填（ragflow.chat_id / openai.model / dify.api_key，400 指明字段）+ 每字段配置来源标签（自有值但上层无默认 = 不标记「自定义」）/「恢复默认」（仅上层存在可回退默认值时显示，身份字段无全局默认 = 隐藏）/「测试连接」（POST /api/admin/protocol-test）+ 留空（继承）字段 placeholder 回显上层值（密钥 = 同长度圆点、上层无值 = 无占位）；
                 P8.41 系统设置布局重构：配置分类（协议全局默认 / 语音输入 ASR）改 el-tabs
                 分类页签切换（各 tab 独立保存；P8.44 后访问控制页签已退役）+ P8.74 移动端表单行（≤720px）标签置顶 / 输入框满宽（.sys-row 原 240px 固定标签致输入框 ~110px，开关行保持横排）+ P8.77 修正：P8.74 覆盖块误置于 .sys-row 基础规则之前被反向覆盖（同特异性后写者胜，标签盒仍 240px 居中）——移至基础规则之后（标签置顶居左生效）；
                 P8.43 协议启用状态：协议全局默认各卡片「启用协议」开关（config.protocols.<p>.enabled，
                 缺省启用）；停用协议 → 智能体管理列表「协议」列红色「已停用」标签 + 新建对话框协议下拉
                 禁用该选项（加「（已停用）」后缀）+ 编辑停用协议智能体显示警示条；提问被拒（400「已停用」）、
                 新建/改选停用协议 400；PUT /api/config 显式清空管理密码才停用 admin（UI 保存不携带该字段）；
                 P8.44 匿名访问开关移除：「系统设置」访问控制页签退役（仅留协议全局默认 / 语音输入 ASR）；
                 匿名恒放行（无凭证 = 匿名主体，首屏与问答恒公开）；显式携带的凭证无效仍 403（principal 不匿名
                 回退 + viewerOk 判定，SSE 探针语义保留）；/api/access/login 移除匿名捷径（统一校验码签发）；
                 security.allow_anonymous 字段保留兼容（/api/status 恒 true））；
                 /login 首启表单同源组件)/Login(P7.1 首启引导；P8.46 登录页双页签「访问码/账号登录」：访问码在前（默认显示）、账号登录第二)；
                 components: AudioPanel/SessionSettings(P8.53 协议配置页签仅 admin 可见 + 保存不提交 protocol_config；服务端 PUT /api/sessions/:id 对非 admin 静默忽略 protocol_config；P8.81 占位口径 = 上层（全局 ← 智能体）是否已配置；P8.67 表单行距统一：注记并入 el-form-item label 槽位、token 警示贴控制项下（4px）、独立指引行不占 form-item 行距（顺带移除提示 emoji，P8.25）、弹窗体 max-height + 内部滚动；全站表单审计其余对话框为标准 el-form 无同类问题)/ProfileDialog(P8.55 个人设置：显示名 + 修改密码，PUT /api/auth/me)/AdminBootstrap(首启管理账号)；
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

**强制规则：任何改动（代码 / 配置 / 文档口径）提交前，必须完整跑一遍下方本地验证并全绿；
未验证或验证未过不得提交、更不得部署。** 并行会话同样适用；纯文档且不影响
代码口径的改动可只做 `node --check`（若涉及后端文件）后提交。

```bash
node --check server.js server/*.js server/services/*.js server/routes/*.js lib/*.js   # 语法
npm test                                        # 173 项断言全绿
node tests/store_tests.js                       # 47 项数据层单测全绿
# 前端改动：cd web && npm run build（产物 dist/ 随仓库提交）后浏览器刷新；
# 前端版本号：web/src/version.ts（APP_VERSION，首页页脚显示 EchoAnswer vNN）每次用户可见更新 +1；
# server.js/lib 改动：重启 node server.js 后 curl /api/health
```

## 6. 安全红线

- 不向任何输出/文档写入 config.json 中的完整 API Key（文档用 `kaasr_…` 截断式）；
- 不在代码中硬编码本机 IP/端口作为默认（默认值语义见 02 §1）；
- 删除/重置类接口保持现有确认语义（前端 confirm + 服务端 404 幂等）；
- 101 服务器（172.16.30.101）**禁止自动更新**——仅用户明确要求时可部署（详见 §7 部署红线）。

## 7. 部署红线（101 服务器 172.16.30.101）

- **不允许自动更新**：任何 AI 代理（含并行会话）、自动化脚本或定时器，都不得主动对
  101 执行拉取代码 / 构建 / 重启服务 / 版本升级等操作——即使本地测试全绿、即使改动
  「显然可部署」；
- **唯一触发条件 = 用户明确要求**：用户在本会话中明确指示部署/更新 101 后，才可执行
  部署流程（git pull → 校验产物 → 重启服务 → `curl /api/health` 验证），并把操作与
  验证结果记入 `doc/04-101服务器部署说明.md` 对应记录段落；
- 用户未要求更新时，改动只提交到仓库（含 `web/dist` 构建产物），回复中列明待部署
  提交清单并注明「待用户指示后部署 101」。
