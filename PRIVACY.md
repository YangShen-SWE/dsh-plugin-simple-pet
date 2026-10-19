# Privacy / 隐私说明

## v1.0.4 双栏工作台与目录读取边界（2026-10-19）

左侧账号导航仅改变设置页内存中的查看目标；鼠标/键盘浏览不会查询额度、读取在线模型、切换默认或写入账号目录。窄容器只改变布局，不增加网络操作。主动刷新额度、打开模型目录、设本服务默认、设 DSH 默认及消费授权仍是独立目标操作；编辑草稿保护不变。

在线模型目录读取保留 1000 条/10 秒及严格结构校验，解码后最多 8 MiB；只解析必要安全元数据，不把指令模板/原始响应加入日志或诊断。超限单独报错并保留标旧缓存，不删除账号、重登录或自动重试。

发布前，依用户另行授权，对完成本地界面改造后的当前默认绑定账号执行一次完整目录 GET 和一次 `gpt-6.1-sol` 最小请求 `Reply only OK.`，均 HTTP 200，正常返回 OK。测试仅通过既有公共凭据服务使用自有绑定，安全记录不含令牌、身份或完整响应；没有真实额度查询、切号、预热或自动重试。此为开发验收动作，不是安装/打开设置后会运行的功能，不授予任何后台消费权限。结果仅限该账号、该时刻、该最小生产服务调用，不是所有账号或宿主会话的保证。

## v1.0.3 本机昵称、显式批量额度与诊断（2026-10-17）

昵称在停止编辑约 450ms 后写入本机既有账号目录，仅修改本地标签及目录代际；不会更换身份、授权、默认账号、模型或每日预算。用户若自行将邮箱等敏感内容填作昵称，该内容仍会作为昵称保存，请避免填写不愿落盘的信息。

批量额度只有勾选后明确点击才查询，每次最多八账号、并发两个，每目标一次逻辑读取；不会因打开页面或勾选自动读取，不切号、登录、调用模型或预热，不自动重试。取消停止剩余工作，但不能保证已在途 GET 未发送。额度观察时间仍不是服务器采样时间。

诊断由已缓存的页面状态生成，先在只读区域预览，再由用户主动下载到本机；不新增账号/额度/模型请求，不上传或自动收集。导出仅含固定白名单状态、计数、请求兼容版本与目标模型诊断，不含昵称、邮箱、账号键、凭据、回调、路径、原始异常、消息正文或预热账本。下载文件由用户自行保管，未读取或陈旧状态不会冒充已验证事实。

显式模型目录刷新绕过旧 ETag，但不调用推理、不扩大模型白名单或预热授权；兼容版本维护不证明真实订阅资格或 gpt-6.1-sol 已恢复。既有结果未知的预热记录保持暂停，不清理、不补发。普通/模型偏好自动保存、来源和消费授权分离的边界不变。

## v1.0.2 账号管理状态与移除（2026-10-17）

账号页新增的本地授权状态仅核验本插件既有绑定，不代表服务器 OAuth、额度或模型资格；不会扩大凭据读取命名空间。昵称、短标识、错误与额度观察仍为白名单 DTO，不新增邮箱采集、遥测或原始响应日志。客户端接收时间不称服务器采样，陈旧值不会当作实时可用额度。

移除必须明确确认当前目标与目录代际，先持久撤销本地绑定并清默认、终止该账号在途请求，再清理自有凭据。凭据清理失败不会恢复已撤销绑定，也不代表远端退出 OAuth；不删除历史或每日预热账本。结果未知时保留标旧快照、冻结相关写入并等待主动核验，不自动重试、回滚或借用另一账号。

## v1.0.1 自动保存（2026-10-17）

普通显示偏好与账号模型偏好会在停止编辑后自动写入本机，不上传至其他网站。预热、账号来源、切号入口等授权仍须明确提交，普通自动保存不会夹带它们；设置 DSH 默认模型也仍是单独操作。网络失败与冲突保留草稿且不自动重试，关闭设置会取消未发送的写入，不能撤回服务端已经接受的写入。下文“明确保存后生效”是历史行为，不适用于新版的普通偏好；“已保存”仍不等于桌宠已应用。目录省略可选上下文时的 8192-token 值是本地保守预算，不是服务端能力或权限证明。

## v1.0.0 单插件账号服务（2026-10-17）

账号服务现内置于桌宠，因而「桌宠不处理 Codex grant」仅指此前隔离的 UI/legacy 路径，不再代表整个新版安装包。内置模块通过宿主 credentials 公共接口访问自有固定账号 `codex-accounts/account-*` 命名空间；不导出/复制真实 grant，不读取全局或第三方凭据，保留旧目录与授权。昵称、身份散列、模型 hints/settings 保存在原目录；hints 不是模型权限。

