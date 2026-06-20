# 缓存命中率统计遗漏点补齐 设计

## 背景与目标

上一轮"16 通路缓存命中率统计全量补齐"（spec：`2026-06-19-cache-hit-stats-design.md`）完成了采集层 D1-D7 修复，cacheCreation 能正确落库 `tenant_daily_usage.input_cache_creation` 列。但审计发现仍有 5 个遗漏点：cacheCreation 落库后**无任何读取方消费**、service-profile 累计维度**口径不一致**、`input_cache_miss` 列**写进却没人读**、两个本地 tenant-manager 死代码**口径漂移**、两处硬编码**未走统一提取函数**。

目标：让 cacheCreation 与 input_cache_miss 从"采得到、存得进"变成"读得出、看得见"，并统一累计与明细两条统计路径的 cacheCreation 口径，清理已知技术债。

## 修复范围

四层修复，按数据流自下而上，层 1→2→3 有序依赖，层 4 独立：

| 层 | 职责 | 性质 |
| --- | --- | --- |
| 层 1 | service-profile 累计维度补 cacheCreation（落库） | 结构补齐 |
| 层 2 | stats.js 聚合查询补 cacheCreation + miss 读取（数据出口） | 结构补齐 |
| 层 3 | admin.html 前端展示写缓存成本（加列与卡片） | 展示补齐 |
| 层 4 | 清理死代码 + 硬编码归一 | 技术债 |

## 统一口径

- 写缓存成本 cacheCreation：累计维度落 `tenant_service_profiles.total_cache_creation_tokens`，明细维度读 `tenant_daily_usage.input_cache_creation`，stats 聚合 `SUM(input_cache_creation)`。
- 未命中 miss：`input_cache_miss = max(0, input - cacheHit)`，由 `recordDailyUsage` 落库（已实现），stats.js 改为**直接读 DB 列**而非现算，让该列成为唯一数据源。
- 命中率口径不变：`cacheHitRate = cacheHit / inputTokens`。

---

## 层 1：service-profile 累计维度补 cacheCreation

### 模型 — `src/db/models/tenant-service-profile.js`

在 `total_cache_hit_tokens`（第 37 行）之后新增列：

```javascript
total_cache_creation_tokens: {
    type: DataTypes.INTEGER,
    defaultValue: 0
},
```

### DB 迁移 — `src/db/index.js`

新增 `ensureTenantServiceProfileColumns` 幂等钩子，仿现有 `ensureTenantDailyUsageColumns` 模式：`describeTable('tenant_service_profiles')` 检查 `total_cache_creation_tokens`，缺失则 `addColumn`。在 `initDb` 两处调用序列（sync 前 + sync 后）各加一次，与现有 ensure 钩子一致。

### 累计落库 — `src/services/gateway/tenant-manager.js`

- `incrementTokenUsage`（第 188 行）签名加第 6 参 `cacheCreationTokens = 0`，delta 累加 `delta.cache_creation_tokens += cacheCreationTokens || 0`。
- `_ensureDelta`（第 256 行）delta 初始对象加 `cache_creation_tokens: 0`。
- `_flushDirtyTenants`（第 344 行）：`d` 对象加 `total_cache_creation_tokens: delta.cache_creation_tokens || 0`；delta 清零加 `delta.cache_creation_tokens = 0`；跳过条件补 `d.total_cache_creation_tokens === 0`。
- `syncStatsFromDb` reset 分支（第 320 行）与 `resetServiceStats`（第 334 行）的 `TenantServiceProfile.update` 补 `total_cache_creation_tokens: 0`。

### 调用点补传 cacheCreation（27 处，与 recordDailyUsage 调用点一一对应）

- relay.js:599（1 处）
- codebuddy.js：282 / 313 / 585 / 626 / 900 / 938 / 1033 / 1316（8 处）
- copilotStore `src/services/copilot/runtime.js:50` 签名加第 4 参 `cacheCreationTokens = 0` 透传（copilot.js 18 处调用点补传；估算兜底分支无 usage 不传走默认 0）

### 接口暴露 — `src/routes/dashboard-frontend.js`

- `/service-profile` GET（第 418 行）返回补 `total_cache_creation_tokens: profile.total_cache_creation_tokens || 0`。
- `aggregateUsageRows`（第 95 行）totals/daily/monthly/model 聚合对象补 `cacheCreationTokens`，从 `row.input_cache_creation` 取值。
- `tenantView`（第 62 行）serviceProfiles 映射补 `total_cache_creation_tokens: profile.total_cache_creation_tokens || 0`。

---

## 层 2：stats.js 聚合查询补 cacheCreation 与 miss 读取

5 个聚合函数的 SELECT 各补两列 `[fn('SUM', col('input_cache_creation')), 'cacheCreationTokens']` 与 `[fn('SUM', col('input_cache_miss')), 'inputMissTokens']`，返回对象带 `cacheCreationTokens`，`inputMissTokens` 改为直接读 DB 列：

- `getMonthlyStats`（第 183 行）
- `getModelCacheStats`（第 247 行）—— 移除第 271 行 `Math.max(0, inputTokens - cacheHitTokens)` 现算
- `getModelCacheDailyTrend`（第 300 行）—— 补 `cacheCreationTokens`
- `getDailyTrendData`（第 340 行）—— 补 `cacheCreationTokens`
- `getOverviewStats`（第 459 行）—— usageMap 补 `cacheCreationTokens`/`inputMissTokens`，users 映射的 `inputMissTokens`（第 548 行）改读 DB 列，返回 total 补 `totalCacheCreationTokens`

