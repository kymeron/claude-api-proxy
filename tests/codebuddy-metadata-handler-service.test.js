import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodebuddyMetadataHandlers} from '../src/services/codebuddy/metadata-handler.js';

function createResponse() {
    return {calls: []};
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    const deps = {
        calls,
        authenticateAndGetCredential: async () => ({
            credential: {id: 'cred-1'}
        }),
        getModels: async () => ({
            data: [{id: 'model-1', name: 'Model One'}]
        }),
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendAnthropicError: (res, status, message) => res.calls.push(['anthropic-error', status, message]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({messages: [{role: 'user', content: 'hello'}]}),
        sanitizeAnthropicPayload: (payload) => payload,
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
    return deps;
}

test('handleOpenAIModels returns auth errors without fetching models', async () => {
    const res = createResponse();
    let fetchedModels = false;
    const deps = createBaseDeps({
        authenticateAndGetCredential: async () => ({
            error: {status: 401, message: 'Unauthorized'}
        }),
        getModels: async () => {
            fetchedModels = true;
        }
    });
    const {handleOpenAIModels} = createCodebuddyMetadataHandlers(deps);

    await handleOpenAIModels({headers: {}}, res);

    assert.equal(fetchedModels, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', 'authentication_error']]);
});

test('handleOpenAIModels renders OpenAI model list shape', async () => {
    const res = createResponse();
    const {handleOpenAIModels} = createCodebuddyMetadataHandlers(createBaseDeps());

    await handleOpenAIModels({headers: {}}, res);

    assert.equal(res.calls[0][0], 'json');
    assert.equal(res.calls[0][1], 200);
    assert.equal(res.calls[0][2].object, 'list');
    assert.equal(res.calls[0][2].data[0].owned_by, 'codebuddy');
});

test('handleAnthropicCountTokens estimates token count from sanitized messages', async () => {
    const res = createResponse();
    const {handleAnthropicCountTokens} = createCodebuddyMetadataHandlers(createBaseDeps({
        sanitizeAnthropicPayload: (payload) => ({
            messages: [...payload.messages, {role: 'assistant', content: 'world'}]
        })
    }));

    await handleAnthropicCountTokens({headers: {}}, res);

    assert.equal(res.calls[0][0], 'json');
    assert.equal(res.calls[0][1], 200);
    assert.equal(typeof res.calls[0][2].input_tokens, 'number');
});

test('handleAnthropicModels renders Anthropic model list shape', async () => {
    const res = createResponse();
    const {handleAnthropicModels} = createCodebuddyMetadataHandlers(createBaseDeps());

    await handleAnthropicModels({headers: {}}, res);

    assert.deepEqual(res.calls[0], ['json', 200, {
        data: [{
            id: 'model-1',
            object: 'model',
            created: 0,
            owned_by: 'codebuddy',
            name: 'Model One',
            capabilities: {}
        }],
        object: 'list'
    }]);
});
