import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicToOpenAI as codebuddyAnthropicToOpenAI} from '../src/services/codebuddy/translator.js';
import {anthropicToOpenAI as relayAnthropicToOpenAI} from '../src/services/relay/translator.js';
import {UpstreamManager} from '../src/services/relay/upstream-manager.js';

function request(model) {
    return {
        model,
        messages: [{role: 'user', content: 'hello'}],
        max_tokens: 100
    };
}

test('model names pass through unchanged before upstream requests', () => {
    const cases = [
        'default',
        'best',
        'sonnet',
        'opus',
        'haiku',
        'opusplan',
        'sonnet[1m]',
        'opus[1m]',
        'deepseek-v4-pro[1m]'
    ];

    for (const model of cases) {
        assert.equal(codebuddyAnthropicToOpenAI(request(model)).model, model);
        assert.equal(relayAnthropicToOpenAI(request(model)).model, model);
    }
});

test('relay auto model fallback uses an advertised non-bare DeepSeek model for gpt requests', () => {
    const manager = new UpstreamManager({tenantId: 1});
    manager.upstreams = [{
        index: 0,
        model_auto: true,
        model_map: {},
        models: ['deepseek-v4-pro']
    }];

    assert.equal(manager.resolveModel('gpt-5', 0), 'deepseek-v4-pro');
});

test('relay auto model fallback no longer defaults gpt requests to bare deepseek-v4', () => {
    const manager = new UpstreamManager({tenantId: 1});
    manager.upstreams = [{
        index: 0,
        model_auto: true,
        model_map: {},
        models: []
    }];

    assert.equal(manager.resolveModel('gpt-5', 0), 'deepseek-v4-pro');
});
