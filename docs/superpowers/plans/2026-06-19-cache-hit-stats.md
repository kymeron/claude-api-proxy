# 16 通路缓存命中率统计全量补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 16 通路（chat/responses/responses_ws/anthropic 四协议交叉 + relay 内部上游分支）按统一口径采集并落库 cacheHit 与 cacheCreation，修复 D1-D7 共 7 处缺陷。

**Architecture:** 自下而上四层修复——提取层扩展 `extractCacheCreationTokens` 三协议兜底；转换层补 Chat↔Responses 双向 cache_creation 映射；落库层加 `input_cache_creation` 列并写入 `input_cache_miss`；采集层修 ws-server 硬编码、relay/copilot 的 cacheCreation 透传与 `||` 短路 bug。依赖顺序：提取层 → 转换层 → 落库层 → 采集层。

**Tech Stack:** Node.js ESM（`type: module`），`node:test` + `node:assert/strict`，Sequelize 6（MySQL），测试命令 `npm test`（`node --test tests/*.test.js`）。

**Spec:** `docs/superpowers/specs/2026-06-19-cache-hit-stats-design.md`

---

## File Structure

| 文件 | 职责 | 改动类型 |
| --- | --- | --- |
| `src/transformer/shared-translator.js` | 缓存字段提取 + rewriteOpenAIStream | 修改 |
| `src/transformer/responses-translator.js` | Chat↔Responses usage 双向转换 | 修改 |
| `src/db/models/tenant-daily-usage.js` | 每日用量表模型 | 修改（加列） |
| `src/db/index.js` | DB 初始化与幂等迁移 | 修改（加 ensure 钩子） |
| `src/services/gateway/tenant-manager.js` | recordDailyUsage 落库 | 修改 |
| `src/services/shared/responses-ws-server.js` | WS 入口 usage 采集 | 修改（D1 + 扩参） |
| `src/routes/relay.js` | relay 路由 usage 采集 | 修改（D2/D7） |
| `src/routes/codebuddy.js` | codebuddy 路由 usage 采集 | 修改（WS onUsage 扩参） |
| `src/routes/copilot.js` | copilot 路由 usage 采集 | 修改（D5 + cacheCreation） |
| `src/services/copilot/runtime.js` | copilotStore 落库签名 | 修改（D4） |
| `tests/cache-metrics.test.js` | 缓存提取单元测试 | 修改（扩展） |
| `tests/responses-usage-cache-creation.test.js` | 转换层 cache_creation 映射测试 | 新建 |
| `tests/service-usage-isolation.test.js` | 落库 increment 断言测试 | 修改（适配新字段） |

---

## Task 1: 扩展 extractCacheCreationTokens 三协议兜底（提取层）

**Files:**
- Modify: `src/transformer/shared-translator.js:21-46`
- Test: `tests/cache-metrics.test.js`

当前 `extractCacheCreationTokens` 只认 `cache_creation_input_tokens`（Anthropic），需扩展为同时认 Chat 的 `prompt_tokens_details.cache_creation_tokens` 与 Responses 的 `input_tokens_details.cache_creation_tokens`。`extractCacheMetrics` 的 cacheCreation 分支同步对齐。

- [ ] **Step 1: 在 cache-metrics.test.js 末尾追加失败测试**

在 `tests/cache-metrics.test.js` 文件末尾追加：

```javascript
/* ==================== extractCacheCreationTokens 三协议兜底 ==================== */

test('extractCacheCreationTokens 识别 Chat 的 prompt_tokens_details.cache_creation_tokens', () => {
    const usage = {prompt_tokens_details: {cache_creation_tokens: 2500}};
    assert.equal(extractCacheCreationTokens(usage), 2500);
});

test('extractCacheCreationTokens 识别 Responses 的 input_tokens_details.cache_creation_tokens', () => {
    const usage = {input_tokens_details: {cache_creation_tokens: 1800}};
    assert.equal(extractCacheCreationTokens(usage), 1800);
});

test('extractCacheCreationTokens 优先 Anthropic 原生字段', () => {
    const usage = {
        cache_creation_input_tokens: 3000,
        prompt_tokens_details: {cache_creation_tokens: 999},
        input_tokens_details: {cache_creation_tokens: 888}
    };
    assert.equal(extractCacheCreationTokens(usage), 3000);
});

test('extractCacheMetrics 同步返回三协议 cacheCreation', () => {
    assert.equal(extractCacheMetrics({prompt_tokens_details: {cache_creation_tokens: 500}}).cacheCreation, 500);
    assert.equal(extractCacheMetrics({input_tokens_details: {cache_creation_tokens: 700}}).cacheCreation, 700);
    assert.equal(extractCacheMetrics({cache_creation_input_tokens: 900}).cacheCreation, 900);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test 2>&1 | grep -A2 "extractCacheCreationTokens 识别 Chat"`
