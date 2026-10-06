# 更新记录 / Changelog

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
