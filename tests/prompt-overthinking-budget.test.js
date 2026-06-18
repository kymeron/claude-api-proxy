import test from 'node:test';
import assert from 'node:assert/strict';
import {getBehaviorRulesForModel} from '../src/config/model-prompt-router.js';
import {normalizePayload} from '../src/transformer/shared-translator.js';
import {anthropicToOpenAI as relayAnthropicToOpenAI} from '../src/services/relay/translator.js';
import {anthropicToOpenAI as codebuddyAnthropicToOpenAI} from '../src/services/codebuddy/translator.js';
import {anthropicToOpenAI as copilotAnthropicToOpenAI} from '../src/services/copilot/anthropic-translator.js';

const MODELS = ['glm-5.2', 'deepseek-v4-pro', 'kimi-k2', 'minimax-text-01', 'unknown-model'];

test('model behavior rules avoid fixed-depth reasoning and mandatory planning triggers', () => {
    for (const model of MODELS) {
        const rules = getBehaviorRulesForModel(model);
        assert.doesNotMatch(rules, /推理深度|5-10步|工具返回后必须先.*思考|主动寻找自己推理中的漏洞/);
        assert.doesNotMatch(rules, /禁止跳过规划|plan mode|拆分子 Agent|superpowers skill/);
    }
});

test('model behavior rules keep concise output guidance', () => {
    for (const model of MODELS) {
        const rules = getBehaviorRulesForModel(model);
        assert.match(rules, /中文/);
        assert.match(rules, /简洁|简短|少说/);
    }
});

test('normalizePayload does not default absent reasoning effort to high', () => {
    const normalized = normalizePayload({
        model: 'glm-5.2',
        messages: [{role: 'user', content: 'hello'}],
        stream: false
    });

    assert.equal(Object.hasOwn(normalized, 'reasoning_effort'), false);
});

test('normalizePayload preserves explicit reasoning effort and explicit disabled sentinel', () => {
    assert.equal(
        normalizePayload({model: 'glm-5.2', messages: [], reasoning_effort: 'medium'}).reasoning_effort,
        'medium'
    );
    assert.equal(
        Object.hasOwn(normalizePayload({model: 'glm-5.2', messages: [], reasoning_effort: ''}), 'reasoning_effort'),
        false
    );
});

test('anthropic adaptive thinking maps to medium instead of high across entrypoints', () => {
    for (const convert of [relayAnthropicToOpenAI, codebuddyAnthropicToOpenAI, copilotAnthropicToOpenAI]) {
        const payload = convert({
            model: 'claude-sonnet-4',
            max_tokens: 1024,
            thinking: {type: 'adaptive'},
            messages: [{role: 'user', content: 'hello'}]
        });

        assert.equal(payload.reasoning_effort, 'medium');
    }
});
