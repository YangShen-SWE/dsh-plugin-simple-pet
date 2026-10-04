# 更新记录 / Changelog

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
