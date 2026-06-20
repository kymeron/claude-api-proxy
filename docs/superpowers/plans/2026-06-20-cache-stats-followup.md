# 缓存命中率统计遗漏点补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cacheCreation（写缓存成本）与 input_cache_miss（未命中）从"采得到、存得进"变成"读得出、看得见"，统一累计与明细两条统计路径的 cacheCreation 口径，清理死代码技术债。

**Architecture:** 自下而上四层修复——层 1 给 service-profile 累计维度补 cacheCreation 落库；层 2 给 stats.js 5 个聚合查询补 cacheCreation/miss 读取；层 3 给 admin.html 三处缓存展示加列与卡片；层 4 删除死代码 + 硬编码归一。依赖顺序：层 1 → 层 2 → 层 3，层 4 独立可并行。

**Tech Stack:** Node.js ESM（`type: module`），`node:test` + `node:assert/strict`，Sequelize 6（MySQL），内嵌 HTML/JS 前端（echarts），测试命令 `npm test`（`node --test tests/*.test.js`）。

**Spec:** `docs/superpowers/specs/2026-06-20-cache-stats-followup-design.md`

---

## File Structure

| 文件 | 职责 | 改动类型 |
| --- | --- | --- |
| `src/db/models/tenant-service-profile.js` | service-profile 模型 | 修改（加列） |
| `src/db/index.js` | DB 初始化与幂等迁移 | 修改（加 ensure 钩子） |
| `src/services/gateway/tenant-manager.js` | 累计落库 | 修改（incrementTokenUsage/_ensureDelta/_flushDirtyTenants/reset） |
| `src/services/copilot/runtime.js` | copilotStore 落库签名 | 修改（incrementTokenUsage 扩参） |
| `src/routes/relay.js` | relay 路由累计调用 | 修改（incrementTokenUsage 补参 + 硬编码归一） |
| `src/routes/codebuddy.js` | codebuddy 路由累计调用 | 修改（incrementTokenUsage 补参） |
| `src/routes/copilot.js` | copilot 路由累计调用 | 修改（incrementTokenUsage 补参） |
| `src/routes/dashboard-frontend.js` | service-profile 接口 + 聚合 | 修改（补 cacheCreation） |
| `src/routes/stats.js` | 5 聚合查询 | 修改（补 cacheCreation/miss 读取） |
| `src/templates/admin.html` | 前端展示 | 修改（加列与卡片 + CSS） |
| `src/services/relay/tenant-manager.js` | 死代码 | 删除 |
| `src/services/codebuddy/tenant-manager.js` | 死代码 | 删除 |
| `tests/remove-cluster-mode.test.js` | 集群移除断言 | 修改（移除已删文件路径） |
| `tests/service-usage-isolation.test.js` | 落库断言测试 | 修改（适配 cacheCreation 字段） |

---

## Task 1: service-profile 加 total_cache_creation_tokens 列与幂等迁移

**Files:**
- Modify: `src/db/models/tenant-service-profile.js:37-40`
- Modify: `src/db/index.js:35, 40, 122`

- [ ] **Step 1: 在 tenant-service-profile.js 加列定义**

在 `total_cache_hit_tokens`（第 37-40 行）之后插入新列。将第 37-41 行：

```javascript
    total_cache_hit_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_credit: {
```

替换为：

```javascript
    total_cache_hit_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_cache_creation_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_credit: {
```

- [ ] **Step 2: 在 db/index.js initDb 两处加 ensureTenantServiceProfileColumns 调用**

将第 30-41 行的 `initDb` 替换为：

```javascript
export async function initDb() {
    await sequelize.authenticate();
    await ensureTenantCredentialColumns();
    await ensureCopilotCredentialColumns();
    await ensureTenantUpstreamColumns();
    await ensureTenantDailyUsageColumns();
    await ensureTenantServiceProfileColumns();
    await sequelize.sync();
    await ensureTenantCredentialColumns();
    await ensureCopilotCredentialColumns();
    await ensureTenantUpstreamColumns();
    await ensureTenantDailyUsageColumns();
    await ensureTenantServiceProfileColumns();
}
```

- [ ] **Step 3: 在 db/index.js 新增 ensureTenantServiceProfileColumns 函数**

在 `ensureTenantDailyUsageColumns` 函数（第 105-122 行）之后、`export {sequelize}`（第 124 行）之前，新增函数：

```javascript

async function ensureTenantServiceProfileColumns() {
    const queryInterface = sequelize.getQueryInterface();
    const table = 'tenant_service_profiles';
    let columns;
    try {
        columns = await queryInterface.describeTable(table);
    } catch {
        return;
    }

    if (!columns.total_cache_creation_tokens) {
        await queryInterface.addColumn(table, 'total_cache_creation_tokens', {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0
        });
    }
}
```

- [ ] **Step 4: 静态检查模型加载**

Run: `node -e "import('./src/db/models/tenant-service-profile.js').then(m => console.log(Object.keys(m.TenantServiceProfile.rawAttributes).filter(k => k.startsWith('total_cache'))))"`
Expected: 输出 `[ 'total_cache_hit_tokens', 'total_cache_creation_tokens', 'total_credit' ]`

- [ ] **Step 5: 提交**

```bash
git add src/db/models/tenant-service-profile.js src/db/index.js
git commit -m "feat(db): tenant_service_profiles 加 total_cache_creation_tokens 列

新增 ensureTenantServiceProfileColumns 幂等迁移钩子，老库自动补列。"
```

---

## Task 2: gateway 累计落库补 cacheCreation（incrementTokenUsage/_ensureDelta/_flushDirtyTenants/reset）

**Files:**
- Modify: `src/services/gateway/tenant-manager.js:188-196, 256-265, 316-342, 344-379`
- Test: `tests/service-usage-isolation.test.js`

- [ ] **Step 1: 先更新现有 service-usage-isolation 测试断言（改为失败状态）**

`tests/service-usage-isolation.test.js` 第 26-47 行的 `assert.deepEqual(writes, [...])` 当前断言 delta 只含 5 个字段。给两个测试对象的 `values` 各补 `total_cache_creation_tokens: 0`。

将第 28-34 行的 relay values：