Expected: FAIL — 当前 `extractCacheCreationTokens({prompt_tokens_details: {cache_creation_tokens: 2500}})` 返回 0，断言期望 2500。

- [ ] **Step 3: 修改 extractCacheCreationTokens 与 extractCacheMetrics**

将 `src/transformer/shared-translator.js` 的 `extractCacheMetrics`（第 21-31 行）与 `extractCacheCreationTokens`（第 40-46 行）替换为：

```javascript
export function extractCacheMetrics(usage) {
    if (!usage) return {cacheHit: 0, cacheCreation: 0};
    const cacheHit =
        usage.prompt_cache_hit_tokens
        || usage.prompt_tokens_details?.cached_tokens
        || usage.cache_read_input_tokens
        || usage.input_tokens_details?.cached_tokens
        || 0;
    const cacheCreation =
        usage.cache_creation_input_tokens
        || usage.prompt_tokens_details?.cache_creation_tokens
        || usage.input_tokens_details?.cache_creation_tokens
        || 0;
    return {cacheHit, cacheCreation};
}

/**
 * 从上游 usage 中提取缓存写入 token 数（向后兼容，委托统一函数）
 */
export function extractCacheHitTokens(usage) {
    return extractCacheMetrics(usage).cacheHit;
}

/**
 * 从上游 usage 中提取缓存写入 token 数
 * 覆盖三种协议字段：Anthropic cache_creation_input_tokens、
 * Chat prompt_tokens_details.cache_creation_tokens、
 * Responses input_tokens_details.cache_creation_tokens
 */
export function extractCacheCreationTokens(usage) {
    if (!usage) return 0;
    return extractCacheMetrics(usage).cacheCreation;
}
```

注意：`extractCacheCreationTokens` 改为委托 `extractCacheMetrics`，与 `extractCacheHitTokens` 保持一致，避免两处兜底逻辑漂移。原第 40-46 行注释保留在新的 JSDoc 中。

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test 2>&1 | grep -E "extractCacheCreationTokens|extractCacheMetrics 同步" -A1`
Expected: 4 个新测试全 PASS，原有 cache-metrics 测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/transformer/shared-translator.js tests/cache-metrics.test.js
git commit -m "feat(cache): extractCacheCreationTokens 三协议字段兜底

支持 Anthropic cache_creation_input_tokens、Chat prompt_tokens_details.cache_creation_tokens、Responses input_tokens_details.cache_creation_tokens 三种字段，extractCacheMetrics 同步对齐。"
```

---

## Task 2: 补 Chat↔Responses 双向 cache_creation 映射（转换层）

**Files:**
- Modify: `src/transformer/responses-translator.js:758-789`
- Test: `tests/responses-usage-cache-creation.test.js`（新建）

`convertUsage`（Chat→Responses）与 `convertResponsesUsageToChat`（Responses→Chat）当前都不映射 cache_creation，导致 Anthropic→Responses 交叉通路丢失写缓存成本。

- [ ] **Step 1: 新建失败测试 tests/responses-usage-cache-creation.test.js**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {convertResponsesUsageToChat} from '../src/transformer/responses-translator.js';

/* convertUsage 是模块私有函数，通过 convertResponsesUsageToChat 间接验证双向映射：
   Chat→Responses→Chat 往返后 cache_creation 应保持不变。 */

test('convertResponsesUsageToChat 从 Responses usage 提取 cache_creation_tokens', () => {
    const chatUsage = convertResponsesUsageToChat({
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        input_tokens_details: {cached_tokens: 300, cache_creation_tokens: 800}
    });
    assert.equal(chatUsage.prompt_tokens_details.cache_creation_tokens, 800);
    assert.equal(chatUsage.prompt_tokens_details.cached_tokens, 300);
});

test('convertResponsesUsageToChat 在 cache_creation 缺失时返回 0', () => {
    const chatUsage = convertResponsesUsageToChat({
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: {cached_tokens: 100}
    });
    assert.equal(chatUsage.prompt_tokens_details.cache_creation_tokens, 0);
});

/* Chat→Responses 映射通过 chatChunkToResponsesEvents 生成 response.completed 间接验证：
   构造一个带 cache_creation_tokens 的最终 Chat chunk，断言输出的 response.completed.usage
   携带 input_tokens_details.cache_creation_tokens。 */
