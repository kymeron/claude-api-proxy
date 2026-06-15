# Relay 会话状态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Relay 增加通用短期会话状态，让 Responses/Responses WebSocket 入口在转到 Chat 或 Anthropic 上游时能恢复完整上下文。

**Architecture:** 新增 `RelayConversationStore` 作为 relay 通用内存状态层，不区分本地和云端。Chat/Anthropic 入口写入完整 chat-shaped canonical transcript；Responses/WS 入口在需要全量上下文时用 `previous_response_id` hydrate，再按当前上游协议格式化。Responses-capable 上游继续允许增量透传。

**Tech Stack:** Node.js ESM、`node:test`、现有 Relay route/converter、现有 Responses WS server/client。

---

## 文件结构

- Create: `src/services/relay/conversation-state.js`
  - 负责短期会话状态、`response_id -> conversationKey` 索引、Responses 请求 hydrate、assistant 输出记录。
- Create: `tests/relay-conversation-state.test.js`
  - 覆盖 store、hydrate、state_missing、response id 映射。
- Modify: `src/routes/relay.js`
  - 在 Chat/Anthropic/Responses/Responses WS 入口接入状态读写。
  - 在 Chat/Anthropic 目标上游前强制 hydrate。
  - 在上游响应完成后记录 response id 和 assistant 输出。
- Modify: `src/transformer/responses-translator.js`
  - 保持现有 converter 公开行为不变；本计划当前不需要修改该文件，验证时确认无需新增导出。
- Modify: `tests/responses-ws-stream-bridge.test.js`
  - 增加 WS 增量请求 hydrate 到 Chat/Anthropic 的覆盖。

## Task 1: 会话状态单元测试

**Files:**
- Create: `tests/relay-conversation-state.test.js`
- Create: `src/services/relay/conversation-state.js`

- [ ] **Step 1: 写失败测试**

在 `tests/relay-conversation-state.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RelayConversationStore,
    RelayStateMissingError
} from '../src/services/relay/conversation-state.js';

test('hydrateResponsesForFullHistory appends Responses input to stored chat history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'system', content: 'You are concise.'},
                {role: 'user', content: 'first question'}
            ],
            tools: [{type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}],
            tool_choice: 'auto'
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey: undefined,
        request: {
            model: 'client-model',
            previous_response_id: 'resp_1',
            input: [{role: 'user', content: [{type: 'input_text', text: 'second question'}]}],
            stream: false
        }
    });

    assert.equal(hydrated.conversationKey, conversationKey);
    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'system', content: 'You are concise.'},
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'},
        {role: 'user', content: 'second question'}
    ]);
    assert.deepEqual(hydrated.chatRequest.tools, [
        {type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}
    ]);
    assert.equal(hydrated.chatRequest.tool_choice, 'auto');
});

test('hydrateResponsesForFullHistory throws state_missing when previous response is unknown', () => {
    const store = new RelayConversationStore({ttlMs: 60_000});

    assert.throws(
        () => store.hydrateResponsesForFullHistory({
            tenantId: 'tenant-a',
            conversationKey: 'conv-a',
            request: {
                model: 'client-model',
                previous_response_id: 'resp_missing',
                input: 'continue'
            }
        }),
        RelayStateMissingError
    );
});

test('prepareResponsesPassthrough leaves unknown previous_response_id untouched', () => {
    const store = new RelayConversationStore({ttlMs: 60_000});
    const result = store.prepareResponsesPassthrough({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {
            model: 'client-model',
            previous_response_id: 'resp_remote',
            input: 'continue'
        }
    });

    assert.equal(result.request.previous_response_id, 'resp_remote');
    assert.equal(result.conversationKey, 'conv-a');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/relay-conversation-state.test.js`

Expected: FAIL，错误为 `Cannot find module '../src/services/relay/conversation-state.js'`。

## Task 2: 实现 RelayConversationStore

**Files:**
- Create: `src/services/relay/conversation-state.js`
- Test: `tests/relay-conversation-state.test.js`

- [ ] **Step 1: 写最小实现**

创建 `src/services/relay/conversation-state.js`，导出：

