# dsh-plugin-simple-pet

**最新版：[v0.5.2 · 修复重启后桌宠消失](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/releases/tag/v0.5.2)** · [更新记录](CHANGELOG.md) · [安装包](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/releases/latest/download/dsh-plugin-simple-pet.tgz)

Windows 桌面上的 Q 版 DSH 桌宠：DeepSeek 模式看余额、用量与峰谷价格；Codex 模式看订阅的 5 小时及周额度，用角色动作反馈调用。A small native Windows pet for DeepSeek billing and Codex subscription quotas in DeepSeek Harness (DSH).

> **兼容 / Compatibility:** 面向 DSH `0.2.0-rc.1`、`0.2.0-rc.2`；DeepSeek 功能已在 Windows + `0.2.0-rc.2` 实机验证，`rc.1` 尚待实机回归。Codex 额度需要宿主提供公共进程内连接适配器，并安装、启用支持的订阅插件；不能仅凭 DSH 版本号保证额度接口可用。This is an unofficial community project, not a DeepSeek product.

> **v0.5.2 更新：** 修复 Windows PowerShell 5.1 在已有设置文件时保存失败、导致重启后桌宠不显示的问题，保留原子保存与原有设置。默认 5 秒／可自定义额度刷新、三个独立且默认关闭的预热开关和持久去重不变；更新实际安装副本后请完整重启 DSH。主动启用预热会发送真实请求并消耗额度。

## 中文使用说明

### v0.5.2 更新重点

- **修复重启后窗口消失：** Windows PowerShell 5.1 将 `File.Replace` 的普通 `$null` 备份路径绑定成空字符串；改为传入真正的 null，已有配置下可正常启动并原子保存。
- **真实写盘回归：** 在隔离临时目录直接执行生产保存函数，验证首次创建、已有文件替换、重复保存、中文和字段类型，以及失败时旧配置保留与临时文件清理。源码与解包安装包均通过 79 项测试、1283 条原生断言；完整窗口已在隔离的已有配置环境连续启动两次。
- **设置不重置：** 皮肤、尺寸、位置、历史与预热开关兼容；升级不启用预热，Codex 测试仍使用模拟服务、不发送真实请求。

### v0.5.1 功能继续保留

- **可自定义额度检测：** 默认每 5 秒强制刷新；设置支持 1–3600 秒整数，保存后直接重排定时器，不会启用预热开关。查询忙碌时不并发积压，上游限流与报告新鲜度仍受接口约束。
- **启动就绪等待：** 接口尚未加载、报告过期或账号未确认时不提前消耗启动检查；取得可靠报告后再判断。
- **提前满额与空闲窗口：** 「5h 重置」开关按检测间隔检查满额新窗口，不只等待旧截止时间。允许新鲜满额报告的过期空闲截止时间启动窗口，并刷新实际新窗口；持续 100% 不会重复请求。
- 保留单次目标定时器、三个独立且默认关闭的预热开关、账号／周额度保护及持久去重。仅已证实未发送的失败最多安全重试 3 次，间隔 5 秒；发送后结果不明不重试，不补发休眠错过的任务。
- 原有 DeepSeek / Codex 双模式及下表功能继续保留；设置、位置、六款皮肤和用量历史兼容。服务器报告决定重置时间，不能保证 09:30 → 14:30。

| 模式 | 悬浮卡片 | 用量飘字与统计 |
| --- | --- | --- |
| DeepSeek 计费模式 | 当前官方路由的钱包余额、缓存命中率、峰谷价格 | 人民币 / Token 飘字；原有统计保留 |
| Codex 订阅模式 | 5 小时 / 周剩余额度、重置时间、数据状态 | Token / 实测额度百分比飘字；独立 Token 统计，不显示人民币与峰谷价格 |

在右键设置中切换模式。**切换只改变桌宠显示，不改变 DSH 的模型、提供商或登录账号。** 原有六款皮肤、位置、统计、可拖动设置窗口及右键直达设置继续保留。

