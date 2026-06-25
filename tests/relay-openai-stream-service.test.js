import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRelayOpenAIStreamPassthrough,
    streamRelayOpenAIPassthrough
} from '../src/services/relay/openai-stream.js';

function createAccumulatorFactory(responseFactory = (chunks, model) => ({id: 'chatcmpl_test', model, chunks})) {
    const accumulators = [];
    return {
        accumulators,
        createAccumulator({model}) {
            const chunks = [];
            const accumulator = {
                model,
                chunks,
                feed(chunk) {
                    chunks.push(chunk);
                },
                toChatResponse() {
                    return chunks.length ? responseFactory(chunks, model) : null;
                }
            };
            accumulators.push(accumulator);
            return accumulator;
        }
    };
}

test('streamRelayOpenAIPassthrough records accumulated chat response and usage', () => {
    const responseBody = {stream: true};
    const res = {id: 'res'};
    const {accumulators, createAccumulator} = createAccumulatorFactory();
    const recordedResponses = [];
    const usageCalls = [];
    const logger = {warn() {}};
    let rewriteOptions = null;

    streamRelayOpenAIPassthrough(
        {body: responseBody},
        res,
        {
            tenantId: 42,
            model: 'gpt-test',
            conversationKey: 'tenant:42:conv',
            conversationStore: {
                recordChatResponse: (payload) => recordedResponses.push(payload)
            },
            recordUsage: (...args) => usageCalls.push(args),
            logger,
            createChatStreamAccumulator: createAccumulator,
            rewriteOpenAIStream: (actualRes, actualBody, onUsage, onChunk, options) => {
                assert.equal(actualRes, res);
                assert.equal(actualBody, responseBody);
                rewriteOptions = options;
                onChunk({id: 'chunk_1'});
                onUsage(11, 7, 3);
            }
        }
    );

    assert.equal(accumulators.length, 1);
    assert.equal(accumulators[0].model, 'gpt-test');
    assert.deepEqual(recordedResponses, [{
        tenantId: 42,
        conversationKey: 'tenant:42:conv',
        response: {
            id: 'chatcmpl_test',
            model: 'gpt-test',
            chunks: [{id: 'chunk_1'}]
        }
    }]);
    assert.deepEqual(usageCalls, [[42, 11, 7, 3, 'gpt-test']]);
    assert.equal(rewriteOptions.logger, logger);
});

test('streamRelayOpenAIPassthrough skips conversation storage without a key', () => {
    const recordedResponses = [];
    const {createAccumulator} = createAccumulatorFactory();

    streamRelayOpenAIPassthrough(
        {body: 'body'},
        {},
        {
            tenantId: 42,
            model: 'gpt-test',
            conversationKey: null,
            conversationStore: {
                recordChatResponse: (payload) => recordedResponses.push(payload)
            },
            recordUsage() {},
            createChatStreamAccumulator: createAccumulator,
            rewriteOpenAIStream: (_res, _body, onUsage, onChunk) => {
                onChunk({id: 'chunk_1'});
                onUsage(0, 0, 0);
            }
        }
    );

    assert.deepEqual(recordedResponses, []);
});

test('createRelayOpenAIStreamPassthrough preserves the route-facing positional API', () => {
    const recordedResponses = [];
    const usageCalls = [];
    const {createAccumulator} = createAccumulatorFactory();
    const streamOpenAIPassthrough = createRelayOpenAIStreamPassthrough({
        conversationStore: {
            recordChatResponse: (payload) => recordedResponses.push(payload)
        },
        recordUsage: (...args) => usageCalls.push(args),
        createChatStreamAccumulator: createAccumulator,
        rewriteOpenAIStream: (_res, _body, onUsage, onChunk) => {
            onChunk({id: 'chunk_1'});
            onUsage(1, 2, 3);
        }
    });

    streamOpenAIPassthrough({body: 'body'}, {}, 42, 'tenant info', 'gpt-test', 'tenant:42:conv');

    assert.equal(recordedResponses[0].tenantId, 42);
    assert.equal(recordedResponses[0].conversationKey, 'tenant:42:conv');
    assert.deepEqual(usageCalls, [[42, 1, 2, 3, 'gpt-test']]);
});