```js
import {responsesRequestToChat, responsesResponseToChat} from '../../transformer/responses-translator.js';

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

export class RelayStateMissingError extends Error {
    constructor(previousResponseId) {
        super(`Missing relay conversation state for previous_response_id=${previousResponseId}`);
        this.name = 'RelayStateMissingError';
        this.code = 'state_missing';
        this.previousResponseId = previousResponseId;
    }
}

export class RelayConversationStore {
    constructor({ttlMs = DEFAULT_TTL_MS, now = () => Date.now()} = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.conversations = new Map();
        this.responseIndex = new Map();
    }

    saveChatRequest({tenantId, conversationKey, request}) {
        const key = this._conversationKey(tenantId, conversationKey);
        if (!key || !request) return null;
        const state = {
            tenantId,
            conversationKey,
            chatRequest: cloneChatRequest(request),
            responses: new Set(),
            updatedAt: this.now()
        };
        this.conversations.set(key, state);
        return cloneState(state);
    }

    hydrateResponsesForFullHistory({tenantId, conversationKey, request}) {
        const previousResponseId = normalizeId(request?.previous_response_id);
        let state = null;
        if (previousResponseId) {
            state = this._getByResponseId(tenantId, previousResponseId);
            if (!state) throw new RelayStateMissingError(previousResponseId);
        } else {
            state = this._getByConversationKey(tenantId, conversationKey);
        }

        const visibleChat = responsesRequestToChat(request || {});
        const base = state?.chatRequest ? cloneChatRequest(state.chatRequest) : {model: request?.model, messages: []};
        const chatRequest = mergeChatRequests(base, visibleChat, request);
        const resolvedConversationKey = state?.conversationKey || conversationKey;
        if (resolvedConversationKey) {
            this.saveChatRequest({tenantId, conversationKey: resolvedConversationKey, request: chatRequest});
        }
        return {conversationKey: resolvedConversationKey, chatRequest};
    }

    prepareResponsesPassthrough({tenantId, conversationKey, request}) {
        const previousResponseId = normalizeId(request?.previous_response_id);
        const state = previousResponseId ? this._getByResponseId(tenantId, previousResponseId) : null;
        return {
            conversationKey: state?.conversationKey || conversationKey,
            request: {...request}
        };
    }

    recordResponsesResponse({tenantId, conversationKey, response}) {
        if (!response || !conversationKey) return null;
        const key = this._conversationKey(tenantId, conversationKey);
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const chatResponse = responsesResponseToChat(response);
        const nextRequest = appendAssistantFromChatResponse(existing?.chatRequest, chatResponse);
        const state = {
            tenantId,
            conversationKey,
            chatRequest: nextRequest,
            responses: new Set(existing?.responses || []),
            updatedAt: this.now()
        };
        if (response.id) {
            state.responses.add(response.id);
            this.responseIndex.set(this._responseKey(tenantId, response.id), key);
        }
        this.conversations.set(key, state);
        return cloneState(state);
    }

    recordChatResponse({tenantId, conversationKey, response}) {
        if (!response || !conversationKey) return null;
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const nextRequest = appendAssistantFromChatResponse(existing?.chatRequest, response);
        return this.saveChatRequest({tenantId, conversationKey, request: nextRequest});
    }

    _getByConversationKey(tenantId, conversationKey) {
        const key = this._conversationKey(tenantId, conversationKey);
        if (!key) return null;
        const state = this.conversations.get(key);
        if (!state) return null;
        if (this.now() - state.updatedAt > this.ttlMs) {
            this.conversations.delete(key);
            return null;
        }
        return state;
    }

    _getByResponseId(tenantId, responseId) {
        const stateKey = this.responseIndex.get(this._responseKey(tenantId, responseId));
        if (!stateKey) return null;
        const state = this.conversations.get(stateKey);
        if (!state || this.now() - state.updatedAt > this.ttlMs) return null;
        return state;
    }

    _conversationKey(tenantId, conversationKey) {
        if (!tenantId || !conversationKey) return null;
        return `${tenantId}:${conversationKey}`;
    }

    _responseKey(tenantId, responseId) {
        return `${tenantId}:${responseId}`;
    }
}

export const relayConversationStore = new RelayConversationStore();

function normalizeId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cloneChatRequest(request) {
    return clone(request) || {messages: []};
}

function cloneState(state) {
    return {...state, chatRequest: cloneChatRequest(state.chatRequest), responses: new Set(state.responses || [])};
}

function mergeChatRequests(base, visibleChat, originalResponsesRequest) {
    const messages = [...(base.messages || []), ...(visibleChat.messages || [])];
    return {
        ...base,
        ...visibleChat,
        model: visibleChat.model || originalResponsesRequest?.model || base.model,
        messages,
        stream: originalResponsesRequest?.stream
    };
}

function appendAssistantFromChatResponse(existingRequest, chatResponse) {
    const base = cloneChatRequest(existingRequest || {model: chatResponse?.model, messages: []});
    const message = chatResponse?.choices?.[0]?.message;
    if (message) {
        base.messages = [...(base.messages || []), clone(message)];
    }
    return base;
}
```

