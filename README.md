# dsh-plugin-simple-pet

**最新版本：v0.2.4。** 启动后即查询已登录 DeepSeek 账号的钱包，不必等待第一次模型调用；之后若使用 API Key 路由则切换显示对应余额。详见 [更新记录](CHANGELOG.md)。

Windows 桌面上的 Q 版 DeepSeek API 桌宠：看余额、用量和峰谷价格，用角色动作反馈每次调用。A small native Windows pet for DeepSeek API balance and usage in DeepSeek Harness (DSH).

> **兼容 / Compatibility:** 面向 DSH `0.2.0-rc.1`、`0.2.0-rc.2`；已在 Windows + `0.2.0-rc.2` 实机验证，`rc.1` 尚待实机回归。支持 DSH 的 `deepseek-official`（API Key）与 `deepseek-account`（账号登录）两条官方路由。This is an unofficial community project, not a DeepSeek product.

## 中文使用说明

### 功能与特色

- **轻量悬浮窗：** 透明、可拖动、始终置顶；角色位于余额卡边缘，文字保持可读。右键可选小／中／大尺寸及两套可替换形象：默认海蓝鲸鱼娘、夜航科技娘。
- **峰谷形象：** 根据北京时间工作日 09:00–12:00、14:00–18:00 区分峰价与谷价，卡片显示相应图标；两套形象都有不同的峰谷姿态。
- **按调用反馈：** 缓存命中轻微受伤，未命中暴击，模型返回时开心弹跳，余额充值恢复时吃白米饭；连续消费与余额耗尽也有独立反馈。扣费数字按事件顺序上飘，无气泡。
- **打瞌睡待机：** 连续一段时间没有官方 DeepSeek 调用时进入睡眠动作；峰价站姿与谷价趴姿各有待机动作。默认 10 分钟，可在设置中调整为 1–240 分钟。
- **余额与统计：** 卡片显示最近使用的 DeepSeek 路由对应的余额及最近一次调用的缓存命中率；API Key 与账号钱包不会混扣。右键「设置与统计…」可看今日 Token、今日整体缓存命中率、今日估算人民币消耗，并切换本周／本月／本年折线图及 Token／人民币单位。
- **简化范围：** 只处理 DSH 的两条官方 DeepSeek 模型路由；没有通知、其他模型计价或自定义价格规则。扣费飘字可选 Token 或人民币；今日总量集中在设置窗口。动作由 WPF 原生动画播放，状态轮询不限制动作帧率。

### 安装（推荐：保留本地源码目录）

1. 在 Windows 上安装 DSH `0.2.0-rc.1` 或 `0.2.0-rc.2`，在 DSH 中配置官方 DeepSeek API Key，或登录 DeepSeek 账号。凭据由 DSH 管理，无需填入本插件。
2. 从本仓库下载 ZIP 并解压到**长期保留的目录**，或运行 `git clone https://github.com/YangShen-SWE/dsh-plugin-simple-pet.git`。不要只复制 `pet.ps1`；`assets/`、`index.js`、`stats.js`、`settings-window.ps1` 和清单文件都需要保留。
3. 在 PowerShell 中安装本地目录，将示例路径换成你的实际解压路径：

   ```powershell
   dsh plugin --profile desktop add "file:C:/path/to/dsh-plugin-simple-pet"
   ```

4. 如果以前安装过 `@local/dsh-simpledesktoppet` 或 `@local/dsh-deepseek-pet`，先在 DSH 的插件管理界面禁用／移除旧插件，避免重复处理同一事件。**完全退出并重新打开 DSH**，让新插件加载。
5. 启动 DSH 并在插件管理中启用 `dsh-plugin-simple-pet`。插件启动时会自动打开 Windows 桌宠悬浮窗；停用插件时会关闭由插件启动的窗口。右键悬浮窗可进入设置。如果首次启用后没有出现，完全退出并重新打开 DSH。

