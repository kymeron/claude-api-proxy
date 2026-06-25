import test from 'node:test';
import assert from 'node:assert/strict';
import {
    streamRelayResponsesEventsAsAnthropic,
    writeRelayAnthropicEvent
} from '../src/services/relay/anthropic-stream.js';

function createResponseRecorder() {
    const writes = [];
    return {
        writes,
        res: {
            write: (chunk) => writes.push(chunk)
        }
    };
}

async function* createEventStream(events) {
    for (const event of events) yield event;
}

test('writeRelayAnthropicEvent writes Anthropic SSE frames', () => {
    const {writes, res} = createResponseRecorder();

    writeRelayAnthropicEvent(res, {
        type: 'content_block_delta',
        delta: {type: 'text_delta', text: 'hello'}
    });

    assert.deepEqual(writes, [
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n'
    ]);
});

test('writeRelayAnthropicEvent ignores writes after response is closed', () => {
    const writes = [];
    const res = {
        writableEnded: true,
        destroyed: false,
        write: (chunk) => writes.push(chunk)
    };

    writeRelayAnthropicEvent(res, {
        type: 'content_block_delta',
        delta: {type: 'text_delta', text: 'ignored'}
    });

    assert.deepEqual(writes, []);
});

test('streamRelayResponsesEventsAsAnthropic bridges Responses events to Anthropic SSE and returns usage', async () => {
    const {writes, res} = createResponseRecorder();
    const accumulatorCalls = [];
    const usage = await streamRelayResponsesEventsAsAnthropic(
        createEventStream([
            {type: 'response.output_text.delta', data: {delta: 'hello'}},
            {
                type: 'response.completed',
                data: {response: {usage: {input_tokens: 3, output_tokens: 4}}}
            }
        ]),
        res,
        null,
        {
            feed: (...args) => accumulatorCalls.push(args)
        },
        {
            createResponsesToChatStreamBridge: () => ({
                feed: (eventType, data) => [{eventType, data}]
            }),
            createChatToAnthropicStreamBridge: () => ({
                feed: (chatChunk) => [{
                    type: 'content_block_delta',
                    chatChunk
                }]
            })
        }
    );

    assert.deepEqual(usage, {input_tokens: 3, output_tokens: 4});
    assert.deepEqual(accumulatorCalls, [
        ['response.output_text.delta', {delta: 'hello'}],
        ['response.completed', {response: {usage: {input_tokens: 3, output_tokens: 4}}}]
    ]);
    assert.deepEqual(writes, [
        'event: content_block_delta\ndata: {"type":"content_block_delta","chatChunk":{"eventType":"response.output_text.delta","data":{"delta":"hello"}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","chatChunk":{"eventType":"response.completed","data":{"response":{"usage":{"input_tokens":3,"output_tokens":4}}}}}\n\n'
    ]);
});

test('streamRelayResponsesEventsAsAnthropic stops when aborted before processing the next event', async () => {
    const controller = new AbortController();
    const {writes, res} = createResponseRecorder();
    async function* eventStream() {
        yield {type: 'response.output_text.delta', data: {delta: 'hello'}};
        controller.abort();
        yield {type: 'response.output_text.delta', data: {delta: 'ignored'}};
    }

    await streamRelayResponsesEventsAsAnthropic(
        eventStream(),
        res,
        controller.signal,
        null,
        {
            createResponsesToChatStreamBridge: () => ({
                feed: (eventType, data) => [{eventType, data}]
            }),
            createChatToAnthropicStreamBridge: () => ({
                feed: (chatChunk) => [{type: 'content_block_delta', chatChunk}]
            })
        }
    );

    assert.equal(writes.length, 1);
    assert.match(writes[0], /hello/);
    assert.doesNotMatch(writes[0], /ignored/);
});