### 功能与特色

- **轻量悬浮窗：** 透明、可拖动、始终置顶；角色位于卡片边缘。右键直接打开设置，可选择小／中／大尺寸；设置与统计窗口可拖动标题栏移动。
- **六款图片形象：** 默认海蓝鲸鱼娘、夜航科技娘、雪绒鲸娘、薄荷茶娘、樱桃汽水娘、星砂魔法娘。图库点击即切换并保存，选中卡片有高亮和勾选，支持 Tab 聚焦及 Space／Enter 选择。预览使用本地缓存；小屏幕可滚动设置内容，退出按钮固定在底部。
- **DeepSeek 峰谷形象：** 按北京时间工作日 09:00–12:00、14:00–18:00 区分峰价与谷价；六款形象均有两种姿态。Codex 使用固定单预览，不显示峰谷措辞。
- **按调用反馈：** 缓存命中轻微受伤、未命中暴击、模型返回时开心弹跳；DeepSeek 另有余额恢复吃白米饭、连续消费与余额耗尽反馈。用量数字按事件顺序上飘，无气泡；仅播放所选计费模式的事件。
- **打瞌睡待机：** 根据所选模式的调用活动进入睡眠动作，默认 10 分钟，可调整为 1–240 分钟。
- **独立统计：** DeepSeek 的 API Key 与账号钱包不会混扣；Codex Token 单独记账。设置中的统计页支持本周／本月／本年折线图，Codex 只绘制 Token，不虚构人民币花费。
- **明确数据边界：** 处理 `deepseek-official`、`deepseek-account`、`openai-codex` 与 `codex` 路由；没有通知或自定义价格规则。动作由 WPF 原生动画播放，状态轮询不限制动作帧率。

### 安装与升级

1. 在 Windows 上安装 DSH。使用 DeepSeek 时，在 **DSH 内**配置官方 API Key 或登录 DeepSeek 账号；使用 Codex 时，在 DSH 中安装并启用支持的订阅插件并登录。凭据由 DSH / 订阅插件管理，无需填入桌宠。
2. 从 [v0.5.2 发布页](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/releases/tag/v0.5.2) 下载源码 ZIP 并解压到**长期保留的目录**，或运行：

   ```powershell
   git clone --branch v0.5.2 https://github.com/YangShen-SWE/dsh-plugin-simple-pet.git
   ```

3. 安装完整目录，将路径换成实际解压路径。不要只复制某个脚本；所有运行文件和 `assets/` 都需保留。

   ```powershell
   dsh plugin --profile desktop add "file:C:/path/to/dsh-plugin-simple-pet"
   ```

4. 如果以前安装过 `@local/dsh-simpledesktoppet` 或 `@local/dsh-deepseek-pet`，先禁用／移除旧插件，避免重复处理事件。升级已有安装时，重新安装新目录或通过市场更新，不能只修改源码副本。
5. **保存当前任务后，完全退出并重新启动 DSH（包含后台／托盘进程）**，让新版 Node 后端加载。只刷新网页、关闭桌宠、重新打开桌宠或重启旧安装副本都不等于升级后台。
6. 在插件管理中启用 `dsh-plugin-simple-pet`，桌宠随插件自动启动；停用插件时关闭由插件启动的窗口。右键进入「设置与统计」，切换计费模式、形象、尺寸、飘字单位与睡眠时间。右上角「×」只关闭设置，「退出桌宠」才退出悬浮窗。运行期间不要移动或删除安装目录。

市场条目使用 [最新稳定版安装包](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/releases/latest/download/dsh-plugin-simple-pet.tgz)，不是固定到旧版本的下载地址。市场收录状态取决于维护者审核，[收录 PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6267) 未合并前可先使用 GitHub 安装。

