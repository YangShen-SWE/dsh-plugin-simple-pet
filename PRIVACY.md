# Privacy / 隐私说明

## 中文

- 插件只处理 DSH 中 `deepseek-official` 与 `deepseek-account` 两条官方路由的模型用量事件。事件包含模型名、时间、Token 类别和数量；插件不读取或保存提问、回复正文。
- API Key 路由查询余额时，插件通过 DSH 的 credentials 机制取得 API Key，并且仅向 `https://api.deepseek.com/user/balance` 发送；账号登录路由通过 DSH 的 `deepseekAccount.getBalance` 服务查询钱包，插件不接触账号令牌。两种凭据都不写入本插件的状态、统计或设置文件。
- 余额、最近事件、每日 Token 与估算人民币消耗、桌宠偏好只保存在本机 `%LOCALAPPDATA%\DshSimpleDesktopPet\`。该目录沿用早期版本名称，以保留升级前的数据。
- 插件没有遥测、广告、第三方分析或云端同步。受 DSH 本地连接校验保护的状态和素材接口仅供 DSH 使用。
- 形象图库只从安装目录读取峰时／谷时图片，预览不访问网络；切换只保存本机形象 ID，不上传图片、余额或使用记录。
- 四款新皮肤由开发阶段的 AI 图片生成服务制作；生成使用角色美术描述，不包含用户余额、对话、API Key 或本机状态。发布的源图保留 AI 生成来源声明，运行图集注明来源与哈希。可读 PNG 元数据检查未发现用户路径、用户邮箱或常见密钥格式；这不代表对所有二进制数据的完整隐私保证。安装后不会调用图片生成服务。
- 发布仓库不包含本机状态、会话日志、API Key 或 `work/` 中的开发检查文件。卸载插件不会自动删除本机数据；如需清除，请先退出 DSH 和桌宠，再自行删除上述目录。

## English

- The plugin processes usage events only from DSH's official `deepseek-official` and `deepseek-account` routes. It uses model names, timestamps, and token categories/counts, and does not read or store prompt or response text.
- For the API-key route, it obtains the key through DSH credentials solely to request the official balance at `https://api.deepseek.com/user/balance`. For the sign-in route, it asks DSH's `deepseekAccount.getBalance` service for the wallet and never accesses the account token. Neither credential is written to its state, statistics, or settings files.
- Balance, recent events, daily token/CNY estimates, and preferences stay under `%LOCALAPPDATA%\DshSimpleDesktopPet\`. The directory keeps its earlier name so upgrades retain local data.
- There is no telemetry, advertising, third-party analytics, or cloud sync. State and asset endpoints are guarded by DSH's local connection check.
- The gallery reads peak/off-peak images from the installed directory without network requests. Selection saves only a local skin ID and does not upload images, balances, or usage.
- The four new skins were created during development using an AI image service and art descriptions, not user balances, conversations, API keys, or local state. Published sources retain AI provenance; runtime derivatives identify their source and hash. Readable PNG metadata checks found no user paths, user email addresses, or common credential patterns; this is not an exhaustive guarantee for all binary content. Installing the plugin does not call the image-generation service.
- The public repository excludes local state, session logs, API keys, and development files in `work/`. Uninstalling the plugin does not delete local data. To erase it, exit DSH and the pet, then remove that directory yourself.
