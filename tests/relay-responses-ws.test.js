import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProtocolAwareUrl,
    buildResponsesWebSocketHeaders,
    buildResponsesWebSocketUrl,
    isResponsesUpstream,
    isResponsesWebSocketUpstream
} from '../src/services/relay/api.js';
import {
    normalizeResponsesWebSocketMode,
    shouldUseResponsesWebSocketPassthrough
} from '../src/services/shared/responses-ws-mode.js';

test('responses_ws protocol is distinct from HTTP responses protocol', () => {
    assert.equal(isResponsesWebSocketUpstream({protocol: 'responses_ws'}), true);
    assert.equal(isResponsesUpstream({protocol: 'responses_ws'}), false);
    assert.equal(isResponsesUpstream({protocol: 'responses'}), true);
});

test('buildResponsesWebSocketUrl converts HTTP endpoint to WS endpoint', () => {
    assert.equal(
        buildResponsesWebSocketUrl({name: 'OpenAI', base_url: 'https://api.example.com/v1'}),
        'wss://api.example.com/v1/responses'
    );
    assert.equal(
        buildResponsesWebSocketUrl({name: 'Local', base_url: 'http://127.0.0.1:3080/v1'}),
        'ws://127.0.0.1:3080/v1/responses'
    );
});

test('buildResponsesWebSocketUrl preserves upstream query flags such as ws=true', () => {
    assert.equal(
        buildResponsesWebSocketUrl({name: 'Compat', base_url: 'https://api.example.com/v1?ws=true'}),
        'wss://api.example.com/v1/responses?ws=true'
    );
    assert.equal(
        buildResponsesWebSocketUrl({name: 'Compat', base_url: 'https://api.example.com/v1/responses?ws=true'}),
        'wss://api.example.com/v1/responses?ws=true'
    );
});

test('buildResponsesWebSocketUrl accepts already-WS upstream URLs', () => {
    assert.equal(
        buildResponsesWebSocketUrl({name: 'Compat', base_url: 'wss://api.example.com/v1/responses?ws=true'}),
        'wss://api.example.com/v1/responses?ws=true'
    );
});

test('buildResponsesWebSocketHeaders uses bearer API key and JSON headers', () => {
    const headers = buildResponsesWebSocketHeaders({name: 'OpenAI', api_key: 'sk-test'});

    assert.equal(headers.Authorization, 'Bearer sk-test');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers.Accept, 'application/json');
});

test('Anthropic Ark upstreams use bearer authentication', () => {
    const headers = buildResponsesWebSocketHeaders({
        name: 'Volc Ark',
        protocol: 'anthropic',
        base_url: 'https://ark.cn-beijing.volces.com/api/coding',
        api_key: 'ark-test'
    });

    assert.equal(headers.Authorization, 'Bearer ark-test');
    assert.equal(headers['x-api-key'], undefined);
});

test('Standard Anthropic upstreams keep x-api-key authentication', () => {
    const headers = buildResponsesWebSocketHeaders({
        name: 'Anthropic',
        protocol: 'anthropic',
        base_url: 'https://api.anthropic.com/v1',
        api_key: 'sk-ant-test'
    });

    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['x-api-key'], 'sk-ant-test');
});

test('Anthropic Ark coding base URL receives v1 messages path', () => {
    assert.equal(
        buildProtocolAwareUrl(
            {protocol: 'anthropic', base_url: 'https://ark.cn-beijing.volces.com/api/coding'},
            'messages'
        ),
        'https://ark.cn-beijing.volces.com/api/coding/v1/messages'
    );
});

test('Anthropic URL builder does not duplicate v1 or message endpoints', () => {
    assert.equal(
        buildProtocolAwareUrl(
            {protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1'},
            'messages'
        ),
        'https://api.anthropic.com/v1/messages'
    );
    assert.equal(
        buildProtocolAwareUrl(
            {protocol: 'anthropic', base_url: 'https://api.example.com/anthropic/v1/messages'},
            'messages'
        ),
        'https://api.example.com/anthropic/v1/messages'
    );
});

test('Responses WebSocket mode normalizes current and legacy values', () => {
    assert.equal(normalizeResponsesWebSocketMode('passthrough'), 'passthrough');
    assert.equal(normalizeResponsesWebSocketMode('ctx_pool'), 'ctx_pool');
    assert.equal(normalizeResponsesWebSocketMode('shared'), 'ctx_pool');
    assert.equal(normalizeResponsesWebSocketMode('dedicated'), 'ctx_pool');
    assert.equal(normalizeResponsesWebSocketMode('off'), 'off');
    assert.equal(normalizeResponsesWebSocketMode('unknown'), 'ctx_pool');
});

test('passthrough mode only applies to responses_ws upstreams', () => {
    assert.equal(
        shouldUseResponsesWebSocketPassthrough({protocol: 'responses_ws', ws_mode: 'passthrough'}),
        true
    );
    assert.equal(
        shouldUseResponsesWebSocketPassthrough({protocol: 'responses', ws_mode: 'passthrough'}),
        false
    );
    assert.equal(
        shouldUseResponsesWebSocketPassthrough({protocol: 'responses_ws', ws_mode: 'ctx_pool'}),
        false
    );
    assert.equal(
        shouldUseResponsesWebSocketPassthrough({protocol: 'responses_ws', base_url: 'https://api.example.com/v1?ws_mode=passthrough'}),
        true
    );
});