test('Chat→Responses 转换保留 cache_creation_tokens 到 input_tokens_details', async () => {
    const {chatChunkToResponsesEvents, createResponsesStreamState} = await import('../src/transformer/responses-translator.js');
    const state = createResponsesStreamState();
    // 先发一个带内容的 delta 触发 message 生命周期，再发带 usage 的最终 chunk
    chatChunkToResponsesEvents({
        id: 'chatcmpl_1', object: 'chat.completion.chunk',
        choices: [{index: 0, delta: {content: 'hi'}, finish_reason: null}]
    }, state);
    const events = chatChunkToResponsesEvents({
        id: 'chatcmpl_1', object: 'chat.completion.chunk',
        choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
        usage: {
            prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500,
            prompt_tokens_details: {cached_tokens: 300, cache_creation_tokens: 800}
        }
    }, state);
    const completed = events.find((e) => e.event === 'response.completed');
    assert.ok(completed, '应生成 response.completed 事件');
    assert.equal(completed.data.response.usage.input_tokens_details.cache_creation_tokens, 800);
    assert.equal(completed.data.response.usage.input_tokens_details.cached_tokens, 300);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test 2>&1 | grep -A2 "cache_creation"`
Expected: FAIL — `convertResponsesUsageToChat` 返回的 `prompt_tokens_details` 无 `cache_creation_tokens` 字段（undefined ≠ 0）；Chat→Responses 同样缺失。

- [ ] **Step 3: 修改 convertUsage 与 convertResponsesUsageToChat**

将 `src/transformer/responses-translator.js` 第 758-789 行的两个函数替换为：

```javascript
export function convertResponsesUsageToChat(usage) {
    if (!usage) return {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0};
    return {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details?.cached_tokens || 0,
            cache_creation_tokens: usage.input_tokens_details?.cache_creation_tokens || 0
        },
        completion_tokens_details: {
            reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0
        }
    };
}

/**
 * 转换 usage 格式
 */
function convertUsage(usage) {
    if (!usage) return {input_tokens: 0, output_tokens: 0, total_tokens: 0};
    return {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        input_tokens_details: {
            cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
            cache_creation_tokens: usage.prompt_tokens_details?.cache_creation_tokens || 0
        },
        output_tokens_details: {
            reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0
        }
    };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test 2>&1 | grep -E "cache_creation" -A1`
Expected: 3 个新测试全 PASS。

- [ ] **Step 5: 全量回归并提交**

Run: `npm test 2>&1 | tail -5`
Expected: 全部测试 PASS（确认未破坏 responses-input-sanitize / responses-merge-assistant 等依赖转换器的测试）。

```bash
git add src/transformer/responses-translator.js tests/responses-usage-cache-creation.test.js
git commit -m "feat(cache): Chat↔Responses usage 双向映射 cache_creation_tokens

convertUsage 与 convertResponsesUsageToChat 补 cache_creation_tokens 映射，
修复 Anthropic→Responses 交叉通路写缓存成本丢失。"
```

---

## Task 3: 加 input_cache_creation 列与幂等迁移（落库层 - 模型）

**Files:**
- Modify: `src/db/models/tenant-daily-usage.js:35-50`
- Modify: `src/db/index.js:30-101`

给 `tenant_daily_usage` 表加 `input_cache_creation` 列，并新增 `ensureTenantDailyUsageColumns` 幂等迁移钩子。`input_cache_miss` 列已存在（第 39 行），无需新增。

- [ ] **Step 1: 在 tenant-daily-usage.js 加列定义**

将 `src/db/models/tenant-daily-usage.js` 的列定义中，`input_cache_miss` 之后插入 `input_cache_creation`：

```javascript
    input_cache_miss: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    input_cache_creation: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    output_tokens: {
```

（即在第 39-42 行的 `input_cache_miss` 块与第 43 行 `output_tokens` 之间插入 `input_cache_creation` 块。）

- [ ] **Step 2: 在 db/index.js 新增 ensureTenantDailyUsageColumns 钩子**

在 `src/db/index.js` 的 `initDb`（第 30-39 行）中，在 `ensureTenantUpstreamColumns()` 两处调用后各加一次 `ensureTenantDailyUsageColumns()`：

```javascript
export async function initDb() {
    await sequelize.authenticate();
    await ensureTenantCredentialColumns();
    await ensureCopilotCredentialColumns();
    await ensureTenantUpstreamColumns();
    await ensureTenantDailyUsageColumns();
    await sequelize.sync();
    await ensureTenantCredentialColumns();
    await ensureCopilotCredentialColumns();
    await ensureTenantUpstreamColumns();
    await ensureTenantDailyUsageColumns();
}
```

在 `ensureTenantUpstreamColumns` 函数（第 84-101 行）之后，新增函数：

```javascript
async function ensureTenantDailyUsageColumns() {
    const queryInterface = sequelize.getQueryInterface();
    const table = 'tenant_daily_usage';
    let columns;
    try {
        columns = await queryInterface.describeTable(table);
    } catch {
        return;
    }

    if (!columns.input_cache_creation) {
        await queryInterface.addColumn(table, 'input_cache_creation', {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0
        });
    }
}
```

- [ ] **Step 3: 静态检查加载无误**

Run: `node -e "import('./src/db/models/tenant-daily-usage.js').then(m => console.log(Object.keys(m.TenantDailyUsage.rawAttributes).filter(k => k.startsWith('input_cache'))))"`
Expected: 输出 `[ 'input_cache_hit', 'input_cache_miss', 'input_cache_creation' ]`

- [ ] **Step 4: 提交**

```bash
git add src/db/models/tenant-daily-usage.js src/db/index.js
git commit -m "feat(db): tenant_daily_usage 加 input_cache_creation 列

新增 ensureTenantDailyUsageColumns 幂等迁移钩子，老库自动补列。"
```

---

## Task 4: recordDailyUsage 落库 cacheCreation 与 input_cache_miss（落库层 - 记录）

**Files:**
- Modify: `src/services/gateway/tenant-manager.js:198-226`
- Test: `tests/service-usage-isolation.test.js:55-88`

`recordDailyUsage` 当前只 increment `input_cache_hit`，需补 increment `input_cache_creation` 与 `input_cache_miss`（miss = max(0, input - cacheHit)），defaults 也补新字段。

- [ ] **Step 1: 先更新现有 service-usage-isolation 测试断言（改为失败状态）**

`tests/service-usage-isolation.test.js` 第 78-84 行的 `assert.deepEqual(incrementValues, {...})` 当前断言只有 4 个字段。先更新它，使其成为本次改动的失败测试：

将第 78-84 行：

```javascript
        assert.deepEqual(incrementValues, {
            api_calls: 1,
            input_tokens: 11,
            output_tokens: 12,
            input_cache_hit: 4,
            credit: 1.5
        });
```

替换为：

```javascript
        assert.deepEqual(incrementValues, {
            api_calls: 1,
            input_tokens: 11,
            output_tokens: 12,
            input_cache_hit: 4,
            input_cache_miss: 7,
            input_cache_creation: 0,
            credit: 1.5
        });
```

（第 70 行调用 `recordDailyUsage(42, 'codebuddy', 11, 12, 4, 1.5, 'claude-sonnet-4')` 中 input=11、cacheHit=4，故 miss = 11-4 = 7；cacheCreation 未传故默认 0。）

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test 2>&1 | grep -A20 "records daily usage"`
Expected: FAIL — `incrementValues` 缺少 `input_cache_miss` 与 `input_cache_creation`。

- [ ] **Step 3: 修改 recordDailyUsage**

将 `src/services/gateway/tenant-manager.js` 第 198-226 行的 `recordDailyUsage` 替换为：

```javascript
    async recordDailyUsage(tenantId, serviceType, inputTokens, outputTokens, cacheHitTokens = 0, credit = 0, model = 'unknown', cacheCreationTokens = 0) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        try {
            const today = new Date().toISOString().slice(0, 10);
            const [record] = await models.TenantDailyUsage.findOrCreate({
                where: {tenant_id: id, service_type: serviceType, date: today, model: model || 'unknown'},
                defaults: {
                    tenant_id: id, service_type: serviceType, date: today, model: model || 'unknown',
                    api_calls: 0, input_tokens: 0, output_tokens: 0,
                    input_cache_hit: 0, input_cache_miss: 0, input_cache_creation: 0, credit: 0
                }
            });
            const effectiveInput = inputTokens || 0;
            const effectiveHit = cacheHitTokens || 0;
            const cacheMiss = Math.max(0, effectiveInput - effectiveHit);
            await record.increment({
                api_calls: 1,
                input_tokens: effectiveInput,
                output_tokens: outputTokens || 0,
                input_cache_hit: effectiveHit,
                input_cache_miss: cacheMiss,
                input_cache_creation: cacheCreationTokens || 0,
                credit: credit || 0
            });
            // 缓存可观测性诊断日志：cacheCreationTokens 仅 Anthropic 上游提供，
            // 用于观测缓存写入成本与命中率。
            const cacheHitRate = effectiveInput > 0 ? (effectiveHit / effectiveInput) : 0;
            logger.info(`cache usage: tenant=${id} service=${serviceType} model=${model || 'unknown'} input=${effectiveInput} output=${outputTokens || 0} cacheHit=${effectiveHit} cacheCreation=${cacheCreationTokens || 0} cacheHitRate=${cacheHitRate.toFixed(4)}`);
        } catch (error) {
            logger.error(`Failed to record daily usage for tenant ${id}: ${error.message}`);
        }
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test 2>&1 | grep -A2 "records daily usage"`
Expected: PASS。

- [ ] **Step 5: 全量回归并提交**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 PASS。

```bash
git add src/services/gateway/tenant-manager.js tests/service-usage-isolation.test.js
git commit -m "feat(stats): recordDailyUsage 落库 cacheCreation 与 input_cache_miss

input_cache_miss = max(0, input - cacheHit)，input_cache_creation 累计写缓存成本。"
```

---

## Task 5: ws-server 修复 D1 硬编码并扩 onUsage 签名（采集层 - WS）

**Files:**
- Modify: `src/services/shared/responses-ws-server.js:32, 197-291`

ws-server 第 233 行硬编码 `usage.input_tokens_details?.cached_tokens`，改用 `extractCacheHitTokens`；新增 cacheCreationTokens 累加；onUsage 回调扩为 5 参 `(input, output, cacheHitTokens, cacheCreationTokens, model)`。

- [ ] **Step 1: 修改 import 与 onUsage 文档签名**

在 `src/services/shared/responses-ws-server.js` 第 8 行 `import logger` 之后新增 import：

```javascript
import {extractCacheHitTokens, extractCacheCreationTokens} from '../../transformer/shared-translator.js';
```

第 32 行 JSDoc 注释中 onUsage 签名更新为：

```javascript
 * @param {function} [options.onUsage] - 用量记录回调 (inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, model) => void
```

- [ ] **Step 2: 修改 usage 累加与 onUsage 调用**

第 199 行 `let cacheHitTokens = 0;` 之后新增一行：

```javascript
    let cacheHitTokens = 0;
    let cacheCreationTokens = 0;
```

第 229-234 行的 usage 提取块替换为：

```javascript
            if (event.type === 'response.completed' && event.data?.response?.usage) {
                const usage = event.data.response.usage;
                inputTokens = usage.input_tokens || 0;
                outputTokens = usage.output_tokens || 0;
                cacheHitTokens = extractCacheHitTokens(usage);
                cacheCreationTokens = extractCacheCreationTokens(usage);
            }
```

第 287-290 行 onUsage 调用替换为：

```javascript
        if (ctx.onUsage && (inputTokens > 0 || outputTokens > 0)) {
            const recordUsage = () => ctx.onUsage(inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, model);
            if (ctx.runInContext) ctx.runInContext(recordUsage);
            else recordUsage();
        }
```

- [ ] **Step 3: 静态检查语法**

Run: `node --check src/services/shared/responses-ws-server.js`
Expected: 无输出（语法正确）。

- [ ] **Step 4: 全量回归**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 PASS（relay-responses-ws / responses-ws-stream-bridge 等相关测试不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/services/shared/responses-ws-server.js
git commit -m "fix(ws): 用 extractCacheHitTokens 替换硬编码并采集 cacheCreation

修复 D1：WS 入口原先只识别 input_tokens_details.cached_tokens，Chat→Responses
转换路径的 cacheHit 丢失；onUsage 扩为 5 参透传 cacheCreationTokens。"
```

---

## Task 6: relay 三处采集点补 cacheCreation（采集层 - relay，D2/D7）

**Files:**
- Modify: `src/routes/relay.js:214-222, 908-915, 1295, 1332, 2397-2399`

D2：`recordResponsesUsage` 补第 8 参。D7：openai 直通非流式（908）、anthropic 直通流式（1295）与非流式（1332）补 cacheCreation。relay WS onUsage 闭包（2397）接收第 5 参透传。

- [ ] **Step 1: 修改 recordResponsesUsage（D2）**

`src/routes/relay.js` 第 214-222 行替换为：

```javascript
function recordResponsesUsage(tenantId, usage, model) {
    recordUsage(
        tenantId,
        usage?.input_tokens || 0,
        usage?.output_tokens || 0,
        usage?.input_tokens_details?.cached_tokens || 0,
        model,
        null,
        null,
        extractCacheCreationTokens(usage)
    );
}
```

确认 `extractCacheCreationTokens` 已在文件顶部 import（第 35-50 行附近的 shared-translator import 块）。若未 import，在 import 块中添加 `extractCacheCreationTokens`。

- [ ] **Step 2: 修改 openai 直通非流式分支（D7，第 908-915 行）**

将第 908-915 行：

```javascript
            const cacheHitTokens = extractCacheHitTokens(parsed.usage);
            recordUsage(
                tenantId,
                parsed.usage?.prompt_tokens || 0,
                parsed.usage?.completion_tokens || 0,
                cacheHitTokens,
                relayStatsModel
            );
```

替换为：

```javascript
            const cacheHitTokens = extractCacheHitTokens(parsed.usage);
            const cacheCreationTokens = extractCacheCreationTokens(parsed.usage);
            recordUsage(
                tenantId,
                parsed.usage?.prompt_tokens || 0,
                parsed.usage?.completion_tokens || 0,
                cacheHitTokens,
                relayStatsModel,
                null,
                null,
                cacheCreationTokens
            );
```

- [ ] **Step 3: 修改 anthropic 直通非流式分支（D7，第 1331-1332 行）**

将第 1331-1332 行：

```javascript
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, relayStatsModel);
```

替换为：

```javascript
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const cacheCreationTokens = extractCacheCreationTokens(aggregated.usage);
            recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, relayStatsModel, null, null, cacheCreationTokens);
```

- [ ] **Step 4: 修改 anthropic 直通流式分支（D7，第 1295 行）**

先在流式处理块（约第 1217 行 `let streamCacheHitTokens = 0;` 附近）确认 cacheHit 累加点，新增 cacheCreation 累加。在第 1217 行 `let streamCacheHitTokens = 0;` 之后新增：

```javascript
            let streamCacheHitTokens = 0;
            let streamCacheCreationTokens = 0;
```

在第 1243 行 `streamCacheHitTokens = extractCacheHitTokens(data.usage);` 之后新增：

```javascript
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCacheCreationTokens = extractCacheCreationTokens(data.usage);
```

第 1295 行 `recordUsage(tenantId, streamInputTokens, streamOutputTokens, streamCacheHitTokens, relayStatsModel);` 替换为：

```javascript
                recordUsage(tenantId, streamInputTokens, streamOutputTokens, streamCacheHitTokens, relayStatsModel, null, null, streamCacheCreationTokens);
```

- [ ] **Step 5: 修改 relay WS onUsage 闭包（D1 连带，第 2397-2399 行）**

将第 2397-2399 行：

```javascript
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            recordUsage(req.tenantId, inputTokens, outputTokens, cacheHitTokens, req.relayResolvedModel || model);
        }