```javascript
                values: {
                    total_api_calls: 1,
                    total_input_tokens: 10,
                    total_output_tokens: 20,
                    total_cache_hit_tokens: 3,
                    total_credit: 0
                },
```

替换为：

```javascript
                values: {
                    total_api_calls: 1,
                    total_input_tokens: 10,
                    total_output_tokens: 20,
                    total_cache_hit_tokens: 3,
                    total_cache_creation_tokens: 0,
                    total_credit: 0
                },
```

将第 39-44 行的 copilot values：

```javascript
                values: {
                    total_api_calls: 1,
                    total_input_tokens: 7,
                    total_output_tokens: 8,
                    total_cache_hit_tokens: 1,
                    total_credit: 0
                },
```

替换为：

```javascript
                values: {
                    total_api_calls: 1,
                    total_input_tokens: 7,
                    total_output_tokens: 8,
                    total_cache_hit_tokens: 1,
                    total_cache_creation_tokens: 0,
                    total_credit: 0
                },
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test 2>&1 | grep -A15 "flushes usage deltas"`
Expected: FAIL — `writes[0].values` 缺少 `total_cache_creation_tokens`。

- [ ] **Step 3: 扩展 incrementTokenUsage 签名与 delta 累加**

将 `src/services/gateway/tenant-manager.js` 第 188-196 行的 `incrementTokenUsage` 替换为：

```javascript
    incrementTokenUsage(tenantId, serviceType, inputTokens, outputTokens, cacheHitTokens = 0, cacheCreationTokens = 0) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        const key = this._usageKey(id, serviceType);
        this._dirtyTenants.add(key);
        const delta = this._ensureDelta(id, serviceType);
        delta.input_tokens += inputTokens || 0;
        delta.output_tokens += outputTokens || 0;
        delta.cache_hit_tokens += cacheHitTokens || 0;
        delta.cache_creation_tokens += cacheCreationTokens || 0;
    }
```

- [ ] **Step 4: _ensureDelta delta 初始对象加 cache_creation_tokens**

将第 256-265 行的 `_ensureDelta` 替换为：

```javascript
    _ensureDelta(tenantId, serviceType) {
        const key = this._usageKey(tenantId, serviceType);
        if (!this._deltaTenants.has(key)) {
            this._deltaTenants.set(key, {
                api_calls: 0, input_tokens: 0, output_tokens: 0,
                cache_hit_tokens: 0, cache_creation_tokens: 0, credit: 0
            });
        }
        return this._deltaTenants.get(key);
    }
```

- [ ] **Step 5: _flushDirtyTenants 的 d 对象与跳过条件补 cacheCreation**

将第 344-379 行的 `_flushDirtyTenants` 替换为：

```javascript
    async _flushDirtyTenants() {
        if (this._dirtyTenants.size === 0) return;
        const keys = [...this._dirtyTenants];
        this._dirtyTenants.clear();

        for (const key of keys) {
            const separator = key.lastIndexOf(':');
            const id = Number(key.slice(0, separator));
            const serviceType = key.slice(separator + 1);
            const delta = this._deltaTenants.get(key);
            if (!delta) continue;
            const d = {
                total_api_calls: delta.api_calls || 0,
                total_input_tokens: delta.input_tokens || 0,
                total_output_tokens: delta.output_tokens || 0,
                total_cache_hit_tokens: delta.cache_hit_tokens || 0,
                total_cache_creation_tokens: delta.cache_creation_tokens || 0,
                total_credit: delta.credit || 0
            };
            delta.api_calls = 0;
            delta.input_tokens = 0;
            delta.output_tokens = 0;
            delta.cache_hit_tokens = 0;
            delta.cache_creation_tokens = 0;
            delta.credit = 0;
            if (d.total_api_calls === 0 && d.total_input_tokens === 0 &&
                d.total_output_tokens === 0 && d.total_cache_hit_tokens === 0 &&
                d.total_cache_creation_tokens === 0 && d.total_credit === 0) continue;

            try {
                await TenantServiceProfile.increment(d, {
                    where: {tenant_id: id, service_type: serviceType}
                });
            } catch (error) {
                logger.error(`Failed to flush tenant ${id}/${serviceType}: ${error.message}`);
            }
        }
    }
```

- [ ] **Step 6: reset 分支补 total_cache_creation_tokens: 0**

将第 316-329 行的 `syncStatsFromDb` 替换为：

```javascript
    async syncStatsFromDb(tenantId, reset = false) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        await this._flushDirtyTenants();
        if (reset && Number.isFinite(id)) {
            await TenantServiceProfile.update({
                total_api_calls: 0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                total_cache_hit_tokens: 0,
                total_cache_creation_tokens: 0,
                total_credit: 0
            }, {where: {tenant_id: id}});
        }
        await this._loadFromDb();
    }
```

将第 331-342 行的 `resetServiceStats` 替换为：

```javascript
    async resetServiceStats(tenantId, serviceType) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        await this._flushDirtyTenants();
        await TenantServiceProfile.update({
            total_api_calls: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_hit_tokens: 0,
            total_cache_creation_tokens: 0,
            total_credit: 0
        }, {where: {tenant_id: id, service_type: serviceType}});
        await this._loadFromDb();
    }
```

- [ ] **Step 7: 运行测试验证通过**

Run: `npm test 2>&1 | grep -A2 "flushes usage deltas"`
Expected: PASS。

- [ ] **Step 8: 全量回归并提交**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 PASS。

```bash
git add src/services/gateway/tenant-manager.js tests/service-usage-isolation.test.js
git commit -m "feat(stats): service-profile 累计维度补 cacheCreation 落库

incrementTokenUsage 加第 6 参 cacheCreationTokens，_ensureDelta/_flushDirtyTenants/
reset 同步累计 total_cache_creation_tokens，统一累计与 daily 口径。"
```

---

## Task 3: 累计调用点补传 cacheCreation（relay/codebuddy/copilotStore/copilot）

**Files:**
- Modify: `src/routes/relay.js:599`
- Modify: `src/routes/codebuddy.js:282, 313, 585, 626, 900, 938, 1033, 1316`
- Modify: `src/services/copilot/runtime.js:50-58`
- Modify: `src/routes/copilot.js:18 处 incrementTokenUsage 调用`

