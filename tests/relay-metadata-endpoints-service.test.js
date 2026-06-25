import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayMetadataHandlers} from '../src/services/relay/metadata-endpoints.js';

function createResponse() {
    return {calls: []};
}

function createHandlers(overrides = {}) {
    const logs = [];
    const deps = {
        authenticateAndGetUpstream: async () => ({
            upstream: {protocol: 'chat', index: 0},
            tenantId: 42
        }),
        getUpstreamModels: async () => ({data: [{id: 'gpt-test'}]}),
        getAnthropicRequestHeaders: () => ({'anthropic-version': '2023-06-01'}),
        isAnthropicUpstream: (upstream) => upstream?.protocol === 'anthropic',
        isResponsesUpstream: (upstream) => upstream?.protocol === 'responses',
        isResponsesWebSocketUpstream: (upstream) => upstream?.protocol === 'responses_ws',
        createAnthropicCountTokens: (payload, upstream, headers) => ({payload, upstream, headers}),
        callUpstream: async (upstream, invoke) => ({
            response: {body: '{"input_tokens":123}'},
            request: invoke(upstream)
        }),
        readResponseBody: async (body) => body,
        parseBody: async (req) => JSON.stringify(req.body ?? {}),
        sanitizeAnthropicPayload: (payload) => ({...payload, sanitized: true}),
        mapAnthropicModelsToOpenAI: (models) => ({mapped: 'anthropic-to-openai', models}),
        mapOpenAIModelsToAnthropic: (models) => ({mapped: 'openai-to-anthropic', models}),
        getProtocolErrorMessage: () => 'protocol mismatch',
        upstreamErrorStatus: (error) => error.status || 500,
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendAnthropicError: (res, status, message) => res.calls.push(['anthropic-error', status, message]),
        logger: {error: (...args) => logs.push(args)},
        ...overrides
    };

    return {
        logs,
        deps,
        handlers: createRelayMetadataHandlers(deps)
    };
}

test('handleOpenAIModels maps Anthropic upstream model lists to OpenAI shape', async () => {
    const res = createResponse();
    const {handlers} = createHandlers({
        authenticateAndGetUpstream: async () => ({upstream: {protocol: 'anthropic'}})
    });

    await handlers.handleOpenAIModels({}, res);

    assert.deepEqual(res.calls, [[
        'json',
        200,
        {
            mapped: 'anthropic-to-openai',
            models: {data: [{id: 'gpt-test'}]}
        }
    ]]);
});

test('handleAnthropicModels maps OpenAI model lists to Anthropic shape', async () => {
    const res = createResponse();
    const {handlers} = createHandlers();

    await handlers.handleAnthropicModels({}, res);

    assert.deepEqual(res.calls, [[
        'json',
        200,
        {
            mapped: 'openai-to-anthropic',
            models: {data: [{id: 'gpt-test'}]}
        }
    ]]);
});

test('handleAnthropicCountTokens passes Anthropic upstream requests through', async () => {
    const res = createResponse();
    const seen = {};
    const {handlers} = createHandlers({
        authenticateAndGetUpstream: async () => ({upstream: {protocol: 'anthropic', name: 'claude'}}),
        createAnthropicCountTokens: (payload, upstream, headers) => {
            seen.payload = payload;
            seen.upstream = upstream;
            seen.headers = headers;
            return {payload, upstream, headers};
        }
    });

    await handlers.handleAnthropicCountTokens({body: {messages: [{role: 'user', content: 'hello'}]}}, res);

    assert.deepEqual(seen.payload, {
        messages: [{role: 'user', content: 'hello'}],
        sanitized: true
    });
    assert.equal(seen.upstream.name, 'claude');
    assert.deepEqual(seen.headers, {'anthropic-version': '2023-06-01'});
    assert.deepEqual(res.calls, [['json', 200, {input_tokens: 123}]]);
});

test('handleAnthropicCountTokens estimates Chat upstream token counts locally', async () => {
    const res = createResponse();
    const messages = [{role: 'user', content: 'hello world'}];
    const {handlers} = createHandlers();

    await handlers.handleAnthropicCountTokens({body: {messages}}, res);

    assert.deepEqual(res.calls, [[
        'json',
        200,
        {input_tokens: Math.ceil(JSON.stringify(messages).length / 4)}
    ]]);
});

test('handleAnthropicCountTokens rejects Responses upstreams', async () => {
    const res = createResponse();
    const {handlers} = createHandlers({
        authenticateAndGetUpstream: async () => ({upstream: {protocol: 'responses'}})
    });

    await handlers.handleAnthropicCountTokens({body: {messages: []}}, res);

    assert.deepEqual(res.calls, [['anthropic-error', 400, 'protocol mismatch']]);
});
