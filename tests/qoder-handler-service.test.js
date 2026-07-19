/**
 * Qoder Handler 单元测试
 *
 * 直接调用 handler factory，注入 mock CLI 依赖（runCli / runCliStream），
 * 验证从 OpenAI/Anthropic 请求到响应输出的完整链路。
 * 不实际 spawn 子进程。
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createQoderChatCompletionsHandler} from '../src/services/qoder/chat-completions-handler.js';
import {createQoderAnthropicMessagesHandler} from '../src/services/qoder/anthropic-messages-handler.js';
import {anthropicToOpenAI, openAIToAnthropic} from '../src/services/qoder/anthropic-adapter.js';
import {sanitizeAnthropicPayload} from '../src/services/qoder/protocol-adapter.js';

function createMockRes() {
    const res = {
        status: null,
        headers: null,
        body: null,
        chunks: [],
        events: [],
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
        write(chunk) {
            const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            this.chunks.push(s);
            // 简单统计 event: xxx 行数（每个 Anthropic 事件一条 event:）
            const eventMatches = s.match(/event: \w+/g);
            if (eventMatches) {
                for (const em of eventMatches) {
                    const type = em.replace(/^event: /, '');
                    this.events.push({type, data: null});
                }
            }
        },
        end(data) {
            if (data) {
                this.body = typeof data === 'string' ? data : data.toString('utf8');
            }
        }
    };
    return res;
}

function createMockDeps({runCli, runCliStream}) {
    const recorded = [];
    const tenantManager = {
        getTenant: () => ({name: 'Test', username: 'tester'}),
        incrementApiCallCount: (...args) => recorded.push(['apiCall', args]),
        incrementTokenUsage: (...args) => recorded.push(['tokenUsage', args]),
        incrementCreditUsage: (...args) => recorded.push(['creditUsage', args]),
        recordDailyUsage: (...args) => recorded.push(['dailyUsage', args])
    };
    const recordUsage = (tenantId, inT, outT, cache, credit, upModel, clientModel) => {
        recorded.push(['recordUsage', {tenantId, inT, outT, cache, credit, upModel, clientModel}]);
    };
    const authenticateAndGetCredential = async () => ({
        credential: {bearer_token: 'test-pat', backend: 'cn'},
        tenantId: 1
    });
    return {
        tenantManager, recordUsage, authenticateAndGetCredential, recorded,
        runCli, runCliStream
    };
}

test('chat-completions - non-stream success', async () => {
    const deps = createMockDeps({
        runCli: async () => ({content: 'Hello from CLI', toolCalls: []})
    });
    const handler = createQoderChatCompletionsHandler({
        ...deps,
        sendOpenAIError: (res, status, msg) => {
            res.writeHead(status, {});
            res.end(JSON.stringify({error: {message: msg}}));
        },
        sendJson: (res, status, data) => {
            res.writeHead(status, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(data));
        },
        upstreamErrorStatus: (err) => err.status || 500,
        parseBody: async (req) => req.body,
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1'
    });

    const res = createMockRes();
    await handler({
        headers: {},
        body: JSON.stringify({
            model: 'auto',
            messages: [{role: 'user', content: 'Hi'}],
            stream: false
        })
    }, res);

    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.choices[0].message.content, 'Hello from CLI');
    assert.equal(data.choices[0].finish_reason, 'stop');
    assert.equal(data.usage.prompt_tokens > 0, true);
    assert.ok(deps.recorded.some(r => r[0] === 'recordUsage'));
});

test('chat-completions - non-stream tool calls', async () => {
    const deps = createMockDeps({
        runCli: async () => ({
            content: '',
            toolCalls: [{id: 'c1', name: 'search', arguments: {q: 'foo'}}]
        })
    });
    const handler = createQoderChatCompletionsHandler({
        ...deps,
        sendOpenAIError: () => {},
        sendJson: (res, status, data) => {
            res.writeHead(status, {});
            res.end(JSON.stringify(data));
        },
        upstreamErrorStatus: () => 500,
        parseBody: async (req) => req.body,
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1'
    });

    const res = createMockRes();
    await handler({
        headers: {},
        body: JSON.stringify({
            model: 'auto',
            messages: [{role: 'user', content: 'Hi'}],
            stream: false
        })
    }, res);

    const data = JSON.parse(res.body);
    assert.equal(data.choices[0].finish_reason, 'tool_calls');
    assert.equal(data.choices[0].message.tool_calls.length, 1);
    assert.equal(data.choices[0].message.tool_calls[0].function.name, 'search');
});

test('chat-completions - stream success', async () => {
    const deps = createMockDeps({
        runCliStream: async (opts, onDelta) => {
            onDelta({type: 'content', text: 'Hello '});
            onDelta({type: 'content', text: 'world'});
            return {content: 'Hello world', toolCalls: []};
        }
    });
    const handler = createQoderChatCompletionsHandler({
        ...deps,
        sendOpenAIError: () => {},
        sendJson: () => {},
        upstreamErrorStatus: () => 500,
        parseBody: async (req) => req.body,
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1'
    });

    const res = createMockRes();
    await handler({
        headers: {},
        body: JSON.stringify({
            model: 'auto',
            messages: [{role: 'user', content: 'Hi'}],
            stream: true
        })
    }, res);

    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    const joined = res.chunks.join('');
    assert.match(joined, /role.*assistant/);
    assert.match(joined, /Hello/);
    assert.match(joined, /world/);
    assert.match(joined, /\[DONE\]/);
});

test('chat-completions - stream tool calls', async () => {
    const deps = createMockDeps({
        runCliStream: async (opts, onDelta) => {
            onDelta({type: 'tool_call', toolCall: {id: 'c1', name: 'search', arguments: {q: 'foo'}}});
            return {content: '', toolCalls: [{id: 'c1', name: 'search', arguments: {q: 'foo'}}]};
        }
    });
    const handler = createQoderChatCompletionsHandler({
        ...deps,
        sendOpenAIError: () => {},
        sendJson: () => {},
        upstreamErrorStatus: () => 500,
        parseBody: async (req) => req.body,
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1'
    });

    const res = createMockRes();
    await handler({
        headers: {},
        body: JSON.stringify({
            model: 'auto',
            messages: [{role: 'user', content: 'Hi'}],
            stream: true
        })
    }, res);

    const joined = res.chunks.join('');
    assert.match(joined, /tool_calls/);
    assert.match(joined, /search/);
    assert.match(joined, /finish_reason.*tool_calls/);
});

test('chat-completions - auth failure', async () => {
    const tenantManager = {
        getTenant: () => null,
        incrementApiCallCount: () => {},
        incrementTokenUsage: () => {},
        incrementCreditUsage: () => {},
        recordDailyUsage: () => {}
    };
    const handler = createQoderChatCompletionsHandler({
        tenantManager,
        sendOpenAIError: (res, status, msg, type) => {
            res.writeHead(status, {});
            res.end(JSON.stringify({error: {message: msg, type}}));
        },
        sendJson: () => {},
        upstreamErrorStatus: () => 500,
        parseBody: async () => '{}',
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1',
        authenticateAndGetCredential: async () => ({error: {status: 401, message: 'Unauthorized'}}),
        recordUsage: () => {}
    });

    const res = createMockRes();
    await handler({headers: {}}, res);
    assert.equal(res.status, 401);
    const data = JSON.parse(res.body);
    assert.match(data.error.message, /Unauthorized/);
});

test('chat-completions - runCli throws handled', async () => {
    const deps = createMockDeps({
        runCli: async () => { throw new Error('CLI failed'); }
    });
    const handler = createQoderChatCompletionsHandler({
        ...deps,
        sendOpenAIError: (res, status, msg) => {
            res.writeHead(status, {});
            res.end(JSON.stringify({error: {message: msg}}));
        },
        sendJson: () => {},
        upstreamErrorStatus: () => 500,
        parseBody: async (req) => req.body,
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1'
    });

    const res = createMockRes();
    await handler({
        headers: {},
        body: JSON.stringify({model: 'auto', messages: [{role: 'user', content: 'Hi'}]})
    }, res);
    assert.equal(res.status, 500);
});

test('anthropic-messages - non-stream success', async () => {
    const deps = createMockDeps({
        runCli: async () => ({content: 'Anthropic reply', toolCalls: []})
    });
    const handler = createQoderAnthropicMessagesHandler({
        ...deps,
        sendAnthropicError: () => {},
        sendJson: (res, status, data) => {
            res.writeHead(status, {});
            res.end(JSON.stringify(data));
        },
        upstreamErrorStatus: () => 500,
        parseBody: async (req) => req.body,
        sanitizeAnthropicPayload: (p) => p,
        anthropicToOpenAI: (p) => ({
            messages: p.messages,
            model: p.model,
            max_tokens: p.max_tokens,
            stream: p.stream
        }),
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1',
        openAIToAnthropic: (r) => ({
            id: r.id,
            type: 'message',
            role: 'assistant',
            model: r.model,
            content: [{type: 'text', text: r.choices[0].message.content}],
            stop_reason: 'end_turn',
            usage: {input_tokens: 10, output_tokens: 5}
        })
    });

    const res = createMockRes();
    await handler({
        headers: {},
        body: JSON.stringify({
            model: 'auto',
            max_tokens: 100,
            messages: [{role: 'user', content: 'Hi'}],
            stream: false
        })
    }, res);

    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.type, 'message');
    assert.equal(data.content[0].text, 'Anthropic reply');
});

test('anthropic-messages - stream success', async () => {
    const deps = createMockDeps({
        runCliStream: async (opts, onDelta) => {
            onDelta({type: 'content', text: 'Stream'});
            onDelta({type: 'content', text: ' reply'});
            return {content: 'Stream reply', toolCalls: []};
        }
    });
    const handler = createQoderAnthropicMessagesHandler({
        ...deps,
        sendAnthropicError: () => {},
        sendJson: () => {},
        upstreamErrorStatus: () => 500,
        parseBody: async (req) => req.body,
        sanitizeAnthropicPayload: (p) => p,
        anthropicToOpenAI: (p) => ({
            messages: p.messages,
            model: p.model,
            stream: p.stream
        }),
        mapModelName: (m) => m,
        resolveConversationId: () => 'conv-1',
        openAIToAnthropic: () => ({})
    });

    const res = createMockRes();
    await handler({
        headers: {},
        body: JSON.stringify({
            model: 'auto',
            messages: [{role: 'user', content: 'Hi'}],
            stream: true
        })
    }, res);

    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    const joined = res.chunks.join('');
    assert.match(joined, /event: message_start/);
    assert.match(joined, /event: content_block_start/);
    assert.match(joined, /event: message_stop/);
});

test('anthropic-adapter - anthropicToOpenAI round-trip', () => {
    const openai = anthropicToOpenAI({
        model: 'auto',
        max_tokens: 100,
        messages: [{role: 'user', content: 'Hi'}]
    });
    assert.ok(openai.messages);
    assert.equal(openai.messages[0].role, 'user');
});