如需单独排查窗口，也可以在解压目录运行：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\pet.ps1 -DshProfile desktop
   ```

6. 拖动角色或卡片调整位置；右键打开「设置与统计…」、切换形象／尺寸／飘字单位，或选择「退出桌宠」。运行期间不要移动或删除已安装的源码目录。

通过市场／GitHub 安装到 Windows 的 DSH desktop profile 后，桌宠会随插件启用自动启动。`start-pet.cmd` 仅供故障排查时手动启动；默认安装位置通常是 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-simple-pet\`。桌宠为单实例，重复启用不会打开多个窗口。

### 数字怎么读

- **余额**启动时立即查询已登录的 DeepSeek 账号钱包，不用等待模型调用；如果后续使用 API Key 路由，则改查官方 API 余额，切回账号路由时再改查账号钱包。调用结束后先按用量估算更新，并约每 60 秒校准。人民币扣费属于估算；未知模型只显示 Token，不猜测金额。今日统计汇总两条路由，悬浮卡显示当前路由对应的钱包。若未登录账号或账号余额服务暂不可用，启动时仍会显示「未连接」，直至服务可用或切换到已配置的 API Key 路由。
- **Token 飘字**是一轮 API 调用报告的缓存命中输入、未命中输入或输出 Token，不只是刚输入的几个字。DSH 可能把历史对话与工具内容一起发送，因此短问题也可能显示数千输入 Token。不同颜色代表同一轮请求的不同计费类别，不是重复扣费。
- **今日总量**在右键设置里，按本机日期统计实际收到的模型用量事件。图表的「周」按天、「月」按天、「年」按月显示。安装前的旧调用不保证补全；若升级时仍保留最近事件，插件会尽力补录。

### 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 设置页显示「等待 DSH 加载统计」 | 完全退出并重启 DSH。只重启桌宠窗口不会重新加载 DSH 插件。 |
| 今日总量为 0 | 确认当前调用使用 `deepseek-official` 或 `deepseek-account`，且新插件加载后至少完成一次模型调用。历史调用可能不在统计内。 |
| 余额显示「等待 DSH…」或无法查询 | 检查 DSH 是否运行；API Key 路由检查 DSH 中的 Key 和官方余额接口，账号路由检查 DSH 登录状态及账号余额服务。 |
| 看到约 −7000 Token | 这是该次请求报告的完整输入用量，可能包括上下文缓存。可查看命中率，并用新会话或压缩上下文减少输入。 |
| 看不到悬浮窗 | 完全退出并重新打开 DSH，确认插件已启用；检查 Windows 任务管理器中是否已有 `pet.ps1` 进程。仍无法启动时，在插件目录手动运行 `pet.ps1` 查看报错。 |

### 数据、版权和开发检查

本机数据保存在 `%LOCALAPPDATA%\DshSimpleDesktopPet\`：`state-desktop.json` 保存余额与最近事件，`stats-desktop.json` 保存每日用量，`settings.json` 保存外观与位置。目录沿用旧版名称，以保留升级数据。状态文件**不保存 API Key、提问或回复正文**。完整说明见 [PRIVACY.md](PRIVACY.md)。

`billing.js` 的价格表按 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 于 2026-09-29 核对；官方改价后需更新代码。源码与文档采用 MIT 许可，四张角色图集有单独的 [美术授权说明](ARTWORK-LICENSE.md)。桌宠交互受 [dsh-damage-pulse](https://github.com/wssfk12138/dsh-damage-pulse) 启发，但本仓库未打包上游源码或美术文件；本项目与 DeepSeek 及上游项目无隶属关系。

开发者可运行 `node --test` 检查计费、过滤与统计；运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\pet.ps1 -Preview` 看独立的模拟动效，不会修改真实余额。加入 `-PreviewSleep` 可看峰谷打瞌睡，加入 `-PreviewSettings` 可看使用模拟数据的设置窗口。

## English guide

### What it does

