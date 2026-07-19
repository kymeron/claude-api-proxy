# 通道接入模式选型：HTTP 代理 vs SDK

日期：2026-07-06（更新：2026-07-06，补充 CodeBuddy 官方 SDK 信息）

## 背景

项目在集成 CodeBuddy 和 Qoder 两个 AI 通道时，面临两种技术路线的选择：

1. **HTTP 代理模式** — 手动构造 HTTP 请求，直接调用上游 REST API
2. **SDK 模式** — 引入官方 SDK，通过编程接口调用

当前状态：

- CodeBuddy 通道使用 HTTP 代理模式，依赖 `@tencent-ai/codebuddy-code`（CLI 工具，仅用于读取版本号），未使用官方 SDK `@tencent-ai/agent-sdk`
- Qoder 通道默认使用 CLI spawn 模式，同时通过 `QODER_USE_SDK=true` 环境变量可选切换到 `@qoder-ai/qoder-agent-sdk` SDK 模式

## 可用的官方 SDK

| 通道 | SDK 包名 | 版本 | 描述 | 通信方式 |
|------|----------|------|------|----------|
| CodeBuddy | `@tencent-ai/agent-sdk` | 0.3.201 | CodeBuddy Code SDK for JavaScript/TypeScript | 基于 Agent Client Protocol + MCP |
| Qoder | `@qoder-ai/qoder-agent-sdk` | 1.0.11 | Qoder 官方 Agent SDK | 封装 CLI spawn |

### CodeBuddy SDK (`@tencent-ai/agent-sdk`) 分析

- 基于 **Agent Client Protocol** (`@agentclientprotocol/sdk`) 和 **MCP** (`@modelcontextprotocol/sdk`)
- 提供编程式接口，不再是简单的 CLI 封装
- 版本号 0.3.x，尚处于早期阶段
- 与 `@tencent-ai/codebuddy-code`（纯 CLI 二进制工具）是两个独立包

## 两种模式对比

### HTTP 代理模式

**做法**：项目自行构造 HTTP 请求（URL、Headers、Body），通过 HTTP 客户端直接调用上游 API。

**CodeBuddy 当前实践**：

- 手动构造完整的请求头（`X-IDE-Type`、`X-IDE-Version`、`x-stainless-*`、`Authorization`、`X-Enterprise-Id` 等）
- 区分个人版/企业版上游，动态组装不同请求头
- 实现关键词替换防 content_filter（`sanitizePayload`）
- JWT 解析兜底提取企业 ID
- KV Cache 优化（`prompt_cache_key` + `X-Session-ID`）
- 会话 ID 管理（`X-Conversation-ID`、`X-Conversation-Request-ID` 等）

| 维度 | 评价 |
|------|------|
| 可控性 | ★★★★★ 请求的每一层都可精确控制 |
| 灵活性 | ★★★★★ 可自由实现任意定制逻辑 |
| 依赖复杂度 | ★★★★★ 零额外 SDK 依赖 |
| 性能 | ★★★★★ 纯 HTTP 调用，无进程开销 |
| 维护成本 | ★★☆☆☆ 上游接口变化需手动跟进 |
| 版本一致性 | ★★★☆☆ 版本号硬编码，需手动与上游对齐 |
| 协议稳定性 | ★★★★☆ REST API 相对稳定，但无契约保证 |

### SDK 模式

**做法**：引入官方 SDK 包，通过其暴露的编程接口调用，由 SDK 封装底层通信细节。

**通用特点**：

| 维度 | 评价 |
|------|------|
| 可控性 | ★★☆☆☆ 受限于 SDK 暴露的能力边界 |
| 灵活性 | ★★☆☆☆ 特殊需求可能无法满足 |
| 依赖复杂度 | ★★★☆☆ 增加 SDK 版本依赖，需关注 breaking change |
| 性能 | 因 SDK 实现而异（见下方分通道分析） |
| 维护成本 | ★★★★☆ SDK 升级自动获得 bug 修复和新特性 |
| 版本一致性 | ★★★★☆ SDK 与服务端版本配套，减少手动对齐工作 |
| 协议稳定性 | ★★★★★ 通过 SDK 契约保证接口兼容性 |

### 分通道 SDK 特殊性

#### Qoder SDK (`@qoder-ai/qoder-agent-sdk`)

- 内部仍 spawn `qodercli` 二进制子进程
- 本质是对 CLI spawn 的封装（参数构造、JSONL 解析、超时管理），而非 HTTP 调用
- 每次请求仍有进程启动开销

