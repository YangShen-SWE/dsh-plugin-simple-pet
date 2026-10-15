# Codex 依赖、切号、邮箱与多账号 warm-up 评估（v0.7.2，2026-10-16）

**当前范围：** v0.7.2 已交付面板邮箱/一键切号与独立绑定的每日多账号预热，均默认关闭。多账号启动满额和 5h 刷新满额触发仍明确禁用，不代表已实现；下文保留 v0.7.1 等历史核查以解释演进。

本文保留 v0.6.6 的静态接口核查证据；v0.7.0 已实现设置页只读脱敏邮箱与面板匿名账号标识。v0.7.1 增加 DSH 设置页明确确认的共享账号切换，仅对已核验精确版本、至少两个新鲜有效已绑定账号启用；卡片按钮、多账号额度列表与多账号 warm-up 仍未实现。未知写结果时本插件暂停后续切号和自动预热，需在订阅插件核验后完整重启，不能靠状态读取自动解锁。切号 RPC 本身不调模型，原有已授权预热仍可能在成功切换后继续。原明日定时已取消。本轮验证只使用模拟公共接口、私有临时文件和隐藏 WPF，未读取真实凭据／账号状态或调用真实登录、status、额度、切号、模型接口。两步实施、隐私取舍及后续启用门槛见 [ACCOUNT-ROADMAP.md](ACCOUNT-ROADMAP.md)。

## 启动满额与5h刷新为什么暂不可用（v0.7.2 核查）

当前只交付每日授权预算，不把未知新鲜度报告当作自动触发依据。设置「自动预热」子页明确展示两个禁用项；API 返回 `triggers.daily=true`、`startupFull=false`、`resetFull=false`、`quotaEvidence=unverifiable`，不增加新的可保存权限。旧 `allowUnverifiedQuota` 只授权每日一次，不授权启动或每窗口额外调用。设置页切换或读取不会查询上游额度。

本次复核公开通用订阅 **0.9.9** 固定提交 `9930c5ee5e3fa239db9031f47a0f6f30f7ffc443`：

