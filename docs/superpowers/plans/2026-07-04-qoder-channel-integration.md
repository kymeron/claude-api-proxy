# Qoder 渠道接入开发计划

> 日期：2026-07-04
> 状态：待实施
> 参考仓库：https://github.com/avaritiachaos/qoder-proxy

---

## 一、背景

当前项目已接入三个渠道：Relay（直连 Anthropic/OpenAI）、Codebuddy（腾讯 CodeBuddy）、Copilot（GitHub Copilot）。现需新增 **Qoder** 渠道，将 Qoder CLI 适配为 OpenAI/Anthropic 兼容的 HTTP API。

Qoder 与现有渠道的核心差异在于**上游调用方式**：

| 渠道 | 上游调用方式 |
|------|-------------|
| Relay | HTTP API 直连 Anthropic/OpenAI |
| Codebuddy | HTTP API 调腾讯 CodeBuddy |
| Copilot | HTTP API + WebSocket 调 GitHub Copilot |
| **Qoder** | **CLI 子进程**（spawn `qodercli`/`qoderclicn`） |

整体仍遵循现有的 **工厂 + 依赖注入 + 门面** 架构模式，文件结构与其他渠道保持对称。

---

## 二、新增文件清单

```
src/
├── services/qoder/                  # Qoder 渠道服务
│   ├── index.js                     # 公共边界 (re-export)
│   ├── config.js                    # 配置：后端类型、CLI路径、模型列表、请求头
│   ├── route-runtime.js             # 工厂函数：组装所有 handler
│   ├── qoder-cli.js                 # ★ 核心差异：CLI 子进程管理（spawn、流式/非流式）
│   ├── model-mapping.js             # 模型名映射（客户端名 → CLI名）
│   ├── prompt-builder.js            # 构建 CLI prompt（消息序列化、工具注入）
│   ├── tool-parser.js               # 工具调用解析（prompt注入+输出解析）
│   ├── chat-completions-handler.js  # OpenAI Chat Completions 处理
│   ├── anthropic-messages-handler.js# Anthropic Messages 处理
│   ├── responses-api-handler.js     # Responses API 处理
│   ├── responses-compact-handler.js # Responses Compact 处理
│   ├── responses-websocket-handler.js# Responses WebSocket 处理
│   ├── protocol-adapter.js          # 协议引擎门面
│   ├── conversation-key.js          # 会话 ID 解析
│   ├── response-writer.js           # 响应写入器
│   ├── usage.js                     # 用量记录
│   ├── outbound-chat.js             # 出站请求预处理
│   ├── credential-context.js        # 凭证上下文
│   ├── credential-service.js        # 凭证服务
│   └── metadata-handler.js          # 模型列表、count_tokens
├── routes/qoder.js                  # 路由表层
```

---

## 三、模块实现要点

### 1. `config.js` — 配置模块（参照 Codebuddy 模式）

#### 环境变量（.env 配置区块）

```bash
# ================================================
# Qoder
# ================================================
# 可选 cn 或 intl。cn 使用 qoderclicn，intl 使用 qodercli。
QODER_REGION=cn
# QODER_DEFAULT_BASE_URL=qoder.example.com
# 控制台中非官方/自定义 Qoder 上游的显示标签，按 host 或完整 URL 映射。
# QODER_CUSTOM_SITE_LABELS={"qoder.example.com":"自定义站"}
# 控制台中额外展示的上游 base URL，多个值用英文逗号分隔。
# QODER_EXTRA_BASE_URLS=https://qoder.example.com,https://qoder-intl.example.com
# 可选：按 host 或完整 URL 覆盖模型列表。
# QODER_MODEL_OVERRIDES={"qoder.example.com":[{"id":"custom:glm51","name":"GLM-5.1","tools":true,"vision":false}]}
# QODER_DEFAULT_USER_ID=unknown
# CLI 可执行文件绝对路径，留空则使用 PATH 中的 qodercli / qoderclicn
# QODER_CLI_PATH=/usr/local/bin/qoderclicn
# 默认模型（CLI 不识别时回退到此），默认 auto
# QODER_DEFAULT_MODEL=auto
# 是否启用流式响应（CLI --output-format stream-json），默认 true
# QODER_STREAM_ENABLED=true
# 工具调用最大轮次（CLI 不支持原生 tool_calls，需 prompt 内多轮循环），默认 10
# QODER_TOOL_MAX_ROUNDS=10
# 子进程超时（毫秒），默认 300000（5 分钟）
# QODER_CLI_TIMEOUT_MS=300000
# 工具调用 JSON 解析深度上限，默认 32
# QODER_JSON_DEPTH_LIMIT=32
# 单条响应最大 token 数（-1 表示由 CLI 决定），默认 -1
# QODER_MAX_TOKENS=-1
# 凭证存储：控制台管理 PAT，QODER_PAT 仅为环境变量覆盖（优先级低于 DB 凭证）
```