明确选择账号或打开模型设置会为该账号发送兼容的只读模型目录 GET；选择提交成功但目录失败时不回滚、不调用模型或替换账号。目录诊断仅保存有界安全 slug/固定原因，不包含原始元数据、令牌、响应或错误；未知推理能力不被授予。刷新不会扩大用户保存的可见白名单，也不授权自动化。升级不自动登录、查真实额度、预热、切宿主模型或重启；旧独立 owner 运行时不抢占。以下双包描述是历史说明，新版只安装桌宠。

The integrated account module accesses its own existing host credential scope. Explicit account selection/model settings refresh only that account's model catalogue, never model inference; persisted hints are not authorization. No credential migration or automatic automation consent.

## v0.7.4 / 账号服务 0.1.1 通道补充（2026-10-16）

浏览器 HTTP 仍由宿主连接校验；新增进程内 Shared Fetch 由注册所属 Connection 的 owner/admission 边界保护，不重复索取浏览器 Cookie，不作为免鉴权公共 HTTP。两种注册随上下文卸载清理。明确开始 OAuth 后的两秒轮询只读取进度；不自动开始登录、刷新额度或调用模型，结束/取消/换后端/卸载停止。回调输入只在本次页面内存，prompt 改变即清空；取消在分发前生效，不能把已分发请求伪称未发送。错误使用固定公开分类，不转发私密上游异常。旧备份不新增，用户数据/凭据不作本次验证输入。

HTTP admission remains authenticated; the new in-process route is owner-scoped, not a public unauthenticated endpoint. Explicit-login progress polling is read-only and lifecycle-bound. Tests use synthetic data and do not authenticate a real user or query live quotas/models.

## v0.7.3 独立官方账号后端补充（2026-10-16）

新增社区账号插件复用官方 ChatGPT Codex OAuth，不是 API Key 方案或 OpenAI 官方产品。只有用户显式选择后端、添加账号/发起授权时才启动登录；登录使用官方浏览器/设备码流程。桌宠只处理安全目录、昵称、额度与不透明账号/模型键，不接收 access/refresh token。OAuth grant 通过独立插件自有 `codex-accounts/account-*` CredentialStore 交给宿主公开 credentials 服务；不承诺宿主加密，不读取/复制全局 llm-pi-ai、~/.codex 或第三方凭据。

账号服务自己的 accounts.json 仅含私有随机键、身份散列、手工昵称、epoch、撤销标记和默认引用；昵称若由用户填写邮箱，该内容会作为昵称落盘，因此请勿填入不愿保存的敏感信息。不会从 OAuth 伪造“邮箱”。目录/状态/错误/API 无令牌；API 不返回模型回答，预热只结算安全数值 usage。撤销本地绑定不等于远端撤销 OAuth。宿主 credentials 的访问保护、同用户恶意进程、浏览器/网络及上游资格不在账号隔离保证内。

额度只读兼容请求带绑定账号 OAuth 头，禁止重定向和 reset-credit 消费；新后端默认仅作用于自己的后续请求。每日自动化需独立逐账号授权，不因安装、读取、保存或切后端立即发送；未知结果/崩溃认领持久暂停，同日跨后端不能重放。真实登录/模型/宿主尚未验收。本次没有实际账号、依赖安装或自动重启。以下原有“不处理 Codex 凭据”等描述适用于桌宠/legacy，本段另述的是独立可选账号服务。

## 中文

- **v0.7.2 面板多账号管理：** 显式开关默认关闭。开启后，公共 DTO 中已验证的邮箱可完整显示于桌宠信息框／悬停提示；仅在内存经随机 Bearer 能力保护的临时 `127.0.0.1` 通道传给自有 WPF 进程，不写邮箱或通道密钥到设置、state、统计、日志或命令行。通道拒绝浏览器 Origin、代理、重定向及非法负载；不承诺防御同用户恶意本机进程。过期／撤销／退出清除。面板一键切换不再二次确认，改变共享激活／默认账号且可能影响连接和已授权预热；至少两个有效绑定账号、写前复核、未知结果隔离仍生效。浏览器设置继续只显示遮罩，不提供原始邮箱展开；旧 accounts 写入口退休。用户明确确认安装时通过宿主 pluginManager 获取和执行订阅插件代码，可能访问 npm 注册源；已有同名插件不自动变更，不默认授权构建脚本。宿主没有原子 ifAbsent，不能保证并发管理同名包时零替换。此前 v0.7.1 的设置确认／无面板邮箱描述以下保留历史，不适用于 v0.7.2 当前行为。