- [ ] **Step 2: 运行 store 测试**

Run: `node --test tests/relay-conversation-state.test.js`

Expected: PASS。

- [ ] **Step 3: 提交**

Run:

```bash
git add -- src/services/relay/conversation-state.js tests/relay-conversation-state.test.js
git commit -m "Add relay conversation state store"
```

## Task 3: Responses HTTP 到 Chat/Anthropic 的 hydrate

**Files:**
- Modify: `src/routes/relay.js`
- Test: `tests/relay-conversation-state.test.js`

- [ ] **Step 1: 增加路由级失败测试 helper**

在 `tests/relay-conversation-state.test.js` 追加纯函数级测试，先不启动 HTTP server：

```js
test('hydrated Responses request can be formatted for Anthropic with full history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000});
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first'}],
            tools: [{type: 'function', function: {name: 'lookup', parameters: {type: 'object'}}}]
        }
    });
    store.recordResponsesResponse({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        response: {
            id: 'resp_1',
            output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'answer'}]}]
        }
    });

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId: 'tenant-a',
        request: {model: 'client-model', previous_response_id: 'resp_1', input: 'next'}
    });

    assert.deepEqual(hydrated.chatRequest.messages.map(m => m.role), ['user', 'assistant', 'user']);
});
```

- [ ] **Step 2: 在 `src/routes/relay.js` 导入 store**

在 imports 中加入：

```js
import {
    RelayStateMissingError,
    relayConversationStore
} from '../services/relay/conversation-state.js';
```

- [ ] **Step 3: 增加 state_missing 响应 helper**

在 `sendOpenAIError` / `sendAnthropicError` 附近加入：

```js
function sendStateMissingOpenAIError(res, error) {
    sendJson(res, 400, {
        error: {
            message: error.message,
            type: 'invalid_request_error',
            code: 'state_missing'
        }
    });
}
```

WS 路径使用 `ResponsesWebSocketError` 风格事件，不在这里发送 HTTP。

- [ ] **Step 4: 改 `handleResponsesAPI` 的 Anthropic 分支**

把当前：

```js
const chatReq = responsesRequestToChat(responsesReq);
```

替换为：

```js
const conversationKey = extractConversationKey(req, responsesReq, {tenantId});
const hydrated = relayConversationStore.hydrateResponsesForFullHistory({
    tenantId,
    conversationKey,
    request: responsesReq
});
const chatReq = hydrated.chatRequest;
```

同一分支里的 `relayMeta.conversationKey` 使用 `hydrated.conversationKey || conversationKey`。

- [ ] **Step 5: 改 `handleResponsesAPI` 的 Chat 分支**

把默认 OpenAI Chat 上游分支里的：

```js
const chatReq = responsesRequestToChat(responsesReq);
```

替换为同样的 hydrate 逻辑：

```js
const conversationKey = extractConversationKey(req, responsesReq, {tenantId});
const hydrated = relayConversationStore.hydrateResponsesForFullHistory({
    tenantId,
    conversationKey,
    request: responsesReq
});
const chatReq = hydrated.chatRequest;
```

- [ ] **Step 6: state_missing catch**

在 `handleResponsesAPI` catch 开头加入：

