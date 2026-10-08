# Privacy / 隐私说明

## 中文

- 插件处理 DSH 中 `deepseek-official`、`deepseek-account`、`openai-codex` 与 `codex` 路由的模型用量事件。事件包含模型名、时间、Token 类别和数量；插件不读取或保存用户提问、回复正文。启用自动预热时只发送固定短提示 `Reply only OK.`，瞬时检查该请求的非空回复，不保存回复文本，也不读取用户会话历史。
- API Key 路由查询余额时，插件通过 DSH 的 credentials 机制取得 API Key，并且仅向 `https://api.deepseek.com/user/balance` 发送；账号登录路由通过 DSH 的 `deepseekAccount.getBalance` 服务查询钱包，插件不接触账号令牌。两种凭据都不写入本插件的状态、统计或设置文件。
- Codex 额度仅通过 DSH 公共的进程内连接适配器调用订阅插件的状态 / 用量接口；不读取 Codex 凭据文件、不取得 access / refresh token、不登录或切换账号。账号邮箱与标签不转存；仅保存账号 ID 的短哈希以隔离不同账号的额度变化。订阅插件可能自行请求其官方用量接口，桌宠不会自行携带 Codex 凭据联网。
- 自动预热三个开关默认关闭；启用后通过 DSH 公共模型服务使用现有 Codex 认证，调用前后核对活动账号，不直接取得令牌或改变账号 / 模型设置。API 无法锁定调用期间账号；认证刷新及底层传输 / 日志仍由宿主和订阅插件管理，不保证这些组件不写凭据或记录。去重日志只保存本地日期 / 短哈希与截止时间组成的键，以及尝试 / 成功时间、错过的本地每日日期和时刻；不保存原始账号、邮箱、令牌或回复。
- 余额、订阅额度与重置时间、最近事件、分别保存的 DeepSeek / Codex 每日 Token 与估算人民币消耗、桌宠偏好只保存在本机 `%LOCALAPPDATA%\DshSimpleDesktopPet\`。该目录沿用早期版本名称，以保留升级前的数据。
- 插件没有遥测、广告、第三方分析或云端同步。受 DSH 本地连接校验保护的状态和素材接口仅供 DSH 使用。
- 原生 DSH 设置页面通过同源、宿主鉴权的接口读取／保存白名单偏好及本地统计，图片由本地安装目录的受保护接口提供；不连接外部图片服务。选项先成为草稿，显式保存才修改本机配置；拖动只写独立位置文件。打开页面不触发模型请求，不上传图片、余额或使用记录。
- 四款新皮肤由开发阶段的 AI 图片生成服务制作；生成使用角色美术描述，不包含用户余额、对话、API Key 或本机状态。发布的源图保留 AI 生成来源声明，运行图集注明来源与哈希。可读 PNG 元数据检查未发现用户路径、用户邮箱或常见密钥格式；这不代表对所有二进制数据的完整隐私保证。安装后不会调用图片生成服务。
- 发布仓库不包含本机状态、会话日志、API Key 或 `work/` 中的开发检查文件。卸载插件不会自动删除本机数据；如需清除，请先退出 DSH 和桌宠，再自行删除上述目录。

## English

- The plugin processes usage events from DSH's `deepseek-official`, `deepseek-account`, `openai-codex`, and `codex` routes. It uses model names, timestamps, and token categories/counts, and does not read or store user prompt or response text. Opt-in automatic warm-up sends only the fixed prompt `Reply only OK.` and transiently checks its own nonblank response, without storing it or reading conversation history.
- For the API-key route, it obtains the key through DSH credentials solely to request the official balance at `https://api.deepseek.com/user/balance`. For the sign-in route, it asks DSH's `deepseekAccount.getBalance` service for the wallet and never accesses the account token. Neither credential is written to its state, statistics, or settings files.
- Codex quota is read through the subscription plugin's public status/usage RPC via DSH's in-process connection adapter. The pet never reads Codex credentials, obtains access/refresh tokens, or changes accounts. Emails and labels are not forwarded; only a short hash of the account identifier is stored to isolate quota changes. The subscription owner may make its own upstream quota request.
- All three warm-up switches default off. When enabled, it uses DSH's public LLM service and existing Codex authentication, checks the active account before/after dispatch and changes no account/model preferences. The API cannot pin an account during the call. Authentication refresh, transport and logging remain host/addon responsibilities; their credential writes or logging are not controlled by the pet. The local attempt journal stores date/account-hash/deadline keys, attempt/success timestamps, and missed local daily dates/times and unresolved-window deduplication timestamps only, not raw identities, emails, tokens or responses.
- Balances, subscription windows and reset times, recent events, separate DeepSeek/Codex token ledgers, daily CNY estimates, and preferences stay under `%LOCALAPPDATA%\DshSimpleDesktopPet\`. The directory keeps its earlier name so upgrades retain local data.
- There is no telemetry, advertising, third-party analytics, or cloud sync. State and asset endpoints are guarded by DSH's local connection check.
- Native DSH settings read/write whitelisted preferences and local statistics over same-origin, host-authenticated endpoints; bundled images are served locally, with no external image service. Edits are drafts until explicit save; dragging writes a separate position file. Opening settings makes no model call or upload of images, balances, or usage.
- The four new skins were created during development using an AI image service and art descriptions, not user balances, conversations, API keys, or local state. Published sources retain AI provenance; runtime derivatives identify their source and hash. Readable PNG metadata checks found no user paths, user email addresses, or common credential patterns; this is not an exhaustive guarantee for all binary content. Installing the plugin does not call the image-generation service.
- The public repository excludes local state, session logs, API keys, and development files in `work/`. Uninstalling the plugin does not delete local data. To erase it, exit DSH and the pet, then remove that directory yourself.