层 1 已扩展 gateway.incrementTokenUsage 签名加第 6 参 cacheCreationTokens。现在所有调用点需补传对应 cacheCreationTokens（与同一作用域 recordDailyUsage 的 cacheCreationTokens 同源），让累计维度也累计 cacheCreation。

- [ ] **Step 1: 扩展 copilotStore.incrementTokenUsage 签名**

将 `src/services/copilot/runtime.js` 第 50-59 行替换为：

```javascript
    incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens = 0, cacheCreationTokens = 0) {
        const {tenantId} = currentCopilotContext();
        unifiedTenantManager.incrementTokenUsage(
            tenantId,
            'copilot',
            inputTokens,
            outputTokens,
            cacheHitTokens,
            cacheCreationTokens
        );
    },
```

- [ ] **Step 2: relay.js recordUsage 闭包补传 cacheCreationTokens**

`src/routes/relay.js` 第 596-601 行的 `recordUsage` 已有 `cacheCreationTokens` 第 8 参。将第 599 行：

```javascript
    unifiedTenantManager.incrementTokenUsage(tenantId, 'relay', inputTokens, outputTokens, cacheHitTokens);
```

替换为：

```javascript
    unifiedTenantManager.incrementTokenUsage(tenantId, 'relay', inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens);
```

（relay 仅此 1 处 incrementTokenUsage 调用，在 recordUsage 闭包内，cacheCreationTokens 已是该闭包的形参。）

- [ ] **Step 3: codebuddy.js 8 处 incrementTokenUsage 调用补传 cacheCreationTokens**

codebuddy.js 共 8 处 `unifiedTenantManager.incrementTokenUsage(...)` 调用，均紧邻同作用域的 `recordDailyUsage(...)` 调用，后者已传 `cacheCreationTokens`（流式分支用 `cacheCreationTokens` 变量，非流式用 `cacheCreationTokens` 常量，WS onUsage 用 `cacheCreationTokens` 形参）。

对每处 `incrementTokenUsage(...)` 调用，在末尾 `cacheHitTokens` 后补 `, cacheCreationTokens`。8 处行号：282-288、313、585-588、626、900-903、938、1033、1316。

示例（第 282-288 行流式回调，已有多行参数格式）：

```javascript
                    unifiedTenantManager.incrementTokenUsage(
                        authResult.tenantId,
                        'codebuddy',
                        inputTokens,
                        outputTokens,
                        cacheHitTokens,
                        cacheCreationTokens
                    );
```

示例（第 1316 行 WS onUsage 闭包，单行格式）：

```javascript
            unifiedTenantManager.incrementTokenUsage(tenantId, 'codebuddy', inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens);
```

其余 6 处（313/585-588/626/900-903/938/1033）按相同规则补 `, cacheCreationTokens`，格式跟随各自现有风格（多行或单行）。

- [ ] **Step 4: copilot.js 18 处 copilotStore.incrementTokenUsage 调用补传**

copilot.js 共 18 处 `copilotStore.incrementTokenUsage(...)` 调用，分两形态：
- **有 usage 形态**（流式 `streamCacheCreationTokens` + 非流式 `cacheCreationTokens`，共约 11 处）：在 `cacheHitTokens` 后补 `, streamCacheCreationTokens` 或 `, cacheCreationTokens`（与同作用域 recordDailyUsage 第 5 参一致）。
- **估算兜底形态**（`copilotStore.incrementTokenUsage(estimated, 0, 0)`，7 处：292/396/431/559/590/704/738）：无 usage，cacheCreation 恒 0，保持不变。

有 usage 形态的行号（与上一轮 recordDailyUsage 补 cacheCreation 时同源）：287/317/391/427/554/586/699/734/911/936/1040/1058/1114/1255。

逐处将 `copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens)` 改为 `copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens, cacheCreationTokens)`（流式分支用 `streamCacheCreationTokens`）。变量名与同作用域 recordDailyUsage 调用的第 5 参一致。

- [ ] **Step 5: 语法检查**

Run: `node --check src/services/copilot/runtime.js && node --check src/routes/relay.js && node --check src/routes/codebuddy.js && node --check src/routes/copilot.js`
Expected: 无输出（四个文件语法正确）。

- [ ] **Step 6: 全量回归并提交**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 PASS。

```bash
git add src/services/copilot/runtime.js src/routes/relay.js src/routes/codebuddy.js src/routes/copilot.js
git commit -m "feat(collect): 累计调用点补传 cacheCreationTokens 到 incrementTokenUsage

relay(1)/codebuddy(8)/copilotStore+copilot(18有usage) 调用点补传，
让 service-profile 累计维度同步累计 cacheCreation，与 daily 口径一致。"
```

---

## Task 4: dashboard-frontend 接口与聚合补 cacheCreation

**Files:**
- Modify: `src/routes/dashboard-frontend.js:56-64, 95-137, 410-421`

- [ ] **Step 1: tenantView serviceProfiles 映射补字段**

将 `src/routes/dashboard-frontend.js` 第 56-64 行替换为：

```javascript
        serviceProfiles: (tenant.serviceProfiles || []).map(profile => ({
            service_type: profile.service_type,
            enabled: profile.enabled,
            total_api_calls: profile.total_api_calls || 0,
            total_input_tokens: profile.total_input_tokens || 0,
            total_output_tokens: profile.total_output_tokens || 0,
            total_cache_hit_tokens: profile.total_cache_hit_tokens || 0,
            total_cache_creation_tokens: profile.total_cache_creation_tokens || 0,
            total_credit: profile.total_credit || 0
        }))
```

- [ ] **Step 2: aggregateUsageRows 补 cacheCreationTokens 聚合**

将第 95-137 行的 `aggregateUsageRows` 替换为：

