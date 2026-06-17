# 业务架构说明

本文面向开发维护者，补充 README 未覆盖的架构、数据流、模块职责、鉴权与会话机制。配置项、API 入口、环境变量和部署步骤请直接看 [README.md](../README.md) 和 [本地安装部署.md](../本地安装部署.md)。

## 1. 总体架构

Claude API Proxy 是一个**统一 AI 服务控制台 + 协议代理**。它对外暴露四类客户端协议（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Responses WebSocket），对内对接三类上游服务（Relay 自定义上游、CodeBuddy、GitHub Copilot），并在服务端完成协议之间的交叉转换。

```
                 ┌─────────────────────────────────────────────┐
   客户端 ──HTTP/WS──▶  server.js  路由分发 + URL 归一化 + CORS  │
                 │                                             │
                 │   ┌── /relay     → relay.js (4 协议入口)     │
                 │   ├── /codebuddy → codebuddy.js              │
                 │   ├── /copilot   → copilot.js                │
                 │   ├── /dashboard → dashboard-frontend.js     │
                 │   ├── /login     → auth.js                   │
                 │   ├── /stats/api → stats.js                  │
                 │   └── /feedback  → feedback.js / admin       │
                 └─────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
     gateway 鉴权层           三类代理业务层              transformer 转换层
     (API Key / session /     (relay / codebuddy /        (shared-translator /
      租户管理)                 copilot)                   responses-translator)
                                    │
                                    ▼
                              shared 能力层
                     (responses-ws-* / local-auth / auth-mode)
                                    │
                                    ▼
                        上游 (Anthropic/OpenAI/Responses/WS/
                              CodeBuddy/Copilot) + MySQL
```

核心设计原则：

- **协议转换在路由层完成**。每个代理路由根据上游协议类型，选择直通或转换，尽量保持流式边收边转。
- **租户隔离是第一道横切**。所有 `/relay`、`/codebuddy`、`/copilot` 请求先经 `requireApiAuth` 校验 API Key 并注入 `req.tenantId`，WS 升级同理。
- **单实例部署**。Relay 的会话状态、CodeBuddy 的凭证亲和、Responses WS 连接池都在进程内存，重启丢失。这是有意的取舍，避免引入共享存储的复杂度。

## 2. 入口与路由分发

[src/index.js](../src/index.js) 是启动入口：加载 `load-env.js` → `unifiedTenantManager.initialize()` → `initAuthMode()`（探测 LDAP，失败回退 local）→ local 模式下 `ensureAdminFromEnv()` + `reloadRegistry()` → 监听 3080/0.0.0.0，注册 SIGTERM 优雅关闭。

[src/server.js](../src/server.js) 是 HTTP + WS 路由分发核心。关键点：

- **URL 归一化** `normalizeRequestUrl`：把 `/coding`、`/api/coding` 前缀剥掉，把 `/api/login`、`/api/dashboard`、`/api/usage`、`/api/stats` 等旧命名空间映射到当前路径。这是兼容旧客户端的关键。
- **CORS**：允许 `shifeng1993.com` 及其子域 + `DASHBOARD_CORS_ORIGINS` 配置的额外源。
- **HTTP 路由顺序**：登录 → 控制台 → 旧路径重定向 → Relay（鉴权）→ 反馈管理 → 统计 → Copilot（鉴权）→ CodeBuddy（鉴权）→ 文件上传 → 根路径跳转。鉴权在分发前完成，失败的请求不会进入业务路由。
- **WS 升级**：`/relay/v1/responses`、`/codebuddy/v1/responses`、`/copilot/v1/responses` 三个路径升级到对应 handler。升级前先 `authenticateApiKey` + 校验该服务的 `TenantServiceProfile.enabled`，失败直接写 HTTP 错误码关闭 socket。
- **守卫函数**：`requirePageSession`（控制台页面，校验 session）和 `requireApiAuth`（API 端点，校验 API Key + 服务开关）。

## 3. 鉴权与会话机制

### 3.1 API Key 校验

[src/services/gateway/gateway-auth.js](../src/services/gateway/gateway-auth.js) 的 `authenticateApiKey(headers, tenantManager)`：