```

替换为：

```javascript
        onUsage: (inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, model) => {
            recordUsage(req.tenantId, inputTokens, outputTokens, cacheHitTokens, req.relayResolvedModel || model, null, null, cacheCreationTokens);
        }
```

- [ ] **Step 6: 确认 extractCacheCreationTokens 已 import**

Run: `grep -n "extractCacheCreationTokens" src/routes/relay.js | head -3`
Expected: 至少在 import 块出现一次。若未 import，在 `src/routes/relay.js` 顶部 shared-translator 的 import 块（约第 31-50 行）加入 `extractCacheCreationTokens`。

- [ ] **Step 7: 语法检查与全量回归**

Run: `node --check src/routes/relay.js && npm test 2>&1 | tail -5`
Expected: 语法正确，全部测试 PASS。

- [ ] **Step 8: 提交**

```bash
git add src/routes/relay.js
git commit -m "fix(relay): 补全 openai/anthropic 直通支与 responses 支的 cacheCreation

D2 recordResponsesUsage + D7 openai/anthropic 直通支提取 cacheCreation；
WS onUsage 闭包接收并透传 cacheCreationTokens，闭合自嵌套 A→B 链路。"
```

---

## Task 7: rewriteOpenAIStream 补 cacheCreation 提取与扩参（采集层 - 共享流式）

**Files:**
- Modify: `src/transformer/shared-translator.js:890-1008`

`rewriteOpenAIStream` 只提取 cacheHit，需补 cacheCreation；onUsage 回调扩为 6 参 `(input, output, cacheHitTokens, cacheCreationTokens, credit, model)`。连带两个调用方：relay `_streamOpenAIPassthrough` 与 codebuddy 流式分支。

- [ ] **Step 1: 修改 rewriteOpenAIStream 提取与回调签名**

在 `src/transformer/shared-translator.js` 的 `rewriteOpenAIStream` 函数内（第 891-898 行变量声明区），`let streamCacheHitTokens = 0;` 之后新增：

```javascript
    let streamCacheHitTokens = 0;
    let streamCacheCreationTokens = 0;
