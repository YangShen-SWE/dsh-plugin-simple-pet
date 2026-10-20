# 更新记录 / Changelog

## v1.0.6 — Codex 长会话与账号连接兼容补丁（2026-10-20）

### 更新原因

v1.0.5 已恢复图片卸载的安全控制协议，但固定账号路由下的原生 replay 身份不匹配、上下文控制码合并及新模型元数据继承仍有兼容缺口。本版对照本机 dsh-codex-subscription 2.6.8 补齐必要封装，不重做界面、不扩大消费授权，也不宣称旧截图已唯一归因。

### 修复与改进

- **回放隔离：** 新增账号/模型作用域封装，同账号同模型还原有效原生 replay；跨账号、跨模型、旧无归属证明的状态保留中立文本/工具历史，不复用签名。覆盖 slug、default 与旧 hash 路由。
- **控制码与用量：** 保留 CONTEXT_WINDOW_EXCEEDED、EMPTY_RESPONSE、INVALID_REQUEST 及固定安全文案；补全服务/断流分类，取消终态不泄露原始错误，不丢弃已报告用量。重验真实 SDK 图片卸载控制协议，不由插件重发或删历史。
- **目录与取消：** 未知新模型不继承其他 slug 的上下文上限，畸形显式上限拒绝；未刷新目录返回 unverified，失败旧值返回 stale，不把静态表当权限。选择账号和模型配置在排队、最终提交前检查取消/生命周期，RPC 转发 signal；不承诺撤回已提交副作用。
- **连接生命周期：** Shared Fetch 注册归属 ctx.effect，卸载释放路由；流事件空闲窗口由一分钟恢复为十分钟（不是总时长保证）。保留 SSE、零自动重试与账号固定，不自动切号。
- **版本与文档：** 根包 1.0.6、内置账号模块内部版本 0.1.2，只发布一个桌宠包；SDK 依赖、账号存储、偏好和预热授权不变。新增 [兼容性清单](CODEX-CONNECTION-COMPATIBILITY.md)，明确代理/请求能力/WS/图片策略等剩余差异，不宣称全功能等价。

### 验证与升级边界

- 定向回归 **212/212**；实际公共 SDK 合成传输 **19 场景、309 断言**通过。真实网络、凭据/附件读取和模型调用为零；不是新增真实账号或长会话验收。
- 完整 `test` 为 **820 项、813 通过、7 失败**；7 项在未修改的 v1.0.5 归档同样失败（旧设置布局/文案 5 项，Windows PowerShell/WPF 设置 2 项），本版不修无关界面测试，不标成全量通过。详见兼容性清单。
- GitHub 发布和本机安装分开：本轮不更新运行中插件、不重启 DSH。请从 Release 导入更新并自行完整退出（含托盘）后重开，保留账号、凭据和预热记录，不需删除聊天。
- 下方版本记录是各次发布当时的状态；历史 replay 待办已由本版离线覆盖，仍不能据此宣称原聊天已恢复。

## v1.0.5 — 完整 B 设置与长会话图片兼容（2026-10-19）

### 为什么更新

此前 v1.0.4 只将账号页改成 B 工作台，其他设置仍是旧布局，没有完整兑现用户选定的整套方案；此外，可选安装器的未声明服务访问会阻止设置菜单注册。真实长会话又暴露出内容错误被合并、图片卸载控制信息被吞的问题，不能拿此前最小 `Reply only OK.` 成功代替长会话兼容验收。本次补齐界面范围、修正入口并恢复安全的错误控制协议。

### 完整 B 设置

- 补齐原先只修改账号工作台的范围缺口：统一 **账号与额度、模型设置、桌宠设置、自动预热** 四个主页面，不再混用原“常规/外观与动效/账号管理/自动预热/用量统计”五页布局。
- 模型设置成为独立页面，账号选择只改变查看范围，不自动刷新、切号或设 DSH 默认；草稿、目录失效及跨账号模型隔离仍保留。桌宠页统一预览、简洁/安静开关、显示与尺寸，人物/主题、动效及应用回执默认折叠，用量统计改为可返回的二级入口。
- 预热独立展示消费提示、每日计划和逐账号授权；打开页面、读取计划或编辑计划不触发预热，也不随普通偏好自动保存。规则与旧订阅单账号计划折叠；未知结果的持久暂停不被保存清除。
- 统一紧凑字号、开关、分组、深浅主题及不透明页头/面板，按容器宽度适配；保留原模型大目录与设置入口注入修复。源码定向回归 **433/433**，隔离生产 React/Edge **33/33** 场景，以及真实打包 Cordis 的可选服务已存在/缺失/晚到三个入口生命周期检查通过；未做全量测试、真实账号/额度/模型调用或宿主重启。
- 本次统一发布为 v1.0.5；自行完整退出并重开后进入 **设置 → 桌宠**。本次修订不能用先前版本的真实请求成功来代替运行中宿主的逐页体验验收。

### 设置入口修复

- 修正设置前端在注册菜单前直接读取未声明的 `remote.pluginManager` 子服务，真实 Cordis 服务隔离下会抛出 `cannot get property "remote.pluginManager" without inject`，导致“桌宠”入口未注册。现在先注册设置，再通过独立注入上下文接入可选安装器；服务缺失、晚到或卸载不隐藏设置，也不保留失效安装器。
- 使用当前桌面程序打包的真实 Cordis 离线复现修复前失败及修复后正常，并验证可选服务已存在、缺失、晚到/移除和父插件清理；未调用真实账号、额度、模型或插件安装。
- 合入 v1.0.5，不改写旧版 GitHub 资产，不自动重启。请完整退出 DSH（含托盘）后重开，进入 **设置 → 桌宠**；“Codex 订阅”是另一个插件的设置页。

### 长会话图片与错误协议

- 修复确定的控制信息丢失：只对真实 SDK 签发、数量为正安全整数的 `IMAGE_OFFLOAD_REQUIRED` 发送前错误，重建固定安全消息并保留 `offloadImages`，交还宿主已有图片卸载协议处理；插件不自行循环重试、删除历史或提高图片请求预算。
- 发送后/流内失败仍保留已报告用量，不把任意同名错误变成可重放指令；取消优先，不清除未知预热结果。普通失败保留匹配的安全 `code`/`failure`，不再仅剩 `UNKNOWN`；已识别的附件服务缺失、历史 assistant/system 图片及工具历史格式分别分类，未知原因仍不猜测。
- 离线实际公共 SDK 可复现：两个合成 4 MiB 图片 occurrence 超过原有 base64 总预算，修复后完整服务链保留 `offloadImages: 1`，模型派发与自动重试均为零；缺附件服务也在零派发下得到明确安全类别。不输出原始异常、路径、图片字节或签名。
- **证据边界：** 截图两次 `BOUND_CONTENT_UNSUPPORTED` 的原始子原因已被旧代码抹去，不能倒推它们一定是图片超限；本次未重发真实请求。正常宿主会先投影 developer/deferred-tool 历史，不能只凭 SDK 的直接拒绝代码认定它是宿主根因。绑定路由的原生 replay 身份封装仍需后续专项验证，不宣称本次一并修复。

## v1.0.4 — B 双栏工作台与模型目录兼容（2026-10-19）