```javascript
function aggregateUsageRows(rows) {
    const totals = {apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheCreationTokens: 0, credit: 0};
    const monthly = new Map();
    const daily = new Map();
    const modelsByName = new Map();

    for (const row of rows) {
        const apiCalls = Number(row.api_calls || 0);
        const inputTokens = Number(row.input_tokens || 0);
        const outputTokens = Number(row.output_tokens || 0);
        const cacheHitTokens = Number(row.input_cache_hit || 0);
        const cacheCreationTokens = Number(row.input_cache_creation || 0);
        const credit = Number(row.credit || 0);
        totals.apiCalls += apiCalls;
        totals.inputTokens += inputTokens;
        totals.outputTokens += outputTokens;
        totals.cacheHitTokens += cacheHitTokens;
        totals.cacheCreationTokens += cacheCreationTokens;
        totals.credit += credit;

        const month = String(row.date || '').slice(0, 7);
        const day = row.date;
        const model = row.model || 'unknown';
        for (const [key, map] of [[month, monthly], [day, daily], [model, modelsByName]]) {
            if (!key) continue;
            const item = map.get(key) || {key, apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheCreationTokens: 0, credit: 0};
            item.apiCalls += apiCalls;
            item.inputTokens += inputTokens;
            item.outputTokens += outputTokens;
            item.cacheHitTokens += cacheHitTokens;
            item.cacheCreationTokens += cacheCreationTokens;
            item.credit += credit;
            map.set(key, item);
        }
    }

    const withRate = item => ({
        ...item,
        cacheHitRate: item.inputTokens > 0 ? Math.round((item.cacheHitTokens / item.inputTokens) * 1000) / 10 : 0
    });
    return {
        totals: withRate({...totals, totalTokens: totals.inputTokens + totals.outputTokens}),
        monthlyTrend: [...monthly.values()].sort((a, b) => a.key.localeCompare(b.key)).map(item => withRate({month: item.key, ...item})),
        dailyTrend: [...daily.values()].sort((a, b) => a.key.localeCompare(b.key)).map(item => withRate({date: item.key, ...item})),
        modelStats: [...modelsByName.values()].sort((a, b) => b.inputTokens - a.inputTokens).map(item => withRate({model: item.key, ...item}))
    };
}
```

- [ ] **Step 3: /service-profile GET 返回补字段**

将第 410-421 行替换为：

```javascript
            return sendJson(res, 200, {
                service: serviceType,
                profile: profile ? {
                    service_type: profile.service_type,
                    enabled: profile.enabled,
                    total_api_calls: profile.total_api_calls || 0,
                    total_input_tokens: profile.total_input_tokens || 0,
                    total_output_tokens: profile.total_output_tokens || 0,
                    total_cache_hit_tokens: profile.total_cache_hit_tokens || 0,
                    total_cache_creation_tokens: profile.total_cache_creation_tokens || 0,
                    total_credit: profile.total_credit || 0
                } : null
            });
```

- [ ] **Step 4: 语法检查与全量回归**

Run: `node --check src/routes/dashboard-frontend.js && npm test 2>&1 | tail -5`
Expected: 语法正确，全部测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/routes/dashboard-frontend.js
git commit -m "feat(dashboard): service-profile 接口与 aggregateUsageRows 补 cacheCreation