- **v0.7.2 多账号预热：** 通过通用订阅插件已公开的独立账号模型条目发送固定短提示，不读取凭据、不切换默认／激活账号，不回退其他账号。独立授权默认关闭；每账号每日一次逻辑请求，额度新鲜度未知需额外同意，不能视为 HTTP／Token／费用硬上限。公共状态和完整绑定模型 ID 只瞬时匹配，`multi-warmup.json` 仅保存账号短哈希、精确模型 SHA-256、显式授权、日期和尝试／终态；遮罩邮箱仅页面内存。请求跨发送边界后失败、超时或崩溃认领会持久暂停，保存配置不能清除。执行中授权变更同样保守暂停；不自动重试、回退或补发，不保证宿主中间件不改路由／重试。本轮验证没有真实模型调用。

- 插件处理 DSH 中 `deepseek-official`、`deepseek-account`、`openai-codex` 与 `codex` 路由的模型用量事件。事件包含模型名、时间、Token 类别和数量；插件不读取或保存用户提问、回复正文。启用自动预热时只发送固定短提示 `Reply only OK.`，瞬时检查该请求的非空回复，不保存回复文本，也不读取用户会话历史。
- API Key 路由查询余额时，插件通过 DSH 的 credentials 机制取得 API Key，并且仅向 `https://api.deepseek.com/user/balance` 发送；账号登录路由通过 DSH 的 `deepseekAccount.getBalance` 服务查询钱包，插件不接触账号令牌。两种凭据都不写入本插件的状态、统计或设置文件。
- Codex 额度仅通过 DSH 公共的进程内连接适配器调用订阅插件的状态 / 用量接口；不读取 Codex 凭据文件、不取得 access / refresh token、不自行登录。v0.7.1 仅在用户主动读取并明确确认后调用公共共享账号选择接口；仅对已核验版本及至少两个有效已绑定账号启用，可能改变 DSH 共享连接／缓存，不是局部显示选项。一次性目标和列表只在内存与受保护请求中短时存在，不写原始账号 ID 或邮箱；未知写结果暂停本插件后续切号和预热，需在订阅插件核验后完整重启。公共 DTO 的邮箱瞬时用于构建遮罩，原始邮箱/标签不转发；设置页通过独立鉴权 no-store 内存接口显示遮罩，原始及遮罩邮箱都不写入桌宠快照、偏好、统计或日志，也不提供完整展开。原生面板及落盘仅使用账号 ID 的短哈希以隔离不同账号的额度变化。订阅插件可能自行请求其官方用量接口，桌宠不会自行携带 Codex 凭据联网。
- 自动预热三个开关默认关闭；启用后通过 DSH 公共模型服务使用现有 Codex 认证，调用前后核对活动账号，不直接取得令牌或改变账号 / 模型设置。API 无法锁定调用期间账号；认证刷新及底层传输 / 日志仍由宿主和订阅插件管理，不保证这些组件不写凭据或记录。去重日志只保存本地日期 / 短哈希与截止时间组成的键，以及尝试 / 成功时间、错过的本地每日日期和时刻；不保存原始账号、邮箱、令牌或回复。
- 余额、订阅额度与重置时间、最近事件、分别保存的 DeepSeek / Codex 每日 Token 与估算人民币消耗、桌宠偏好只保存在本机 `%LOCALAPPDATA%\DshSimpleDesktopPet\`。该目录沿用早期版本名称，以保留升级前的数据。
- 插件没有遥测、广告、第三方分析或云端同步。受 DSH 本地连接校验保护的状态和素材接口仅供 DSH 使用。
- 原生 DSH 设置页面通过同源、宿主鉴权的接口读取／保存白名单偏好及本地统计，图片由本地安装目录的受保护接口提供；不连接外部图片服务。选项先成为草稿，显式保存才修改本机配置；拖动只写独立位置文件。打开页面不触发模型请求，不上传图片、余额或使用记录。
- 四款新皮肤由开发阶段的 AI 图片生成服务制作；生成使用角色美术描述，不包含用户余额、对话、API Key 或本机状态。发布的源图保留 AI 生成来源声明，运行图集注明来源与哈希。可读 PNG 元数据检查未发现用户路径、用户邮箱或常见密钥格式；这不代表对所有二进制数据的完整隐私保证。安装后不会调用图片生成服务。
- 发布仓库不包含本机状态、会话日志、API Key 或 `work/` 中的开发检查文件。卸载插件不会自动删除本机数据；如需清除，请先退出 DSH 和桌宠，再自行删除上述目录。

## English

- **v0.7.2 panel account management:** explicit default-off consent enables full public email display only in WPF memory, delivered over an ephemeral IPv4 loopback capability channel. No email/channel secret is persisted or put on the command line. Browser origins, proxies and redirects are rejected; this does not isolate malicious processes running as the same OS user. Settings still show only masked email. A panel click immediately cycles the shared active/default account without another dialog, retaining fresh two-account checks, pre-write verification and unknown-result quarantine. Explicit dependency installation uses the host's public pluginManager, may contact package registries and execute installed plugin code, never automatically changes an existing same-name addon or approves build scripts. The host has no atomic ifAbsent guarantee against concurrent third-party package changes. The historical v0.7.1 behavior below is superseded by v0.7.2.

- **v0.7.2 multi-account warm-up:** separate default-off grants use reviewed public independent model entries, not shared-account rotation. Account/model identities are persisted only as hashes with consent, dates and attempt outcomes; masked email stays in page memory. Unknown quota freshness requires extra per-account consent. At most one logical request/account/day is not a hard HTTP/token/cost limit. Claims precede dispatch; unknown or crashed claims pause all automation persistently, including after disabling the feature. Legacy and multi-account daily claims conservatively block each other; unreadable journals are preserved and disable automation. No automatic retry, fallback, startup catch-up or live-account validation was performed.

- The plugin processes usage events from DSH's `deepseek-official`, `deepseek-account`, `openai-codex`, and `codex` routes. It uses model names, timestamps, and token categories/counts, and does not read or store user prompt or response text. Opt-in automatic warm-up sends only the fixed prompt `Reply only OK.` and transiently checks its own nonblank response, without storing it or reading conversation history.
- For the API-key route, it obtains the key through DSH credentials solely to request the official balance at `https://api.deepseek.com/user/balance`. For the sign-in route, it asks DSH's `deepseekAccount.getBalance` service for the wallet and never accesses the account token. Neither credential is written to its state, statistics, or settings files.
- Codex quota is read through the subscription plugin's public status/usage RPC via DSH's in-process connection adapter. The pet never reads Codex credentials or obtains access/refresh tokens. v0.7.1 can change the shared active/default account only after explicit user listing, target selection and confirmation, with reviewed exact-version and two-bound-account gates. This may invalidate host connections/caches. Opaque targets and lists stay transient in authenticated requests/memory; raw account IDs and email are not persisted. Unknown writes quarantine subsequent local switching and automatic warm-up until upstream verification and a full restart; an abort is not an upstream cancellation guarantee. Raw emails and labels are not forwarded. Optional email is masked transiently and shown only through a separate authenticated no-store memory-only settings endpoint; neither raw nor masked email enters pet snapshots, preferences, statistics or logs. No full-email reveal is provided. The native panel and persisted data use only a short hash of the account identifier to isolate quota changes. The subscription owner may make its own upstream quota request.
- All three warm-up switches default off. When enabled, it uses DSH's public LLM service and existing Codex authentication, checks the active account before/after dispatch and changes no account/model preferences. The API cannot pin an account during the call. Authentication refresh, transport and logging remain host/addon responsibilities; their credential writes or logging are not controlled by the pet. The local attempt journal stores date/account-hash/deadline keys, attempt/success timestamps, and missed local daily dates/times and unresolved-window deduplication timestamps only, not raw identities, emails, tokens or responses.
- Balances, subscription windows and reset times, recent events, separate DeepSeek/Codex token ledgers, daily CNY estimates, and preferences stay under `%LOCALAPPDATA%\DshSimpleDesktopPet\`. The directory keeps its earlier name so upgrades retain local data.
- There is no telemetry, advertising, third-party analytics, or cloud sync. State and asset endpoints are guarded by DSH's local connection check.
- Native DSH settings read/write whitelisted preferences and local statistics over same-origin, host-authenticated endpoints; bundled images are served locally, with no external image service. Edits are drafts until explicit save; dragging writes a separate position file. Opening settings makes no model call or upload of images, balances, or usage.
- The four new skins were created during development using an AI image service and art descriptions, not user balances, conversations, API keys, or local state. Published sources retain AI provenance; runtime derivatives identify their source and hash. Readable PNG metadata checks found no user paths, user email addresses, or common credential patterns; this is not an exhaustive guarantee for all binary content. Installing the plugin does not call the image-generation service.
- The public repository excludes local state, session logs, API keys, and development files in `work/`. Uninstalling the plugin does not delete local data. To erase it, exit DSH and the pet, then remove that directory yourself.
