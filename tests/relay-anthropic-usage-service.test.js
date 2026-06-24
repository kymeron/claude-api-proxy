import test from 'node:test';
import assert from 'node:assert/strict';
import {
    estimateRelayAnthropicInputTokens,
    handleRelayAnthropicUsageEvent
} from '../src/services/relay/anthropic-usage.js';

test('handleRelayAnthropicUsageEvent records stream usage and maximum cache hits', () => {
    const usageState = {
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 4,
        model: null
    };

    handleRelayAnthropicUsageEvent(
        'message_start',
        {
            message: {
                model: 'claude-sonnet',
                usage: {
                    input_tokens: 10,
                    output_tokens: 2,
                    cache_read_input_tokens: 3
                }
            }
        },
        usageState,
        {
            extractInputTokens: (usage) => usage.input_tokens + 1,
            extractCacheHitTokens: (usage) => usage.cache_read_input_tokens || 0
        }
    );
    handleRelayAnthropicUsageEvent(
        'content_block_delta',
        {
            usage: {
                output_tokens: 9,
                cache_read_input_tokens: 7
            }
        },
        usageState,
        {
            extractInputTokens: (usage) => usage.input_tokens || 0,
            extractCacheHitTokens: (usage) => usage.cache_read_input_tokens || 0
        }
    );

    assert.deepEqual(usageState, {
        inputTokens: 11,
        outputTokens: 9,
        cacheHitTokens: 7,
        model: 'claude-sonnet'
    });
});

test('handleRelayAnthropicUsageEvent ignores events without usage', () => {
    const usageState = {
        inputTokens: 1,
        outputTokens: 2,
        cacheHitTokens: 3,
        model: 'old-model'
    };

    handleRelayAnthropicUsageEvent('ping', {}, usageState);

    assert.deepEqual(usageState, {
        inputTokens: 1,
        outputTokens: 2,
        cacheHitTokens: 3,
        model: 'old-model'
    });
});

test('estimateRelayAnthropicInputTokens includes system messages and tools', () => {
    const calls = [];
    const total = estimateRelayAnthropicInputTokens(
        {
            system: [{type: 'text', text: 'system rules'}],
            messages: [
                {role: 'user', content: 'hello'},
                {role: 'assistant', content: 'hi'}
            ],
            tools: [{name: 'read_file', input_schema: {type: 'object'}}]
        },
        {
            estimateMessageTokens: (messages) => {
                calls.push(messages);
                return messages.length * 10;
            }
        }
    );

    assert.equal(total, 40);
    assert.deepEqual(calls, [
        [
            {role: 'system', content: [{type: 'text', text: 'system rules'}]},
            {role: 'user', content: 'hello'},
            {role: 'assistant', content: 'hi'}
        ],
        [
            {
                role: 'tool',
                content: JSON.stringify({name: 'read_file', input_schema: {type: 'object'}})
            }
        ]
    ]);
});