默认安装目录通常是 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-simple-pet\`。桌宠为单实例，正常使用不需额外运行启动脚本。仅排查窗口时，可在已安装目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\pet.ps1 -DshProfile desktop
```

### Codex 订阅模式

右键 → 设置 → **计费模式 → Codex 订阅模式**。卡片展示**剩余额度**与本机时区的重置时间；未知显示 `—`，过期或失败标为上次额度。

- **`dsh-codex-subscription`：** 通过其公开状态 / 用量接口跟随激活账号，查询前后核对账号，丢弃切号期间的结果。不默认查询 Codex CLI 账号，也不擅自切换账号。
- **`dsh-plugin-subscriptions`：** 显示其默认 Codex 账号，标为「默认账号 · 可能缓存」。模型池／独立模型实际使用账号没有公开关联，不能保证与默认账号一致；上游没有原始刷新时间，不生成其百分比飘字。
- **Token 飘字：** 来自 DSH 报告的输入、缓存与输出，不重复计入推理 Token，不包含其他客户端未报告给 DSH 的调用。
- **额度百分比飘字：** 只表示同账号、同重置窗口、两次新鲜报告间的实际下降；不是 Token 折算，也不保证属于某一轮 DSH 请求。额度恢复、窗口重置、账号切换不算消费；缺少可靠报告时回退 Token。
- **刷新与升级：** 新后台加载后立即查询，默认每 5 秒请求刷新；右键设置 → **Codex 额度检测** 可保存 1–3600 秒整数，保存后重排刷新定时器，无需重启。查询忙碌时不并发积压，报告新鲜度和上游限流仍由订阅接口决定。调整检测间隔不会启用预热。提示「请重启 DSH 更新桌宠」表示读到缺少 Codex 字段的旧后端状态，不代表订阅插件未登录；「等待 DSH 数据」表示尚未读到首份状态。
- **统计边界：** Codex 不显示人民币／峰价／谷价；统计页显示今日 Codex Token 和 5h／周额度，折线图仅统计 DSH Token。其他客户端的消耗可能影响账户额度，但不会被编造成本插件的 Token 历史。只有 OAuth 模型、没有受支持的用量接口时，不虚构额度。

### Codex 自动预热（v0.5.1）

启动就绪等待、周期满额检测、过期空闲截止时间支持和默认 5 秒／可自定义检测间隔已包含在 v0.5.1。请更新实际安装副本并完整重启 DSH；下载旧安装包或仅修改源码不会更新已经运行的后台。

右键 → 设置 → **Codex 自动预热**，在任一计费显示模式下均可设置。**没有手动预热按钮**；三个开关独立，默认都关闭（升级保留原有开关偏好，新启动开关默认关闭）：

