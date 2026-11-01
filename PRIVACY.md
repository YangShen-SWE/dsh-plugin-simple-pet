# Privacy / 隐私说明

## v1.1.6：可选账号轮换（2026-11-01）

账号轮换默认关闭，启用须选择至少两个现有账号代次、策略、保留额度并明确确认保存；普通外观自动保存、新登录及重新绑定均不代为授权。浏览本设置只读取本机目录与缓存；显式刷新会对账号查询官方套餐/额度，可能刷新 OAuth；启用后的明确额度拒绝处理也会在线核对候选额度及同模型目录，不是后台全账号轮询。

开启表示同意切换共享当前账号，并将当前聊天所需的历史发送到参与账号后在原步骤自动继续，可能消耗目标账号额度。只有 HTTP 429 官方明确的 `usage_limit_reached` 且无生成/工具输出、无非零或未知用量才允许续接；网络/认证错误或普通限流不授权重发。单步骤最多八个不同订阅主体，不调用重置卡，不因轮换启用预热。不能保证撤回已抵达服务端的请求，也不能保证所有账号可用。

配置仅保存不透明账号引用及代次哈希、策略和授权；哈希不是匿名化。额度/套餐及最近轮换摘要仅保存在进程内存，界面不返回原始订阅身份、令牌或原始错误。宿主聊天会记录安全的重试事件；请求副本剔除跨账号原生签名，可信压缩检查点仍验证账号和模型，持久聊天内容不被重写。选择序号保护是当前所有者进程内的保护，不宣称跨独立宿主的全局事务或磁盘回滚防护。

本次依用户授权发布 GitHub 源码、安装包与说明；验证仅使用离线合成数据和公开 SDK 夹具。没有读取真实账号或会话、查询真实额度、切换真实账号或执行模型调用；不包含本机状态、凭据、日志与备份，不自动安装、启用轮换或重启宿主。

## v1.1.5：静默预热诊断（2026-10-29）

单当前账号自动预热失败不再显示桌面模态弹窗。诊断独立保存在插件数据目录的 `warmup-errors-<profile>.json`：最近 20 条时间、内部告警标识和受限分类，按标识去重；设置页面仅接收时间和固定安全摘要。不记录账号、邮箱、令牌、模型、会话、原始请求或异常，不上传诊断，不回填旧弹窗历史。

诊断文件与消费认领、预算、兑换保护分离；日志损坏或不可写不会改变调度规则，也不解除未知结果暂停。发布验证仅使用合成数据和隔离临时文件；不读取本机真实日志、凭据或会话，不调用真实模型，不自动部署、启用预热或重启宿主。下文保留各版本功能与隐私边界。

## v1.1.4：固定账号多账号预热与重置卡（2026-10-29）

新多账号计划默认关闭，账号目录由内置所有者投影；浏览器只收到不透明账号/模型引用，不收到凭据或原始订阅身份。目录读取不自动联网；逐账号模型/额度刷新独立确认，可能联网及刷新 OAuth，但不发送模型请求。保存消费授权和实际手动执行均需明确确认，外观自动保存不代为授权。

账号固定执行只在内置所有者内部解析授权，不修改全局当前账号；每个账号/模型上下文隔离，标准速度 SSE 极简请求，无历史/工具/Fast、无模型重试。每日与手动共享最多八个稳定预算主体、每主体每日一次的逻辑预算。持久文件仅含不透明引用、稳定身份哈希、授权、时间、状态与数值用量；哈希不是匿名化保证。旧计划互斥，未知认领和存储异常保守暂停，不自动补发或跨日解锁。

兑换继续使用原账号/卡联合哈希保护文件；发送前同步认领，已认领、已结算或结果未知均阻止再次发送。卡片检查入口独立于额度摘要；查询不等于兑换，未知 Credits 不当零。重启、清内存、刷新令牌和新挑战不移除保护；不承诺磁盘回滚、人工删除或 Windows 断电后的恰好一次。