1. `extractTenantApiKey` 从 Authorization Bearer 或 x-api-key 提取 key。
2. SHA256 哈希后在 `unifiedTenantManager.apiKeyHashMap` 内存 Map 中查 `hash → tenantId`。
3. 返回 `{tenantId}` | `{skipAuth}`（租户系统未启用）| `{error}`（401）。

租户隔离靠 **API Key 哈希映射 tenantId**，后续所有处理都带着这个 tenantId。明文 key 只在 DB 的 `api_key_plain` 字段存一份（控制台展示用），鉴权只用哈希。`resolveCredential` 按 `x-credential-id` 头 → activeIndex → 首个 enabled 选凭证。

### 3.2 控制台 session

[src/services/gateway/session.js](../src/services/gateway/session.js) 用 JWT cookie `cap_session`，HS256 + `JWT_SECRET`，有效期 `JWT_EXPIRES_IN`（默认 8h）。共享域 `.shifeng1993.com`，HttpOnly + SameSite=Strict，HTTPS 下加 Secure。`clearSessionCookie` 同时清 domain cookie 和 hostOnly cookie 防残留。`getSessionUser` 解析 cookie 返回 `{authenticated, username, role}`。

[src/services/gateway/dashboard-auth.js](../src/services/gateway/dashboard-auth.js) 是守卫中间件：`requireApiAuth`（relay/codebuddy/copilot）鉴权后注入 `req.tenantId` 并校验服务开关；`requireAdminAuth`（控制台）校验 session；`requireAdminRole` 检查 admin/superadmin。

### 3.3 登录模式切换

[src/services/shared/auth-mode.js](../src/services/shared/auth-mode.js) 在启动时一次性确定模式：LDAP 四个环境变量齐全 + `detectLdapReachable`（TCP 探测 389/636，超时 `LDAP_PROBE_TIMEOUT_MS` 默认 3000ms）→ `'ldap'`，否则 `'local'`。幂等，`getAuthMode` 未初始化抛错。

[src/routes/auth.js](../src/routes/auth.js) 的登录流程：按 `getAuthMode()` 调 `ldapAuthenticate` 或 `localAuthenticate`，成功后 `resolveLoginRole`（LDAP 模式调 `createTenantForUser` 为首登用户建租户），签发 session cookie。CodeBuddy 的 [ldap-auth.js](../src/services/codebuddy/ldap-auth.js) 是 ldapjs 两次绑定：服务账号 bind → 搜用户 DN → 用户 DN+密码二次 bind 验证。

### 3.4 本地账号

[src/services/shared/local-auth.js](../src/services/shared/local-auth.js) 用 scrypt（N:16384,r:8,p:1）+ timingSafeEqual 恒定时间比较。`localAuthenticate` 跨 service_type 查 `Tenant.password_hash`，用户不存在或无密码统一返回"用户名或密码错误"防枚举。`ensureAdminFromEnv` 启动时从 `LOCAL_ADMIN_USER/PASSWORD` 同步 superadmin。

[src/services/shared/local-user-manager.js](../src/services/shared/local-user-manager.js) 是账号 CRUD，角色 superadmin/admin/user。`canManageTarget`/`canViewTarget` 权限矩阵：superadmin 管所有人，admin 只能动 user，无人能动 superadmin。所有读写按 `authMode` 分流到 Local 或 LDAP 版本。env 配置的 superadmin 不允许在页面改密码。

## 4. 租户与统计模型

[src/services/gateway/tenant-manager.js](../src/services/gateway/tenant-manager.js) 的 `UnifiedTenantManager` 单例是核心。**不分 service_type，一租户一条 Tenant 记录**，各服务的开关和统计放在 `TenantServiceProfile` 表。

三张内存缓存：

- `tenantsCache`: tenantId → 完整租户数据
- `apiKeyHashMap`: api_key_hash → tenantId（鉴权用）
- `usernameMap`: username → tenantId（登录用）

加上 `upstreamManagerCache`（Relay 上游管理器）和 `codebuddyManagerCache`（CodeBuddy 凭证管理器）。