```js
if (error instanceof RelayStateMissingError) {
    sendStateMissingOpenAIError(res, error);
    return;
}
```

- [ ] **Step 7: 运行测试**

Run: `node --test tests/relay-conversation-state.test.js`

Expected: PASS。

## Task 4: Chat/Anthropic 入口写入状态，非流式响应写回状态

**Files:**
- Modify: `src/routes/relay.js`
- Test: `tests/relay-conversation-state.test.js`

- [ ] **Step 1: Chat 入口保存请求**

在 `handleOpenAIChatCompletions` 中 `openAIPayload.messages = stripDynamicReminders(...)` 后加入：

```js
const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
relayConversationStore.saveChatRequest({
    tenantId,
    conversationKey,
    request: openAIPayload
});
```

该函数后面已有 `conversationKey` 变量时，移动现有声明到保存请求之前，保证同一作用域只声明一次。

- [ ] **Step 2: Chat 非流式响应写回**

在 Chat passthrough 非流式发送前加入：

```js
relayConversationStore.recordChatResponse({
    tenantId,
    conversationKey,
    response: parsed
});
```

Chat -> Responses/Responses WS 非流式分支在拿到 `completedResponse` 后加入：

```js
relayConversationStore.recordResponsesResponse({
    tenantId,
    conversationKey,
    response: completedResponse
});
```

- [ ] **Step 3: Anthropic 入口保存请求**

在 `handleAnthropicMessages` 将 Anthropic 转成 `openAIPayload` 并完成 inject/strip 后加入：

```js
const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
relayConversationStore.saveChatRequest({
    tenantId,
    conversationKey,
    request: openAIPayload
});
```

Anthropic passthrough 分支如果没有 `openAIPayload`，用 `anthropicToOpenAI(anthropicPayload, relayStatsModel)` 生成一份仅用于状态记录的 chat-shaped request。

- [ ] **Step 4: Anthropic 非流式响应写回**

Anthropic -> Chat 上游聚合得到 `chatResponse` 后调用：

```js
relayConversationStore.recordChatResponse({
    tenantId,
    conversationKey,
    response: chatResponse
});
```

Anthropic -> Responses/Responses WS 非流式拿到 `completedResponse` 或 `parsed` 后调用 `recordResponsesResponse`。

- [ ] **Step 5: 运行现有转换测试**

Run: `node --test tests/auxiliary-endpoints-and-thinking.test.js tests/responses-input-sanitize.test.js tests/relay-conversation-state.test.js`

Expected: PASS。

## Task 5: Responses HTTP/WS 上游透传时记录 response id

**Files:**
- Modify: `src/routes/relay.js`
- Test: `tests/relay-conversation-state.test.js`

- [ ] **Step 1: Responses HTTP 非流式记录**

在 `handleResponsesAPI` 的 `isResponsesUpstream(upstream)` 非流式分支，`const parsed = JSON.parse(responseBody);` 后加入：

```js
relayConversationStore.recordResponsesResponse({
    tenantId,
    conversationKey,
    response: parsed
});
```

- [ ] **Step 2: Responses HTTP 流式记录**

在解析 `response.completed` 的 data 时，除了 usage 外保存完整 response：

```js
let completedResponse = null;
...
const completed = JSON.parse(data).response;
usage = completed?.usage || usage;
completedResponse = completed || completedResponse;
...
if (completedResponse) {
    relayConversationStore.recordResponsesResponse({tenantId, conversationKey, response: completedResponse});
}
```

- [ ] **Step 3: Responses WS 非流式记录**

在 `collectResponsesWebSocketResponse(wsResult)` 返回后加入：

```js
relayConversationStore.recordResponsesResponse({
    tenantId,
    conversationKey: extractConversationKey(req, responsesReq, {tenantId}),
    response: completedResponse
});
```

- [ ] **Step 4: Responses WS 流式记录**

在 WS event loop 中捕获 `response.completed`：

```js
let completedResponse = null;
...
if (event.type === 'response.completed') {
    completedResponse = event.data?.response || completedResponse;
}
...
if (completedResponse) {
    relayConversationStore.recordResponsesResponse({tenantId, conversationKey, response: completedResponse});
}
```

