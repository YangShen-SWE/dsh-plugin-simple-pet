# Desktop Pet 内置分支

上游：WSL043/dsh-codex-subscription，公开发行版 2.6.8，MIT，Copyright (c) 2026 WSL043。

完整保留上游后端、前端、图像/草图/检索/订阅模型/额度与重置卡实现和发行资产；不把某个 alias 伪装成完整内置。原始发行文件的 SHA-256 清单见 UPSTREAM.json。LICENSE 与 THIRD_PARTY_NOTICES.md 原样保留。

本地修改：

- 后端 `apply(ctx, config, createEmbeddedSettings)` 接受桌宠提供的独立设置存储工厂。未提供时仍按上游 standalone 方式运行。该入口避免父 Loader entry 设置被订阅配置覆盖；不改变账户密钥命名空间。
- 构建时从前端原始 ModuleLoader 包装提取完整 factory，在桌宠唯一的 factory 内作为子插件显式激活，不再注册第二个全局 ModuleLoader id。前端所有贡献及清理保持完整，而非仅摘取设置组件。
- 不复制或迁移 OAuth、账号目录、会话历史或重置账本。桌宠现有固定账号 codex-accounts 路由仍独立保留。

- 授权到期本地修复引入根模块 `subscription-oauth.js`：读取期限只取存储值/JWT `exp` 的较早者，保留原始持久期限；OAuth 解析进入原有网络作用域并转发选项。PiAiAdapter 接收单次内存绑定句柄，而非提前冻结的 bearer。完整 provider 在上下文/代理准备后解析同一绑定的新鲜授权，再明确覆盖 SDK 显式 `apiKey` 选项（SDK 的请求选项优先于 auth 返回值，因此只更改 apiKey resolver 不足以修复）。身份/当前 bearer、取消及卸载均重新核对，不新增模型重试或跨账号回退。内部 review 原有尝试可重新核验同一绑定，但不能重新消费句柄为另一个请求。

完整内置已在本机安装并通过公开宿主 SDK 的合成测试；运行中实例是否已重新加载、真实账号刷新是否成功仍是独立边界。旧 openai-codex alias 方案已被完整内置方案取代，不应同时注册。
