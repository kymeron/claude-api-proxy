# 项目业务说明

## 1. 项目定位

这个项目是一个 **Claude API 代理与协议转换服务**。它的核心作用不是直接提供模型能力，而是把 Claude Code 的请求接入到不同上游服务，再把返回结果转换成客户端可识别的格式。

当前项目把能力分成三条业务线：

1. **GitHub Copilot 代理**
2. **腾讯 CodeBuddy 代理**
3. **Relay 通用中继代理**

项目主页会统一展示这三类服务，并提供对应的管理面板入口。

## 2. 核心业务目标

项目解决的主要问题是：

- 让 Claude Code 或其他支持 Anthropic / OpenAI / Responses 协议的客户端
- 无需改造客户端代码
- 直接切换到 Copilot、CodeBuddy 或任意兼容上游
- 同时保留统一的认证、路由、模型列表、用量统计和管理能力

一句话总结：

**把多个不同协议、不同账号体系的 AI 服务，统一包装成一个本地可用的代理入口。**

## 3. 业务模块划分

### 3.1 GitHub Copilot 代理

Copilot 模块面向已经开通 GitHub Copilot 订阅的用户，主要提供：

- GitHub 设备码授权登录
- API Key 管理
- OpenAI 格式接口
- Anthropic 格式接口
- OpenAI Responses 接口
- 模型列表查询
- 用量统计与 token 统计
- 代理配置支持

适合场景：

- 想把 Claude Code 请求转发到 Copilot 后端
- 想在国内或特定网络环境下通过代理访问 GitHub 服务
- 想把 Copilot 能力以 Anthropic / OpenAI 兼容方式暴露出来

### 3.2 CodeBuddy 代理

CodeBuddy 模块面向腾讯 CodeBuddy 账号体系，支持：

- 多凭证管理
- 手动切换当前活跃凭证
- 自动轮换开关
- OpenAI 格式接口
- Anthropic 格式接口
- OpenAI Responses 接口
- 模型列表查询
- 用量统计与 credit 统计
- 企业站 / 国内站 / 国际站模型列表

适合场景：

- 同时维护多个 CodeBuddy 账号
- 需要在不同站点模型之间切换
- 需要把 CodeBuddy 包装成 Claude 兼容代理

### 3.3 Relay 通用中继代理

Relay 模块更偏通用型，面向任意上游 AI 服务。它支持：

- 多上游配置
- 手动选择当前活跃上游
- OpenAI 格式接口
- Anthropic 格式接口
- OpenAI Responses 接口
- 模型映射
- 上游协议自动识别与转换
- 用量统计

它可以接入：

- DeepSeek 等 OpenAI 兼容服务
- 本地运行的 Copilot 上游
- 本地运行的 CodeBuddy 上游
- Anthropic 兼容上游
- Responses 兼容上游

适合场景：

- 想把多个 AI 提供商统一收口到一个入口
- 想用 Claude Code 访问非 Anthropic 后端
- 想把本地代理继续作为上游再做一层聚合

## 4. 对外提供的能力

### 4.1 协议能力

项目当前支持三种对外协议：

- **Anthropic**
- **OpenAI Chat Completions**
- **OpenAI Responses**

这意味着同一套后端可以同时服务：

- Claude Code
- Cherry Studio
- 其他 OpenAI 兼容客户端
- 使用 Responses API 的客户端

### 4.2 路由能力

每个业务线都提供两类入口：

- **API 代理接口**
- **Web 管理面板**

例如：

- `/copilot` 与 `/copilotFE`
- `/codebuddy` 与 `/codebuddyFE`
- `/relay` 与 `/relayFE`

根路径 `/` 会展示三个业务入口卡片。

### 4.3 管理能力

项目不是纯接口层，还提供管理后台，主要用于：

- 登录 / 授权
- 凭证管理
- 上游管理
- 模型查看
- 代理配置
- 用量统计查看
- API Key 查看、复制、重置

## 5. 典型业务流程

### 5.1 Copilot 使用流程

1. 用户访问 `/copilotFE`
2. 完成 GitHub 授权
3. 系统保存 Copilot Token
4. 用户复制 API Key
5. Claude Code 指向 `/copilot`
6. 请求在 Anthropic / OpenAI / Responses 间转换后转发到 Copilot
7. 返回结果再转换成客户端所需格式

### 5.2 CodeBuddy 使用流程

1. 用户访问 `/codebuddyFE`
2. 添加一个或多个 CodeBuddy 凭证
3. 选择当前活跃凭证
4. 复制 API Key
5. 客户端指向 `/codebuddy` 或 `/codebuddy/anthropic`
6. 系统按请求格式进行转换并调用上游
7. 返回结果统一转回客户端格式

### 5.3 Relay 使用流程

1. 用户访问 `/relayFE`
2. 添加多个上游服务
3. 设置当前活跃上游
4. 可配置模型映射和代理
5. 客户端指向 `/relay` 或 `/relay/anthropic`
6. 系统根据上游协议决定直连或转换
7. 返回结果统一转换为请求方需要的格式

## 6. 业务上的关键特点

### 6.1 统一入口

项目首页作为统一入口，把三类代理服务集中管理，降低使用门槛。

### 6.2 多协议兼容

同一个上游可以同时服务不同客户端协议，减少前端改造成本。

### 6.3 账号/上游可切换

- Copilot 支持代理与授权后使用
- CodeBuddy 支持多凭证切换
- Relay 支持多上游切换

### 6.4 兼容性转换

项目内部会处理：

- Anthropic ↔ OpenAI 消息结构转换
- Responses ↔ Chat Completions 转换
- 流式输出转换
- reasoning / thinking 相关字段转换
- token usage 统计转换

### 6.5 统计能力

各模块都会记录：

- 请求次数
- token 消耗
- cache hit token
- credit 消耗（CodeBuddy / Relay 场景）
- 日常用量

## 7. 当前业务边界

这个项目的业务重点是 **代理、转换、管理、统计**，不是直接训练模型或提供独立大模型推理平台。

它更像一个：

- 多后端 AI 接入层
- 协议适配层
- 账号与上游管理层
- 本地可部署的中转网关

## 8. 面向用户的使用价值

对使用者来说，这个项目的价值主要在于：

- 不需要修改 Claude Code 客户端
- 可以切换不同 AI 供应商
- 可以统一多个账号或上游
- 可以把非 Anthropic 服务包装成 Claude 可用接口
- 可以在一个地方管理认证、模型和用量

## 9. 一页式总结

如果只用一句话概括：

**这是一个把 Copilot、CodeBuddy 和通用 LLM 上游统一接入 Claude Code 的多协议 API 代理平台。**

它的核心业务不是“提供模型”，而是“让不同模型/不同供应商/不同协议可以被同一套客户端稳定使用”。
