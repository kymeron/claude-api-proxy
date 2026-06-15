# Relay 会话状态设计

## 目标

让 Relay 的 16 种协议组合都能正常工作。这里的协议包括 OpenAI Chat
Completions、OpenAI Responses HTTP、Responses WebSocket 和 Anthropic
Messages。

这套方案必须同时适用于本地部署和云端部署，不能写“云上专用”或“本地专用”的逻辑。每个
Relay 实例只根据三个信息做决定：

- 当前入口协议
- 当前活跃上游协议
- 当前实例是否能找到对应的会话状态

## 问题

Chat Completions 和 Anthropic Messages 通常会在每次请求里携带完整上下文。
Responses 和 Responses WebSocket 则可能只携带增量输入和
`previous_response_id`，并依赖 Responses 上游保存的历史状态来恢复上下文。

当前 Relay 的转换器只能转换请求里可见的 Responses input，无法凭空还原被省略的历史。
当活跃上游也是 Responses 或 Responses WebSocket 时，这通常没问题，因为上游可以自己解析
`previous_response_id`。但当活跃上游是 Chat Completions 或 Anthropic 时就会失败，因为这两类协议需要完整 messages。

这就是当前现象的根因：Responses/WS 上游优化后不报错了，但 Chat 和 Anthropic 上游又开始因为缺少历史字段报错。

## 设计

新增一个 Relay 通用的 `RelayConversationStore`。所有 Relay 实例都使用同一套逻辑，不区分本地和云上。

第一版使用内存存储即可，因为当前规模为个位数用户，部署目标已经调整为单实例。存储接口需要和具体实现解耦，后续如果重新扩容、需要重启恢复或更长时间保留，可以替换成 Redis 或数据库实现。

状态按 `tenantId + conversationKey` 保存短期会话，并额外维护
`response_id -> conversationKey` 索引。这样下一次 Responses 请求只带
`previous_response_id` 时，Relay 可以找到对应会话并恢复完整上下文。

Relay 内部不要把 Chat 或 Responses 当作唯一中间格式，而是维护一份自己的 canonical transcript。它至少包含：

- model 和会影响生成结果的请求参数
- system 或 instructions 内容
- 按顺序排列的消息历史
- content parts、reasoning、assistant output
- tool calls 和 tool results
- tools、tool_choice、parallel_tool_calls
- 已知的 Responses id 和对应完成输出
- 更新时间、过期时间、大小计数和裁剪信息

## 数据流

Chat Completions 入口通常自带完整 `messages`。Relay 收到后先转换成 canonical transcript，写入 store，再根据当前活跃上游协议进行格式化。

Anthropic 入口通常自带完整 `system`、`messages`、tools、tool_choice、thinking 和 tool block。Relay 收到后同样先转换成 canonical transcript，写入 store，再进入上游调用。

Responses HTTP 和 Responses WebSocket 入口需要先检查是否带有
`previous_response_id`：

- 如果 store 中能找到对应状态，Relay 先恢复旧 transcript，再追加这次请求里的新 input。
- 如果找不到状态，Relay 暂时只能保留本次请求可见 input，是否足够继续由上游协议决定。
- 如果当前活跃上游是 Responses 或 Responses WebSocket，可以继续透传增量请求，因为下一跳 Responses-capable 上游可能有状态。
- 如果当前活跃上游是 Chat 或 Anthropic，必须返回 `state_missing`，不能发送一个丢历史的请求。

每次上游成功返回后，Relay 都需要把 assistant 输出写回 canonical transcript：

- 如果上游返回 Responses id，把该 id 映射回当前会话。
- 如果上游是 Chat 或 Anthropic，把转换后的 assistant message、tool call、reasoning 和 usage 相关输出写回状态。
- 如果是流式响应，在完成事件或结束阶段写入最终输出。

## 上游格式化规则

当活跃上游是 Responses HTTP 或 Responses WebSocket 时，Relay 可以继续保留 Responses 的增量能力。也就是说，它可以继续发送
`previous_response_id`，并继续使用现有 Responses WebSocket context pool。

当活跃上游是 Chat Completions 或 Anthropic 时，Relay 必须从已经恢复的 canonical transcript 生成完整请求：

- Chat 上游需要完整 `messages`
- Anthropic 上游需要完整 `system` 和 `messages`
- 不能只把当前 Responses input item 临时转换后发上游

这个规则只由“目标上游协议”触发，和当前实例部署在本地还是云上无关。

## 错误处理

如果状态缺失，但当前活跃上游是 Responses 或 Responses WebSocket，Relay 可以继续透传。因为下一层 Responses-capable Relay 或最终模型服务可能能解析
`previous_response_id`。

如果状态缺失，且当前活跃上游是 Chat 或 Anthropic，Relay 必须在调用上游前失败，并返回明确错误：

- OpenAI 形态的 HTTP 路由返回 OpenAI 风格错误，code 为 `state_missing`
- Anthropic 形态的 HTTP 路由返回 Anthropic 风格错误，code 为 `state_missing`
- Responses WebSocket 路由发送 `error` 事件，code 为 `state_missing`

状态过期是正常情况，不应当伪装成上游错误。日志级别建议用 info 或 debug。

## 测试

实现前先补失败测试，至少覆盖：

- Responses HTTP -> Chat，带 `previous_response_id` 时能使用已存历史
- Responses HTTP -> Anthropic，带 `previous_response_id` 时能使用已存历史
- Responses WebSocket -> Chat，带 `previous_response_id` 时能使用已存历史
- Responses WebSocket -> Anthropic，带 `previous_response_id` 时能使用已存历史
- 状态缺失时，Chat 和 Anthropic 上游会返回 `state_missing`
- 状态缺失时，Responses 和 Responses WebSocket 上游仍可透传
- Chat 入口会更新同一份 store，供后续 Responses 入口恢复
- Anthropic 入口会更新同一份 store，供后续 Responses 入口恢复
- `response.completed` 里的 response id 会映射回 canonical conversation

验证顺序建议：

1. 先跑新增的 conversation state 单元测试。
2. 再跑 relay 和 Responses WebSocket 相关测试。
3. 最后跑完整 `npm test`。