- **B 工作台：** 账号页左侧导航、右侧当前账号详情；5h / 每周额度卡片与进度条集中呈现。按设置容器宽度自动上下排列，适配明暗主题、不透明粘顶栏且无横向溢出。
- **查看不切号：** 鼠标及上下/Home/End 键仅改变查看状态，不查询额度、不读取在线模型、不切换默认。刷新保留查看对象；目标被移除时只回退本地查看。设本服务默认、刷新额度、打开模型及设 DSH 默认仍是独立操作，已有会话不被重写。
- **减少干扰：** 改名/移除、批量额度/脱敏诊断及来源说明默认折叠；普通/模型/昵称自动保存、独立授权、冲突草稿和未知结果保护保持不变。切换查看不会把 A 的模型编辑器显示到 B 名下；草稿未保存时暂停浏览。
- **大目录兼容：** 合法目录中的指令模板/兼容副本可能超过旧 512 KiB 硬上限。改为有界的 8 MiB 解码后读取与可增长缓冲区，保留 1000 条、10 秒、严格 UTF-8/JSON/根结构和安全 304 校验；不会无限读取或保留大量微小分块。
- **更准确的失败：** 新 `MODEL_CATALOG_TOO_LARGE` 贯穿服务/代理/页面；失败保留上次模型、ETag 与设置并标旧，不删除账号、不借用另一账号、不自动重试。一般目录错误也不再误导用户重新授权。此确定性兼容缺陷不等于已证明此前截图的唯一根因。
- **真实连接已验证：** 界面完成并同步本地后，按用户另行授权，当前默认绑定账号完整目录读取一次 HTTP 200（9 项返回/7 项保留，接受 gpt-6.1-sol），最小真实模型请求一次 HTTP 200、正常 stop、恰好返回 OK；无切号、额度查询、预热或自动重试。仅证明该账号/时刻/最小生产服务链路，不泛化为所有账号、现有会话或界面完整任务验收。
- **回归与升级：** 源码和解包受影响测试 424 项、生产公共 SDK 离线验证及隔离 React/Edge 15 场景；不执行全量测试、不自动重启或关机。保留账号、凭据、偏好与未知预热记录，公共依赖版本不变；升级后请自行完整退出并重开 DSH。操作说明见 [使用指南](USAGE.md)，边界见 [隐私说明](PRIVACY.md)。

## v1.0.3 — 真正自动保存与多账号工具（2026-10-17）

- 普通设置、账号模型偏好移除常驻保存按钮，停止编辑约 450ms 自动保存；只有失败时显示重试。修正仍要求手动保存的旧文案；账号读取繁忙时模型保存延后串行，不再丢掉唯一待保存草稿。授权、来源、DSH 默认模型和每日预热仍须独立确认，409/结果未知不自动重试。
- 设置顶部状态与导航使用不透明的主题底色，保留旧浏览器回退；修复滚动文字透出、深浅主题及窄屏顶部重叠。
- 新增本机账号昵称编辑及 450ms 自动保存。固定账号/目录代际 CAS，只改本地标签与目录 generation，不改身份、授权、默认、模型键或预算；限制 1–64 个 Unicode 字符并拒绝控制符/双向隐藏字符，冲突保留草稿。
- 新增显式批量额度读取：用户勾选并点击后才执行，最多八账号、并发两个、每目标一次逻辑查询。支持取消；可确认的账号局部错误单独反馈，未知共享错误或来源变化停止队列。取消不保证撤回已发送 GET，不附带切号、登录、模型或预热调用。
- 新增脱敏诊断预览和本地 JSON 下载，只读取页面缓存的白名单状态、计数、版本与目标模型结果；不新增请求、不上传，不含昵称、邮箱、账号键、凭据、回调、路径、原始异常或预热账本。
- 显式更新模型目录绕过 ETag，完整读取；新增返回/保留/启用计数、后端能力和目标模型独立诊断，不受过滤原因最多显示 128 条的上限干扰。兼容配置集中为 `codex-models-v0.163.0`，查询版本与 `version` header 同步，保留 `originator: pi` 与本插件 User-Agent。
- **未宣称修复真实账号的 gpt-6.1-sol 缺失。** 旧查询版本已高于公开目录的最低版本，兼容维护不等于确认根因；不虚构 slug、不改用 API Key、不自动清理或重试“结果未知”的预热。原位重授权、账号池、自动切号及精确满额触发继续暂缓。
- 受影响源码/解包测试、真实公共 SDK 离线夹具及隔离 React/Edge 界面验证；不执行全量测试、真实 OAuth/额度/模型请求或宿主重启。使用步骤见 [使用指南](USAGE.md)，已完成/待核验清单见 [账号管理评审](ACCOUNT-MANAGEMENT-REVIEW.md)。

## v1.0.2 — 多账号可管理、失败不连坐（2026-10-17）

- 产品、UX、架构三方对照固定版本公开参考源码，首版优先修复失败隔离、额度时间、移除确认及真实冲突传播；评审结论、证据边界和后续待办见 [账号管理评审](ACCOUNT-MANAGEMENT-REVIEW.md)。不是参考产品的全功能复制，也不是用户访谈或真实账号验收。
- 本地授权缺失、凭据身份不符等可确认账号级故障仅隔离对应账号；健康账号固定模型入口保留。目录损坏、公共凭据服务或未识别 driver 错误仍整体关闭，不以错误字符串猜测账号局部失败。
- 单账号操作失败不再清空整个列表；全局失败保留明确标旧的只读快照并冻结写入，须主动重读。额度区分未查询、查询中、缺窗口、失败旧值和耗尽，显示本机接收及重置时间；时钟越过窗口后降级，不自动回满或新增上游查询。
- 移除改为针对昵称与短 ID 的内联确认，说明默认账号、在途请求与本地撤销影响；取消/Escape 零写，双击只提交一次，目录代际/来源往返/卸载使旧确认失效。先持久撤销再清理凭据，清理失败不谎称撤销回滚；不重置账本或自动选择其他账号。
- 进程内 RPC → HTTP 代理保留白名单 `SOURCE_CHANGED`/409 等冲突语义，不回显私密异常；前端保留模型草稿并暂停重试。已提交动作与附带目录/重读失败分别反馈，不重放已确认或结果未知的操作。
- 不新增账号采集、后台额度轮询、自动切号/重试、预热权限或默认模型变更；账号改名、批量刷新和完整诊断列下一增量。只做受影响定向/离线验证，不做真实 OAuth、额度、模型或全量回归。

## v1.0.1 — 自动保存与新模型目录兼容（2026-10-17）

- 普通设置采用 450ms 合并防抖、revision CAS 串行保存与最新草稿回包合并；保存状态独立于桌宠应用回执。正向 14 字段 allowlist 不包含预热/切号/账号来源授权，新字段不会自动变成消费授权。
- 每账号模型可见性、首选与推理档位也自动保存，仍不自动改 DSH 默认；请求中锁定模型编辑器，错误保留草稿且不自动重试，409 须明确放弃后重读，来源往返切换/卸载会作废旧定时回调。
- 无效本地数值修正后恢复保存，网络结果未知/冲突则不能靠继续编辑自动解除暂停；设置首次读取不写入，组件卸载取消未分发的保存。
- 在线返回且可见的新模型可省略可选上下文元数据，不再因此隐藏整个模型；标注本地 8192-token 请求预算，不假造服务端上限、模型 slug、账号权限或免费价格。明确给出的无效上限继续拒绝。
- 仅做新/受影响测试与真实公开 SDK 离线传输验证，不触发真实 OAuth/额度/模型、切号、宿主重启或发布。已按本机用户请求卸载被内置服务取代的旧独立账号插件；账号目录、凭据与预热记录保留。

## v1.0.0 — 单插件账号管理与模型目录刷新（2026-10-17）

- 账号 OAuth/模型/额度服务作为桌宠所属注入子上下文内置；根包声明官方公开组件依赖。不再发布第二个账号安装包，保留第三方后端可选。
- 保留原账号目录、`codex-accounts/account-*` grant 命名空间、模型路由和自动化预算，不迁移或复制真实凭据。旧独立 owner 存在时不抢占；升级需用户停用旧包并手动完整重启，不能自动重启或中断请求。
- 选择账号即刷新固定账号目录，失败不回滚已提交选择；显式模型设置同样刷新。服务重建后的 hints 仅作重新验证线索，绝不充当权限。并发目录刷新最新请求胜出，过期成功/失败均不能覆盖新状态。
- 新增 `gpt-6.1-sol` 来源和缺失诊断，区分未刷新/失败、服务端未返回、可见性、缺失能力与本地关闭。未知推理档位不隐藏模型，不授予未知档位；旧白名单不被刷新自动扩大。

### 合入此前本地修复：普通对话与账号模型设置