#### 配置映射（与 Codebuddy 对齐）

| Codebuddy 配置 | Qoder 对应 | 说明 |
|---------------|-----------|------|
| `CODEBUDDY_REGION` | `QODER_REGION` | 区域切换（cn/intl）→ 决定 CLI 命令和默认上游 |
| `CODEBUDDY_DEFAULT_BASE_URL` | `QODER_DEFAULT_BASE_URL` | 自定义上游 URL 覆盖 |
| `CODEBUDDY_CUSTOM_SITE_LABELS` | `QODER_CUSTOM_SITE_LABELS` | 控制台显示标签（JSON: host→label） |
| `CODEBUDDY_EXTRA_BASE_URLS` | `QODER_EXTRA_BASE_URLS` | 额外上游 URL（逗号分隔） |
| `CODEBUDDY_MODEL_OVERRIDES` | `QODER_MODEL_OVERRIDES` | 按 host 覆盖模型列表（JSON: host→models） |
| `CODEBUDDY_DEFAULT_USER_ID` | `QODER_DEFAULT_USER_ID` | 默认用户 ID |
| — | `QODER_CLI_PATH` | CLI 可执行文件路径（Qoder 特有） |
| — | `QODER_DEFAULT_MODEL` | 默认模型 |
| — | `QODER_STREAM_ENABLED` | 是否启用流式 |
| — | `QODER_TOOL_MAX_ROUNDS` | 工具调用最大轮次 |
| — | `QODER_CLI_TIMEOUT_MS` | 子进程超时 |
| — | `QODER_JSON_DEPTH_LIMIT` | JSON 解析深度上限 |
| — | `QODER_MAX_TOKENS` | 单条响应最大 token 数 |

#### 核心函数（与 Codebuddy config.js 对称）

```javascript
// 区域 → CLI 命令映射
getQoderCliCommand()     // cn → 'qoderclicn', intl → 'qodercli'
getQoderBaseUrl(baseUrl) // 优先传入值 → QODER_DEFAULT_BASE_URL → 区域默认值
getExtraBaseUrls()       // QODER_EXTRA_BASE_URLS 逗号分隔
getCustomSiteLabels()    // QODER_CUSTOM_SITE_LABELS JSON 解析
getHostModelOverrides()  // QODER_MODEL_OVERRIDES JSON 解析
getModelsForHost(host)   // 特定站点覆盖 > 区域默认模型列表
isPersonalHost(host)     // 个人版/企业版判断
```

#### 模型列表

```javascript
// 国内站可用模型（cn）
const CN_MODELS = [
  {id: 'auto', name: 'Auto', tools: true, vision: false},
  {id: 'qwen3.7-max', name: 'Qwen3.7-Max', tools: true, vision: false},
  {id: 'glm-5.1', name: 'GLM-5.1', tools: true, vision: false},
  {id: 'kimi-k2.6', name: 'Kimi-K2.6', tools: true, vision: true},
  {id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', tools: true, vision: false},
  {id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', tools: false, vision: false},
  {id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', tools: true, vision: false},
  {id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', tools: false, vision: false},
  // 推理强度别名
  {id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max (Low)', tools: true, vision: false},
  {id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max (Medium)', tools: true, vision: false},
  {id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max (High)', tools: true, vision: false},
  {id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max (Max)', tools: true, vision: false},
];

// 国际站可用模型（intl）
const INTL_MODELS = [
  {id: 'auto', name: 'Auto', tools: true, vision: false},
  // ... 根据国际站实际支持情况补充
];
```

### 2. `qoder-cli.js` — CLI 子进程管理（核心差异点）

- `runQoderCli(prompt, options)` — 非流式调用，返回完整输出
- `runQoderCliStream(prompt, options, onDelta)` — 流式调用，实时回调
- `buildCliArgs(prompt, options)` — 构建 CLI 参数数组
- `buildChildEnv()` — 构建子进程环境变量（注入 Token）
- `getCliBackend()` — 获取后端配置（CN/Global）
- 临时附件文件管理（写入/清理）
- 子进程超时与错误处理

### 3. `prompt-builder.js` — Prompt 构建

- `buildPrompt(messages, options)` — 消息序列化为 CLI 输入
- `buildToolSystemPrompt(tools)` — 工具调用 prompt 注入
- `formatToolResult(toolResult)` — 工具结果格式化
- 三路径注入策略：
  1. 客户端有 system prompt → 不注入额外指令
  2. 无 system prompt 且无 tools → 仅添加最简引导
  3. 有 tools → 注入工具格式指令

### 4. `tool-parser.js` — 工具调用解析

- `parseToolCallOutput(output)` — 解析 CLI 输出中的工具调用
- `extractBalancedJsonWithToolCalls(text)` — 花括号平衡算法
- 将解析结果转换为 OpenAI/Anthropic tool_calls 格式