```

第 953-955 行 usage 提取块：

```javascript
                streamCacheHitTokens =
                    data.usage.prompt_cache_hit_tokens || data.usage.prompt_tokens_details?.cached_tokens || 0;
                streamCredit = data.usage.credit || 0;
```

替换为：

```javascript
                streamCacheHitTokens = extractCacheHitTokens(data.usage);
                streamCacheCreationTokens = extractCacheCreationTokens(data.usage);
                streamCredit = data.usage.credit || 0;
```

（此处同时复用统一提取函数，消除原硬编码。`extractCacheHitTokens`/`extractCacheCreationTokens` 已在本文件定义。）

第 998 行 `onUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit, streamModel);` 替换为：

```javascript
            onUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCacheCreationTokens, streamCredit, streamModel);
```

同步更新第 888 行 JSDoc：

```javascript
 * @param {Function} onUsage - usage 统计回调 (inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, credit, model)
```

- [ ] **Step 2: 更新 relay _streamOpenAIPassthrough 调用方**

`src/routes/relay.js` 第 1374-1378 行替换为：

```javascript
function _streamOpenAIPassthrough(response, res, tenantId, tenantInfo = '', model = 'unknown') {
    rewriteOpenAIStream(res, response.body, (inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, credit, model) => {
        recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, model, null, null, cacheCreationTokens);
    });
}
```

- [ ] **Step 3: 更新 codebuddy 流式分支调用方**

`src/routes/codebuddy.js` 第 278-299 行的回调签名与 recordDailyUsage 调用替换为：

```javascript
            rewriteOpenAIStream(res, response.body, (inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, credit, model) => {
                if (authResult.tenantId) {
                    unifiedTenantManager.incrementApiCallCount(authResult.tenantId, 'codebuddy');
                    unifiedTenantManager.incrementTokenUsage(
                        authResult.tenantId,
                        'codebuddy',
                        inputTokens,
                        outputTokens,
                        cacheHitTokens
                    );
                    unifiedTenantManager.incrementCreditUsage(authResult.tenantId, 'codebuddy', credit);
                    unifiedTenantManager.recordDailyUsage(
                        authResult.tenantId,
                        'codebuddy',
                        inputTokens,
                        outputTokens,
                        cacheHitTokens,
                        credit,
                        pickModelName(model, openAIPayload.model),
                        cacheCreationTokens
                    );
                }
            });
