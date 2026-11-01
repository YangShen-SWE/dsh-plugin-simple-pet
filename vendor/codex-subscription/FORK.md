# Desktop Pet 内置分支

上游：WSL043/dsh-codex-subscription，公开发行版 2.6.8，MIT，Copyright (c) 2026 WSL043。

完整保留上游后端、前端、图像/草图/检索/订阅模型/额度与重置卡实现和发行资产；不把某个 alias 伪装成完整内置。原始发行文件的 SHA-256 清单见 UPSTREAM.json。LICENSE 与 THIRD_PARTY_NOTICES.md 原样保留。

本地修改：

- v1.1.6 新增 `subscription-rotation.js` 与纯策略模块：同一完整适配器的请求绑定包装、明确额度拒绝与完整零输出证据、原步骤安全重试，以及同一 vault 的代次/选择序号 CAS；内置账号页提供独立授权和只读订阅/额度刷新。私有固定账号预热不走轮换，普通账号与凭据仍由原 owner 唯一持有。跨账号原生 replay 从请求副本移除，压缩检查点按冻结账号重新核验。依用户授权随 v1.1.6 发布，仅完成离线合成验证，未自动安装、启用或进行真实切换。使用与限制见根目录 ACCOUNT-ROTATION-USAGE.md。

- v1.1.4 在同一内置 owner 内增加固定账号预热服务及受审计 SDK 的专用 SSE 请求，不切换全局 active；逐账号目录、授权刷新和额度上下文隔离。调度、逐账号消费同意和持久预算由桌宠持有，浏览器不接收凭据。新增相同旧保护文件的持久重置兑换包装，卡片检查入口独立于额度摘要，未知 Credits 不当零。上游版本和原始发行哈希仍保持 2.6.8；完整用法和边界见根目录 UNIFIED-WARMUP-USAGE.md。

- 后端 `apply(ctx, config, createEmbeddedSettings)` 接受桌宠提供的独立设置存储工厂。未提供时仍按上游 standalone 方式运行。该入口避免父 Loader entry 设置被订阅配置覆盖；不改变账户密钥命名空间。
- 完整适配器初始化后在同一生命周期注册旧路由包装器 `subscription-legacy-route.js`。它不替代完整后端、不创建账号 store，也不触发历史发送；透传公开请求控制并降级账号原生 replay 元数据。注册前若发现其他旧 provider 所有者则明确失败，不静默维持双所有者。
- 构建时从前端原始 ModuleLoader 包装提取完整 factory，在桌宠唯一的 factory 内作为子插件显式激活，不再注册第二个全局 ModuleLoader id。前端所有贡献及清理保持完整，而非仅摘取设置组件。
- 不复制或迁移 OAuth、账号目录、会话历史或重置账本。原桌宠账号数据保留，但其独立引擎已退休；按用户明确授权，可解析的旧 codex-accounts 请求仅委托同一个完整内置订阅适配器，跟随当前选中账号。旧不可逆 hash 模型要求重选，不回查旧账号库。

- 授权到期本地修复引入根模块 `subscription-oauth.js`：读取期限只取存储值/JWT `exp` 的较早者，保留原始持久期限；OAuth 解析进入原有网络作用域并转发选项。PiAiAdapter 接收单次内存绑定句柄，而非提前冻结的 bearer。完整 provider 在上下文/代理准备后解析同一绑定的新鲜授权，再明确覆盖 SDK 显式 `apiKey` 选项（SDK 的请求选项优先于 auth 返回值，因此只更改 apiKey resolver 不足以修复）。身份/当前 bearer、取消及卸载均重新核对，不新增模型重试或跨账号回退。内部 review 原有尝试可重新核验同一绑定，但不能重新消费句柄为另一个请求。

- v1.1.3 的私有单当前账号预热使用同一 owner、凭据/取消/压缩链路及非速度 profile，另固定标准速度 provider；在 SDK 选项和最终 payload 中移除 `serviceTier` / `service_tier`，不写全局 `speedMode`。普通聊天与旧聊天兼容仍注册原完整适配器，保留其 Fast/ultrafast 设置；私有策略不通过浏览器 RPC 或通用请求标记开放。

v1.1.3 发行说明：上游元数据仍为 2.6.8，UPSTREAM.json 只记录原始发行资产，不随本地 fork 重写。根清单固定 `@earendil-works/pi-ai` 0.87.1、`@deepseek-ai/dsh-llm-pi-ai` 与 `@deepseek-ai/dsh-home-paths` 0.2.0-rc.2、`https-proxy-agent` 7.0.6、`ws` 8.21.3。原 THIRD_PARTY_NOTICES.md 中的 0.82.1 与 lockfile 描述为上游历史声明；本仓库未跟踪 lockfile，不保证传递依赖已锁定。

完整内置已在本机安装并通过公开宿主 SDK 的合成测试，用户于 2026-10-23 反馈本机验收完成。该反馈不代替任意其他账号/远端能力的验证。旧 openai-codex alias 方案已被完整内置方案取代，不应同时注册；发布不读取或上传本机授权与会话。
