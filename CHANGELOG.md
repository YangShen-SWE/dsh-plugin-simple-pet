# 更新记录 / Changelog

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