统计采用**增量刷盘**：`incrementApiCallCount` / `incrementTokenUsage` / `incrementCreditUsage` 先累加到内存 `_deltaTenants`（key 为 `tenantId:serviceType`，仅 relay/codebuddy/copilot），30s 周期用 `TenantServiceProfile.increment` 做 SQL `SET col = col + N` 批量写回，保证并发安全且减少 DB 压力。`recordDailyUsage` 直接写 `TenantDailyUsage` 表（按 tenant_id + service_type + date + model 唯一），写入时清理 3 个月前数据。

`createTenantForUser`：`LOCAL_ADMIN_USER` → superadmin，普通用户默认建 relay+codebuddy 启用、copilot 仅 superadmin 启用。租户的 CRUD、服务开关、API Key 重生成、统计同步/重置都在这里。

### 数据模型一览

| 模型 | 作用 |
|---|---|
| Tenant | 租户主表（api_key_hash/prefix/plain、username、role、password_hash/salt、各服务累计统计） |
| TenantServiceProfile | 每租户每服务的开关 + 累计统计（relay/codebuddy/copilot） |
| TenantCredential | CodeBuddy 凭证（bearer/refresh token、user_id、base_url、enterprise_id 等） |
| TenantCopilotCredential | Copilot 凭证（github_token、copilot_token、expires_at、proxy、account_type 等） |
| TenantUpstream | Relay 上游配置（protocol、ws_mode、base_url、api_key、proxy、model_map 等） |
| TenantState | CodeBuddy 凭证管理器状态（current_index、disabled_indexes） |
| TenantDailyUsage | 每日用量明细（tenant_id + service_type + date + model） |
| Feedback | 用户反馈记录 + 附件 |

## 5. Relay 代理

Relay 是最复杂的代理，支持四类客户端入口 × 四类上游协议的交叉转换。

### 5.1 上游协议分支

[src/routes/relay.js](../src/routes/relay.js) 的每个 handler（`handleOpenAIChatCompletions`、`handleAnthropicMessages`、`handleResponsesAPI`、`handleResponsesCompact`）都按上游协议分四个分支：

| 上游协议 | 判定函数 | 行为 |
|---|---|---|
| `anthropic` | `isAnthropicUpstream` | 转 Anthropic Messages 直通上游 |
| `responses` | `isResponsesUpstream` | 转 OpenAI Responses HTTP 直通 |
| `responses_ws` | `isResponsesWebSocketUpstream` | 转 Responses WebSocket |
| openai（默认） | — | Chat Completions 直通 |

交叉组合示例：Anthropic Messages 入口 + responses_ws 上游 → `anthropicToOpenAI` → `chatRequestToResponses` → WS → `responsesEventToChatChunks` → `chatChunkToAnthropicEvents`。流式转换链尽量边收边转，非流式请求会强制 `stream=true` 请求上游再聚合。

### 5.2 会话状态

[src/services/relay/conversation-state.js](../src/services/relay/conversation-state.js) 的 `RelayConversationStore` 在内存维护短期会话状态，按 `tenantId:conversationKey` 隔离。解决的核心问题：**Responses/WS 增量请求（只带 previous_response_id）转到 Chat 或 Anthropic 上游时，需要恢复完整上下文**。

- `extractConversationKey`：从 header（x-conversation-id 等）+ payload（conversation_id/session_id/thread_id）+ `buildConversationAnchorKey` 兜底提取会话 key。
- `saveChatRequest` / `recordChatResponse` / `recordResponsesResponse`：存每次请求和响应。
- `hydrateResponsesForFullHistory`：用 `previous_response_id` 找历史状态（找不到抛 `RelayStateMissingError`，code=state_missing），合并 base chatRequest + 可见 chat，`getDuplicatePrefixLength` 去重。
- `prepareResponsesPassthrough`：透传时优先用 previous_response_id，否则用 conversationKey。

TTL 默认 24h（`RELAY_CONVERSATION_STATE_TTL_MS`），定期清理。**单实例部署**，重启丢状态——这是 README 明确的取舍。

### 5.3 上下文压缩

