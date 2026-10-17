# Codex 多账号管理评审与首版行动清单

评审日期：2026-10-17。当前实现基线：[v1.0.1 / 81304f9](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/tree/81304f9c59061fc73942e6b7010157f65d9efc43)。产品经理、UX 研究员、软件架构师分别独立只读分析，主理人核对实际代码后取舍并实施。本报告不是用户研究或真实订阅验收。

## 结论：先把已有账号管可靠，而不是重做订阅插件

本项目已经具备内置 OAuth 多账号、固定账号模型、逐账号额度、模型偏好自动保存、独立授权的每日预热；不能把这些列成“完全没有”。主要差距是故障发生后的可管理性、额度的可解释性以及破坏操作的保护。本轮选择四项 P0；改名和批量查询不阻塞首版，不增加登录来源、自动请求或费用授权。

参考固定为 [dsh-codex-subscription / 53eaf99](https://github.com/WSL043/dsh-codex-subscription/tree/53eaf993874f68d1a6e18135a45ec36cfbb51627)。该提交的 [package.json](https://github.com/WSL043/dsh-codex-subscription/blob/53eaf993874f68d1a6e18135a45ec36cfbb51627/package.json) 标记 3.0.0-beta.8，[README](https://github.com/WSL043/dsh-codex-subscription/blob/53eaf993874f68d1a6e18135a45ec36cfbb51627/README.md) 推荐稳定 2.7.1；以下是源码比较，不是两个已安装版本的实测，也不将参考全部机制照搬。

## 必须做：本次最小生产交付

### P0-1 可信的单账号故障不连坐；全局故障不掩盖

- 用户任务：A 的授权或模型目录发生问题，仍能看到并管理 B，B 的固定模型入口仍存在；A 的请求不转给 B。
- 直接证据：[基线客户端](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/client-source.js#L234-L269) 在非模型操作错误时清掉整个列表；[服务](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/codex-accounts/service.js#L165-L182) 把所有凭据读取异常都吞成 `bound=false`，而 [bindings](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/codex-accounts/service.js#L332-L349) 只隔离四类模型目录错误。它已有部分隔离，缺的是来源可信、分阶段的边界。
- 参考：[逐账号额度读取](https://github.com/WSL043/dsh-codex-subscription/blob/53eaf993874f68d1a6e18135a45ec36cfbb51627/src/account-usage.js) 和 [状态控制器](https://github.com/WSL043/dsh-codex-subscription/blob/53eaf993874f68d1a6e18135a45ec36cfbb51627/src/account-status-controller.js) 将局部错误、状态代际和取消分开。
- 决策：仅本服务签发的 `OAUTH_REQUIRED`、`OAUTH_IDENTITY_INVALID`、`OAUTH_IDENTITY_CHANGED` 及四类安全 `MODEL_CATALOG_*` 可作账号局部状态。撤销/代际变化必须重读同一账号目录确认。未知异常、共享凭据存储/目录故障、依赖导入/驱动契约、来源变化、服务关闭和调用者取消仍明确失败；不按外部异常文字猜测归属。
- 新状态只表达本地凭据可读性，不证明远端会话有效、额度可用或模型权限。状态计算不新增 driver 初始化、OAuth refresh 或上游查询。显示旧列表时标明尚未核验并暂停依赖其代际的操作；已提交动作的后续目录读取失败，不等于动作失败，不自动重发。
- 拟定验收：合成 A/B 与顺序交换、授权在读取间隙消失、撤销/卸载、共享存储故障、伪造同名异常；健康入口保留，失效入口无模型，不回退、不改变默认或每日账本，不泄漏令牌/邮箱/账号原始 ID/异常正文。

### P0-2 额度旧值、观察时间和重置状态可解释

- 用户任务：区分尚未查询、缺少窗口、读取失败、以前读到的值和已过重置时间，知道何时应主动刷新。
- 直接证据：[基线额度 UI](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/client-source.js#L487-L496) 用占位对象显示破折号，刷新失败又隐藏旧值；[服务](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/codex-accounts/service.js#L276-L289) 实际保留旧数值和原 `clientObservedAt`。已有 [quota DTO](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/codex-accounts/quota.js#L20-L41) 可支持展示。
- 参考：[逐账号额度组件](https://github.com/WSL043/dsh-codex-subscription/blob/53eaf993874f68d1a6e18135a45ec36cfbb51627/src/client-account-quota.jsx) 展示窗口、重置与独立错误，而不是只显示百分比。
- 决策：保留旧百分比并醒目标旧；显示本机收到时间和窗口重置时间，按本地时钟重绘过重置提示，不推算补成 100%。没有读数不显示 0%，只报告周窗口时不虚构 5h。普通用量受限单独说明。
- 拟定验收：未查询、成功、缺窗、失败有/无旧值、零剩余、时间前进、未来观察时间；数值及成功观察时间不因刷新目录/重绘改变，不串账号，不触发新增上游查询。
- 限制：客户端收到时间不是服务器采样时间；状态更清楚也不构成启动/5h 精确满额预热证据。

### P0-3 移除前确认目标，操作后核验结果

- 用户任务：核对昵称、短标识和默认状态，能取消误触；知道移除是本地撤销，不是官方远端退出。
- 直接证据：[基线一击移除](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/client-source.js#L493) 对应 [后端先撤销、清默认、终止该账号请求、再删凭据](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/codex-accounts/service.js#L244-L253)。误触概率未经用户观察验证，但这些后果是代码事实。
- 参考：[账号卡片](https://github.com/WSL043/dsh-codex-subscription/blob/53eaf993874f68d1a6e18135a45ec36cfbb51627/src/client-account.jsx) 对删除目标先确认/取消。
- 决策：仅设置页行内确认；昵称、短标识、默认状态及在途请求影响可见。公开移除动作带目录代际校验，旧确认或目标变化不能删新记录。内部取消登录仍可清理自己的临时绑定。初次点击/取消不写；确认只提交一次，随后重读核验。凭据清理或后续读取失败提示结果未确认/可能已撤销，禁止自动重试、回滚或选择别号。
- 拟定验收：取消/Escape 零提交，重复确认至多一次，代际变更零删除，默认被移除后不自动选 B，未知结果只能先刷新；按钮含目标的可访问名称，确认默认聚焦取消，不新增桌宠右键行为。
- 保持：不删除每日预热记录、统计、他插件授权；同一订阅重新绑定不重置预算身份。

### P0-4 安全错误码与冲突状态跨代理保真

- 直接证据：[基线代理](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/official-accounts.js#L24-L39) 转换错误后又 [统一回 503](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/blob/81304f9c59061fc73942e6b7010157f65d9efc43/official-accounts.js#L93-L95)，但客户端以 HTTP 409 暂停模型保存冲突，导致真实冲突被误导成可重试保存。
- 决策：仅正向白名单的公共错误保留对应状态/代码，未知异常继续用固定安全错误，不回传原始 cause、stack、响应体或路径。`SOURCE_CHANGED` 仍为冲突，草稿保留并暂停自动保存；明确放弃并重新读取才能取得新基线。普通 503 和已提交后读取失败不得伪装成确定未发送。
- 拟定验收：实际 handler→RPC→proxy→UI 合成链路；409 保留、草稿不丢、无自动重发；未知错误哨兵不得泄漏。

## 建议做：后续待办，不作为本版完成条件

- P1 本地账号改名：仅改已有 `label`，独立确认/取消及代际校验；不变 key、epoch、默认、模型键、授权与账本。继续短标识，不为识别账号而采集完整邮箱。
- P1 主动批量额度查询：只有明确按钮才启动，最多八账号且受限并发，逐账号结果隔离、取消/源变化丢弃晚到回包；不照搬打开页面即查询所有账号。
- P1 安全诊断：只输出白名单代码与状态；不收集原始错误、凭据、账号 ID、回调 URL、正文或路径。
- P1 可用性走查：以合成双账号页面验证辨认 A/B、读旧额度、理解三层默认、取消/确认移除及键盘/窄屏使用；不增加遥测，不编造转化率、性能收益、工期或用户研究结果。

## 暂缓与保留约束

- 原位重新授权不是给现有登录加按钮：需要临时授权槽、同身份验证、原子替换、epoch 隔离、旧 refresh 晚到防护、取消保留旧授权及默认/模型配置恢复。现有 `beginLogin` 创建新 private key 且拒绝重复身份，不具备这套事务。本次不做。
- 不新增 Pool/自动切号、模型重试、全部退出、清授权恢复、启动或精确 5h 满额触发、重置卡/Credits 消费、邮箱采集、主会话自动改模。
- 本服务默认仅作用于 `default:` 入口；固定账号模型不跟随切号。DSH 默认模型仍需明确保存并回读，已固定会话由用户在顶部重选。
- 普通及模型偏好已有 450ms 自动保存；授权、账号来源、DSH 默认和每日预热授权仍需明确操作。评审简报中的“模型偏好都手动保存”已按源码纠正，不回退现有自动保存。

## 验证记录

首版已实现 P0-1～P0-4。实际离线结果：

- 源码受影响定向测试 **313/313 通过**，不是全量测试。新增合成用例覆盖 A/B 故障位置互换、未知同名错误不能冒充局部错误、撤销与卸载、共享存储失败、真实 service→Fetch RPC→proxy→设置组件的 409、移除取消/双确认/旧代际/后续读取失败，以及额度跨重置时钟降级。首次运行仅旧版本号断言未随小版本更新，修正为 1.0.2 后重跑通过。
- 实际公开 SDK 的隔离离线夹具 **16 场景、259 断言通过**。凭据、消息、额度与 SSE 都是合成数据，禁止真实 socket、HTTP、WebSocket 和子进程；真实凭据修改及真实上游请求为零。
- 生产 React/ReactDOM 的隔离 Edge 页面 **4 场景通过**：宽屏、380px 窄屏、移除确认、单账号失败。DOM 检查确认保存栏仍可见、无横向溢出、取消默认聚焦及健康账号操作保留；此为合成状态/传输，不是运行中 DSH 页面或真人可用性走查。
- 发布安装包另执行严格路径/文件白名单、源码字节与 PowerShell BOM 核对，并从解包目录重跑同一受影响测试集；本机只更新插件所有文件，不修改账户目录、凭据、每日预热账本或其他插件配置。

全量/WPF 回归、真实 OAuth/额度/订阅资格、真实模型和真人走查不在本次授权范围，不将离线通过当真实账号成功。P1 与原位重新授权等暂缓项保持未完成，不以 coverage 或三位成员返回代替产品验收。
