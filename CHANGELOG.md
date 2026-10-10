# 更新记录 / Changelog

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
