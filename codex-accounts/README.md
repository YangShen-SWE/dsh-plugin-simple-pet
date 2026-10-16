# Codex Accounts for DeepSeek Harness

独立账号服务插件 **dsh-plugin-codex-accounts 0.1.0**。非 OpenAI 官方产品；复用 DSH 官方 `PiAiAdapter` 与 pi-ai 的 **ChatGPT Codex OAuth**，不是 OpenAI Platform API Key 计费接口，也不依赖第三方订阅插件。

## 安装与使用

从本仓库 Release 下载 `dsh-plugin-codex-accounts.tgz`，在 DSH 插件管理安装并启用；需要公共官方组件 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`、`@earendil-works/pi-ai@0.87.1`，包中明确声明依赖，不访问宿主私有安装路径。SDK 不兼容时拒绝操作，不猜测内部实现。

搭配桌宠 **0.7.3+**：DSH → 设置 → 桌宠 → 账号管理，选择「官方组件独立账号服务」并保存，再显式添加 ChatGPT 订阅账号、读取登录进度和额度。登录页面只能是官方授权域名；可选择浏览器回调或设备码。不要在插件中输入密码、API Key、access/refresh token。取消/卸载会取消本次登录，迟到结果不能重新绑定账号。

本包自己提供账号服务、鉴权 API 和 `codex-accounts` 模型路由；管理界面由桌宠提供，并不是安装后自动接管宿主原来的 `openai-codex` 账号。

## 已实现

- 最多八个有效绑定；账号目录只保存本地键、用户自选昵称、身份哈希、epoch、撤销标记与默认引用。昵称是用户填写的信息，不假装是官方返回的邮箱。撤销后同一订阅重新绑定使用相同公开预算键，不能重置桌宠同日次数。
- 每次登录独立私有凭据 scope。OAuth grant 存于宿主公开 credentials 服务；宿主存储方式决定访问保护，**不承诺加密**。默认 `llm-pi-ai/openai-codex`、环境 API Key、`~/.codex` 均不读取或兜底。
- 刷新网络往返包含在宿主 `modifyRecord` 锁内；已绑定目录身份、grant.accountId 与 access JWT 账号声明必须一致。缺失、撤销、epoch 改变或身份漂移立即拒绝，不切到别的账号。
- 默认只决定本服务后续新请求；已准备的 A 请求继续固定 A。显式账号模型为 `<不透明账号键>:<模型哈希>`，默认新请求模型为 `default:<官方模型ID>`。不会修改第三方插件或官方全局激活账号。
- 额度通过 Codex 客户端使用的只读兼容 GET 查询，`redirect:error`、账号头与绑定一致；不调用模型、不购买/消费 reset credits。查询失败保留旧采样时间并标 stale，追加 limit bucket 不冒充账号。
- 最小预热为无工具、最低受支持 reasoning、`Reply only OK.` 的一次逻辑请求。固定 **SSE** 与 `maxRetries:0`，避免 auto-WebSocket 断连后 SSE 隐式重发；按真实公共 StreamChunk 记 usage，工具/失败/取消/未知终态不算成功，不自动重试或更换账号。

## 额度与自动化边界

`clientObservedAt` 不是服务器采样证明；`serverSampledAt:null`、`fullTriggerEligible:false`。仅严格的 18000 秒窗口归类 5h；不把分钟舍入、0% used 或新 resetAt 当作精确满额/必然起窗证据。**开机满额、5h 恢复满额自动预热仍不开放**。

桌宠的多账号每日定时需要单独逐账号授权，默认关闭，持久认领先于请求；同一天跨后端保护和 unknown/崩溃隔离仍生效。官方后端不自动继续原第三方单账号计划，也不把旧账号授权迁移到新账号。

额度兼容端点不是稳定承诺的 OpenAI Platform 公共 API，可能因账号资格、策略、地区、上游格式变化而不可用。一次逻辑请求不等于物理 HTTP exactly-once，也不是 Token/费用硬上限；此版本没有真实账号或付费请求验收。公开库的 OAuth 流程与上游政策仍以用户当前环境为准。

## 管理 API

鉴权复用 DSH 同源 `connection.requestRejection`，响应 `no-store`：`GET/HEAD /api/dsh-plugin-codex-accounts` 读取目录/登录进度；POST 的独立动作是 `login.start`、`login.respond`、`login.cancel`、`account.select`、`account.remove`、`quota.read`、`bindings`、`warmup.run`。只读不会发送模型请求。桌宠的管理代理不允许 `warmup.run`，预热由独立授权调度器调用。API 不返回 OAuth grant 或模型回答文本。

## 验证与故障恢复

本包定向测试：`node --test --test-isolation=none service.test.js`；仓库还包含完整合成账号/双插件生产接线回归。未执行真实 OAuth 登录、真实额度/模型调用、第三方安装或宿主重启。

目录写入是原子替换并跨进程排他；崩溃留下无法证明无主的 metadata `.lock` 会 fail closed，不自动删锁。请先确认无写入进程再人工核验，不能删除预热 journal 来重新执行未知请求。撤销本地绑定不是远端 OAuth 授权撤销；如需远端撤销，请使用官方账号安全设置。