[src/services/relay/context-compactor.js](../src/services/relay/context-compactor.js) 的 `invokeWithRelayContextCompaction` 实现两级压缩：

1. **主动压缩**：请求前 `compactChatRequestIfNeeded` 估算 token，超阈值时调上游生成摘要替换历史。
2. **被动重试**：上游返回 context-window-exceeded 错误时，`isContextWindowExceededError` 识别后强制压缩重试一次。

`prepareRelayOutboundChatRequest` 是出站前最后一道处理：`injectBehaviorRules`（按模型族注入行为规则）+ `stripDynamicReminders`（剥离 system-reminder 记账块，避免破坏缓存前缀）+ `mergeConsecutiveAssistantMessages`（合并连续 assistant 消息）。

### 5.4 上游管理

[src/services/relay/upstream-manager.js](../src/services/relay/upstream-manager.js) 的 `UpstreamManager` 按 tenantId 隔离，管理上游列表的 CRUD、活跃切换、模型映射（`resolveModel`）、reload。`getActiveUpstream` 返回当前活跃上游。

[src/services/relay/api.js](../src/services/relay/api.js) 是上游 HTTP/WS 客户端，带 per-upstream 代理 agent 缓存（HTTP/HTTPS/SOCKS5）和 `RelayUpstreamError`（保留上游状态码便于 429 透传）。

### 5.5 Responses WebSocket

Relay 复用 shared 层的 [responses-ws-server.js](../src/services/shared/responses-ws-server.js)（客户端↔本代理）和 [responses-ws-pool.js](../src/services/shared/responses-ws-pool.js)（本代理↔上游）。模式由 [responses-ws-mode.js](../src/services/shared/responses-ws-mode.js) 决定：OFF / CTX_POOL / PASSTHROUGH，legacy 的 shared/dedicated/passthrough 都归一为 ctx_pool。

## 6. CodeBuddy 代理

### 6.1 配置与上游

[src/services/codebuddy/config.js](../src/services/codebuddy/config.js)：`getCodebuddyBaseUrl` 按 env > 区域（intl→www.codebuddy.ai，cn→copilot.tencent.com）回退。`getModelsForHost` 优先用 `CODEBUDDY_MODEL_OVERRIDES`（按 host JSON 覆盖），否则按 `isPersonalHost` 返回 PERSONAL/ENTERPRISE 模型清单。`codebuddyHeaders` 区分个人版（基础头 + X-Product=SaaS + X-Session-ID=userId 做 KV Cache 路由）和企业版（额外 X-Enterprise-Id/X-Tenant-Id/X-Department-Info）。

### 6.2 上游调用

[src/services/codebuddy/api.js](../src/services/codebuddy/api.js) 的 `createChatCompletions`：强制 stream=true、设 `prompt_cache_key=conversationId`，enterprise_id 为空时从 JWT bearer token 的 `realm_access.roles` 里 `ent-member:` 前缀兜底提取。个人站请求经 `sanitizePayload` 替换竞品关键词（anthropic→tencent 等）避免服务端 content_filter。`aggregateStreamResponse` 解析 SSE 聚合 content/reasoningContent/toolCalls/usage 并修复不完整 JSON。

### 6.3 凭证管理

[src/services/codebuddy/tenant-token-manager.js](../src/services/codebuddy/tenant-token-manager.js)：管理单租户凭证。`sessionAffinity`（Map，30min TTL）让同一 conversationId 始终命中同一凭证，避免上游缓存 miss。`getNextCredential(conversationId)` 优先级：会话亲和 → 当前活跃 → 首个未禁用未过期。`isTokenExpired` 用 `created_at + expires_in - 300s` buffer。**凭证不自动刷新**——过期即跳过，靠控制台重新 OAuth 落新凭证。

[src/services/codebuddy/tenant-manager.js](../src/services/codebuddy/tenant-manager.js) 是旧的 per-service_type 租户管理器（sk-codebuddy- 前缀），DB 持久化 + 增量刷盘，`createTenantForUser` 用 `_createLocks` 防并发创建。现在与 gateway 的 UnifiedTenantManager 并存，凭证管理通过 `getCodebuddyCredentialManager` 桥接。

### 6.4 协议转换