- 补接官方适配器的宿主附件/文件系统依赖，修复含截图历史的请求发送前失败；通用默认选项正确归一化，保留消息、工具、图片、usage 和终态，SSE 与零自动重试边界不变。
- 按固定账号 OAuth 显式读取模型目录，新增模型仅使用目录支持的输入/推理/上下文，不假设价格免费或所有账号都有 `gpt-6.1-sol`。Model hints 仅在重启后触发同账号重新验证，不是持久权限。
- 账号页增加模型选择、可见模型、首选/推理档位、CAS 单独保存和显式提交/读回 DSH 默认；新路由使用可读 slug，兼容旧哈希会话；已有会话不自动换模型。
- 独立只读复核发现并补齐两个流边界：取消/撤销后先转发已经报告的 usage，再保守结束；in-band `finish(error)` 也脱敏分类，不能绕过 catch 泄露原始上游消息。正常 stop/tool/usage 语义不变，失败不重试。
- 新/受影响定向测试、真实已安装 SDK 的完全离线传输测试、合成 React/Edge 宽窄屏验收；未运行全量套件，未做真实登录/额度/模型请求或安装依赖，不自动重启/关机。发布证据以 v1.0.0 Release 为准。

### 合入此前本地修复：账号服务被宿主卸载（2026-10-16）

- 从实际宿主日志定位 `TypeError: Invalid effect`，并使用本机公开 Cordis 4.0.4 重现：异步插件入口返回普通 service 对象，违反 effect 返回值契约，导致整个插件及通道被卸载。不是用户没有重启。
- 入口不再返回 service 对象；继续由既有 lifetime effect 清理资源。双插件回归改用管理 API，而不依赖非法返回值；独立包增加启动返回值回归。
- 补充实际 Cordis 的 `Context.plugin()` 激活、依赖注入、Shared Fetch/HTTP/模型路由存活、HEAD 和完整卸载验收。只使用私有 Temp、空账号目录与拒绝真实操作的替身服务。
- 缺路由文案改为检查插件启动错误，不再只要求重启。现合入 v1.0.0；未代做真实登录/额度/模型请求或自动重启。


## v0.7.4：账号服务通道修复与简洁账号页（2026-10-16）

**更新原因：** 独立服务只注册了浏览器 HTTP 路由，而桌宠通过宿主进程内 Shared Fetch 注册表访问；两套注册表相互独立，导致插件已安装仍读取失败。本次同时发布桌宠 **0.7.4** 与独立账号服务 **0.1.1**，补齐真实内部通道，不以安装成功冒充已能登录。

- **通道与错误：** 在同一宿主 Connection 上注册内部 Fetch 和鉴权 HTTP 路由；随所属上下文卸载清理。浏览器仍鉴权优先；内部调用沿用 owner/admission 边界，不能当成公开无鉴权端点。固定区分未启用/404、权限、目录锁和暂时写入故障，不回显上游私密错误，也不自动重试 OAuth、额度或模型操作。
- **更简单的账号页：** 账号来源、刷新、添加账号、账号列表、默认/移除与额度查询集中显示，详细风险折叠但保留。登录方式使用浏览器/设备码官方交互；只有明确开始登录后才每两秒读取进度，GET 不重新提交登录。相同 prompt 保留已输入回调，完成、取消、换来源或卸载即停止；旧回调经来源往返切换也不能重新发送。
- **顶部保存：** 通用保存/重新读取与导航固定于可滚动区域顶部，窄屏换行并保持可见。跨页保留草稿；统计页也可提交通用草稿，多账号每日预热仍独立保存，不悄悄扩大授权。
- **取消与目录：** 正文读取期间取消不得首次分发登录、额度或预热；已经分发的操作不假称未发送。Windows 短暂共享冲突只有限重试同一份元数据原子 rename，最多十次，不重试任何账号/模型工作。
- **保持边界：** 默认仍为旧订阅路径，不迁移 grant、账号或预热授权；官方路径需分别安装两包。精确满额启动/5h 触发仍禁用。昵称不是官方邮箱，已保存与实际应用保持区分。本次不自动登录、查询真实额度、切账号或发模型请求。

定向验收与公开下载/本地复制证据写入本次 Release；仅合成账号、私有 Temp、真实公开宿主接口契约 mock，以及真实 React + 隔离 Edge 页面。没有执行完整测试套件，也不把这些结果当作真实 OAuth/运行宿主验收。界面截图中的账号和额度全部为合成数据。

**Update rationale:** the HTTP-only account service was absent from DSH's separate in-process Fetch registry. Desktop 0.7.4 + account service 0.1.1 register both transports with correct admission/lifecycle, harden cancellation and stale callbacks, simplify account management, and keep save/navigation visible at the top. Login polling is GET-only after explicit consent; budgets, defaults and full-trigger restrictions remain unchanged. Synthetic incremental tests and isolated browser checks are not live-account validation.


## v0.7.3 — 官方组件独立账号服务（2026-10-16）

**更新原因：** 默认官方 Codex OAuth 的单账号槽位不等于框架不能支持多账号；此前桌宠账号/额度/每日预热必须借助第三方订阅插件。本次新增独立插件 `dsh-plugin-codex-accounts@0.1.0`，复用官方公开 OAuth/适配器组件完成自有账号目录、账号固定请求和桌宠生产接线，不把 OpenAI Platform API Key 计费当成 ChatGPT 订阅额度。