```

- [ ] **Step 4: 更新 codebuddy WS onUsage 闭包（D1 连带，第 1296-1310 行）**

ws-server onUsage 扩为 5 参后，codebuddy WS 入口闭包需同步接收 cacheCreationTokens：

`src/routes/codebuddy.js` 第 1296-1310 行替换为：

```javascript
        onUsage: (inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, model) => {
            const tenantId = req.tenantId;
            if (!tenantId) return;
            unifiedTenantManager.incrementApiCallCount(tenantId, 'codebuddy');
            unifiedTenantManager.incrementTokenUsage(tenantId, 'codebuddy', inputTokens, outputTokens, cacheHitTokens);
            unifiedTenantManager.recordDailyUsage(
                tenantId,
                'codebuddy',
                inputTokens,
                outputTokens,
                cacheHitTokens,
                0,
                model,
                cacheCreationTokens
            );
        }
```

- [ ] **Step 5: 语法检查与全量回归**

Run: `node --check src/transformer/shared-translator.js && node --check src/routes/relay.js && node --check src/routes/codebuddy.js && npm test 2>&1 | tail -5`
Expected: 三个文件语法正确，全部测试 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/transformer/shared-translator.js src/routes/relay.js src/routes/codebuddy.js
git commit -m "fix(stream): rewriteOpenAIStream 采集 cacheCreation 并扩 onUsage 为 6 参

连带更新 relay _streamOpenAIPassthrough、codebuddy 流式分支与 WS onUsage 闭包。"
```

