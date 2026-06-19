import test from 'node:test';
import assert from 'node:assert/strict';
import {convertResponsesUsageToChat} from '../src/transformer/responses-translator.js';

/* convertUsage 是模块私有函数，通过 convertResponsesUsageToChat 间接验证双向映射：
   Chat→Responses→Chat 往返后 cache_creation 应保持不变。 */

test('convertResponsesUsageToChat 从 Responses usage 提取 cache_creation_tokens', () => {
    const chatUsage = convertResponsesUsageToChat({
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        input_tokens_details: {cached_tokens: 300, cache_creation_tokens: 800}
    });
    assert.equal(chatUsage.prompt_tokens_details.cache_creation_tokens, 800);
    assert.equal(chatUsage.prompt_tokens_details.cached_tokens, 300);
});

test('convertResponsesUsageToChat 在 cache_creation 缺失时返回 0', () => {
    const chatUsage = convertResponsesUsageToChat({
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: {cached_tokens: 100}
    });
    assert.equal(chatUsage.prompt_tokens_details.cache_creation_tokens, 0);
});

/* Chat→Responses 映射通过 chatChunkToResponsesEvents 生成 response.completed 间接验证：
   构造一个带 cache_creation_tokens 的最终 Chat chunk，断言输出的 response.completed.usage
   携带 input_tokens_details.cache_creation_tokens。 */
test('Chat→Responses 转换保留 cache_creation_tokens 到 input_tokens_details', async () => {
    const {chatChunkToResponsesEvents, createResponsesStreamState} = await import('../src/transformer/responses-translator.js');
    const state = createResponsesStreamState();
    // 先发一个带内容的 delta 触发 message 生命周期，再发带 usage 的最终 chunk
    chatChunkToResponsesEvents({
        id: 'chatcmpl_1', object: 'chat.completion.chunk',
        choices: [{index: 0, delta: {content: 'hi'}, finish_reason: null}]
    }, state);
    const events = chatChunkToResponsesEvents({
        id: 'chatcmpl_1', object: 'chat.completion.chunk',
        choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
        usage: {
            prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500,
            prompt_tokens_details: {cached_tokens: 300, cache_creation_tokens: 800}
        }
    }, state);
    const completed = events.find((e) => e.event === 'response.completed');
    assert.ok(completed, '应生成 response.completed 事件');
    assert.equal(completed.data.response.usage.input_tokens_details.cache_creation_tokens, 800);
    assert.equal(completed.data.response.usage.input_tokens_details.cached_tokens, 300);
});