`getUserDetail`（第 884 行）dailyData 累加对象补 `cache_creation_tokens` 与 `cache_miss_tokens`，从 raw row 的 `input_cache_creation` / `input_cache_miss` 取值。

---

## 层 3：admin.html 前端展示（加列与卡片）

### 模型缓存表 — `renderAdminStatsModelCache`（第 847 行）

- 表头在"缓存命中率"列前加 `<th>写缓存成本</th>`
- 行数据 `<td>${fmt(m.cacheCreationTokens)}</td>`
- 空态 colspan 从 9 改 10

### 按日明细表 — `renderStatsBlock`（第 726 行）+ `aggregateDaily`（第 719 行）

- `aggregateDaily` 累加初始对象（第 721 行）与 reduce totals（第 727 行）补 `input_cache_creation`
- `renderStatsBlock` 表头加"写缓存成本"列，行 `fmt(r.input_cache_creation)`
- 空态 colspan 同步（codebuddy 8→9、relay/copilot 7→8）
- stats-grid 卡片保持三卡（命中/未命中/输出）不动，写缓存成本进明细表

### 租户累计卡片 — `serviceInsights`（第 716 行）+ `updateCustomStatsCard`（第 750 行）

- `customMetricCards` 在"缓存命中率"后加一个 stat-item：`<div class="stat-value" id="${type}CustomCacheCreation">${fmt(p.total_cache_creation_tokens)}</div><div class="stat-label">写缓存 Tokens</div>`
- grid 列数变化：codebuddy 6→7、relay/copilot 5→6，需在 CSS 补 `stats-grid-7`/`stats-grid-6` 对应的 `grid-template-columns`
- `updateCustomStatsCard` 补 `set(type+'CustomCacheCreation', fmt(serviceProfile.total_cache_creation_tokens))`

---

## 层 4：清理死代码 + 硬编码归一

- 删除 `src/services/relay/tenant-manager.js` 与 `src/services/codebuddy/tenant-manager.js`（审计确认无任何文件 import，删除前全仓 grep 二次确认零引用）
- **同步修正 `tests/remove-cluster-mode.test.js`**：该测试在 files 数组（第 17-27 行）用 `readFileSync` 读取这两个文件并检查集群字符串是否残留。删除文件后 `readProjectFile` 会抛 ENOENT，必须从该数组移除 `'src/services/relay/tenant-manager.js'` 与 `'src/services/codebuddy/tenant-manager.js'` 两项，否则测试崩溃（非断言失败而是异常）
- `relay.js:674` 与 `relay.js:1571` 两处 `finalUsage?.prompt_tokens_details?.cache_creation_tokens || 0` 改用 `extractCacheCreationTokens(finalUsage)`（函数已在 relay.js import）

---

## 不在范围内

- copilot 调用点统一缺 model 参数（落库 model='unknown'）：既有统计盲点，不属本次缓存统计范畴，不动。
- 命中��口径（cacheHit/input）不变，无需调整。

## 验证

- 扩展 `tests/cache-metrics.test.js` 与 `tests/service-usage-isolation.test.js`：覆盖 `incrementTokenUsage` 第 6 参与 `_flushDirtyTenants` 的 `total_cache_creation_tokens` 累计、reset 清零。
- 新建 service-profile 累计 cacheCreation 测试。
- 全量 `npm test` 通过。
- DB 迁移幂等性：已存在列时 `addColumn` 跳过不报错。
- 静态语法检查所有改动文件（`node --check`）。
- 前端展示：cacheCreation 列/卡片在模型缓存表、按日明细表、租户累计卡片三处可见；历史数据该列为 0 正常显示。

## 改动文件清单

1. `src/db/models/tenant-service-profile.js` — 加 total_cache_creation_tokens 列
2. `src/db/index.js` — ensureTenantServiceProfileColumns 幂等迁移
3. `src/services/gateway/tenant-manager.js` — incrementTokenUsage/_ensureDelta/_flushDirtyTenants/reset 补 cacheCreation
4. `src/routes/relay.js` — 599 行 incrementTokenUsage 补参 + 674/1571 硬编码归一
5. `src/routes/codebuddy.js` — 8 处 incrementTokenUsage 补参
6. `src/services/copilot/runtime.js` — copilotStore.incrementTokenUsage 签名扩参
7. `src/routes/copilot.js` — 18 处 incrementTokenUsage 调用点补参（估算兜底不传）
8. `src/routes/dashboard-frontend.js` — /service-profile 返回 + aggregateUsageRows + tenantView 补 cacheCreation
9. `src/routes/stats.js` — 5 聚合函数 + getUserDetail 补 cacheCreation/miss 读取
10. `src/templates/admin.html` — 模型缓存表/按日明细表/租户累计卡片加列与卡片 + CSS
11. `src/services/relay/tenant-manager.js` — 删除（死代码）
12. `src/services/codebuddy/tenant-manager.js` — 删除（死代码）
13. `tests/remove-cluster-mode.test.js` — 从 files 数组移除上述两个已删文件路径（避免 readFileSync 抛 ENOENT）
14. `tests/cache-metrics.test.js` — 扩展
15. `tests/service-usage-isolation.test.js` — 扩展