---

## Task 8: copilotStore 签名扩展与 copilot 通路补 cacheCreation（采集层 - copilot，D4/D5）

**Files:**
- Modify: `src/services/copilot/runtime.js:50-71`
- Modify: `src/routes/copilot.js:648, 多处 recordDailyUsage 调用, 1234-1238`

D4：`copilotStore.recordDailyUsage` 加第 4 参 cacheCreationTokens。D5：第 648 行 `||` 短路改 `=`。copilot 各 recordDailyUsage 调用点补传 cacheCreationTokens（GPT 上游自然为 0）。

- [ ] **Step 1: 扩展 copilotStore.recordDailyUsage 签名（D4）**

`src/services/copilot/runtime.js` 第 60-71 行替换为：

```javascript
    recordDailyUsage(inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown', cacheCreationTokens = 0) {
        const {tenantId} = currentCopilotContext();
        unifiedTenantManager.recordDailyUsage(
            tenantId,
            'copilot',
            inputTokens,
            outputTokens,
            cacheHitTokens,
            0,
            model,
            cacheCreationTokens
        );
    }
```

注意：原签名是 `(inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown')`，cacheCreationTokens 作为第 4 参会与 model 冲突。此处改为把 cacheCreationTokens 放在第 5 参（model 之后），保持 model 第 4 位不变，避免改动所有调用点的 model 传参。

- [ ] **Step 2: 修复 D5 短路 bug（第 648 行）**

`src/routes/copilot.js` 第 648 行：

```javascript
                                    streamCacheHitTokens = extractCacheHitTokens(openAIChunk.usage) || streamCacheHitTokens;
```

替换为：

```javascript
                                    streamCacheHitTokens = extractCacheHitTokens(openAIChunk.usage);
```

- [ ] **Step 3: 为 copilot 各 recordDailyUsage 调用点补 cacheCreationTokens**

先确认 import：`copilot.js` 第 38 行当前为 `import {sanitizeAnthropicPayload, extractCacheHitTokens} from '../transformer/shared-translator.js';`，需追加 `extractCacheCreationTokens`，改为：

```javascript
import {sanitizeAnthropicPayload, extractCacheHitTokens, extractCacheCreationTokens} from '../transformer/shared-translator.js';
```

`copilotStore.recordDailyUsage` 当前调用点共 20 处，分三种形态：

(a) **流式分支**（6 处：286/387/547/689/898/1024 行，形参 `streamInputTokens, streamOutputTokens, streamCacheHitTokens`）：每个分支顶部已有 `let streamCacheHitTokens = 0;`（声明行约 261/356/519/627/875/972 行），在其旁新增 `let streamCacheCreationTokens = 0;`；在已有的 `streamCacheHitTokens = extractCacheHitTokens(...)` 赋值旁（269/374/527/648/883/993 行）新增 `streamCacheCreationTokens = extractCacheCreationTokens(...)`（注意 648 行 Step 2 已改为 `=` 赋值，此处补同一作用域的 cacheCreation 赋值）；将 6 处 `recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens)` 改为 `recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined, streamCacheCreationTokens)`。