- **两个独立包：** 安装并启用本次 Release 的 `dsh-plugin-codex-accounts.tgz` 与桌宠 `dsh-plugin-simple-pet.tgz`。账号服务显式依赖 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` 和 `@earendil-works/pi-ai@0.87.1`；不依赖第三方订阅插件，但不是零库依赖。桌宠自身仍无生产依赖，安装桌宠不会隐式安装/启用账号服务。
- **明确选择与登录：** 设置 → 桌宠 → 账号管理选择“官方组件独立账号服务”并保存，再主动读取目录、添加官方浏览器/设备码 OAuth、查询额度、选择新请求默认账号或撤销本地绑定。旧订阅路径仍为默认，不导入旧 grant、账号或预热授权。账号管理不受 DeepSeek/Codex 展示模式限制；查看账号与默认路由分开。
- **凭据和绑定：** grant 只经独立插件的固定账号 CredentialStore 进入宿主 credentials 服务，桌宠不接收令牌。刷新整个 mutation 受宿主锁保护；缺 grant、撤销、epoch/身份变化拒绝，不回退环境 Key、全局账号或其他账号。目录仅含不透明键、身份哈希、用户昵称及撤销/默认引用，不承诺宿主加密。昵称不是官方邮箱。
- **订阅额度：** 兼容 Codex 客户端的只读 GET，绑定 OAuth 账号头，失败保留旧采样时间并显示 stale；不调用模型或 reset-credit 消费接口。`clientObservedAt` 不是服务器采样证明，缺失账号回显、分钟/百分比舍入及后端延迟不伪装成精确满额。启动满额/5h 满额自动预热仍禁用。
- **默认与面板：** `codex-accounts` 独立模型路由的默认只影响后续新请求；在途 A 请求固定 A，不改宿主/第三方的 `openai-codex` 激活账号。面板仍需显式开启管理和至少两个可读 OAuth 绑定，点击轮换本服务新请求默认，显示用户昵称。旧后端的面板邮箱/全局切号语义保持原样。
- **每日预热：** 沿用默认关闭的独立逐账号授权，最多八个账号、每天每账号一次逻辑请求，未知额度仍需额外同意。官方发送前另检查普通用量权限和已知耗尽情况，固定账号、SSE、无工具及库重试0；实际 usage 只结算一次。不是 HTTP exactly-once/Token/费用硬上限。同订阅重绑预算键稳定，同日跨后端认领拒绝重放，unknown/崩溃认领仍暂停自动化；不恢复旧单账号计划或悄悄迁移授权。
- **架构与计划：** 将三项既有预热安全策略原样提取为 `warmup-safety.js`，旧导出不变。此前每日16:00任务已取消，未建立新定时。新增服务分离 OAuth/目录/额度/官方 driver，避免继续把账号存储塞进桌宠入口。后台新暂停优先于旧“保存成功”文案。

验证只用合成账号、私有 Temp、公开库假 OAuth 和双插件真实接线 mock；未真实登录/读取账号额度、调用模型、安装依赖、升级运行宿主或重启，也未跑全量测试。发布前源码定向通过 **499 项 Node 检查与 76,414 项隔离 WPF 断言**；源码/模拟通过不等于真实账号/完整宿主验收。兼容额度端点与 OAuth 资格仍受上游变更及政策约束，不能承诺一定开启新5h窗口。安装与安全边界见 [独立账号插件说明](codex-accounts/README.md)。

Official-component account service: this community plugin uses ChatGPT Codex subscription OAuth, not a Platform API key. Install the independent account-service asset explicitly; choose the saved official backend without migrating existing credentials or automation grants. Account-fixed refresh/request isolation, reported quota observations and opt-in daily warm-up are wired to the desktop client. Existing third-party paths remain the default. Exact-full startup/reset triggers remain unavailable. Validation used mocks/private temporary data only, not live authentication, billing calls or host restarts.

## v0.7.2 — 分区设置、面板账号与每日多账号预热（2026-10-16）

**更新原因：** 设置过长、账号操作入口分散，且已完成本地验证的多账号每日预热未进入公开稳定版。本次整合发布：分区导航、面板邮箱一键切号、用户主动依赖安装和默认关闭的每日账号绑定预热。启动／5h 满额多账号触发因上游证据不足仍不可用。

### 设置分区与能力说明

- 顶部导航拆分常规、外观与动效、账号管理、自动预热、用量统计；只有当前页面分区显示，窄屏换行，无横向拖动条。增加方向键、Home/End 与选中/焦点语义；跨页保留通用与多账号草稿，不触发保存、安装或绑定枚举。
- 通用保存与多账号独立保存继续隔离；隐藏页面输入由后台严格校验，避免浏览器因不可见字段无法聚焦而阻止提交。原单账号三个预热开关保留，不冒充多账号启动/刷新功能。
- 多账号接口只读返回触发能力：每日可用，启动满额/5h 刷新暂不可用；设置以禁用项和具体原因呈现，不允许保存无效的空开关。伪造 startup/reset 字段仍拒绝，未知额度额外授权不扩张。
- 静态核验通用订阅 0.9.9 固定源码：force 失败可能返回 lastSnapshot；公共 usage 缺 fetchedAt、缓存/失败状态、账号回显和窗口原始时长，session 还可能按位置回退分类。故不据收到时间、100% 或 resetAt 变化自动调用；未新增实时多账号额度查询。
- 发布前源码定向回归通过 437 项 Node 检查 / 76,414 项隔离 WPF 断言；独立 Edge + 真实 React 合成数据页面通过（包含 380px 外层容器、逐页可见性和切页零新增请求）。不是正在运行宿主或真实账号的验证。
- 本次发布验证未真实查询账号/额度、切号、安装依赖、调模型或重启；完整宿主和真实账号仍待验收。
- Partitioned navigation with persistent drafts and explicit fail-closed multi-account trigger capabilities; no false startup/reset automation or broader billing consent.

### 面板多账号管理

- 修正 Codex 主标题被「激活／默认 #匿名账号」替换的问题：各种账号来源及额度状态下均固定显示「CODEX · 订阅额度」，账号信息仅保留于独立管理栏。

- 新增严格布尔 `multiAccountManagement`，默认关闭，原生设置显式保存并纳入实际应用回执。设置移除旧读取／选目标／确认切号流程，只保留开关、依赖说明和主动安装入口。
- Codex 卡片增加邮箱和直接「切换」，按当前公共列表顺序轮换、无二次确认；仍以至少两个有效绑定账号、唯一当前、精确支持版本、未预热及未知结果隔离为前提，写前复核、成功回读、不重试回滚。
- 原生异步内存 IPC 使用临时回环端口及随机 Bearer 能力、拒绝 Origin/重定向/代理并限制负载；关闭与失效清理。完整邮箱仅本地面板内存展示，不进入 state/偏好/统计/日志；设置 API 保持遮罩。不是对同用户恶意进程的防护。
- 账号状态身份与额度新鲜度独立，过期/不支持的额度不伪装可用，但不会锁死已确认身份的切号入口。经典／简洁布局仅增 28 逻辑像素、保留主题/尺寸/位置/右键无交互。
- 通过公开宿主 Remote 提供明确确认的 `dsh-plugin-subscriptions@0.9.9` 安装；同名依赖存在即停止，不自动升级/降级/启用，不默认批准构建脚本，未应用/需重启不伪报成功。宿主 install 无原子 ifAbsent，跨插件并发安装仍需避免。
- 开发与发布验证未真实安装、切号、调模型、重启或跑全量测试；仅新增/受影响模拟和隐藏 WPF 验证。精确测试证据见本地面板验证记录。
- Opt-in panel account cycling and full-email display via a capability-authenticated memory channel; explicit host dependency installation with no same-name replacement or build approval. Retain two-account, race, warm-up exclusion and unknown-outcome safety; no live-host claim.

### 独立绑定的多账号每日预热

- 尝试实现此前缺失的多账号 warm-up：仅支持静态核验的通用订阅插件 0.9.9 公共独立账号模型入口与宿主模型 API；不是轮换激活／默认账号，不回退其他账号或 Pool，不安装依赖。
- 设置页主动读取、逐账号／模型授权、独立 CAS 保存，默认关闭。最多八账号、串行、每日每账号一次逻辑请求；额度原始新鲜度无法证明时默认跳过，需逐账号额外同意。不是 HTTP／Token／费用硬上限，不保证启动用量窗口。
- 原子认领先于发送，跨实例文件锁、同日账号去重、模型变更不绕过、未来记录与时钟回拨保守阻止；启动／开启／休眠错过的 occurrence 不在下一 tick 补发。失败不自动重试，未知或遗留认领持久暂停全部自动预热，配置保存不清除。
- 与旧单账号计划及本插件共享切号互斥，原有三个开关不改写；多账号启用时暂停单账号计划，执行中变更授权／模式保守中止并暂停。普通额度刷新、偏好、位置及视觉功能保留。
- 只保存账号与完整模型 ID 的哈希、授权、日期／结果；遮罩邮箱仅内存。鉴权 no-store 新接口有严格 schema、读写大小限制、独立错误品牌，外部错误不能伪造 status 泄漏原文。
- 独立复审发现并修复连接失效后的迟到调用、未知结果解除暂停、旧 journal 不可读时被覆盖及跨计划重启去重风险；源读取／时钟／模式更改均保守阻止自动补发。旧单账号合法 null 时间戳仍兼容，损坏日志保持原字节且明确告警，不使正常轮询失效。
- 源码定向通过 358 项新增／直接受影响 Node 检查及 1101 条原生断言（身份 887、回执 214），仅 mock、竞态和私有 Temp。未跑全量、未调用真实账号／模型、未自动重启。实际依赖未安装时应显示不可用，不声称实机验收。
- Default-off daily account-bound warm-up with explicit per-account consent, durable pre-dispatch claims, no account rotation/fallback and persistent unknown-result quarantine. Only public reviewed bindings, synthetic tests and isolated files; not a physical-request/token/cost cap or live validation.

## v0.7.1 — 明确确认的 Codex 共享账号切换（2026-10-15）

- **版本号更正：** 按用户要求，将此前标记为 v0.8.0 的同一功能版本调整为 v0.7.1。仅修改版本及说明，不变更运行代码；原有测试结果为该相同代码的既有证据，本次只重新核验元数据、安装包和发布指向，不重复运行功能测试。已公开的旧标签保留历史，不作为最新版本。
- **更新原因：** 用户要求取消明日定时、今天完成第二任务的安全增量并发布；在只读身份基础上提供主动切号，不把公共共享账号写操作藏进保存偏好，不以后台轮换冒充账号绑定预热。
- 原生设置页独立读取、选目标、影响确认。只对精确核验的 dsh-codex-subscription 2.6.8 / dsh-plugin-subscriptions 0.9.9 启用各自公共写 API；确认必须有同来源新鲜、有效去重、唯一选中的至少两个已绑定 Codex 账号。其他版本仅保留既有只读能力，不自动安装升级。
- 15 秒一次性确认租约、整体 10 秒 RPC 超时；写前重新验证列表、来源代际、当前和目标。取消零写、一次确认最多一次写、成功重读验证；无 404 写源回退、无自动重试／回滚，失效身份及普通／预热额度的迟到写回。独立单调来源代际覆盖 A→B→A；旧 UI 确认在取消、换目标或卸载后不能提交。
- 与本插件已有预热互斥。写已尝试但结果未知时，后续切号和自动预热保守暂停，直到用户在订阅插件核验并完整重启 DSH；读取新状态或迟到结果不能自动解除。超时不等于撤回上游写；外部插件切号仍无跨插件 CAS／全局在途锁保证。
- 切号 RPC 本身不发模型请求，但已授权的旧预热计划在正常确认切换后仍可能运行，所有开关和去重 journal 保留。切号会影响共享连接／模型缓存，通用默认账号不是请求实际账号承诺。
- 鉴权 accounts GET/HEAD 只读内存能力；POST 严格 8KB JSON schema／no-store，主动读取与确认才访问公共 status/select。浏览器仅接收遮罩标签、匿名标识和短时 opaque 目标；不保存原始 ID 或邮箱，不读 Codex 凭据。
- 多账号 warm-up 明确 unavailable：本机无集成验证的公开账号绑定调用与逐账号预算授权；没有偷偷切全局账号、启用付费计划或伪称支持。多账号额度列表、完整邮箱展开和 WPF 卡片按钮仍暂缓，后者缺可信 IPC。原 2026-10-16 16:00 Europe/Copenhagen 定时已取消。
- 源码定向通过 160 项 Node 检查及 1101 条原生断言（身份 887、回执 214）；仅 mock 公共服务、私有临时文件、真实隐藏 WPF。没有全量、真实账号操作、凭据读取、模型请求或自动重启；完整宿主与真实依赖仍未验收。
- Add explicitly confirmed shared-account selection with fresh two-account and exact-version gates, one-shot leases, privacy-safe authenticated control, source-ABA invalidation and stale-handler revocation. Unknown writes quarantine subsequent control and automatic warm-up; never claim a timeout cancelled upstream work. Retain opt-in schedules and explicitly defer unverified account-bound multi-warm-up and WPF IPC. Deliver the second task's safe increment today; cancel the scheduled continuation.

## v0.7.0 — Codex 只读账号识别（2026-10-15）

- **为什么更新：** 先让用户确认额度所属来源及账号，避免把默认账号当成实际请求账号；公共切号有共享连接副作用，多账号收费预热需要可靠绑定，不能为了按钮或版本号混成未经验证的写操作。
- 产品方案评审团三位成员独立只读评审，主会话核验价值、体验和架构交接，拆成恰好两步；本版完成只读首期。评审不是测试，不编造采用率或工期。
- WPF 面板显示“激活/默认 #匿名短标识”，不改变面板高度、额度/重置位置、经典/简洁模式、四尺寸、五主题、拖动和右键无交互。
- 原生 DSH 设置在 Codex 模式显示可选脱敏邮箱和匿名标识；缺失不猜，默认账号与实际请求选择明确区分。前后 status 校验唯一、有效去重账号；账号/来源不一致或过期不确认身份。
- 新鉴权 GET/HEAD account 路由仅返回内存遮罩，no-store；复用既有 status/usage，不新增上游轮询。原始邮箱、label、原始账号 ID 不转发；遮罩也不进入 state/统计/偏好/日志。来源切换清除身份，普通查询与预热写回都校验选择代际。
- 不新增偏好、不改已有预热计划、不触发真实切号或模型调用。本版没有切号按钮、多账号预热、多账号额度列表或完整邮箱展开；详见 [两步计划](ACCOUNT-ROADMAP.md) 与[能力证据](MULTI-ACCOUNT-NOTES.md)。
- 明日 2026-10-16 16:00 Europe/Copenhagen 继续切号与预热能力门控。**切号按钮只能在受支持订阅插件已绑定至少两个 Codex 账号、公共列表新鲜有效且支持切换时启用**；单账号/未登录/未知/过期禁用。缺可靠绑定或费用/共享副作用决策时暂缓，不后台轮换账号。
- 源码通过 80 项新增／受影响 Node 检查及 69757 条原生断言（身份 887、主题 54702、简洁 4924、陪伴 8344、回执 214、尺寸 438、偏好 216、额度呈现 32）。仅模拟/私有临时文件/真实隐藏 WPF 定向验证；没有全量套件、真实账号请求、模型请求或自动宿主重启。完整宿主/多DPI/真实账号验收不在本轮结果之内。
- Add read-only source-aware account identity, optional masked email in settings and anonymous IDs on the native panel. Reuse subscription reads, isolate presentation in memory behind an authenticated no-store endpoint, reject ambiguous/stale/mismatched identity and retain privacy and existing warm-up behavior. Defer shared-account mutations and account-bound paid warm-up to the scheduled second task with explicit capability and user-decision gates.

## v0.6.6 — 简洁模式与依赖说明（2026-10-15）

- **更新原因：** 需要不带人物和动效的纯余额／额度面板；同时澄清 Codex 额度不是桌宠独立登录查询，而依赖两个受支持公共订阅插件中的一个及宿主公共连接。版本更新、市场简介审核和客户端升级是不同环节。

- 新增默认关闭的严格布尔偏好 `compactMode`，DSH 原生设置显式保存并支持可靠应用回执；组合预览同步隐藏人物。
- 简洁模式只显示 DeepSeek 余额／Codex 额度卡片，缩短实际窗口与逻辑画布，不留下原人物的透明占位。保留五款信息框与四种尺寸，左键拖动和右键无交互不变。
- 强制静态视觉策略，清除在播的角色、余额缩放、叠图、睡眠标记、闪光与飘字；恢复原模式时不补播旧事件。隐藏时不再更新人物帧，真实数据／事件游标／统计仍继续处理。
- 不清空人物、主题、舒适偏好、坐标或已有预热选择；没有新增真实模型请求、账号切换或多账号预热。只做新／受影响测试，不跑全量套件或真实模型请求。按授权发布 v0.6.6、更新本地副本，不自动重启。
- 补充当前 Codex 两条订阅插件依赖、多账号只读展示和账号绑定 warm-up 的可行性及安全边界，详见多账号说明；理论方案不是已经实现的能力。
- 源码定向验证通过：58 项 Node 检查、14168 条原生断言（简洁 4924、陪伴 8344、回执 214、尺寸 438、偏好 216、额度呈现 32）。仅模拟服务、私有临时文件与真实隐藏 WPF；不代表所有宿主版本与账号已实机验收。
- 明确两个 Codex 公共插件为二选一，DeepSeek 不依赖它们；现有自动预热要求更严格的新鲜活动账号报告。稳定 Release 的同名 latest 安装包自动跟随新版，简介修改仍在既有市场 PR #7391 审核，本机插件仍需执行更新。
- Add opt-in panel-only compact mode with all visual effects suppressed, independent saved preferences, live data and proper window geometry. Document either supported Codex addon, distinguish stable-asset updates from catalogue metadata review and installed upgrades, and assess public account capabilities without implementing account changes or multi-account warm-up. Publish v0.6.6 after focused validation only.

## v0.6.5 — 可靠设置应用回执（2026-10-11）

- **更新原因：** 原先「保存成功」只能证明设置写盘，无法证明正常桌宠已经加载并成功应用视觉配置；仅看 mtime 或提前缓存也可能遗漏同时间戳变更及失败后的重试。本次把草稿、保存和真实近期应用确认分离，避免错误的成功提示。

- 核查优化清单后完成 P1 设置应用确认：不再把保存响应或草稿摘要当成桌宠已接收；独立显示等待、最近确认、离线及未确认状态。保存立即清除旧证据，错误／旧宿主保留草稿，过期租约失效。
- 后台为自己启动的子进程传入唯一 runId；只读鉴权 `/api/dsh-plugin-simple-pet/application` 同时核对当前进程、profile、原始配置 SHA-256、17 项实际偏好和 15 秒有效期。前后重复读取配置与运行状态，拒绝配置／进程竞态，接口不返回 PID、runId、偏好值或私有路径。
- 原生桌宠一次读字节、严格 UTF-8 解码并对同一字节计算修订；不依赖 mtime 跳过。窗口 Loaded 后仍只发布 pending，完整原生 tick 成功才发布 applied；沿用现有 tick 每 5 秒续期，关闭仅撤销自己的回执。Preview、无 runId 的旧启动与其他活进程不得写入该成功证据。
- 回执采用独立文件与原子临时替换，不写配置、坐标或统计。设置／数据／视觉异常使证据失效、修复缓存并重试；反馈策略缓存改为实际帧应用成功后提交。保留默认经典、双模式主题、人物、睡眠、拖动、右键无交互和原有预热选择。
- 源码 43 项新增／受影响 Node 检查、62996 条原生断言通过（回执 214、主题 54222、陪伴 8344、偏好 216）。仅私有临时文件、模拟宿主与隐藏 WPF；不跑全量套件、不发真实模型请求、不自动重启。用户授权后发布 v0.6.5、更新本地安装并同步唯一市场 PR #6267；合并须遵守上游权限与检查。实际完整宿主页仍待重启后验收。
- **Why:** a successful save proved only a disk write, not a successful pet visual update; timestamp-only skips and premature caches could also hide changes and retries.
- Add a short-lived, process/run/profile-bound native application receipt, separate from saving and drafts. Require the same raw-byte revision and effective settings after a successful full visual tick; reject stale, mismatched or raced evidence. Reuse existing timers, keep receipt writes isolated and atomic, and retry failed presentation rather than caching success early. Released as v0.6.5 following user authorization. Saving previously proved only a disk write; this release closes that gap without claiming continuous visual or live-host acceptance.

## v0.6.4 — 陪伴与舒适首版（2026-10-10）

- 产品方案评审团的产品、UX、架构三位成员分别只读评审，主会话汇总优化清单并实现首版；未增加专家、未把分析意见当作实机验收。
- 原生设置顶部增加「陪伴与舒适」：安静模式、经典／温和反馈、减少动态、关闭闪光／暴击标记、关闭用量飘字；草稿明确标注，显式保存、修订冲突和原子写盘保留。旧配置仍默认经典，四个新开关默认关闭。
- 安静／减少动态统一停止角色、余额、叠图、睡眠及飘字动画，保留静态待机／睡姿；余额、额度、统计、活动时间与事件游标继续更新。进入／退出静态模式消耗边界快照，退出不补播旧事件；安静不会清空其他偏好。
- 温和反馈复用现有中性待机帧，以 450ms／1px 确认替代受伤或消费奖励动作；连续事件仅合并展示，不修改原始事件、统计或账本。独立舒适开关热更新时立即清理正在播放的效果。
- 不新增桌宠鼠标交互、声音、弹窗、联网轮询或陪伴模型请求；不改变人物、主题、尺寸、位置、账号和预热选择。安静仅控制视觉，不停止已经开启的后台预热，也不屏蔽原有失败安全提醒。
- 随机陪伴动作、完整请求生命周期、休息邀请、开工便签和自动安静时段暂缓；敏感心情记录不纳入首版。优化清单与证据见 [COMPANION-REVIEW.md](COMPANION-REVIEW.md)。源码与解包各通过 40 项新增／受影响检查，包含 8344 条原生断言；不运行全量套件。发布 v0.6.4、更新本地副本，并仅同步最早市场 PR #6267；按正常权限尝试合并，不把同步当作收录。宿主设置页视觉、键盘与主观舒适度仍待完整重启后实机验收。
- Add optional quiet/gentle/comfort presentation controls with classic defaults, atomic explicit-save drafts, live data/cursor consumption and no replay. Stop real WPF clocks in static modes; use existing neutral frames for gentle confirmations without spend rewards or ledger changes. Preserve opt-in warm-up safeguards and inert right-click. Publish v0.6.4 and update the local copy; synchronize only original marketplace PR #6267 and attempt a normal permission-checked merge. Source and extracted packages each pass 40 focused checks / 8344 native assertions. No live model requests or full regression claim; refreshed host-page acceptance remains pending a full restart.

## v0.6.3 — 独立信息框主题与双模式组合预览（2026-10-09）

- 新增独立于人物 `skin` 的 `cardTheme` 偏好：海盐蓝（default，保留原色）、苔庭墨绿（forest）、焦糖暖棕（amber）、暮云紫灰（violet）、月笺雾白（paper）。五款各具渐变、文字、徽标、额度条、边框及圆角，可与六款人物任意组合，缺省／非法旧字段仍回退原蓝色。
- 每款均适配 DeepSeek 余额／缓存／独立峰谷价牌与 Codex 5 小时／周额度／重置／状态，Codex 不继承峰价配色或人民币文案；新浅色款使用深色字，新四色正文对比度达到 4.5:1。
- DSH 原生设置新增双模式主题图库和人物／框组合预览；示例数字明确标注为合成数据。DeepSeek 峰谷预览只修改本地画面；Codex 固定人物姿态，预览不新增模型请求、不读取真实账号额度。
- 显式保存沿用严格类型、修订冲突和原子替换；桌宠约一秒内应用新卡片，更新文字、进度条、阴影与边框并保留调用闪光，不移动窗口或写坐标。旧开发预览设置同步支持主题选择。人物、尺寸、位置、统计、预热偏好和右键无交互均保留。
- 本轮只运行新功能测试：13 项定向测试、54222 条原生断言、480 个主题×模式×人物×尺寸×峰谷组合；源码与解包分别验证，真实 WPF 画面已核对。未运行全量回归，不发真实模型请求、不更改账号／模型，不自动重启宿主；宿主设置页的最终视觉验收仍需首次完整重启后进行。
- 发布 v0.6.3 GitHub 标签与安装包并更新本地副本；仅保留、同步最早市场 PR #6267，另外两条提交已关闭。市场同步不代表合并或收录，状态以维护者审核为准。更新后请完整退出并重启 DSH 一次。
- Add five independently selectable card palettes with DeepSeek and Codex variants, freely paired with six character skins. Host-native galleries and combination previews use clearly labeled synthetic values, preserve explicit revision-checked saves and hot reload, and never initiate model requests or change accounts, models, positions or warm-up preferences. Only the new-feature suite runs (13 tests / 54222 native assertions / 480 combinations); no full regression is claimed. Verify real WPF rendering; live host-page visual acceptance remains pending a full restart. Retain and synchronize only original marketplace PR #6267; close the other two submissions.

## v0.6.1 — 原生 DSH 设置与右键无弹窗（2026-10-08）

- 设置与统计注册到宿主 `settings.section`，入口为「DSH → 设置 → 桌宠」，使用宿主 React、设置导航、深浅主题与自适应布局。没有替代服务器、嵌入式 WPF 弹窗或新的 UI 运行依赖。
- 六款本地皮肤、双模式、飘字单位、四档尺寸、休眠时间、额度检测和三个独立预热开关保留；修改先保留为草稿，显式保存才应用。统计保留周／月／年、人民币／Token 与 Codex 的独立额度／Token 视图；日期和每日计划使用后台电脑时区。
- 继续使用原 `settings.json`：只允许白名单字段和严格类型，通过 SHA-256 修订值、进程内串行队列及临时文件原子替换保存；冲突拒绝覆盖，损坏 JSON 保持原样。新路由和图片复用宿主鉴权，拒绝越界路径、非法内容类型和过大请求。
- 普通 WPF 桌宠每秒检查设置修改并应用，不因选项变更移动或重写坐标；拖动仅保存 `position.json`。重启优先恢复新位置，兼容旧配置坐标。桌宠右键不执行操作，不弹出菜单、退出选项或设置窗口，保留原有左键拖动；旧设置弹窗仅通过显式开发参数 `-Preview -PreviewSettings` 打开。本次移除右键只执行相关定向检查，不重跑全项目。
- 预热保持默认关闭，保留已有开关偏好和去重日志；打开设置／统计只读取本地数据，不触发模型请求，也不修改账号或模型。测试全部使用隔离文件及模拟服务。
- 原生 Codex 页明确区分新鲜、过期和默认账号缓存额度，显示后端电脑时区的重置时间；图库使用固定预览，不显示 DeepSeek 峰谷标签。此前的设置迁移版本源码与实际安装副本均通过 123 项测试及 2847 条原生断言；宿主页面的最终实机验收需首次完整重启后进行，本轮未自动关闭宿主。
- 发布 v0.6.1 GitHub 标签与安装包，同步本地安装副本和现有市场 PR；PR 是否合并／收录以维护者审核为准。此次仅做相关定向检查、客户端构建及包内容核验，未重跑全项目。第一次载入新增客户端和后端须完整退出并重启 DSH；后续保存设置热更新。
- Integrate settings/statistics into the native DSH settings sidebar, with host React, themes, responsive layout, explicit-save drafts and hot reload. Use authenticated revision-checked atomic preference saves and separate drag-position storage. Right-click is inert in normal and preview modes; keep left dragging and all existing modes, skins, sizes, ledgers and opt-in warm-up safeguards. Earlier migration regressions passed 123 tests / 2847 native assertions; this release uses focused checks and package/build verification only. Live host visual verification after a full restart remains outstanding. No live model calls or account/model changes.

## v0.6.0 — 自适应布局、主题滚动条与超小尺寸（2026-10-07）

- 设置和统计窗口支持调整大小：窄窗口自动将表单标签与输入上下排列，皮肤图库在 1–3 列之间切换，统计卡片自动换行；禁用横向滚动并消除原有固定宽度溢出。
- 折线图根据实际视口宽度重绘，动态测量大数刻度，缩小窗口时减少横轴标签密度，保留周／月／年和人民币／Token 统计。
- 纵向滚动条改为深蓝青色圆角细滑块，悬停与拖动高亮，保留滚轮、轨道翻页和原生拖动；按钮与退出区域仍可访问。
- 新增「超小」尺寸（0.625 倍基础尺寸，约为原小号的 74%），角色、卡片与飘字统一缩放；小／中／大保持 0.85／1／1.25 倍，兼容保存与位置边界。
- 修正 Codex 统计单位显示为 Token，不再显示被禁用的人民币选项。生产后端与素材不变，保留用户偏好、历史与预热开关；更新不自动启用预热。
- 源码与解包安装包均通过 80 项回归测试及 2631 条原生断言（设置 1706、尺寸 438、素材 454、额度 33），覆盖 380／480／680／820 宽度、两种计费模式、周／月／年图表、大数刻度、轨道翻页及路由拖动事件。测试使用模拟数据，不发送真实模型请求；多显示器／混合 DPI 和实际鼠标体验尚待实机验证。
- 安装包继续使用 `dsh-plugin-simple-pet.tgz` 和 latest stable 下载地址；同步现有市场 PR 的新版说明，收录仍取决于维护者审核。更新实际安装副本后请完整退出并重启 DSH。
- Add resizable, Flexbox-like WPF settings/statistics, responsive charts with measured labels, theme-matched cyan rounded vertical scrollbars and a tiny 0.625 scale while preserving the other three sizes. Fix the Codex chart selector to show Token. Source and extracted package pass 80 tests / 2631 native assertions using mocks only; no live model calls or exhaustive multi-monitor/mixed-DPI validation is claimed. Preserve atomic saves, artwork, histories and opt-in warm-up settings. Fully restart DSH after upgrading.

## v0.5.2 — 修复重启后桌宠消失（2026-10-07）

- 修复 Windows PowerShell 5.1 在已有设置文件时的启动崩溃：普通 `$null` 备份路径被绑定为空字符串，导致 `File.Replace` 报「The path is not of a legal form.」。改用 `NullString.Value` 传递真正的 null，保留原子替换，不删除旧配置再写入。
- 修复覆盖启动尺寸初始化、拖动和设置保存；保留皮肤、尺寸、位置、统计与原有预热开关，不因更新启用预热。默认 5 秒／可自定义额度刷新及已有预热安全保护不变。
- 补充直接执行生产 `Save-Prefs` 的真实磁盘回归，不再只验证模拟保存：覆盖首次创建、已有文件替换、重复保存、中文与字段类型、坐标取整、写入失败后的旧文件保留与临时文件清理。测试只写隔离临时目录，不访问用户设置。
- 源码与解包安装包均通过 79 项测试及 1283 条原生断言（设置 796、素材 454、额度 33）；完整 WPF 窗口在隔离的已有配置环境连续启动两次。Codex／账号测试使用模拟服务，未发送真实模型请求。
- 安装包沿用 `dsh-plugin-simple-pet.tgz` 与市场 latest stable URL。更新实际安装副本后完整退出并重启 DSH；现有市场 PR #6267 同步新版说明，收录仍需维护者审核。
- Fix pet disappearance after restart on Windows PowerShell 5.1: pass `NullString.Value` to `File.Replace` instead of an empty backup path caused by ordinary `$null` binding. Keep atomic writes and existing preferences. Add real isolated-disk persistence regressions, including failure cleanup. Source and extracted package pass 79 tests / 1283 native assertions; two full WPF startups with existing isolated settings are verified. No live model requests are sent. Fully restart DSH after updating the installed copy.

## v0.5.1 — 可自定义额度检测与满额预热修复（2026-10-07）

- 修复启动检查在订阅接口尚未就绪、报告过期或账号不可确认时被提前消耗：等待后续额度刷新取得可靠报告后再判断。
- Codex 额度检测恢复默认 5 秒，在设置页可保存 1–3600 秒整数；保存后即时重排定时器，不需要重启，也不会打开预热开关。查询忙碌时不并发积压，默认账号／缓存报告仍不能触发预热。
- 「5h 重置」开关增加按自定义间隔强制刷新与满额新窗口检测，不再只等待旧截止时间；支持提前恢复、百分比始终为 100% 但可靠重置时间改变的情况。只有每日开关不会启用周期满额请求。
- 新鲜 100% 报告的已知截止时间即使已过期，也可启动空闲窗口；调用前保存旧窗口与未确认窗口保护，调用后刷新实际新窗口并持久去重。同一窗口持续 100% 不会每次检测都重复请求。
- 保留账号、周额度、报告新鲜度、关闭开关、请求未发送重试和发送后不重试保护。若上游既不改变百分比也不改变已尝试窗口的标识，无法仅凭 100% 证明又发生了一次官方刷新，不绕过去重。
- 79 项回归测试及 1153 项原生断言通过（设置 666、素材 454、额度 33）；覆盖默认 5 秒定时器、间隔保存与校验、无需重启热切换／旧定时器清理、卸载清理，以及启动接口加载、提前满额、空闲过期截止时间与持续 100% 去重。全程使用模拟模型，未发送真实 Codex 请求。
- 安装包仍为 `dsh-plugin-simple-pet.tgz`，市场沿用 latest stable URL。更新实际安装目录后须完整退出并重启 DSH；仅刷新网页或重开桌宠不会加载新后端。保留已有设置、统计与去重记录，预热开关不自动启用。
- Defer startup checks until quota is usable; force-refresh every 5 seconds by default with a settings-editable 1–3600-second interval. Warm fresh full windows, including early restoration and expired idle deadlines, without bypassing durable deduplication or fail-closed checks. Hot interval changes and timer disposal are covered. Source and extracted package pass 79 tests / 1153 native assertions using mocks only; no live billable verification is claimed. Fully restart DSH after updating the installed backend.

## v0.5.0 — 启动预热、定时调度与安全重试（2026-10-07）

- 新增独立、默认关闭的「启动满额度预热」：启动或首次启用时，仅新鲜活动账号的 5h 额度为 100%、周额度可用且重置时间有效才尝试。保留现有每日／重置开关偏好；首次安装三个开关均关闭。
- 用下一每日／可靠重置目标的单次定时器替代常驻 5 秒检查；监听设置变更并复用约 60 秒额度刷新兜底，保留休眠、重启和时区保护，不补发错过的任务。
- 仅已证实未调用模型的错误可安全重试，总计最多 3 次、间隔 5 秒；开始调用后的失败、超时或结果不明不重试。取消可打断预检与等待；最终失败弹窗提示。
- 启动、每日与重置共享持久窗口去重；真实请求仍只有固定短提示，不附会话／工具，不修改账号或全局模型。预热会消耗订阅额度，不能保证窗口从请求时刻开始。
- 修复过期上游截止时间长期压制每日任务；调用后刷新新窗口用于重启去重。驱动锁覆盖设置读取与调度，忙时合并待办，设置关闭及时取消；设置文件改为原子替换，保留 Windows PowerShell 中文 BOM。
- 源码与解包安装包通过 72 项回归测试及 1096 项原生断言（设置 609、素材 454、额度 33）；使用模拟模型与账号，不发送真实 Codex 请求，不代表所有宿主／账号已完成实时预热验收。
- 安装包仍为 `dsh-plugin-simple-pet.tgz`，市场沿用 latest stable URL。升级须完整退出并重启 DSH；已有市场 PR #6267 的收录仍待维护者审核。
- Add opt-in startup warm-up at fresh 100% five-hour quota, single-deadline scheduling and bounded retries only for proven-unsent failures. Preserve durable cross-trigger deduplication, cancellation and account/model preferences; use atomic settings writes. Both source and extracted package pass 72 tests and 1096 native assertions without live Codex calls. Fully restart DSH after upgrading.

## v0.4.0 — Codex 自动预热（2026-10-06）

- 新增每日本机时间 `HH:mm` 与可靠观察的 5h 重置后自动预热，两项独立、默认关闭，没有手动按钮。
- 设置面板常驻可滚动内容区；严格校验时间，显示本机时区、状态、上次尝试 / 成功与下一每日时间。开关数秒内生效；第一次升级需完整重启 DSH。
- 通过宿主公共 `llm.stream` 发送固定极短提示，无会话历史、系统提示或工具，不切换模型 / 账号或修改订阅插件设置；真实报告保护额度与账号边界。
- 调用前原子保存尝试记录，失败不由桌宠重试；每日与重置同时命中合并，重启、长休眠、夏令时和设置变化均有保护。独立 Codex 统计包含预热实际报告的用量。
- 复核修正启动 / 唤醒后的多次轮询补发、停用期间已报告用量丢失和共享设置误启用其他配置的问题；仅 Windows desktop 执行，日志损坏停止发送。
- 明确公开接口限制：不能锁定调用中的账号、保证固定 Token / 精确窗口起点、禁止底层传输重试或保证认证阶段严格截止。
- 保留 DeepSeek / Codex 双模式、六款本地预览皮肤、用量动作、独立统计与可拖动设置；升级不重置本机偏好和历史。首次安装两个预热开关默认关闭。
- 源码与解包安装包均通过 56 项回归测试和 1088 项原生断言（设置 601、真实素材 454、额度展示 33）。调度、SDK 调用、额度、账号与后端整合使用模拟服务，不发真实模型请求；不代表所有宿主／账号已完成实时预热验收。
- 新稳定安装包仍使用 `dsh-plugin-simple-pet.tgz`；市场最新稳定版 URL 沿用。完整更新实际安装副本并退出／重启 DSH 后台；市场收录仍需维护者审核。
- Add opt-in local daily and observed 5h-reset warm-up, with no manual button. Preserve model/account preferences, use minimal direct requests and durable deduplication, and disclose SDK transport/token/account limitations. Retain dual billing/quota modes, six skins and statistics. Both source and extracted package pass 56 tests and 1088 native assertions using mocks, with no live model calls. Fully restart DSH after upgrading; marketplace inclusion remains subject to review.

## v0.3.0 — DeepSeek / Codex 双模式（2026-10-05）

- 保留六款皮肤和 DeepSeek 原有余额、人民币 / Token 飘字、峰谷形象与统计。
- 设置新增 DeepSeek 计费模式 / Codex 订阅模式切换，只影响桌宠显示，不修改 DSH 模型或订阅插件的登录账号。
- Codex 卡片显示 5 小时与周额度的剩余百分比、进度条及本机时间的重置日期；不显示人民币、峰价或谷价，形象使用固定预览。
- Codex 飘字可选 Token 或额度百分比；百分比来自同账号、同重置窗口的两次新鲜报告之差，不由 Token 换算。无法可靠取得百分比时回退 Token。
- 通过订阅插件的公开状态 / 用量接口读取额度，不读 Codex 凭据。专用插件跟随当前激活账号；多提供商插件显示其默认账号并标注「可能缓存」，不假装能识别模型池实际选用的账号。
- DeepSeek 与 Codex Token 历史分别保存；未知、过期、切换中及未登录额度明确提示，不虚构 0% 或 100%。
- 识别旧版后端未提供 Codex 字段的情况，提示完整重启 DSH，不再误显示「等待订阅插件」；尚未读到首份状态则提示「等待 DSH 数据」。
- 升级需更新实际安装副本，再完整退出并重启 DSH（含后台／托盘），不能只刷新网页或重开桌宠；本机偏好与旧数据保留。
- 34 项回归测试通过，含 459 项设置、454 项真实素材及 33 项额度展示原生断言。Codex 桥接与切号使用公开 DTO 模拟验证，不代表所有宿主／账号已完成实时额度验收。
- Add selectable DeepSeek billing / Codex subscription modes, remaining 5-hour/week quotas and reset times, Token or observed-percent feedback, and an independent Codex Token ledger. Keep the original DeepSeek behavior and six skins. Use read-only addon RPC without Codex credentials; default-account cached reports remain explicit. Fully restart DSH after upgrading the installed copy.

## v0.2.6 — 新形象与图片预览

- 新增雪绒鲸娘、薄荷茶娘、樱桃汽水娘和星砂魔法娘，保留原来的两款形象。
- 设置里的形象选择改成图片图库，不再用下拉栏；六张卡片都有峰时／谷时预览，点击就能切换并保存。
- 当前形象有高亮和勾选，支持 Tab 聚焦、空格／Enter 选择；预览使用本地缓存，不上传图片或余额。
- 设置内容可滚动，小屏幕下仍能调整尺寸、飘字和睡眠时间，退出桌宠固定在底部。
- 原来的形象 ID、设置与统计数据保留，设置拖动、右键直接进入设置及双路由钱包逻辑不变。
- 新素材保留 AI 生成源图及来源声明，派生图集注明源图和哈希；补充美术授权和隐私说明。有限视觉检查不等于绝无相似或法律保证。
- 22 项测试、420 项设置 WPF 断言及 454 项真实素材整合断言通过；十二张图集的加载、缓存、图库选择与接口访问校验均已回归。
- Four new skins join the existing two. A local, keyboard-accessible six-card gallery shows peak/off-peak previews and replaces the skin dropdown. Preferences and statistics remain compatible; AI source provenance, separate artwork terms and privacy notes are retained.

## v0.2.5 — 设置与统计更新

- 更新设置和统计界面，现在可以拖动顶部标题栏移动窗口。
- 调整右键操作，右键桌宠直接进入设置，不再弹出菜单。
- 形象、尺寸、扣费飘字和退出桌宠都放进设置里，切换后即时生效。
- 设置和统计分成两个页签，关闭设置不会退出桌宠。
- 原来的外观设置和统计数据保留，飘字单位不影响统计图表。
- 15 项测试及 124 项 WPF 断言通过；补充本地安装副本的更新提示。
- Right-click now opens Settings directly. Skin, size, floating-amount unit and Exit Pet live in Settings; usage charts remain in Statistics. Both tabs share a draggable title bar. Existing preferences and statistics are preserved.

## v0.2.4 — 启动即查询账号钱包

- 桌宠启动后立即查询已登录 DeepSeek 账号的钱包；不再先默认查询 API Key 余额，也不必等待首次模型用量事件。
- 模型调用仍按实际路由在账号钱包（`deepseek-account`）和 API Key 钱包（`deepseek-official`）之间切换；余额及定时校准只针对当前路由，不将两种钱包混扣。
- 新增回归测试：启动时在 `seq=0`、没有用量事件的情况下读取账号钱包，并验证两种路由之间的余额切换。
- 如果尚未登录账号或账号余额服务不可用，启动时依旧显示「未连接」；这不是用量动画是否触发的判据。

## v0.2.3 — 双路由支持

- 同时处理 `deepseek-account` 和 `deepseek-official` 的模型用量与余额。

---

## v0.2.4 — Query account wallet at startup

- Query the signed-in DeepSeek account wallet immediately on startup, without a model-usage event or an initial API-key balance request.
- Continue switching between account and API-key wallets according to the actual model provider; balances remain separate.
- Add regression coverage for the empty-event startup and provider switches.
- An absent sign-in or unavailable account balance service can still show “Disconnected” on startup.