#### CodeBuddy SDK (`@tencent-ai/agent-sdk`)

- 基于 **Agent Client Protocol** 和 **MCP** 标准协议
- 提供的是 Agent 级别的编程接口（工具调用、会话管理等），而非简单的 HTTP 封装
- 协议层面比裸 HTTP API 抽象层次更高
- 版本 0.3.x，API 可能不稳定

## 选型关键因素

### 1. SDK 成熟度与抽象层级

| 因素 | CodeBuddy SDK | Qoder SDK | HTTP 代理 |
|------|---------------|-----------|-----------|
| 版本阶段 | 0.3.x（早期） | 1.0.x（稳定） | N/A |
| 抽象层级 | Agent 协议（高） | CLI 封装（中） | HTTP（低） |
| 协议标准 | ACP + MCP | 无标准 | REST |
| Breaking change 风险 | 高（0.x 版本） | 低 | 低 |

**结论**：CodeBuddy SDK 抽象层级高但版本早期风险大；Qoder SDK 成熟但本质仍是 CLI 封装；HTTP 代理最底层也最稳定。

### 2. 通信方式本质

| 通道 | HTTP 代理 | SDK | 实际通信 |
|------|-----------|-----|----------|
| CodeBuddy | HTTP → 云端 API | ACP/MCP → 云端 Agent | 网络协议 |
| Qoder | N/A | SDK → spawn CLI → 本地推理 | 子进程 |

- CodeBuddy 是云端 Agent 服务，HTTP API 和 ACP 协议都是其原生通信方式
- Qoder 是本地 CLI 推理工具，spawn 子进程是其唯一通信方式

**结论**：CodeBuddy 的两种方式都是网络通信，无性能本质差异；Qoder 无论哪种方式都要走子进程。

### 3. 定制化需求程度

- CodeBuddy 通道有大量定制逻辑（关键词替换、JWT 解析、企业 ID 兜底、KV Cache 优化），这些在 HTTP 层直接可控。SDK 的 ACP 协议抽象层级更高，这些底层细节可能被封装在 SDK 内部，无法干预
- Qoder 通道的定制主要在 prompt 构造和工具解析，SDK 封装了重复性的 CLI 交互，定制逻辑仍在 SDK 外层

**结论**：定制化需求越多越底层，HTTP 代理模式的优势越大。

### 4. 维护人力与版本风险

- HTTP 代理模式：需要关注上游 API 变更，手动跟进
- SDK 模式：SDK 升级自动获得修复，但版本升级可能引入 breaking change
- CodeBuddy SDK 0.x 版本：API 可能频繁变动，跟进成本不确定

**结论**：小团队或快速迭代阶段，成熟 SDK 更省心；精细控制或 SDK 早期阶段，HTTP 代理更稳定。

### 5. 性能与资源

- HTTP 代理：每次请求是一次 HTTP 往返，无额外进程开销
- CodeBuddy SDK（ACP 协议）：理论上也是网络通信，性能应与 HTTP 代理相当，但协议层可能有额外序列化开销
- CLI spawn / Qoder SDK：每次请求启动一个子进程，有进程创建和销毁开销

**结论**：CodeBuddy 通道两种网络模式性能差异不大；Qoder 通道受限于子进程模型。

### 6. 架构契合度

| 因素 | HTTP 代理 | CodeBuddy SDK | Qoder SDK |
|------|-----------|---------------|-----------|
| 与项目分层架构契合 | ★★★★★ 完全契合现有 provider 模式 | ★★★☆☆ 需要新的适配层 | ★★★★☆ 已通过兼容层接入 |
| 与其他通道一致性 | ★★★★★ 与 Relay/Copilot 一致 | ★★☆☆☆ ACP 协议是另一套范式 | ★★★☆☆ 独特的子进程模式 |
| 协议转换路径 | 直接走 protocol-engine | 需 ACP → Canonical 映射 | 已有适配 |

## 决策

### CodeBuddy 通道：当前保持 HTTP 代理，SDK 列入观察

- ✅ **HTTP 代理模式是当前正确选择**：
  - 已有大量成熟定制逻辑（关键词替换、JWT 兜底、KV Cache 等），切换 SDK 需重写
  - `@tencent-ai/agent-sdk` 处于 0.3.x 早期版本，API 不稳定，breaking change 风险高
  - SDK 基于 ACP 协议，抽象层级更高，底层 HTTP 细节不可控，定制逻辑可能无法迁移
  - 架构与 Relay、Copilot 等其他产品接入方式一致
  - HTTP API 是 CodeBuddy 服务的原生接口，不存在功能缺失

