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

### 1. `config.js` — 配置模块

环境变量：

```bash
QODER_CLI_BACKEND        # 'cn' | 'global'，默认 'cn'
QODER_CLI_PATH           # CLI 可执行文件路径，默认自动检测
QODER_CN_PAT             # CN 后端 Personal Access Token
QODER_GLOBAL_PAT         # Global 后端 PAT
QODER_MODELS             # 可用模型覆盖（JSON）
QODER_DEFAULT_MODEL      # 默认模型，默认 'auto'
QODER_STREAM_ENABLED     # 是否启用流式，默认 true
QODER_TOOL_MAX_ROUNDS    # 工具调用最大轮次，默认 10
```

模型列表（参考 qoder-proxy）：

```javascript
const QODER_MODELS = [
  {id: 'auto', name: 'Auto', tools: true},
  {id: 'qwen3.7-max', name: 'Qwen3.7-Max', tools: true},
  {id: 'glm-5.1', name: 'GLM-5.1', tools: true},
  {id: 'kimi-k2.6', name: 'Kimi-K2.6', tools: true},
  {id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', tools: true},
  {id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', tools: false},
  {id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', tools: true},
  {id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', tools: false},
  // 推理强度别名
  {id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max (Low)', tools: true},
  {id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max (Medium)', tools: true},
  {id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max (High)', tools: true},
  {id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max (Max)', tools: true},
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
| 双后端支持 | `QODER_CLI_BACKEND` 切换 cn/global | 与 qoder-proxy 一致，支持国内/国际版 |

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