/service-profile 返回 total_cache_creation_tokens，aggregateUsageRows 聚合
input_cache_creation 到 totals/daily/monthly/model。"
```

---

## Task 5: stats.js 5 聚合函数 + getUserDetail 补 cacheCreation/miss 读取

**Files:**
- Modify: `src/routes/stats.js:183-211, 247-283, 300-328, 340-372, 459-597, 884-929`

- [ ] **Step 1: getMonthlyStats 补两列**

将第 183-211 行的 `getMonthlyStats` 替换为：

```javascript
async function getMonthlyStats(serviceType = 'codebuddy', tenantId, startDate, endDate) {
    const monthlyStats = {};
    const service = normalizeStatsService(serviceType);

    if (!unifiedTenantManager.isEnabled()) {
        return monthlyStats;
    }

    try {
        const rows = await TenantDailyUsage.findAll({
            attributes: [
                [fn('SUBSTRING', col('date'), 1, 7), 'month'],
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_creation')), 'cacheCreationTokens'],
                [fn('SUM', col('input_cache_miss')), 'inputMissTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where: await buildStatsUsageWhere(service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {}),
            group: [fn('SUBSTRING', col('date'), 1, 7)],
            raw: true
        });

        for (const row of rows) {
            monthlyStats[row.month] = {
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens: parseInt(row.inputTokens) || 0,
                outputTokens: parseInt(row.outputTokens) || 0,
                cacheHitTokens: parseInt(row.cacheHitTokens) || 0,
                cacheCreationTokens: parseInt(row.cacheCreationTokens) || 0,
                inputMissTokens: parseInt(row.inputMissTokens) || 0,
                credit: parseFloat(row.credit) || 0
            };
        }
    } catch (error) {
        logger.error('读取月度统计数据失败:', error.message);
    }

    return monthlyStats;
}
```

- [ ] **Step 2: getModelCacheStats 补两列，inputMissTokens 改读 DB**

将第 247-283 行的 `getModelCacheStats` 替换为：

```javascript
async function getModelCacheStats(serviceType = 'codebuddy', startDate, endDate, tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const where = await buildStatsUsageWhere(service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {});

        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'model',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_creation')), 'cacheCreationTokens'],
                [fn('SUM', col('input_cache_miss')), 'inputMissTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where,
            group: ['model'],
            order: [[fn('SUM', col('input_tokens')), 'DESC']],
            raw: true
        });

        return rows.map((row) => {
            const inputTokens = parseInt(row.inputTokens) || 0;
            const cacheHitTokens = parseInt(row.cacheHitTokens) || 0;
            const outputTokens = parseInt(row.outputTokens) || 0;
            return {
                model: row.model || 'unknown',
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens,
                inputHitTokens: cacheHitTokens,
                inputMissTokens: parseInt(row.inputMissTokens) || 0,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                cacheHitTokens,
                cacheCreationTokens: parseInt(row.cacheCreationTokens) || 0,
                cacheHitRate: inputTokens > 0 ? Math.round((cacheHitTokens / inputTokens) * 100) : 0,
                credit: parseFloat(row.credit) || 0
            };
        });
    } catch (error) {
        logger.error('读取模型缓存统计数据失败:', error.message);
        return [];
    }
}
```

- [ ] **Step 3: getModelCacheDailyTrend 补 cacheCreationTokens**

将第 291-328 行的 `getModelCacheDailyTrend` 替换为：

```javascript
async function getModelCacheDailyTrend(serviceType = 'codebuddy', model, startDate, endDate, tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const where = await buildStatsUsageWhere(service, startDate, endDate, {model, ...(tenantId ? {tenant_id: tenantId} : {})});

        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'date',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_creation')), 'cacheCreationTokens']
            ],
            where,
            group: ['date'],
            order: [['date', 'ASC']],
            raw: true
        });

        return rows.map((row) => {
            const inputTokens = parseInt(row.inputTokens) || 0;
            const cacheHitTokens = parseInt(row.cacheHitTokens) || 0;
            return {
                date: row.date,
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens,
                cacheHitTokens,
                cacheCreationTokens: parseInt(row.cacheCreationTokens) || 0,
                cacheHitRate: inputTokens > 0 ? Math.round((cacheHitTokens / inputTokens) * 100) : 0
            };
        });
    } catch (error) {
        logger.error('读取模型每日缓存趋势失败:', error.message);
        return [];
    }
}
```

- [ ] **Step 4: getDailyTrendData 补 cacheCreationTokens**

将第 333-372 行的 `getDailyTrendData` 替换为：

```javascript
async function getDailyTrendData(serviceType = 'codebuddy', tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'date',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_creation')), 'cacheCreationTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where: await buildStatsUsageWhere(service, undefined, undefined, tenantId ? {tenant_id: tenantId} : {}),
            group: ['date'],
            order: [['date', 'ASC']],
            raw: true
        });

        return rows.map((row) => ({
            date: row.date,
            apiCalls: parseInt(row.apiCalls) || 0,
            inputTokens: parseInt(row.inputTokens) || 0,
            outputTokens: parseInt(row.outputTokens) || 0,
            totalTokens: (parseInt(row.inputTokens) || 0) + (parseInt(row.outputTokens) || 0),
            cacheHitTokens: parseInt(row.cacheHitTokens) || 0,
            cacheCreationTokens: parseInt(row.cacheCreationTokens) || 0,
            cacheHitRate:
                parseInt(row.inputTokens) > 0
                    ? Math.round((parseInt(row.cacheHitTokens) / parseInt(row.inputTokens)) * 100)
                    : 0,
            credit: parseFloat(row.credit) || 0
        }));
    } catch (error) {
        logger.error('读取每日趋势数据失败:', error.message);
        return [];
    }
}
```

- [ ] **Step 5: getOverviewStats usageMap 补字段 + users inputMissTokens 改读 DB + 返回 total**

将第 456-597 行（usageMap 块到 return）替换。先把 usageMap 块（第 456-483 行）替换为：

```javascript
    // 从 TenantDailyUsage 聚合每个租户的历史总量（不受重置影响）
    const usageMap = {};
    try {
        const usageRows = await TenantDailyUsage.findAll({
            attributes: [
                'tenant_id',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_creation')), 'cacheCreationTokens'],
                [fn('SUM', col('input_cache_miss')), 'inputMissTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where: usageWhere,
            group: ['tenant_id'],
            raw: true
        });
        for (const row of usageRows) {
            usageMap[row.tenant_id] = {
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens: parseInt(row.inputTokens) || 0,
                outputTokens: parseInt(row.outputTokens) || 0,
                cacheHitTokens: parseInt(row.cacheHitTokens) || 0,
                cacheCreationTokens: parseInt(row.cacheCreationTokens) || 0,
                inputMissTokens: parseInt(row.inputMissTokens) || 0,
                credit: parseFloat(row.credit) || 0
            };
        }
    } catch (error) {
        logger.error('从每日用量聚合租户统计失败:', error.message);
    }
```

然后把累加变量区（第 501-508 行）替换为：

```javascript
    let totalApiCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheHitTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCredit = 0;
    let activeUsers = 0;
    let cacheHitRateUsers = 0;
    let cacheHitRateTotal = 0;
```

把 users.map 内的累加与返回对象（第 510-558 行）替换为：

```javascript
    const users = tenants.map(([tenantId, tenant]) => {
        const usage = usageMap[tenant.id] || {
            apiCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitTokens: 0,
            cacheCreationTokens: 0,
            inputMissTokens: 0,
            credit: 0
        };
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const credCount = tenant.credential_count || 0;

        // 注册时间（从时间戳转换）
        const createdAt = tenant.created_at ? toLocalDate(tenant.created_at) : 'N/A';

        // 最后活跃时间（从数据库查询）
        const lastActiveDate = lastActiveMap[tenant.id] || 'N/A';

        totalApiCalls += usage.apiCalls;
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        totalCacheHitTokens += usage.cacheHitTokens;
        totalCacheCreationTokens += usage.cacheCreationTokens;
        totalCredit += usage.credit;
        if (usage.apiCalls > 0) activeUsers++;
        if (usage.inputTokens > 0 && usage.cacheHitTokens > 0) {
            cacheHitRateUsers++;
            cacheHitRateTotal += Math.round((usage.cacheHitTokens / usage.inputTokens) * 100);
        }
        if (credCount > 0) tenantsWithCreds++;
        totalCreds += credCount;

        return {
            tenantId,
            name: tenant.name || '未命名',
            username: tenant.username || 'N/A',
            apiCalls: usage.apiCalls,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            inputHitTokens: usage.cacheHitTokens,
            inputMissTokens: usage.inputMissTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            totalTokens,
            cacheHitTokens: usage.cacheHitTokens,
            cacheHitRate: usage.inputTokens > 0 ? Math.round((usage.cacheHitTokens / usage.inputTokens) * 100) : 0,
            credit: usage.credit,
            credCount,
            createdAt,
            lastActiveDate,
            status: usage.apiCalls > 0 ? 'active' : 'inactive'
        };
    });
```

注意：`usage` 默认对象补 `cacheCreationTokens`/`inputMissTokens` 必需，否则 usageMap 未命中时累加得 NaN。

把 allUsers 映射（第 579-594 行）替换为：

```javascript
        allUsers: users.map((u) => ({
            name: u.name,
            username: u.username,
            apiCalls: u.apiCalls,
            inputTokens: u.inputTokens,
            inputHitTokens: u.inputHitTokens,
            inputMissTokens: u.inputMissTokens,
            cacheCreationTokens: u.cacheCreationTokens,
            outputTokens: u.outputTokens,
            totalTokens: u.totalTokens,
            cacheHitTokens: u.cacheHitTokens,
            cacheHitRate: u.cacheHitRate,
            credit: u.credit,
            createdAt: u.createdAt,
            lastActiveDate: u.lastActiveDate,
            status: u.status
        })),
```

把 return 顶层（第 565-596 行的 return 对象）的 `totalCacheHitTokens,` 行后加 `totalCacheCreationTokens,`：

```javascript
        totalCacheHitTokens,
        totalCacheCreationTokens,
        cacheHitRate: cacheHitRateUsers > 0 ? Math.round(cacheHitRateTotal / cacheHitRateUsers) : 0,
```

- [ ] **Step 6: handleApiRequest overview 响应补 totalCacheCreationTokens**

将第 621-650 行的 overview sendJson 对象，在 `totalCacheHitTokens: stats.totalCacheHitTokens,` 后加一行 `totalCacheCreationTokens: stats.totalCacheCreationTokens,`。同时给 topUsers.map（第 633-645 行）每个对象补 `cacheCreationTokens: u.cacheCreationTokens,`。

- [ ] **Step 7: getUserDetail dailyData 补 cache_creation_tokens / cache_miss_tokens**

将第 899-916 行的 dailyData 初始化与累加替换为：

```javascript
            if (!dailyData[month][day]) {
                dailyData[month][day] = {
                    api_calls: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_hit_tokens: 0,
                    cache_creation_tokens: 0,
                    cache_miss_tokens: 0,
                    credit: 0
                };
            }
            dailyData[month][day].api_calls += row.api_calls || 0;
            dailyData[month][day].input_tokens += row.input_tokens || 0;
            dailyData[month][day].output_tokens += row.output_tokens || 0;
            dailyData[month][day].cache_hit_tokens += row.input_cache_hit || 0;
            dailyData[month][day].cache_creation_tokens += row.input_cache_creation || 0;
            dailyData[month][day].cache_miss_tokens += row.input_cache_miss || 0;
            dailyData[month][day].credit += row.credit || 0;
```

- [ ] **Step 8: 语法检查与全量回归**

Run: `node --check src/routes/stats.js && npm test 2>&1 | tail -5`
Expected: 语法正确，全部测试 PASS。

- [ ] **Step 9: 提交**

```bash
git add src/routes/stats.js
git commit -m "feat(stats): 5 聚合函数 + getUserDetail 补 cacheCreation/miss 读取

SELECT 补 SUM(input_cache_creation)/SUM(input_cache_miss)，返回对象带
cacheCreationTokens，inputMissTokens 改读 DB 列替代现算。"
```

---

## Task 6: admin.html 三处缓存展示加列与卡片 + CSS

**Files:**
- Modify: `src/templates/admin.html:285-287, 716, 721-727, 729, 750-761, 847`

- [ ] **Step 1: CSS 补 stats-grid-7**

将第 287 行：

```css
        .stats-grid-6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
```

替换为：

```css
        .stats-grid-6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
        .stats-grid-7 { grid-template-columns: repeat(7, minmax(0, 1fr)); }
```

- [ ] **Step 2: 租户累计卡片 customMetricCards 加 cacheCreation 卡片项**

将第 716 行的 `customMetricCards` 定义中 `stats-grid-${type==='codebuddy'?'6':'5'}` 改为 `stats-grid-${type==='codebuddy'?'7':'6'}`，并在"缓存命中率"卡片后插入"写缓存 Tokens"卡片。

将该行中：

```javascript
<div class="stat-item"><div class="stat-value" id="${type}CustomCacheRate">${pct(p.total_cache_hit_tokens,p.total_input_tokens)}%</div><div class="stat-label">缓存命中率</div></div>${type==='codebuddy'?`<div class="stat-item"><div class="stat-value" id="${type}CustomCredit">
```

替换为：

```javascript
<div class="stat-item"><div class="stat-value" id="${type}CustomCacheRate">${pct(p.total_cache_hit_tokens,p.total_input_tokens)}%</div><div class="stat-label">缓存命中率</div></div><div class="stat-item"><div class="stat-value" id="${type}CustomCacheCreation">${fmt(p.total_cache_creation_tokens)}</div><div class="stat-label">写缓存 Tokens</div></div>${type==='codebuddy'?`<div class="stat-item"><div class="stat-value" id="${type}CustomCredit">
```

- [ ] **Step 3: updateCustomStatsCard 补 set cacheCreation**

将第 750-761 行的 `updateCustomStatsCard` 替换为：

```javascript
function updateCustomStatsCard(type, serviceProfile){
    if(!serviceProfile)return;
    const current=profile(S.tenant,type);
    Object.assign(current,serviceProfile);
    const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
    set(type+'CustomApiCalls',fmt(serviceProfile.total_api_calls));
    set(type+'CustomInputTokens',fmt(serviceProfile.total_input_tokens));
    set(type+'CustomOutputTokens',fmt(serviceProfile.total_output_tokens));
    set(type+'CustomCacheTokens',fmt(serviceProfile.total_cache_hit_tokens));
    set(type+'CustomCacheRate',pct(serviceProfile.total_cache_hit_tokens,serviceProfile.total_input_tokens)+'%');
    set(type+'CustomCacheCreation',fmt(serviceProfile.total_cache_creation_tokens));
    set(type+'CustomCredit',Number(serviceProfile.total_credit||0).toFixed(2));
}
```

- [ ] **Step 4: aggregateDaily 补 input_cache_creation 累加**

将第 719-724 行的 `aggregateDaily` 替换为：

```javascript
function aggregateDaily(rows){
    const map=new Map();
    rows.forEach(r=>{const d=r.date;const cur=map.get(d)||{date:d,api_calls:0,input_tokens:0,output_tokens:0,input_cache_hit:0,input_cache_creation:0,credit:0};
        cur.api_calls+=Number(r.api_calls||0);cur.input_tokens+=Number(r.input_tokens||0);cur.output_tokens+=Number(r.output_tokens||0);cur.input_cache_hit+=Number(r.input_cache_hit||0);cur.input_cache_creation+=Number(r.input_cache_creation||0);cur.credit+=Number(r.credit||0);map.set(d,cur);
    });
    return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
```

- [ ] **Step 5: renderStatsBlock 补写缓存成本列 + grid 列数 + colspan**

将第 726-733 行的 `renderStatsBlock` 替换为：

```javascript
function renderStatsBlock(el,type,month,rows){
    const days=aggregateDaily(rows);const totals=days.reduce((t,d)=>({api_calls:t.api_calls+d.api_calls,input_tokens:t.input_tokens+d.input_tokens,output_tokens:t.output_tokens+d.output_tokens,input_cache_hit:t.input_cache_hit+d.input_cache_hit,input_cache_creation:t.input_cache_creation+d.input_cache_creation,credit:t.credit+d.credit}),{api_calls:0,input_tokens:0,output_tokens:0,input_cache_hit:0,input_cache_creation:0,credit:0});
    const chartId=`${type}ApiCallsChart`;const tokensId=`${type}TokensChart`;const creditId=`${type}CreditChart`;
    el.className='';el.innerHTML=`<div class="stats-grid stats-grid-${type==='codebuddy'?'7':'6'}"><div class="stat-item"><div class="stat-value" title="${totals.api_calls}">${fmt(totals.api_calls)}</div><div class="stat-label">API 调用次数</div></div><div class="stat-item"><div class="stat-value" title="${totals.input_tokens}">${fmt(totals.input_tokens)}</div><div class="stat-label">输入 Tokens</div></div><div class="stat-item"><div class="stat-value" title="${totals.output_tokens}">${fmt(totals.output_tokens)}</div><div class="stat-label">输出 Tokens</div></div><div class="stat-item"><div class="stat-value" title="${totals.input_cache_hit}">${fmt(totals.input_cache_hit)}</div><div class="stat-label">缓存命中 Tokens</div></div><div class="stat-item"><div class="stat-value">${pct(totals.input_cache_hit,totals.input_tokens)}%</div><div class="stat-label">缓存命中率</div></div><div class="stat-item"><div class="stat-value" title="${totals.input_cache_creation}">${fmt(totals.input_cache_creation)}</div><div class="stat-label">写缓存 Tokens</div></div>${type==='codebuddy'?`<div class="stat-item"><div class="stat-value">${totals.credit.toFixed(2)}</div><div class="stat-label">CodeBuddy 积分</div></div>`:''}</div><div id="${chartId}" class="chart"></div><div id="${tokensId}" class="chart"></div>${type==='codebuddy'?`<div id="${creditId}" class="mini-chart"></div>`:''}<div class="table-wrap"><table class="stats-table"><thead><tr><th>日期</th><th>模型</th><th>API 调用次数</th><th>输入 Tokens</th><th>输出 Tokens</th><th>缓存命中 Tokens</th><th>缓存命中率</th><th>写缓存 Tokens</th>${type==='codebuddy'?'<th>CodeBuddy 积分</th>':''}</tr></thead><tbody>${rows.length?rows.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.model)}</td><td>${fmt(r.api_calls)}</td><td>${fmt(r.input_tokens)}</td><td>${fmt(r.output_tokens)}</td><td>${fmt(r.input_cache_hit)}</td><td>${pct(r.input_cache_hit,r.input_tokens)}%</td><td>${fmt(r.input_cache_creation)}</td>${type==='codebuddy'?`<td>${Number(r.credit||0).toFixed(2)}</td>`:''}</tr>`).join(''):`<tr><td colspan="${type==='codebuddy'?9:8}" class="muted">本月暂无调用记录</td></tr>`}</tbody></table></div>`;
    renderApiCallsChart(chartId,`${month} API 请求次数`,days);
    renderTokensChart(tokensId,`${month} Tokens 使用量`,days);
    if(type==='codebuddy')renderCreditChart(creditId,`${month} CodeBuddy 积分`,days);
}
```

- [ ] **Step 6: renderAdminStatsModelCache 模型缓存表加写缓存成本列**

将第 847 行 `renderAdminStatsModelCache` 中表头 `<th>缓存命中率</th><th>积分</th><th>操作</th>` 改为 `<th>缓存命中率</th><th>写缓存成本</th><th>积分</th><th>操作</th>`；行数据在 `${m.cacheHitRate||0}%</td>` 后、`<td>${Number(m.credit||0).toFixed(2)}</td>` 前加 `<td>${fmt(m.cacheCreationTokens)}</td>`；空态 colspan 从 9 改 10。

即把：

```javascript
<th>缓存命中率</th><th>积分</th><th>操作</th></tr></thead><tbody>${pageRows.length?pageRows.map(m=>`<tr><td>${esc(m.model)}</td><td>${fmt(m.apiCalls)}</td><td>${fmt(m.inputHitTokens||m.cacheHitTokens)}</td><td>${fmt(m.inputMissTokens)}</td><td>${fmt(m.outputTokens)}</td><td>${fmt(m.totalTokens)}</td><td>${m.cacheHitRate||0}%</td><td>${Number(m.credit||0).toFixed(2)}</td><td><button class="btn btn-sm" onclick="openAdminModelCacheDaily(${jsArg(m.model)})">趋势</button></td></tr>`).join(''):'<tr><td colspan="9" class="muted">暂无模型统计</td></tr>'}
```

替换为：

```javascript
<th>缓存命中率</th><th>写缓存成本</th><th>积分</th><th>操作</th></tr></thead><tbody>${pageRows.length?pageRows.map(m=>`<tr><td>${esc(m.model)}</td><td>${fmt(m.apiCalls)}</td><td>${fmt(m.inputHitTokens||m.cacheHitTokens)}</td><td>${fmt(m.inputMissTokens)}</td><td>${fmt(m.outputTokens)}</td><td>${fmt(m.totalTokens)}</td><td>${m.cacheHitRate||0}%</td><td>${fmt(m.cacheCreationTokens)}</td><td>${Number(m.credit||0).toFixed(2)}</td><td><button class="btn btn-sm" onclick="openAdminModelCacheDaily(${jsArg(m.model)})">趋势</button></td></tr>`).join(''):'<tr><td colspan="10" class="muted">暂无模型统计</td></tr>'}
```

- [ ] **Step 7: 全量回归**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 PASS（admin.html 无单测，靠语法正确性 + 后端测试不回归）。

- [ ] **Step 8: 提交**

```bash
git add src/templates/admin.html
git commit -m "feat(ui): admin.html 三处缓存展示加写缓存成本列与卡片

模型缓存表加写缓存成本列、按日明细表加写缓存 Tokens 列、租户累计卡片加
写缓存 Tokens 卡片项，CSS 补 stats-grid-7，colspan 同步。"
```

---

## Task 7: 清理死代码 + 硬编码归一

**Files:**
- Delete: `src/services/relay/tenant-manager.js`
- Delete: `src/services/codebuddy/tenant-manager.js`
- Modify: `src/routes/relay.js:682, 1579`
- Modify: `tests/remove-cluster-mode.test.js:17-27`

- [ ] **Step 1: 全仓确认死代码零引用**

Run: `grep -rn "services/relay/tenant-manager\|services/codebuddy/tenant-manager" src/ tests/ scripts/`
Expected: 仅 `tests/remove-cluster-mode.test.js` 命中（无任何 import）。若有其它命中，停止并复核。

- [ ] **Step 2: 删除两个死代码文件**

```bash
rm src/services/relay/tenant-manager.js src/services/codebuddy/tenant-manager.js
```

- [ ] **Step 3: remove-cluster-mode.test.js 移除已删文件路径**

将 `tests/remove-cluster-mode.test.js` 第 17-27 行的 files 数组替换为（移除两行）：

```javascript
    const files = [
        'src/server.js',
        'src/routes/dashboard-frontend.js',
        'src/routes/dashboard-codebuddy.js',
        'scripts/deploy.mjs',
        '.env.example',
        'README.md',
        '本地安装部署.md'
    ];
```

- [ ] **Step 4: relay.js 第 682 行硬编码归一**

`extractCacheCreationTokens` 已在 relay.js 第 37 行 import。将第 682 行：

```javascript
                    finalUsage?.prompt_tokens_details?.cache_creation_tokens || 0
```

替换为：

```javascript
                    extractCacheCreationTokens(finalUsage)
```

- [ ] **Step 5: relay.js 第 1579 行硬编码归一**

将第 1579 行：

```javascript
                    finalUsage?.prompt_tokens_details?.cache_creation_tokens || 0
```

替换为：

```javascript
                    extractCacheCreationTokens(finalUsage)
```

- [ ] **Step 6: 语法检查与全量回归**

Run: `node --check src/routes/relay.js && npm test 2>&1 | tail -5`
Expected: 语法正确，全部测试 PASS（含 remove-cluster-mode.test.js）。

- [ ] **Step 7: 提交**

```bash
git add src/services/relay/tenant-manager.js src/services/codebuddy/tenant-manager.js src/routes/relay.js tests/remove-cluster-mode.test.js
git commit -m "chore: 删除 relay/codebuddy 死代码 tenant-manager，硬编码归一

删除未被 import 的本地 tenant-manager（同步从 remove-cluster-mode.test.js
移除路径避免 readFileSync 抛 ENOENT）；relay.js:682/1579 两处硬编码改用
extractCacheCreationTokens 统一提取。"
```

---

## Task 8: 全量验证与回归

**Files:** 无（验证任务）

- [ ] **Step 1: 全量测试**

Run: `npm test 2>&1 | tail -15`
Expected: 全部测试 PASS，无失败。

- [ ] **Step 2: 语法检查所有改动文件**

Run: `for f in src/db/models/tenant-service-profile.js src/db/index.js src/services/gateway/tenant-manager.js src/services/copilot/runtime.js src/routes/relay.js src/routes/codebuddy.js src/routes/copilot.js src/routes/dashboard-frontend.js src/routes/stats.js; do node --check "$f" && echo "OK $f"; done`
Expected: 9 个文件全部 OK。

- [ ] **Step 3: 死代码删除确认**

Run: `test ! -f src/services/relay/tenant-manager.js && test ! -f src/services/codebuddy/tenant-manager.js && echo "已删除"`
Expected: 输出 `已删除`。

- [ ] **Step 4: 确认无未提交改动**

Run: `git status --short`
Expected: working tree clean（所有改动已在 Task 1-7 提交）。

---

## Self-Review 记录

**1. Spec 覆盖：** spec 四层逐项映射到 Task 1-8。Task 1-3 覆盖层 1（模型+迁移+累计落库+27 调用点），Task 4 覆盖层 1 的接口暴露（dashboard-frontend），Task 5 覆盖层 2（stats.js 5 聚合+getUserDetail），Task 6 覆盖层 3（admin.html 三处展示+CSS），Task 7 覆盖层 4（死代码+硬编码+remove-cluster-mode.test.js），Task 8 全量回归。input_cache_miss 列接入读取（层 2/3 中 inputMissTokens 改读 DB）已并入 Task 5/6。无遗漏。

**2. 占位符扫描：** 无 TBD/TODO；所有代码步骤含完整代码块；codebuddy/copilot 多处调用点给出了行号与统一补参规则（变量名与同作用域 recordDailyUsage 第 5 参一致）。

**3. 类型一致性：** incrementTokenUsage 第 6 参 cacheCreationTokens（gateway）/第 4 参（copilotStore，保持与 recordDailyUsage 同序 input,output,cacheHit,model,cacheCreation 的前 4 位）；_ensureDelta delta.cache_creation_tokens 与 _flushDirtyTenants d.total_cache_creation_tokens 字段名一致；aggregateUsageRows cacheCreationTokens 与 stats.js 返回对象 cacheCreationTokens 一致；admin.html 用 r.input_cache_creation（raw row 列名）与 m.cacheCreationTokens（stats 返回字段名）分别对应数据源，无混淆。