[src/services/codebuddy/translator.js](../src/services/codebuddy/translator.js)：Anthropic↔OpenAI 双向转换。`resolveThinkingConfig` 按 output_config.effort > thinking 配置推断 > 默认 high 解析 reasoning_effort。ClaudeStreamState 状态机把 OpenAI SSE 还原成 Anthropic 事件，支持多段 thinking 和并行 tool_use，thinking 块转 reasoning_content 回传（DeepSeek/kimi 要求）。复用 transformer/shared-translator。

### 6.5 OAuth 授权

[src/routes/dashboard-codebuddy.js](../src/routes/dashboard-codebuddy.js) 实现 CodeBuddy OAuth 设备授权控制台后端：`startAuth` 调上游 `/v2/plugin/auth/state` 拿 authUrl，`pollAuth` 轮询 `/v2/plugin/auth/token`（code=11217 为 pending），成功后企业版额外取 account 信息、JWT 兜底 enterpriseId、落凭证。`authStates` Map（30min TTL）存 state→{tenantId,baseUrl}。

## 7. Copilot 代理

### 7.1 上下文隔离

[src/services/copilot/runtime.js](../src/services/copilot/runtime.js) 用 `AsyncLocalStorage` 把 `{tenantId, credential}` 注入异步调用链，`runCopilotTenantContext` 建立隔离边界。`copilotState` 和 `copilotStore` 是 Proxy，从 context 读 token 并把统计转发给 `unifiedTenantManager`（service_type='copilot'）。**租户隔离靠 AsyncLocalStorage，不是全局变量**，这是与 CodeBuddy/Relay 的关键区别。

### 7.2 GitHub 设备授权

[src/services/copilot/github-api.js](../src/services/copilot/github-api.js)：`startDeviceAuth` POST `/login/device/code` 拿 device_code/user_code；`pollDeviceAuth` POST `/login/oauth/access_token` 换 github_token，再 GET `/user` 拿用户信息、GET `/copilot_internal/v2/token` 换 copilot_token。抛错带 error.code（authorization_pending/slow_down/expired_token/access_denied）。GITHUB_CLIENT_ID 是 Copilot VSCode 扩展的公开 client_id。

### 7.3 凭证与 Token 刷新

[src/services/copilot/credential-manager.js](../src/services/copilot/credential-manager.js)：CRUD + token 刷新。`resolve`（按 credentialId 或活跃 is_active 凭证）、`ensureToken`（**copilot_token 过期或将在 5 分钟内过期时，用 github_token 重新 GET copilot_internal/v2/token 刷新，写回 DB**）。Copilot Token 按 `tenantId + credentialId` 刷新，持久化在 `TenantCopilotCredential` 表。这与 CodeBuddy 不同——Copilot 会自动刷新，CodeBuddy 不会。

### 7.4 上游调用与 WS 池

[src/services/copilot/copilot-api.js](../src/services/copilot/copilot-api.js)：`createChatCompletions` 自动检测 image_url 开 vision 头、检测 agent 调用设 X-Initiator。`createResponsesWS` 调 copilot-ws-pool 拿池化连接，`buildCopilotNetworkKey` 按 `tenantId:credentialId:proxy:tls` 生成网络隔离 key。

[src/services/copilot/copilot-ws-client.js](../src/services/copilot/copilot-ws-client.js) 和 [copilot-ws-pool.js](../src/services/copilot/copilot-ws-pool.js) 是 thin wrapper，全部委托给 shared/responses-ws-*，只是用 wsHeaders 和 getCopilotBaseUrl 拼出 `ws://api.githubcopilot.com/responses`。

### 7.5 协议转换

[src/services/copilot/anthropic-translator.js](../src/services/copilot/anthropic-translator.js)：Copilot 专用 Anthropic↔OpenAI 转换。`translateModelName` 把 claude-sonnet-4-x 归一化为 claude-sonnet-4。system 数组按 cache_control 重排（可缓存块在前，让上游缓存更长前缀）。`translateStreamChunk` 用 pendingThinkOpen 标志处理跨 chunk 的 `<think>...</think>` reasoning 提取。

## 8. 共享能力层