(b) **非流式分支**（7 处：315/422/578/723/922/1041/1096 行，形参 `inputTokens, outputTokens, cacheHitTokens`）：每处上方已有 `const cacheHitTokens = extractCacheHitTokens(...)`（312/418/574/719/919/1038/1093 行），在其旁新增 `const cacheCreationTokens = extractCacheCreationTokens(同一 usage 对象)`；将调用改为 `recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined, cacheCreationTokens)`。

(c) **估算兜底分支**（6 处：291/392/426/552/582/694/727 行，形参 `estimated, 0, 0`）：无 usage，cacheCreation 恒 0，保持不变（走默认值）。

`undefined` 让 model 走默认 'unknown'，与改动前调用点未传 model 的行为一致。

- [ ] **Step 4: 修改 copilot WS onUsage 闭包（D1 连带，第 1234-1238 行）**

`src/routes/copilot.js` 第 1234-1238 行替换为：

```javascript
        onUsage: (inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens, model) => {
            copilotStore.incrementApiCallCount();
            copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model, cacheCreationTokens);
        }
```

- [ ] **Step 5: 语法检查**

Run: `node --check src/services/copilot/runtime.js && node --check src/routes/copilot.js`
Expected: 语法正确。

- [ ] **Step 6: 全量回归并提交**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 PASS（copilot-runtime-isolation / copilot-credential-manager 等不回归）。

```bash
git add src/services/copilot/runtime.js src/routes/copilot.js
git commit -m "fix(copilot): 扩 copilotStore 签名、修复 || 短路、补 cacheCreation

D4 copilotStore.recordDailyUsage 加 cacheCreationTokens 入参；
D5 第 648 行 || 短路改直接赋值；各调用点与 WS onUsage 补传 cacheCreation。"
```

---

## Task 9: 全量验证与回归

**Files:** 无（验证任务）

- [ ] **Step 1: 全量测试**

Run: `npm test 2>&1 | tail -15`
Expected: 全部测试 PASS，无失败。

- [ ] **Step 2: 语法检查所有改动文件**

Run: `for f in src/transformer/shared-translator.js src/transformer/responses-translator.js src/db/models/tenant-daily-usage.js src/db/index.js src/services/gateway/tenant-manager.js src/services/shared/responses-ws-server.js src/routes/relay.js src/routes/codebuddy.js src/routes/copilot.js src/services/copilot/runtime.js; do node --check "$f" && echo "OK $f"; done`
Expected: 10 个文件全部 OK。

- [ ] **Step 3: 缺陷覆盖核对**

逐条核对 D1-D7 是否全部有对应改动：

- D1（ws-server 硬编码）→ Task 5 ✅
- D2（recordResponsesUsage 缺参）→ Task 6 ✅
- D3（无 cache_creation 列）→ Task 3 + Task 4 ✅
- D4（copilotStore 签名缺参）→ Task 8 ✅
- D5（copilot || 短路）→ Task 8 ✅
- D6（转换器不映射 cache_creation）→ Task 2 ✅
- D7（openai/anthropic 直通支缺 cacheCreation）→ Task 6 + Task 7 ✅

- [ ] **Step 4: 确认无未提交改动**

Run: `git status --short`
Expected: working tree clean（所有改动已在 Task 1-8 提交）。

---

## Self-Review 记录

**1. Spec 覆盖：** spec 的 D1-D7 七处缺陷与改动文件清单逐项映射到 Task 1-9。Task 1 覆盖提取层扩展，Task 2 覆盖 D6 转换层，Task 3-4 覆盖 D3 落库层，Task 5 覆盖 D1，Task 6 覆盖 D2/D7，Task 7 覆盖 rewriteOpenAIStream 连带，Task 8 覆盖 D4/D5，Task 9 全量回归。无遗漏。

**2. 占位符扫描：** 无 TBD/TODO；所有代码步骤含完整代码块；copilot 调用点虽多但给出了统一处理策略（形态 A/B/C）与具体行号。

**3. 类型一致性：** onUsage 回调签名跨任务统一——ws-server 与三个 WS 闭包（relay/codebuddy/copilot）均为 5 参 `(input, output, cacheHit, cacheCreation, model)`；rewriteOpenAIStream onUsage 为 6 参 `(input, output, cacheHit, cacheCreation, credit, model)`；copilotStore.recordDailyUsage 因保持 model 第 4 位，cacheCreation 放第 5 位 `(input, output, cacheHit, model, cacheCreation)`，与 Task 8 Step 1 一致。