开发与发布验证仅使用合成数据和离线夹具，不读取真实授权或会话，不联网调用真实账号/额度/模型/OAuth/兑换。依用户授权发布 GitHub 源码与安装包，不包含本机账号、凭据、会话、策略、保护记录、日志或备份；不自动部署、启用预热或重启宿主。以下版本说明为各历史发布的边界。

## v1.1.3 统一订阅功能适配（2026-10-23）

桌宠新增只读当前账号摘要，来自同一个内置订阅 owner；不读取旧凭据库，不把订阅凭据交给面板或浏览器。账号身份与额度分开校验，失败不冒用旧账号邮箱。面板切号和单当前账号自动预热使用各自默认关闭的新授权，必须单独确认，外观自动保存不代为授权。旧开关不构成新授权，撤销后不再首次分发；取消不能保证已发送请求未抵达。

预热会真实消耗所选账号的订阅额度，只通过完整内置适配器发送固定短提示，无聊天历史、工具或 Fast；保留同账号核验、持久去重/预算、未知结果暂停、旧单/多账号互斥记录，不增加失败自动重试。旧路由只在请求副本保留由 bridge 独立验证的压缩检查点；无可信账号归属的原生签名不转发。不会读取或修改用户会话来修复截图中的上下文超限，也不关闭模型窗口保护。

以下“预热与面板接口停用”只描述本次适配之前的去重版本；退休账号引擎、旧来源接口和旧批量预热仍不启用。

## v1.1.3 统一订阅来源与旧路由（收录 2026-10-22 本地修订）

用户明确选择旧 `codex-accounts` 今后请求跟随内置订阅当前账号，可能不同于原绑定账号；完整后端仍使用其原公开凭据 namespace，不复制或导入旧账号凭据。请求只从该完整适配器取得授权，旧账号配置不再参与。可解析旧路由仅转换模型 slug；不读取旧目录补不可逆 hash，要求用户重选。兼容层不存授权，不加入请求重试，不自动提交历史；不再可信的 replay 元数据仅在请求副本中移除，持久历史不改。

桌宠页只读本机偏好/状态/应用回执，外观改动不捎带账号授权；旧来源/预热/面板配置接口停用，原保护文件和凭据保留，旧授权不会重启已退休调度器。完整内置订阅仍保留原网络与消费功能和独立确认边界，不能将桌宠页面的本机读取承诺泛化为整个订阅管理。旧提供者冲突明确拒绝统一，不抢占未知插件。以下旧版本有关两套账号同时运行、固定账号迁移或旧后台轮询的说明仅为历史。

开发回归仅使用离线合成数据，用户于 2026-10-23 反馈本机验收完成并授权 GitHub 发布；不据此宣称所有账号与远端能力可用。发布源码和安装包不包含本机账号、凭据、会话、专家策略、消费记录、日志或备份，不额外读取真实授权、调用模型/额度/OAuth/兑换或自动重启。多账号 warmup 只发布下一版方案，不因本版升级授权或执行。

## v1.1.2 完整内置订阅与授权时效（2026-10-21）

完整 MIT 上游 2.6.8 分支使用原订阅的公开凭据 namespace 与账号库；旧 `openai-codex` 请求使用该库中选择的账号，不映射到另一套桌宠默认账号。原桌宠 `codex-accounts` 账号、兑换保护和预热记录继续独立保存，不复制令牌或合并账号。完整分支保留其后台目录/额度读取、图片/草图、搜索、输入框等原功能及网络行为，不把只读页面或安装测试当作消费授权，也不声称原分支已具有桌宠独立账号服务的全部持久未知保护。

订阅偏好使用本机独立、schema 校验的版本化文件；首次仅采用原公开配置，不覆盖桌宠设置或原独立插件配置。外部 provider 已存在时内置后端停止；前端须确认内置所有权才加载全部贡献。请自行停用独立订阅插件，避免双重 owner。部分原有搜索选择可能更新宿主公开 web 设置，卸载并不保证恢复原值；本版不隐瞒或扩展上游原行为。

