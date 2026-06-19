# 16 通路缓存命中率统计全量补齐 设计

## 背景与目标

"优化缓存命中"需要稳定的统计数据支撑。当前项目的缓存命中率统计在 16 个通路（chat / responses / responses_ws / anthropic 四种客户端协议 × 四种上游协议交叉，再加 relay 内部按上游协议的分支）中存在采集点漏接与落库链路断裂，导致部分通路 cacheHit 恒为 0、cache_creation 全程未落库。

字段提取层（`extractCacheMetrics`，覆盖 DeepSeek `prompt_cache_hit_tokens`、OpenAI Chat `prompt_tokens_details.cached_tokens`、Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`、Responses `input_tokens_details.cached_tokens`）本身完整，缺陷集中在**采集点**与**落库**。

目标：让 16 通路全部按统一口径采集并落库 cacheHit 与 cacheCreation，为缓存优化提供可信数据。

## 统一口径

- 命中率分母：`cacheHitRate = cacheHit / inputTokens`。保持现状（`src/routes/stats.js` 已在用）。Anthropic 的 `input_tokens` 已含 `cache_read_input_tokens`，分母合理。
- 命中率分子 cacheHit：统一走 `extractCacheHitTokens`。
- 写缓存成本 cacheCreation：统一走 `extractCacheCreationTokens`，落库 `input_cache_creation` 列。
- 未命中 miss：`input_cache_miss = max(0, inputTokens - cacheHit)`，真正写入 DB 列（该列已存在但此前恒为 0）。前端已用 `input - cacheHit` 现算，DB 列写入让原始查询也拿得到。

## 缺陷清单

| 编号 | 缺陷 | 性质 | 影响通路 |
| --- | --- | --- | --- |
| D1 | ws-server:233 硬编码 `usage.input_tokens_details?.cached_tokens`，不走 extractCacheHitTokens | 确定性 bug | relay/codebuddy/copilot 三条 WS 入口 |
| D2 | relay `recordResponsesUsage`(relay.js:214) 只传 5 参数，cacheCreation 丢失 | 结构缺失 | relay 的 Responses/ResponsesWS 上游路径 |
| D3 | tenant_daily_usage 无 cache_creation 列，recordDailyUsage 不 increment 它 | 结构缺失 | 全部通路（Anthropic 透传传了也被忽略） |
| D4 | copilotStore.recordDailyUsage 签名无 cacheCreation 入参 | 结构缺失 | copilot 全部入口 |
| D5 | copilot.js:648 `extractCacheHitTokens(...) || streamCacheHitTokens` 的 `||` 短路 | 确定性 bug | copilot anthropic HTTP 回退流式 |
| D6 | Responses 通路转换器 `convertUsage`/`convertResponsesUsageToChat` 不映射 cache_creation | 结构缺失 | relay 的 Anthropic→Responses 交叉通路 |
| D7 | relay openai 直通支（chat 非流式 908 + 流式 `_streamOpenAIPassthrough`/`rewriteOpenAIStream`）与 anthropic 直通支（1295/1332）未提取 cacheCreation | 结构缺失 | relay 的 openai/anthropic 直通支（自嵌套 A→B 场景下被 B 对应接口触发，平时连真实模型也触发） |

D6 与 D7 合起来覆盖自嵌套场景：A 的 relay 上游可配置成 B 的四种协议接口（chat/responses/responses_ws/anthropic），A 端 4 个上游分支的 cacheCreation 提取覆盖度为——openai 支(D7)、responses 支(D2)、responses_ws 支(D1)、anthropic 支(D7)。修齐 D1/D2/D7 后 16 支在自嵌套下 cacheCreation 全可采集。

## 设计

### 提取层 — `src/transformer/shared-translator.js`

`extractCacheCreationTokens`（当前只认 `cache_creation_input_tokens`）扩展为三协议兜底：

```
cache_creation_input_tokens || prompt_tokens_details?.cache_creation_tokens || input_tokens_details?.cache_creation_tokens || 0
```

`extractCacheMetrics` 的 cacheCreation 分支同步改为上述三协议兜底，保持两个函数一致。`extractCacheHitTokens` 不变（已委托 extractCacheMetrics）。

### 转换层 — `src/transformer/responses-translator.js`

- `convertUsage`（Chat→Responses，第 776 行）：在 `input_tokens_details` 中补 `cache_creation_tokens: usage.prompt_tokens_details?.cache_creation_tokens || 0`。
- `convertResponsesUsageToChat`（Responses→Chat，第 758 行）：在 `prompt_tokens_details` 中补 `cache_creation_tokens: usage.input_tokens_details?.cache_creation_tokens || 0`。

这样 cache_creation 能在 Chat↔Responses 双向流转不丢失，是 D1/D2 修复的前提。

### 采集层

#### ws-server — `src/services/shared/responses-ws-server.js`

- 第 233 行：`cacheHitTokens = extractCacheHitTokens(usage)`（替换硬编码）。
- 新增 `cacheCreationTokens` 累加变量，从 `response.completed.usage` 提取 `extractCacheCreationTokens(usage)`。
- onUsage 回调签名扩展为 `(inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, model)`（D1 + 接 cacheCreation）。

#### relay — `src/routes/relay.js`

- `recordResponsesUsage`（第 214 行）：补第 8 参 `extractCacheCreationTokens(usage)`（D2）。
- relay WS onUsage 闭包（第 2397 行）：接收第 5 参 cacheCreationTokens 透传给 `recordUsage`。
- **openai 直通支（D7）**：chat 非流式分支（第 908 行 recordUsage）补第 8 参 `extractCacheCreationTokens(parsed.usage)`。
- **anthropic 直通支（D7）**：anthropic 流式（第 1295 行）与非流式（第 1332 行）recordUsage 补第 8 参 `extractCacheCreationTokens(aggregated.usage / data.usage)`。
- 其余 `recordUsage` 调用点已含 cacheCreationTokens 入参，无需改。

#### `rewriteOpenAIStream` — `src/transformer/shared-translator.js`

- 第 953-954 行附近：新增 `streamCacheCreationTokens` 累加变量，从 `data.usage` 提取 `extractCacheCreationTokens(data.usage)`。
- onUsage 回调签名扩展为 `(inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, credit, model)`（cacheCreation 插在第 4 位，credit/model 顺延）。
- 两个调用方同步更新：relay `_streamOpenAIPassthrough`（[relay.js:1375](src/routes/relay.js#L1375)）与 codebuddy 流式分支（[codebuddy.js:278](src/routes/codebuddy.js#L278)），回调接收第 4 参 cacheCreationTokens 并透传给各自 recordUsage。codebuddy 上游恒为 OpenAI Chat，cacheCreation 自然为 0。

#### copilot — `src/routes/copilot.js`

- 第 648 行：`streamCacheHitTokens = extractCacheHitTokens(openAIChunk.usage)`（去掉 `|| streamCacheHitTokens`，D5）。
- copilot 各 `recordDailyUsage` 调用点（共约 14 处，含 onUsage 第 1234 行）：补传第 4 参 cacheCreationTokens，值取 `extractCacheCreationTokens(usage)`（对应 usage 对象）。GPT 上游自然返回 0，口径统一。

### 落库层

#### 模型 — `src/db/models/tenant-daily-usage.js`

新增 `input_cache_creation` 列（`DataTypes.INTEGER, defaultValue: 0`），紧跟 `input_cache_miss` 之后。

#### DB 迁移 — `src/db/index.js`

新增 `ensureTenantDailyUsageColumns()` 钩子，仿现有 `ensureTenantUpstreamColumns` 模式幂等补列：`describeTable` 检查 `input_cache_creation`，缺失则 `addColumn`。在 `initDb` 的两处调用序列中各加一次（与现有 ensure 钩子一致）。

#### 记录 — `src/services/gateway/tenant-manager.js`

`recordDailyUsage`（第 198 行）：

- `findOrCreate` 的 defaults 补 `input_cache_creation: 0`。
- `record.increment` 补 `input_cache_creation: cacheCreationTokens || 0` 与 `input_cache_miss: Math.max(0, (inputTokens || 0) - (cacheHitTokens || 0))`。
- 保留现有 `logger.info` 诊断日志。

### 签名扩展 — copilotStore `src/services/copilot/runtime.js`

`copilotStore.recordDailyUsage`（第 60 行）签名加第 4 参 `cacheCreationTokens = 0`，透传给 `unifiedTenantManager.recordDailyUsage` 的第 8 参。

## 不在范围内

- copilot 调用点统一缺 model 参数（落库 model='unknown'）：已存在统计盲点，但不属本次缓存统计范畴，不动以避免范围蔓延。
- 前端 `stats.js`/`admin.html` 展示层：命中率口径不变，无需改动。
- service-profile 的 `total_cache_hit_tokens` 累计统计：与 daily-usage 独立，本次不动。

## 验证

- 现有 `tests/cache-metrics.test.js` 需扩展：为 `extractCacheCreationTokens` 增加三协议字段识别用例（Chat `prompt_tokens_details.cache_creation_tokens`、Responses `input_tokens_details.cache_creation_tokens`）。
- 为 `convertUsage`/`convertResponsesUsageToChat` 增加 cache_creation 双向映射用例。
- 全量 `node --test` 通过。

## 改动文件清单

1. `src/transformer/shared-translator.js` — extractCacheCreationTokens/extractCacheMetrics 扩展 + rewriteOpenAIStream 补 cacheCreation 提取与回调用参
2. `src/transformer/responses-translator.js` — convertUsage/convertResponsesUsageToChat 补 cache_creation
3. `src/services/shared/responses-ws-server.js` — D1 修复 + onUsage 扩参
4. `src/routes/relay.js` — recordResponsesUsage 补参 + WS onUsage 透传 + openai/anthropic 直通支补 cacheCreation（D7）+ `_streamOpenAIPassthrough` 接 cacheCreation
5. `src/routes/codebuddy.js` — 流式分支回调接第 4 参 cacheCreationTokens 并传给 recordDailyUsage（上游 OpenAI Chat 自然为 0）
6. `src/routes/copilot.js` — D5 修复 + recordDailyUsage 调用点补 cacheCreation
7. `src/services/copilot/runtime.js` — copilotStore 签名扩展
8. `src/db/models/tenant-daily-usage.js` — 加 input_cache_creation 列
9. `src/db/index.js` — ensureTenantDailyUsageColumns 钩子
10. `src/services/gateway/tenant-manager.js` — recordDailyUsage increment 新字段
11. `tests/cache-metrics.test.js` — 扩展用例