- **每日预热：** 设置严格的 24 小时制 `HH:mm`，例如 `09:30`，保存时间并启用每日开关。按运行 DSH 的电脑本地时区执行，不固定为北京时间或哥本哈根时间；设置文件变化时重新读取，按下一目标时间安排单次定时器；复用额度刷新（默认每 5 秒，可在设置中调整）作为兜底。只在持续运行、及时观察到指定时刻后，于该分钟内最多尝试一次；启动或恢复运行时已错过时刻不会补发。修改时间、失败、重启不会重试当天已记录的尝试。
- **启动满额度预热：** 启动 DSH 插件或首次开启此选项时，等待订阅接口和活动账号报告就绪，仅在新鲜报告显示 5h 为 100%、周额度可用且有已知有效重置时间时尝试一次。空闲账号可能仍报告过期截止时间，允许极短请求启动窗口，随后刷新实际新窗口；未确认新窗口时保守阻止同账号 5h 内重复请求。同一账号、同一已知窗口持久去重；100% 可能是取整结果，不证明此前没有调用。
- **5h 重置／周期满额预热：** 仅依据 `dsh-codex-subscription` 当前活动账号的新鲜 5h 报告。除单次截止定时器外，按用户设置的检测间隔（默认 5 秒）强制刷新并检查满额新窗口，覆盖提前恢复，以及一直为 100% 但可靠重置时间改变的情况，不必等待旧截止时间。同一已知窗口最多尝试一次，持续 100% 不会每次检测都发送；只有每日开关不会开启周期满额请求。旧缓存、未知额度、周额度耗尽或默认账号报告不会触发；多个条件同时命中合并为一次调用。如果上游百分比与已尝试窗口标识都不变，无法证明再次官方刷新，不绕过去重。
- **后台生命周期：** 仅 Windows 的 `desktop` 配置执行，其他配置不会因共享设置被自动启用。DSH 与插件必须运行；不会唤醒电脑，不补执行长时间休眠、离线期间错过的任务。夏令时不存在的时间跳过，重复时间不重复执行。关闭设置、退出桌宠窗口或切换显示模式不会停用任务；要停止自动请求，请关闭开关或禁用插件。修改相关设置会取消正在进行的请求，已发送部分可能计入额度。
- **真实请求：** 通过现有宿主 `llm.stream`，显式指定 `openai-codex` 与可用目录内模型；优先当前默认的 Codex 模型，否则使用 Codex 目录首项，并选择已报告支持的最低推理档。只发送固定短提示 `Reply only OK.`，不附带聊天历史、系统提示、会话 ID 或工具，不创建聊天或运行工具；不改动全局模型、账号或订阅插件设置。
- **安全与消耗：** 调用前强制查询当前账号的 5h / 周额度，未登录、报告不新鲜、账号变化、额度耗尽或去重记录无法保存时不发送。调用前后再次核对活动账号，但公开接口**不能锁定调用期间账号**。用量计入独立 Codex Token 统计，失败若仍报告用量也计入；不由 Token 推测额度或重置时间。
- **限制：** 仅确认尚未进入模型调用时允许安全重试，最多 3 次、间隔 5 秒；模型调用开始后的异常或超时结果不明则停止并提示，不重复发送。连续安全尝试失败也停止本次任务并提示；现有订阅插件的 WebSocket / middleware 等底层传输仍可能重试或回退。短提示不保证固定 Token 消耗；Codex 不执行这里可用的 `maxTokens` 上限。约 60 秒发出取消信号，认证或清理阶段可能等待更久；未结束时不会并发启动下一次。测试只用模拟服务，不会自动发起真实付费调用。

例如本机 `09:30` 请求，**只有在服务器确实从该请求开启新 5h 窗口时**，才可能在 `14:30` 重置；已有窗口不会因此重新锚定。成功、跳过、失败、上次尝试和下一每日时间在设置中显示；服务器额度报告始终是依据。第一次升级需完整重启 DSH 加载新版后端；之后更改设置不需重启。

### 数字怎么读

- **DeepSeek 余额：** 启动时查询已登录的账号钱包，不必等待模型调用；随后按实际使用路由切换到 API Key 余额或账号钱包。调用结束后估算更新，约每 60 秒校准。未知模型只显示 Token，不猜人民币。未登录或余额服务不可用时显示未连接／不可用。
- **Token 飘字：** 一轮调用报告的缓存命中输入、未命中输入或输出 Token，不只是刚输入的几个字。历史对话与工具内容可能使短问题也显示数千输入 Token；不同颜色是不同类别，不是重复扣费。
- **今日总量：** 按本机日期统计实际收到的模型事件，DeepSeek 与 Codex 分开。周／月图按天，年图按月。安装前的历史不保证补全；DeepSeek 升级时可尽力补录已保存的最近事件。

