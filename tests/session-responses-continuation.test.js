import test from 'node:test';
import assert from 'node:assert/strict';
import {RelayConversationStore} from '../src/services/session/conversation-state.js';
import {prepareResponsesContinuationPayload} from '../src/services/session/responses-continuation.js';

test('prepareResponsesContinuationPayload limits converted full-history input using stored response id', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first question'}]
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

    const input = [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        ...Array.from({length: 1200}, (_, i) => ({role: 'user', content: `message ${i}`}))
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', input},
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.conversationKey, conversationKey);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.equal(result.request.input.length, 500);
    assert.equal(result.request.input[0].content, 'message 700');
    assert.equal(result.request.input.at(-1).content, 'message 1199');
    assert.equal(result.autoLink, true);
});

test('prepareResponsesContinuationPayload sends only new input after previous response history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first question'}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    // The relay handlers save Claude Code's full-history messages before preparing
    // the Responses continuation. The previous response coverage must survive that save.
    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'},
                {role: 'user', content: 'second question'}
            ]
        }
    });

    const fullHistoryInput = [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', input: fullHistoryInput},
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
});

test('prepareResponsesContinuationPayload disables websocket auto-link when stored input is not a prefix', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first question'}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [{role: 'user', content: [{type: 'input_text', text: 'unrelated fresh history'}]}]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, false);
    assert.equal(result.autoLink, false);
    assert.equal('previous_response_id' in result.request, false);
    assert.match(logs.join('\n'), /delta input mismatch; websocket auto-link disabled/);
});

test('prepareResponsesContinuationPayload tolerates clients omitting already-covered assistant output', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first question'}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
});

test('prepareResponsesContinuationPayload does not delta when covered assistant output diverges', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first question'}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'rewritten first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal('previous_response_id' in result.request, false);
    assert.equal(result.deltaApplied, false);
    assert.equal(result.autoLink, false);
});