- A draggable, always-on-top Windows WPF pet with two skins, three sizes, and distinct peak/off-peak poses.
- Light damage for cached input, a critical reaction for uncached input, a happy jump when a model reply arrives, and white-rice eating when an official balance increase is detected. Amounts float upward in event order without bubbles.
- Separate dozing motions for peak and off-peak poses after 1–240 minutes of inactivity (10 minutes by default).
- Balance for the last used official DeepSeek route, latest-call cache hit rate, a peak/off-peak indicator, and a right-click settings window with today's tokens, aggregate cache hit rate, estimated CNY spend, and week/month/year line charts. Charts and floating amounts can use CNY or tokens.
- Only the official `deepseek-official` API-key and `deepseek-account` sign-in routes are counted. There are no alerts, third-party model prices, or custom billing rules. WPF handles animation between background state polls.

### Install and use

1. Use Windows with DSH `0.2.0-rc.1` or `0.2.0-rc.2`. Configure an official DeepSeek API key or sign in to a DeepSeek account **in DSH**.
2. Download and extract this repository to a permanent folder, or clone `https://github.com/YangShen-SWE/dsh-plugin-simple-pet.git`.
3. Install that folder into the desktop profile, replacing the example path:

   ```powershell
   dsh plugin --profile desktop add "file:C:/path/to/dsh-plugin-simple-pet"
   ```

4. Disable/remove older `@local/dsh-simpledesktoppet` or `@local/dsh-deepseek-pet` installations if present. Fully quit and relaunch DSH to load the new plugin.
5. Start DSH and enable `dsh-plugin-simple-pet`. The plugin opens the Windows pet window automatically and closes the window it started when disabled. Right-click the pet to open settings. If it does not appear after first enabling, fully quit and relaunch DSH. For troubleshooting, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\pet.ps1 -DshProfile desktop` in the installed folder. Drag the pet to move it; right-click to open settings or exit. Keep the installed folder in place while using the pet.

On Windows, the DSH desktop plugin starts the pet automatically when enabled. `start-pet.cmd` remains a manual troubleshooting fallback; with the default DSH home it is normally under `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-simple-pet\`. The pet allows only one instance.

### Numbers and troubleshooting

On startup the card queries the signed-in DeepSeek account wallet immediately, without waiting for model usage. It switches to the official API balance if an API-key call is made, and back to the account wallet after an account call. If no account is signed in or the account balance service is unavailable, the initial balance remains disconnected until that service recovers or an API-key route is used. The API-key route reads the official API balance; the sign-in route reads DSH's account balance service. The plugin never deducts account usage from the API-key wallet. It estimates deductions between balance checks (about every 60 seconds). Token amounts are the full usage reported for a completed call, which can include conversation history and cached context. Cache-hit and uncached-input amounts from the same call are separate billing categories. Today's totals combine both official routes, use the local date, and appear in right-click settings; pre-install calls may be incomplete.

If settings says “waiting for DSH to load statistics,” fully restart DSH. If today's total is zero, complete an official DeepSeek model call after the new plugin loads. If the balance is unavailable, check the API key or account sign-in for the selected route and the corresponding balance service. A few thousand input tokens for a short question can be normal when prior conversation context is included.

### Privacy, licensing, and development

The plugin writes balance/recent events, daily estimates, and preferences under `%LOCALAPPDATA%\DshSimpleDesktopPet\` for compatibility with earlier local versions. It does not store API keys or prompt/response text. See [PRIVACY.md](PRIVACY.md). Prices were checked against the [official DeepSeek pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) on 2026-09-29 and may change. Code and docs are MIT licensed; artwork has separate [terms](ARTWORK-LICENSE.md). This independent, unofficial project was inspired by [dsh-damage-pulse](https://github.com/wssfk12138/dsh-damage-pulse) and bundles none of its files.

Run `node --test` for billing/event/statistics checks. `pet.ps1 -Preview` opens an isolated demo with synthetic events; add `-PreviewSleep` for both dozing poses or `-PreviewSettings` for demo charts. Preview mode does not change live balance data.