- 🔭 **SDK 列入观察**：
  - 关注 `@tencent-ai/agent-sdk` 发布 1.0 稳定版后的 API 形态
  - 评估 ACP 协议是否能覆盖当前定制需求
  - 如果 SDK 提供的能力（如原生 tool_use、会话管理）显著优于 HTTP 代理，考虑双模式并存

### Qoder 通道：SDK 模式作为可选优化

- CLI spawn 是 Qoder 的原生通信方式，不可绕过
- SDK 封装了重复性的参数构造和输出解析，减少维护量
- 保持 `QODER_USE_SDK` 开关，允许在 CLI 原生模式和 SDK 封装模式间切换
- 默认保持 CLI 原生模式，SDK 作为可选项

## SDK 迁移评估清单（CodeBuddy）

当 `@tencent-ai/agent-sdk` 达到 1.0 稳定版后，按以下清单评估是否切换：

1. **功能覆盖**：SDK 是否支持个人版/企业版双模式？是否支持自定义 upstream？
2. **定制需求**：关键词替换、JWT 兜底、KV Cache 优化等是否可在 SDK 层实现？
3. **协议适配**：ACP 协议事件是否能无损映射到现有 Canonical Stream Event？
4. **性能基准**：SDK 模式与 HTTP 代理的延迟、吞吐量对比
5. **稳定性**：SDK 1.0 发布后至少观察一个 minor 版本的 breaking change 频率
6. **双模式策略**：通过环境变量开关（如 `CODEBUDDY_USE_SDK=true`）支持两种模式并存，HTTP 代理作为 fallback

## 参考

- [架构边界约定](../architecture-boundaries.md)
- `src/services/codebuddy/api.js` — CodeBuddy HTTP 代理实现
- `src/services/codebuddy/config.js` — CodeBuddy 请求头构造
- `src/services/qoder/sdk-client.js` — Qoder SDK 封装
- `src/services/qoder/qoder-cli.js` — Qoder CLI spawn 实现
- `@tencent-ai/agent-sdk` (v0.3.201) — CodeBuddy 官方 Agent SDK，基于 ACP + MCP
- `@qoder-ai/qoder-agent-sdk` (v1.0.11) — Qoder 官方 Agent SDK，封装 CLI spawn

---

## 附录：CodeBuddy 官方包辨析（2026-07-06 补充）

> 整理背景：在推动 Qoder 渠道“避免自己造轮子，改用官方 SDK”的过程中，对腾讯 CodeBuddy 侧两个名字相近的 npm 包进行梳理，避免后续 CodeBuddy 渠道改造时混淆。

### A.1 `@tencent-ai/codebuddy-code` vs `@tencent-ai/agent-sdk`

两个包都带 `codebuddy` 前缀，但本质不同：

| 包 | 本质 | 你拿到的东西 |
|----|------|-------------|
| `@tencent-ai/codebuddy-code` | **CLI 工具的 npm 包装** | `bin/codebuddy`（交互式 CLI）+ 打包好的 `dist/codebuddy.js` / `codebuddy-headless.js`。`npm i` 它本质是拉一个命令行工具 |
| `@tencent-ai/agent-sdk` | **真正的 JS/TS SDK** | `lib/index.js` 导出 `query()` async generator、Auth、Hooks、Agents、MCP 等 API，可 `import` 进业务代码直接调用 |

### A.2 详细对比

| 维度 | `@tencent-ai/codebuddy-code` | `@tencent-ai/agent-sdk` |
|------|------------------------------|------------------------|
| **npm 描述** | 仓库里那份打包的 CodeBuddy Code CLI | `"CodeBuddy Code SDK for JavaScript/TypeScript"` |
| **main / typings** | 没有 `main`，用 `bin` 暴露可执行文件 | `lib/index.js` + `lib/index.d.ts` |
| **使用方式** | 终端运行 `codebuddy`（交互）/ `codebuddy -p '...'`（headless） | `import { query } from '@tencent-ai/agent-sdk'` |
| **API 形态** | CLI 子进程 + 文本输出 | async generator，`{type:'assistant'\|'result'\|'system', ...}` 消息流 |
| **依赖** | 自带 CLI 工具，无运行时 npm 依赖 | `@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`，peer `zod@^4` |
| **包大小** | 约 90 MB（打包的 CLI） | 仅 SDK 本体（依赖上面两个对等包） |
| **当前 latest** | `2.98.1`（仓库已装，但代码路径未引用） | `0.3.201`（2026-07-04 发布；仓库**未装**） |
| **典型场景** | 终端交互、IDE 扩展、CI 直接跑命令 | 把 CodeBuddy Agent 嵌进自家服务（与本次接 Qoder SDK 同类需求） |
| **包描述里的引用** | — | "Related Links → CodeBuddy Code CLI"，明确把 CLI 当底层 runtime |