授权时效只将存储到期值与 JWT 的 `exp` 取较早者，并保留原始持久期限。未验签声明只用于缩短新鲜度，不能证明身份/权限。请求内存句柄在上下文准备后经原公共 SDK 和串行存储解析同一绑定，校验账号与当前 bearer，取消、切号或身份变化则中止；不输出令牌、不增加模型失败自动重放、不回退其他账号。正常使用时 SDK 可按原 OAuth 流程刷新授权；本轮发布测试全部为合成授权，未读取真实凭据、调用真实账号或自动重启。

## v1.1.1 前台页面的后台只读请求（2026-10-21）

在已确认内置账号来源后，账号/模型页面可见时会自动读取本地账号目录，并只对当前查看的绑定账号读取模型或重置卡。目录、模型、卡片分别按一分钟、五分钟、两分钟节流，失败同样计入尝试；不是全账号轮询。隐藏、离页、编辑草稿或独立确认时暂停，取消不保证上游尚未收到 GET。

账号浏览不会变更默认、查询额度、登录或触发模型/预热。卡片摘要不输出原始卡号；自动检查不构成消费授权。准备与兑换仍须各自明确点击，未知消费保护和独立确认不变。未新增上传、遥测、凭据迁移或真实消费验收。以下旧版“不自动检查”的描述仅指旧版行为。

## v1.1.0 请求偏好与重置卡（2026-10-20）

标准 / Fast 保存为本机账号首选模型偏好，不采集额外账号身份；仅目录明确声明能力时开放 Fast，单独确认可能增加用量。聊天会话推理与账号默认分离，预热不继承 Fast。

重置卡检查和兑换都只针对明确选择的固定账号，不自动检查或兑换，不上传诊断。短期卡引用和确认令牌仅存在服务内存；上游原始卡 ID、标题/描述、访问令牌不进入浏览器 DTO、日志或保护文件。兑换前持久记录的仅为账号/卡联合哈希、请求 UUID、时间、claim 状态和安全结果，位于账号目录旁的专用文件。记录永久保留以阻止重复；同账号重新绑定或更换 epoch 不绕过已有保护，不确定消费不自动重试。哈希不是匿名化或加密保证，稳定本机文件/ACL 与 OS 持久化是保护前提，人工删除、回滚或磁盘故障可破坏保护。

精确专家迁移策略仅存本机，不随包发布；迁移只追加公开选择和通知事件，不直接改写原始历史或私有 descriptor。没有策略就不迁移。本轮未执行真实额度/模型请求或兑换卡片，未重启宿主。

## v1.0.6 回放隔离与连接兼容（2026-10-20）

原生 replay 只在相同账号、模型及匹配路由下还原；新增封装保存账号键、模型和 SDK 原生状态，不新增凭据、邮箱或消息采集。跨账号/模型及无法证明来源的旧状态不复用原生签名，保留中立文本与工具历史；不把原生状态、签名或原始错误加入诊断、日志或发布产物。

上下文控制码保留固定安全文案，取消仍结算已报告用量；取消/卸载在目录提交前重新检查，不能保证撤回已提交副作用。共享路由随生命周期释放；十分钟仅为空闲窗口，保留 SSE、零自动重试、无自动切号和无新增消费授权。本版使用合成账号与离线 SDK 验证，没有新增真实凭据读取、账号/额度/模型请求或本机安装重启。详见 [兼容性清单](CODEX-CONNECTION-COMPATIBILITY.md)。

以下为各历史版本当时的记录。

## v1.0.5 完整设置及图片错误协议

完整 B 的四页导航不新增账号、额度、模型查询或消费授权，普通偏好继续自动保存；设置菜单先注册，可选安装器仅在其独立注入生命周期内可用。本次没有新增真实模型请求或读取用户凭据进行验收。

只有真实 SDK 签发的发送前图片预算控制错误及正安全整数数量可进入宿主已有卸载协议；重建的固定安全错误不带原始异常、cause、路径、图片字节或原生签名。插件不自行重试、删除历史或清除未知用量记录；发送后/流内同名错误不会获得重放权限。一般错误仅保留固定机器码和安全说明，未知子原因不靠输出完整请求来追查。此前 v1.0.4 的一次真实短文本测试是历史、限定范围的验收，不保证长会话，也不会在安装或打开设置后执行。

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