### 8.1 Responses WebSocket

| 文件 | 职责 |
|---|---|
| [responses-ws-server.js](../src/services/shared/responses-ws-server.js) | 客户端↔本代理的服务端桥。`handleWSConnection` 实现标准 Responses WS 协议：客户端发 response.create → handleRequest 拿事件流 → 逐个 WS 推送 → response.completed/error 结束。PING_INTERVAL=25s 防 Nginx/ALB 静默断连，response.cancel 用 AbortController。 |
| [responses-ws-client.js](../src/services/shared/responses-ws-client.js) | 本代理↔上游的客户端。`sendResponsesWebSocketRequest` async generator：auto-link previous_response_id、sanitizeResponsesInput、messageQueue+Promise 等待、response.completed 结束否则抛 stream_disconnected。 |
| [responses-ws-pool.js](../src/services/shared/responses-ws-pool.js) | ctx_pool 连接池。`acquire` 优先级：previous_response_id 匹配 > contextKey 匹配 > 无 context 空闲 > 任意空闲 > 新建。MAX_PER_KEY=5，IDLE_TIMEOUT=60s。`discardByPoolKey` 在上游切换后清旧连接。 |
| [responses-ws-mode.js](../src/services/shared/responses-ws-mode.js) | 模式枚举与解析。`resolveResponsesWebSocketMode` 优先级：upstream 配置 > query param > env。 |

### 8.2 本地账号与 LDAP

见第 3.3、3.4 节。

## 9. 控制台路由

| 路由文件 | 职责 |
|---|---|
| [auth.js](../src/routes/auth.js) | 登录/登出。GET /login 渲染页面，POST /login 按 authMode 鉴权 + 签发 session，POST /logout 清 cookie。 |
| [dashboard-frontend.js](../src/routes/dashboard-frontend.js) | 管理面板总路由。GET /dashboard 返回 admin.html，/dashboard/me 用户信息、/dashboard/me/password 改密码（LDAP 禁用）、/dashboard/stats/overview 聚合统计、/dashboard/tenants 列表与详情、服务开关、统计重置。委托 dashboard-users/codebuddy/copilot/relayOperation。 |
| [dashboard-users.js](../src/routes/dashboard-users.js) | 本地账号 CRUD（列表/创建/改密码/编辑/删除），LDAP 模式禁用创建和改密码。 |
| [dashboard-codebuddy.js](../src/routes/dashboard-codebuddy.js) | CodeBuddy 凭证增删改查 + OAuth 授权流程（start/poll/save）。 |
| [dashboard-copilot.js](../src/routes/dashboard-copilot.js) | Copilot 凭证 CRUD + 设备授权（start/poll/clear）+ token 刷新 + 活跃/启用/排序。 |
| [feedback.js](../src/routes/feedback.js) | 反馈提交，busboy 解析 multipart（附件限大小/数量），存库 + 异步发邮件，修复乱码文件名。 |
| [feedback-admin.js](../src/routes/feedback-admin.js) | 反馈管理后台，列表/详情/状态流转。 |
| [stats.js](../src/routes/stats.js) | 统计聚合（概览/模型缓存/每日趋势/日活/用户详情），从 TenantDailyUsage 聚合，**所有角色只返回当前用户自己的数据**。 |

## 10. 模块职责速查表