### A.3 实际包结构差异

**`@tencent-ai/codebuddy-code`（仓库已装 `^2.98.1`）**

```
@tencent-ai/codebuddy-code/
├── bin/codebuddy               ← CLI 入口
├── dist/
│   ├── codebuddy.js            ← 完整 CLI（webpack 打包，含 Web UI）
│   ├── codebuddy-headless.js   ← 无界面 headless 版本
│   └── web-ui/                 ← 自带 Web UI 资源
└── docs/...                    ← CLI 文档
```

**`@tencent-ai/agent-sdk@0.3.201`**

```
@tencent-ai/agent-sdk/
├── lib/index.js                ← SDK 入口
├── lib/index.d.ts              ← 类型定义
├── src/index.ts                ← 源码（导出）
├── 依赖：@agentclientprotocol/sdk, @modelcontextprotocol/sdk
└── peer：zod ^4
```

### A.4 与本次 Qoder 接入的对应关系

Qoder 已经走 SDK 路线（`@qoder-ai/qoder-agent-sdk`）。CodeBuddy 侧**等价的 SDK 是 `@tencent-ai/agent-sdk`**，API 用法与 Qoder SDK 高度相似：

```js
import {query} from '@tencent-ai/agent-sdk';

for await (const message of query({
    prompt: 'hi',
    options: {permissionMode: 'bypassPermissions'}
})) {
    if (message.type === 'assistant') {
        for (const block of message.message.content) {
            if (block.type === 'text') console.log(block.text);
        }
    }
}
```

消息类型同样为 `system` / `assistant` / `result`，因为两者都遵循 [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) 的标准 wire protocol。

### A.5 当前仓库 CodeBuddy 渠道的真实情况

- `src/services/codebuddy/` 全部是**手工 HTTP 调腾讯 CodeBuddy 上游**（OAuth + `/v1/chat/completions` 等）。
- **没有** spawn `codebuddy` CLI，也**没有** import `@tencent-ai/codebuddy-code` 任何模块。
- `@tencent-ai/codebuddy-code` 依赖挂在 `package.json` 里、`node_modules` 装了，但**代码路径未引用**。

### A.6 给后续 CodeBuddy 渠道改造的补充建议

> 与本次 Qoder 改造对偶：**把 CodeBuddy 服务层从“手写 HTTP”切到 `@tencent-ai/agent-sdk`**，避免重复实现 OAuth 刷新、流式事件、协议适配。

需要关注的差异点（写代码前先评估）：

1. **鉴权**：CodeBuddy 是 OAuth refresh_token 模型，SDK 通过 `auth` 选项注入，需要把现有 `tenant_credentials` 表里的 `access_token` / `refresh_token` 适配进 SDK auth。
2. **输出形态**：SDK 仍是 Anthropic BetaMessage 流事件，handler 协议层要做与 Qoder 一样的桥接（`assistant` / `stream_event` → `onDelta({type, text})`）。
3. **企业版字段**：`enterprise_id` / `department_info` 不在 SDK auth 里，需要继续通过 SDK 的 `env` 或 `extraArgs` 注入。
4. **风险**：当前仓库已经积累了大量围绕 CodeBuddy HTTP API 的逻辑（与 `services/qoder/qoder-cli.js` 对位的是 `services/codebuddy/api.js`），直接替换会牵动 `route-runtime.js`、usage、credential 三层。建议同样按 `CODEBUDDY_USE_SDK` 灰度开关推进。

### A.7 对本决策现有内容的影响

本附录是对主决策（“CodeBuddy 保持 HTTP 代理，SDK 列入观察”）的**包层面澄清**，并不改变主决策结论：

- `0.3.x` 版本早期 + ACP 协议抽象更高 → **仍维持 HTTP 代理为默认**。
- 但补充明确了“未来如果切 SDK，对应的包是 `@tencent-ai/agent-sdk` 而不是 `@tencent-ai/codebuddy-code`”，避免后续读到“依赖 `@tencent-ai/codebuddy-code`”一句话时误以为那就是要切换的目标。
- Qoder 一侧决策不变（CLI spawn 原生，SDK 作为可选优化）。