### 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 更新后仍是旧版／提示「请重启 DSH 更新桌宠」 | 先更新实际安装副本，再完整退出并重启 DSH 后台；只刷新网页或重开桌宠不够。 |
| 「等待 DSH 数据」或「等待 DSH 加载统计」 | 确认 DSH 与桌宠插件运行；升级后完整重启 DSH。 |
| 「未发现支持的订阅接口」 | 确认宿主提供公共连接适配器，订阅插件已安装并启用；仅接入 OAuth 模型不足以提供额度。 |
| 「请在订阅插件登录」 | 在对应订阅插件登录／选择账号，不需把 Codex 凭据交给桌宠。 |
| 「上次额度 · 待更新」／「默认账号 · 可能缓存」 | 数据过期、查询失败或上游缺少刷新时间；等待刷新，不将旧数值视为实时额度。 |
| 今日总量为 0 | 确认所选模式对应支持的路由，新插件加载后至少完成一次模型调用；历史调用可能不在统计内。 |
| DeepSeek 余额无法查询 | 检查 DSH 的 API Key／账号登录及对应余额服务。 |
| 看不到悬浮窗 | 完整重启 DSH，确认插件启用；检查是否已有桌宠进程，必要时在安装目录手动运行脚本查看报错。 |

### 数据、版权和开发检查