- [公共 ProviderUsage/UsageWindow](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/providers/common.ts#L494-L525) 只暴露 supported、windows 的 kind/scope/usedPercent/resetsAt 等，不回显账号，不提供原始采样时间、缓存来源、刷新失败状态或窗口原始秒数。
- [snapshotFor 缓存路径](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/providers/pool-usage.ts#L141-L220) 在失败负缓存期间、或本次新抓取失败后，都可能以成功 RPC 返回旧 lastSnapshot；`force=true`、收到时刻及 repeated 100% 不能证明新鲜。
- [窗口归一化](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/providers/codex.ts#L361-L410) 将约 18000/604800 秒分类为 session/weekly，缺少有效时长时按 primary/secondary 位置回退；原始时长和分类依据在公共 DTO 丢失，session 标签不等于严格官方 5h 证据。resetsAt 是窗口到期报告，不是采样时刻，也不能仅凭时间到期发请求。
- [force 的共享副作用](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/index.ts#L1248-L1250) 包括清理该账号 Pool 健康状态；不把频繁 force 包装为无副作用的后台只读轮询。

要真正开放这两个触发器，需要依赖先提供并明确版本化的公共契约：成功采样时刻（旧缓存保持旧值）、失败/缓存状态、账号绑定回显、原始窗口时长和分类依据；桌宠需再核验该版本并补充独立默认关闭授权、每天总预算、启动/定时/刷新共同窗口认领、跨版本日志迁移和未知结果暂停测试。不能只因为某响应多了 fetchedAt 字段就信任，也不能私读依赖令牌或绕过公共契约。当前不做多账号启动预算请求冒充“满额检测”，不偷偷轮换共享账号。

## v0.7.2 面板管理

新增默认关闭的多账号管理开关；设置页去掉旧切号列表/确认，说明依赖并通过公共 pluginManager 提供用户明确确认的通用订阅 0.9.9 安装入口。既有同名依赖不升级、降级或自动启用，不批准构建脚本；宿主缺 API 时只提示手动管理。宿主无原子 ifAbsent，勿并发管理同名插件。

开启管理后，WPF 显示当前公共邮箱（完整值只在原生内存与短时鉴权回环响应中），按钮直接按公共列表顺序切至下一账号，无第二确认。每次仍验证至少两个有效绑定、唯一当前、精确版本、预热互斥与写前状态；未知写结果隔离后续切号和自动预热。状态身份与额度证据分离，旧/不可用额度不锁死已确认账号的切换，但不允许据此预热。经典/简洁面板增加28逻辑像素，关闭恢复原布局；邮箱与能力密钥不落盘。多账号预热的独立授权不随该开关开启。开发和发布验证没有真实安装、切号或模型调用；下文旧版“无WPF/不安装”的结论已由 v0.7.2 范围替代。

## v0.7.2 独立账号每日预热

现已接入通用订阅插件 **0.9.9** 公共独立账号模型条目：主动读取公共状态与 `llm.listModels('codex')` 的严格交集，逐账号选择固定模型并独立授权，每天本地时间串行、每账号一次逻辑调用。最大八账号，不改共享默认／激活账号，不回退 Pool。`dsh-codex-subscription@2.6.8` 没有该绑定能力，仍不能启用；打开预热页不会安装或升级依赖；账号管理页提供明确点击的安装入口，既有同名插件不变更。未装兼容通用插件时该预热不可用。

额度接口没有可靠原始获取时间，即使 `force` 也可能缓存，因此不再以“收到时间”冒充新鲜额度，也不推断官方窗口。默认逐账号跳过，额外同意“未知额度仍按每日次数预算尝试”后才可调用；预算不是 HTTP、Token、费用硬上限。新计划默认关闭，设置与视觉保存隔离；开启时暂停原单账号计划，不改写原开关。发送前原子认领、跨实例锁、每日去重；结果未知／崩溃认领持久暂停所有自动预热，保存或关闭计划不清除；没有开机、休眠、回拨补发或自动重试。

账号／完整模型 ID 只在公共接口内存中匹配，持久化仅哈希与授权／日期／终态；遮罩邮箱不落盘。只做 mock 和私有临时文件验证，未调用真实状态／额度／模型、未实际安装依赖或重启；不声称真实宿主绑定与中间件已经验收。**以下结论表和接口分析保留为原版本历史，若与此段冲突，以 v0.7.2 范围为准。**

## 结论与版本范围（原发布版本历史）

| 需求 | 结论 |
| --- | --- |
| 卡片加用户主动切号按钮 | 可复用公共 RPC，不必新增生产依赖；但会修改宿主共享订阅账号并使连接／缓存失效，不是桌宠局部操作。 |
| 显示邮箱 | 公共脱敏状态有可选字段，可以做；缺失时显示未知／账号标签。必须区分“激活账号”“默认账号”和“该请求实际执行账号”。 |
| 多账号额度 | 有公开接口可进一步适配，但版本有差异；当前桌宠仅显示一个账号，尚未实现。 |
| 多账号 warm-up | 本机专用插件接入尚无已证实的公开账号绑定调用；另一个插件的新版已有账号独立模型入口，具备可研究的落地路径，但当前桌宠不兼容此路径，不能直接启用。 |

核查时本机桌面 profile 安装的是 `dsh-codex-subscription@2.6.8`。官方 WSL 仓库固定提交 `cd856a0ac5c1790218c77353d65a9c019896baa9` 已为 `3.0.0-beta.7`，不是本机版本。V1ki 官方固定提交 `9930c5ee5e3fa239db9031f47a0f6f30f7ffc443` 为 `0.9.9`；本次未在当前桌面 profile 发现它，不能称其新能力已在本机安装、启用或实测。

## 当前桌宠的使用条件与实现

- DeepSeek 使用 DSH 已配置的官方凭据，不要求 Codex 订阅插件。
- Codex 额度必须有宿主 `connection.createSharedFetchHandler('/api')` 公共连接及以下两个插件之一，启用并登录：`dsh-codex-subscription` **或** `dsh-plugin-subscriptions`。二选一，不是同时必装；桌宠不独立读取私有令牌，不自动安装依赖。
- [当前额度实现](codex.js#L41-L79)：首选 `codex-subscription/status → usage({force}) → status` 的活动账号。仅首选 status 接口不存在时，尝试 `subscriptions-auth.status → usage({provider:'codex',account:key,force:false}) → status` 的默认账号。不是任意未登录／失败都切换来源；后者可能缓存，收到时刻不是原始获取时刻。
- 当前只有一个额度 DTO，`accountCount` 不是多账号额度列表；邮箱与列表没有进入桌宠状态。能调用 Codex 模型或登录 Codex CLI 不保证有额度接口。
- [当前预热准入](warmup.js#L30-L34) 只接受新鲜 `openai-codex` 活动账号报告，不接受第二条默认／缓存路径。[当前调用](warmup-call.js#L3-L60) 固定 `openai-codex`，仅前后核对账号，且模型 ID 校验不接受下述 `~account:` 独立条目；没有显式账号绑定。

## 切号按钮与邮箱：可以做，但要标注真实语义

### 专用插件：本机 2.6.8 已证实

该安装包公开注册 `codex-subscription/status`、`codex-subscription/account/select`、`usage` 等端点，使用现有宿主受信 `/api` 的 client-request envelope；不能拿 JSON 对公网任意发送，也不应读取 vault。

- `status.accounts` 的脱敏行包含 `id`、`label`、`active`、可选 `email` 等。读取 `active === true` 行的 `email`，不是顶层 email；缺失时不把 label 猜成邮箱。
- 切号准确方法是 `codex-subscription/account/select`，载荷 `{id}`，不是猜测的 activate。它会持久修改 activeId、关闭共享连接、清空用量／重置／模型缓存、通知账号变化并刷新模型目录；不能承诺只影响桌宠或在途请求原子切换。
- 界面应叫“Codex 激活账号”，在用户明确点击并确认影响后调用。切换忙碌期间禁用重复操作，先清理旧额度／邮箱／账号确认状态，再重读公共状态确认；不把点击成功当作所有后续模型都已使用该账号。

本机静态核查定位：安装包端点表 L1128–1159，脱敏 DTO L2953–2963，status L3198–3218，select L2999–3007/L3233–3236，连接及缓存失效 L6418–6433。status 自身也可能迁移旧凭据或触发模型目录刷新，因此本次没有实际调用它。

### 通用订阅插件：公开 0.9.9 已证实，非本机验收

- [公共 RPC 契约](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/auth/rpc.ts#L85-L108) 给出 `providers.codex.accounts`、`key`、`isDefault`、可选 `account`；[setDefault／usage](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/auth/rpc.ts#L538-L578) 支持 `subscriptions-auth.setDefault({provider:'codex',account:key})` 和逐账号 usage。
- [`account` 的来源](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/index.ts#L314-L328) 可能是邮箱，也可能回退 accountId，字段名不是 email。不能对所有值标成邮箱。
- setDefault 持久改默认账号并[重建／公告模型路由、清理池状态与缓存](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/index.ts#L768-L810)。普通模型仍可由 Pool 选其他账号，因此应标“默认账号”，不是“当前请求实际账号”。

v0.7.0 只在设置页鉴权内存接口显示遮罩邮箱，不提供完整展开；完整邮箱和遮罩均不进入共享状态落盘、日志、统计或错误消息，原生面板只显示匿名哈希。插件不自动采集含账号的截图，但不能保证用户自行截图不泄露页面可见遮罩。账号与额度必须同来源、同key，换来源/过期/失败清除身份。未来切号按钮必须先确认其他受支持订阅插件已绑定至少两个 Codex 账号，公共列表新鲜有效且有相应切号能力，否则禁用并给出原因。

## 多账号额度：有真实公开接入点，不能混淆版本

- 本机 WSL `2.6.8` 端点表没有 `usage/accounts`，已有 usage 是活动账号路径。官方 `3.0.0-beta.7` 的 [RPC](https://github.com/WSL043/dsh-codex-subscription/blob/cd856a0ac5c1790218c77353d65a9c019896baa9/src/subscription-rpc.js#L223-L230) 新增它，调用 [独立账号额度读取器](https://github.com/WSL043/dsh-codex-subscription/blob/cd856a0ac5c1790218c77353d65a9c019896baa9/src/account-usage.js#L1-L83)，不需改变 active；不能把 beta 功能当作本机已有，也不能将内部 credential store 当公共 API 使用。
- V1ki 公开版本已有 `usage({provider:'codex',account:key,force?})`，可按稳定 key 读取。仍需适配原始获取时间、缓存、失败与并发限流，而不是只循环当前桌宠的默认账号调用。
- 按 provider＋账号独立维护额度／刷新时间／错误，标清新鲜、缓存或未知；不将当前账号额度复制给其他账号，不偷偷切全局账号查询。

## 多账号 warm-up：存在可研究路径，但不是本机现成能力

### 当前 WSL 接入

本机认证与模型适配器读取活动账号 store，公开端点未提供按账号绑定的模型 stream。前后核对活动账号只能发现观察到的变化，不能锁住调用期间身份，也无法排除 A→B→A。新版 `usage/accounts` 是额度读取，不是账号绑定模型调用。因此不能靠循环 select／setDefault 冒充安全多账号预热。

### V1ki 独立模型入口改变了笼统的“上游缺绑定”判断

[官方账号管理说明](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/docs/account-management.md) 的 `independentEntry` 默认关闭。启用某账号的独立入口后，会通过公共模型目录公开绑定稳定账号 key 的模型；账号不可用时失败，不回退普通 Pool。

[AccountPreferencesAdapter](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/providers/account-preferences.ts#L62-L165) 在模型目录公开独立条目，prepareCall／stream 捕获并校验具体账号；[重放](https://github.com/V1ki/dsh-plugin-subscriptions/blob/9930c5ee5e3fa239db9031f47a0f6f30f7ffc443/src/providers/replay.ts#L7-L39) 也按 provider／account／model 隔离。独立条目 ID 以 `~account:` 开头，但不应自行拼 ID 或 deep-import 内部 `streamAccount`；应读取宿主公开 `llm.listModels('codex')` 返回的条目，再按该 provider／model 调用公共 stream。

因此可基于支持版本、用户已开启的独立模型入口另做多账号预热适配，未必需要新插件；但必须更改桌宠现有 provider／模型筛选、额度准入和去重调度，并验证宿主额外中间件／重试不会改账号。当前 v0.6.6 没有这套适配，也没有对任何真实账号验证。

### 实施前安全门槛

1. 每账号独立显式选择、默认关闭、请求预算；共享串行队列，不能干扰正在进行的普通调用。
2. 绑定模型、账号仍存在与允许入口均须可确认；额度未知／耗尽／身份不明则停止，不回退别号。
3. provider＋账号＋日期／窗口独立持久去重，发送前 claim；旧 journal 保守迁移，不能改键重复发送。
4. 调用结果不明不自动重试。极短提示也不保证固定 token 或一定启动官方用量窗口。
5. 先用模拟接口覆盖切号／删除／撤销／模型目录变化与并发边界。真实切号、额度探测或模型请求另行明确授权。

建议顺序：先实现明确来源的脱敏邮箱与用户主动切号，再做按版本探测的多账号只读额度；账号绑定模型经过隔离验证后，才单独实施多账号 warm-up。以上是可行性评估，不是本次功能承诺。