- [ ] **Step 5: 运行 Responses 相关测试**

Run: `node --test tests/relay-responses-ws.test.js tests/responses-ws-stream-bridge.test.js tests/relay-conversation-state.test.js`

Expected: PASS。

## Task 6: Responses WebSocket 到 Chat/Anthropic 的 hydrate 和错误事件

**Files:**
- Modify: `src/routes/relay.js`
- Test: `tests/responses-ws-stream-bridge.test.js`

- [ ] **Step 1: 在 `_relayWSHandleRequest` Anthropic 分支 hydrate**

把：

```js
const chatReq = responsesRequestToChat({...payload, model: resolvedModel, stream: true});
```

替换为：

```js
const hydrated = relayConversationStore.hydrateResponsesForFullHistory({
    tenantId,
    conversationKey,
    request: {...payload, model: resolvedModel, stream: true}
});
const chatReq = hydrated.chatRequest;
```

- [ ] **Step 2: 在 `_relayWSHandleRequest` Chat 分支 hydrate**

把默认 Chat 上游分支里的：

```js
const chatReq = responsesRequestToChat({...payload, model: resolvedModel});
```

替换为同样 hydrate 逻辑，并保留 `chatReq.stream = true`。

- [ ] **Step 3: WS state_missing 转 error event**

在 `_relayWSHandleRequest` 中捕获 `RelayStateMissingError` 时抛出：

```js
throw Object.assign(error, {
    name: 'ResponsesWebSocketError',
    event: {
        type: 'error',
        error: {
            message: error.message,
            code: 'state_missing'
        }
    }
});
```

- [ ] **Step 4: 增加 WS 测试**

在 `tests/responses-ws-stream-bridge.test.js` 增加：

```js
test('Responses WS missing state error uses state_missing code', async () => {
    const error = new RelayStateMissingError('resp_missing');
    assert.equal(error.code, 'state_missing');
});
```

这个测试约束错误类型；同一个任务中的 WS route 改动负责把该错误转换为 WebSocket `error` 事件。

- [ ] **Step 5: 运行 WS 相关测试**

Run: `node --test tests/responses-ws-stream-bridge.test.js tests/relay-conversation-state.test.js`

Expected: PASS。

## Task 7: 全矩阵回归和文档校准

**Files:**
- Modify: `README.md`
- Modify: `本地安装部署.md`

- [ ] **Step 1: README 增加状态说明**

在 Relay 协议支持段落增加：

```md
- Relay 会维护短期会话状态，用于 Responses/Responses WebSocket 增量请求转到 Chat 或 Anthropic 上游时恢复完整上下文。状态按租户和会话隔离，默认使用内存存储，重启后会丢失。
```

- [ ] **Step 2: 本地安装部署增加状态说明**

在 Relay 协议说明附近加入同样含义的中文说明，强调当前推荐单实例部署；未来重新扩容时再引入共享存储。

- [ ] **Step 3: 跑目标测试**

Run:

```bash
node --test tests/relay-conversation-state.test.js tests/relay-responses-ws.test.js tests/responses-ws-stream-bridge.test.js tests/responses-ws-client.test.js tests/responses-ws-passthrough.test.js tests/responses-input-sanitize.test.js
```

Expected: PASS。

- [ ] **Step 4: 跑完整测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 5: 提交实现**

Run:

```bash
git add -- src/services/relay/conversation-state.js src/routes/relay.js src/transformer/responses-translator.js tests/relay-conversation-state.test.js tests/responses-ws-stream-bridge.test.js README.md 本地安装部署.md
git commit -m "Add relay conversation state hydration"
```

## 自检

- Spec 覆盖：计划覆盖了短期状态、统一本地/云端逻辑、Responses hydrate、Chat/Anthropic 强制全量、Responses 透传、state_missing、测试和文档。
- 占位扫描：计划中没有占位词、未定义实现步骤或含糊测试要求。
- 类型一致性：核心类型固定为 `RelayConversationStore`、`RelayStateMissingError`、`relayConversationStore`、`hydrateResponsesForFullHistory`、`prepareResponsesPassthrough`、`recordResponsesResponse`、`recordChatResponse`。