| 模块 | 职责 | 核心函数 |
|---|---|---|
| server.js | HTTP+WS 路由分发、URL 归一化、CORS | createServer, normalizeRequestUrl |
| gateway/gateway-auth | API Key SHA256 校验 | authenticateApiKey, resolveCredential |
| gateway/dashboard-auth | 鉴权守卫中间件 | requireApiAuth, requireAdminAuth |
| gateway/session | JWT cookie 会话 | createSessionToken, setSessionCookie |
| gateway/tenant-manager | 统一租户+服务profile+统计 | authenticate, createTenantForUser, getCodebuddyCredentialManager |
| shared/auth-mode | 启动探测 LDAP/local | initAuthMode, getAuthMode |
| shared/local-auth | scrypt 密码+本地登录 | hashPassword, localAuthenticate, ensureAdminFromEnv |
| shared/local-user-manager | 账号 CRUD（按模式分流） | createLocalUser, updateManagedUser |
| shared/responses-ws-server | 客户端 WS 协议桥 | handleWSConnection |
| shared/responses-ws-client | 上游 WS 客户端 | sendResponsesWebSocketRequest |
| shared/responses-ws-pool | ctx_pool 连接池 | acquire, release, discardByPoolKey |
| shared/responses-ws-mode | WS 模式枚举解析 | resolveResponsesWebSocketMode |
| relay 路由 | 4 协议入口 × 4 上游交叉转换 | handleOpenAIChatCompletions, handleAnthropicMessages, handleResponsesAPI |
| relay/conversation-state | 内存会话状态恢复 | hydrateResponsesForFullHistory, prepareResponsesPassthrough |
| relay/context-compactor | 主动+被动上下文压缩 | invokeWithRelayContextCompaction |
| relay/upstream-manager | 上游 CRUD/活跃/模型映射 | getActiveUpstream, resolveModel |
| relay/api | 上游 HTTP/WS 客户端 | createChatCompletions, createAnthropicMessages, createResponsesWebSocket |
| transformer/shared-translator | Anthropic/OpenAI 通用转换 | anthropicToOpenAI, openAIToAnthropic, injectBehaviorRules |
| transformer/responses-translator | Responses 格式转换 | chatRequestToResponses, responsesEventToChatChunks |
| codebuddy/config | 上游 URL/模型/请求头 | getCodebuddyBaseUrl, getModelsForHost, codebuddyHeaders |
| codebuddy/api | 上游 HTTP 客户端 | createChatCompletions, aggregateStreamResponse |
| codebuddy/tenant-token-manager | 单租户凭证+会话亲和 | getNextCredential, addCredentialWithData |
| codebuddy/translator | Anthropic↔OpenAI 转换 | anthropicToOpenAI, ClaudeStreamState |
| codebuddy/ldap-auth | LDAP 两次绑定 | ldapAuthenticate |
| copilot/runtime | AsyncLocalStorage 上下文 | runCopilotTenantContext, currentCopilotContext |
| copilot/github-api | GitHub 设备授权 | startDeviceAuth, pollDeviceAuth, getCopilotToken |
| copilot/credential-manager | 凭证 CRUD+token 自动刷新 | resolve, ensureToken, pollDeviceAuth |
| copilot/copilot-api | 上游 HTTP/WS 客户端 | createChatCompletions, createResponsesWS |
| copilot/anthropic-translator | Copilot 专用协议转换 | anthropicToOpenAI, translateStreamChunk |
| routes/auth | 登录/登出 | routeAuthRequest |
| routes/dashboard-frontend | 管理面板总路由 | routeAdminFrontend |
| routes/dashboard-users | 本地账号 CRUD | handleAdminUsers |
| routes/dashboard-codebuddy | CodeBuddy OAuth 后台 | handleCodebuddyAdminRoute |
| routes/dashboard-copilot | Copilot 凭证管理 | handleCopilotAdminRoute |
| routes/feedback | 反馈提交 | handleFeedback |
| routes/stats | 统计聚合 | routeStatsRequest |

## 11. 三个关键横切点

1. **租户隔离**在两层：gateway-auth 的 API Key→tenantId（HTTP 层），copilot/runtime 的 AsyncLocalStorage（Copilot 业务层）。Relay 和 CodeBuddy 通过 `req.tenantId` 贯穿，Copilot 通过 AsyncLocalStorage 贯穿。

2. **token/凭证刷新**三类各异：Relay 用配置的 api_key 不刷新；CodeBuddy 凭证靠控制台 OAuth 落库、不自动刷新（过期跳过）；Copilot token 按 tenantId+credentialId 用 github_token 自动刷新 copilot_token（5 分钟 buffer）。

3. **协议转换**集中在三层：transformer/shared-translator（通用 Anthropic↔OpenAI）、transformer/responses-translator（Responses 格式）、各代理自己的 translator（codebuddy/translator、copilot/anthropic-translator）。WS 通道统一复用 shared/responses-ws-* 全套。
