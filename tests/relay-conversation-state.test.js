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