本机数据位于 `%LOCALAPPDATA%\DshSimpleDesktopPet\`：`state-desktop.json` 保存余额、额度与最近事件，`stats-desktop.json` 保存 DeepSeek 用量，`stats-codex-desktop.json` 单独保存 Codex Token，`settings.json` 保存偏好与位置，`warmup.json` 保存自动预热的尝试键、时间及错过的每日时刻，防止重启后重复；已有日志损坏或无法读取时停止发送，不静默重建。旧目录与数据保留；状态不保存 API Key、Codex 令牌或对话正文。额度查询走订阅插件公共只读接口；启用预热才通过宿主模型接口发送固定极短提示，账号标识仅保存短哈希；完整说明见 [隐私说明](PRIVACY.md)。

价格表按 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 于 2026-09-29 核对，官方改价后需更新代码。源码与文档为 MIT 许可；十二张角色图集及四张生成源图另见 [美术授权](ARTWORK-LICENSE.md)。保留 AI 来源信息，人工视觉检查不等于绝无相似或法律保证。本项目交互受 [dsh-damage-pulse](https://github.com/wssfk12138/dsh-damage-pulse) 启发，但未打包其源码或素材，与 DeepSeek 及上游无隶属关系。

运行 `npm test` 检查计费、路由、额度、统计和 UI；受限沙箱可用 `node --test --test-isolation=none`。v0.5.2 的源码与解包安装包回归均包括 79 项测试及 1283 项原生断言（设置 796、真实素材 454、额度展示 33）。Codex 接口与切号行为使用公开 DTO 的模拟回归；这些测试不读取真实账号数据，也不等于所有宿主／账号已完成实时额度验收。

`powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\pet.ps1 -Preview` 可查看独立模拟动效；加 `-PreviewSleep` 看睡眠、`-PreviewSettings` 看模拟统计，不修改真实余额。

## English guide

### What's new in v0.5.2

- Fix the pet disappearing after restart on Windows PowerShell 5.1: use a true null backup path for `File.Replace`, preserving atomic saves and existing preferences.
- Exercise the production save function against isolated real files: creation, replacement, repeated saves, Unicode/types, and failure preservation/cleanup. Source and extracted package pass 79 tests / 1283 native assertions. Two full WPF startups with existing isolated settings are verified.
- Keep the configurable five-second quota default and opt-in warm-up safeguards. No preference reset or automatic enabling; Codex tests use mocks and send no live model requests.

### Retained v0.5.1 features

- **Configurable quota checks:** force-refresh every 5 seconds by default; Settings accepts integer intervals of 1–3600 seconds and rearms immediately without enabling warm-up. Busy queries do not overlap and upstream limits still apply.
- **Startup readiness:** wait for a usable active-account quota report rather than consuming the startup check while the addon is loading or reports are stale.
- **Early full windows and idle deadlines:** the reset switch detects fresh full windows before an old deadline. Expired idle deadlines can start a window, followed by a real quota refresh and durable deduplication; sustained 100% never resends on every check.
- Keep three independent default-off warm-up switches, one-shot deadline scheduling, account/weekly-quota checks and saved preferences. Only proven-unsent failures retry, up to three attempts five seconds apart; ambiguous post-invocation failures stop and warn.
- Sends only a fixed short prompt through existing Codex authentication, with no conversation history or tools and no global model/account changes. Real requests consume quota; server reports determine reset times.
- **Existing two display modes remain:** DeepSeek balance, CNY/Token feedback, peak/off-peak poses and statistics; Codex remaining 5-hour/week quotas, reset times and a separate Token ledger.
- Switch under right-click **Settings → Billing mode**. This only changes the pet, not DSH's model, provider or account. Codex shows no CNY or peak/off-peak pricing.
- Six local, keyboard-accessible skin cards, three sizes, draggable settings/statistics, direct right-click entry, and saved preferences remain available. DeepSeek previews both poses; Codex shows a single preview.
- Cached-input damage, uncached-input reactions and reply jumps use the selected mode's events. Sleep follows that mode's activity, after 1–240 minutes (10 by default). WPF animates between state polls.

### Install or upgrade

1. Use Windows and DSH. Configure official DeepSeek credentials in DSH, or install/enable and sign in to a supported Codex subscription addon. Never give the pet Codex credentials.
2. Download the source ZIP from [v0.5.2](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/releases/tag/v0.5.2), or clone the tagged version to a permanent directory. Install the **whole directory**:

   ```powershell
   dsh plugin --profile desktop add "file:C:/path/to/dsh-plugin-simple-pet"
   ```

3. Disable/remove old `@local/dsh-simpledesktoppet` or `@local/dsh-deepseek-pet` copies. To upgrade, update the installed copy via the market or reinstall the updated folder.
4. **Save running work, fully quit DSH including its background/tray process, and relaunch it.** Refreshing the browser or reopening the pet does not update the loaded Node backend.
5. Enable `dsh-plugin-simple-pet`. DSH owns the pet window lifecycle. Right-click for settings; drag the title bar to move settings/statistics. × closes settings; Exit Pet closes the pet. Keep the installed directory in place.

The market submission uses the [latest stable release tarball](https://github.com/YangShen-SWE/dsh-plugin-simple-pet/releases/latest/download/dsh-plugin-simple-pet.tgz); [PR #6267](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6267) is subject to maintainer review. The pet is single-instance. Manual startup is only a troubleshooting fallback.

### Codex quota and account limits

The host must expose the public in-process connection adapter and a supported addon must be enabled. `dsh-codex-subscription` follows its active account, checked before and after the query. `dsh-plugin-subscriptions` exposes a default account, not necessarily the pool's selected account; its report is labeled potentially cached and never generates percent animations without an original refresh timestamp.

Unknown quota is `—`, not 0% or 100%. Reset times use your local time zone. Queries start when the backend loads and repeat every 5 seconds by default. Settings → Codex quota checks accepts an integer interval of 1–3600 seconds; saving rearms the timer without restarting or enabling warm-up. Busy queries do not overlap, and upstream refresh limits still apply. Percent feedback measures decreases between fresh reports for the same account/window; it is **not a Token conversion or guaranteed per-turn attribution**. Resets and account changes are not spending. Missing reliable reports fall back to Token feedback.

“请重启 DSH 更新桌宠” means an old backend snapshot lacks Codex fields: update the installed copy and fully restart DSH, not the subscription login. “等待 DSH 数据” means no initial snapshot yet. Other statuses distinguish signed-out, unsupported, switching and stale data. Codex Token charts count DSH-reported usage only; account quota may also reflect other clients.

### Automatic Codex warm-up (v0.5.1)

Startup-readiness waiting, periodic full-quota detection, expired-idle-deadline support and the configurable five-second polling default ship in v0.5.1. Update the installed copy and fully restart DSH; updating source alone does not update a running installed backend.

Settings has independent, default-off **daily local HH:mm**, **observed 5-hour reset**, and **startup at 100% quota** switches, with no manual request button. The startup switch and revised scheduling ship in v0.5.0; existing switches keep their saved preferences, and the new startup switch defaults off. Startup waits until the active-account quota is usable, then requires fresh 100% five-hour quota, usable weekly quota and a known deadline. An expired idle deadline is permitted: a post-call refresh records the actual new window, with conservative same-account suppression if it remains unknown. Durable account/window claims prevent repeated requests on restart. The reset switch also force-refreshes and checks for full new windows at the configured interval (5 seconds by default), including early restoration or a changed deadline while quota remains 100%; daily alone does not opt into this behavior. Sustained 100% never causes a request on every quota check. If both percentage and the already-claimed window identifier stay unchanged, the API cannot prove a new provider-wide reset, so deduplication is not bypassed. Only the Windows desktop profile executes the shared local schedule; other profiles do not opt in. Settings-file changes wake the scheduler, which uses one-shot deadline timers plus the configurable quota refresh. A target already missed at startup/wake is suppressed, including subsequent ticks and restarts; the computer is never woken. Closing the pet or changing display mode does not disable the backend schedule; turn off the switches or disable the plugin to stop it.

A fresh, forced active-account quota check and durable attempt claim precede a direct `openai-codex` stream. It uses an available Codex model (current Codex default if available, otherwise the first catalog entry) and the lowest advertised supported reasoning effort. Only `Reply only OK.` is sent: no session, history, system prompt or tools. Model/account/addon preferences are not changed. A daily date or observed reset deadline is attempted at most once; simultaneous triggers coalesce. Unknown/stale/exhausted quotas or account changes skip dispatch. Reported usage, including failed-call usage, enters the separate Codex ledger.

The public API cannot pin an account during dispatch, impose an enforceable Codex token cap, or forbid every existing transport retry. The pet retries only proven-unsent failures, at most three attempts five seconds apart. Once model invocation begins, an uncertain failure or timeout stops the occurrence and shows a warning instead of resending. Existing addon WebSocket/middleware behavior may still retry internally. A 60-second cancellation signal does not guarantee an authentication/cleanup deadline. Reset reports, not success or token counts, determine window timing: 09:30 does not guarantee a 14:30 reset. Tests use mocks only; no live billable verification was performed. Warm-up remains opt-in in v0.5.1; existing preferences are preserved and no switch is enabled by the upgrade. Fully restart DSH once after updating the installed backend.

### DeepSeek numbers, privacy and verification

The DeepSeek card queries the signed-in account wallet at startup and switches wallets according to actual official `deepseek-account` / `deepseek-official` calls. It estimates deductions between official balance checks; unknown prices stay unpriced. Token amounts include reported context/cache, not only your last prompt. Today's totals use local dates; old history may be incomplete.

Data and preferences stay under `%LOCALAPPDATA%\DshSimpleDesktopPet\`, with separate DeepSeek/Codex ledgers. No prompt/response bodies or credentials are stored. Codex quota uses public read-only addon RPC and hashes account identifiers; opt-in warm-up sends only a fixed short prompt through the host LLM service and stores attempt timestamps/keys, not response bodies. See [PRIVACY.md](PRIVACY.md), [artwork terms](ARTWORK-LICENSE.md), and [CHANGELOG.md](CHANGELOG.md). There is no telemetry or cloud sync.

Run `npm test` (or `node --test --test-isolation=none` in restricted sandboxes). Both the v0.5.2 source and extracted installation package pass 79 tests and 1283 native assertions (796 settings, 454 actual-asset and 33 quota-presentation assertions). Codex/account-switch tests use synthetic public DTOs, not live credentials; passing them is not a claim of live quota verification on every host/account. Isolated preview mode uses synthetic events and does not change live balance data.