### 5. Handler 实现模式

所有 handler 遵循与现有渠道相同模式：

```
请求 → 认证凭证 → 解析body → 模型映射 → 会话ID →
出站预处理 → CLI调用 → 协议适配 → 流式/非流式响应 → 用量记录
```

区别仅在于"CLI调用"环节：用 `qoder-cli.js` 替代 `providers/upstream-api.js`

### 6. 认证与多租户集成

- 复用现有 `gateway/tenant-manager.js` 的 `authenticateApiKey()`
- 凭证存储：将 Qoder PAT 存储在 `Credential` 表中，`service_type = 'qoder'`
- 支持多凭证轮转（与 Codebuddy 模式一致）

---

## 四、路由注册（修改现有文件）

### `src/server.js` 新增

```javascript
// HTTP 路由
if (req.url.startsWith('/qoder')) {
    if (!requireApiAuth(req, res, unifiedTenantManager, 'qoder')) return;
    await routeQoderRequest(req, res);
}

// WebSocket 路由
'/qoder/v1/responses': handleQoderResponsesWS,
```

### `src/routes/qoder.js` 新增（极简路由表层）

```javascript
const qoderRuntime = createQoderRouteRuntime({
    tenantManager: unifiedTenantManager,
    resolveCredential,
    logger
});
export async function routeQoderRequest(req, res) {
    return qoderRuntime.routeQoderRequest(req, res);
}
```

---

## 五、开发阶段划分

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P1 - 基础框架** | config.js, index.js, route-runtime.js, model-mapping.js, conversation-key.js, response-writer.js, usage.js, protocol-adapter.js, credential-context.js, credential-service.js | 无 |
| **P2 - CLI 核心** | qoder-cli.js, prompt-builder.js, tool-parser.js, outbound-chat.js | P1 |
| **P3 - Handler 实现** | chat-completions-handler.js, anthropic-messages-handler.js, metadata-handler.js | P1 + P2 |
| **P4 - 高级协议** | responses-api-handler.js, responses-compact-handler.js, responses-websocket-handler.js | P3 |
| **P5 - 路由集成** | routes/qoder.js, server.js 修改, .env.example 更新 | P3 |
| **P6 - 测试验证** | 基础连通性测试、流式测试、工具调用测试、多模型测试 | P5 |

---

## 六、关键技术决策

| 决策点 | 方案 | 理由 |
|--------|------|------|
| CLI 子进程管理 | 每次请求 spawn 新进程 | 与 qoder-proxy 一致，无状态，避免进程复用问题 |
| 流式实现 | 使用 CLI `--output-format stream-json` | 实时增量输出，与现有 SSE 转发机制兼容 |
| 工具调用 | Prompt 注入 + 输出解析 | CLI 不支持原生 tool_calls，需模拟 |
| 凭证管理 | 复用 TenantManager + Credential 表 | 统一多租户架构，支持凭证轮转 |
| 模型回退 | 未知模型 → `auto` | 与 qoder-proxy 一致，避免请求失败 |
| 附件文件 | `os.tmpdir()` + 请求后清理 | 避免 Windows 长命令行限制 |
| 双后端支持 | `QODER_REGION` 切换 cn/intl（与 Codebuddy 对齐） | 区域切换决定 CLI 命令和默认上游，与 Codebuddy 的 REGION 模式完全一致 |

---

## 七、Qoder CLI 子进程调用流程

```
客户端请求 → Handler 接收
    ↓
prompt-builder.js: 消息序列化 + 工具 prompt 注入
    ↓
qoder-cli.js: 构建 CLI 参数 + 环境变量
    ↓
child_process.spawn(qodercli/qoderclicn, [
    '--print',
    '--output-format json|stream-json',
    '--model <mapped_model>',
    '--dangerously-skip-permissions',
    '--append-system-prompt <system_msg>',
    '--attachment <tmp_file>',
    '-- <instruction>'
])
    ↓
流式: stdout 逐行解析 → onDelta 回调 → SSE 转发
非流式: stdout 收集 → JSON 解析 → 完整响应
    ↓
tool-parser.js: 解析工具调用（如有）
    ↓
response-writer.js: 格式化响应 → 返回客户端
    ↓
usage.js: 记录用量
```

---

## 八、风险与注意事项

1. **CLI 可用性**：部署环境必须预装 `qodercli` 或 `qoderclicn`，需在启动时检测并警告
2. **进程开销**：每次请求 spawn 新进程有启动开销，高并发场景需评估性能
3. **临时文件清理**：异常中断时需确保临时附件文件被清理，建议用 `finally` 块
4. **Token 计数**：CLI 不返回 token 计数，usage 字段需估算或标记为 0
5. **工具调用模拟**：Prompt 注入方式不保证 100% 可靠，需充分测试边界情况
6. **流式降级**：有工具调用时流式请求需降级为非流式（CLI 限制）
