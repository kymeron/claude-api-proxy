import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {
    getRelaySSEEventType,
    parseRelayResponsesSSEEvents,
    parseRelaySSEBlock,
    readRelayRequestBody,
    readRelayResponseBody
} from '../src/services/relay/stream-events.js';

test('readRelayRequestBody joins request chunks as utf8 text', async () => {
    const req = Readable.from([
        Buffer.from('{"model":"'),
        Buffer.from('gpt-5"}')
    ]);

    assert.equal(await readRelayRequestBody(req), '{"model":"gpt-5"}');
});

test('readRelayResponseBody joins upstream response chunks as utf8 text', async () => {
    const stream = Readable.from([
        Buffer.from('upstream '),
        Buffer.from('body')
    ]);

    assert.equal(await readRelayResponseBody(stream), 'upstream body');
});

test('parseRelaySSEBlock extracts event and multi-line data', () => {
    assert.deepEqual(
        parseRelaySSEBlock('event: response.output_text.delta\ndata: {"a":1}\ndata: {"b":2}'),
        {
            event: 'response.output_text.delta',
            data: '{"a":1}\n{"b":2}'
        }
    );
});

test('getRelaySSEEventType prefers explicit event over parsed type', () => {
    assert.equal(
        getRelaySSEEventType('response.completed', {type: 'message'}),
        'response.completed'
    );
    assert.equal(
        getRelaySSEEventType(undefined, {type: 'response.created'}),
        'response.created'
    );
});

test('parseRelayResponsesSSEEvents parses chunked Responses SSE events', async () => {
    const stream = Readable.from([
        Buffer.from('event: response.created\n'),
        Buffer.from('data: {"type":"ignored","response":{"id":"draft"}}\n\n'),
        Buffer.from('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'),
        Buffer.from('data: [DONE]\n\n'),
        Buffer.from('data: {bad json}\n\n')
    ]);

    const events = [];
    for await (const event of parseRelayResponsesSSEEvents(stream)) {
        events.push(event);
    }

    assert.deepEqual(events, [
        {
            type: 'response.created',
            data: {type: 'ignored', response: {id: 'draft'}}
        },
        {
            type: 'response.completed',
            data: {type: 'response.completed', response: {id: 'resp_1'}}
        }
    ]);
});

test('parseRelayResponsesSSEEvents stops when the signal is aborted', async () => {
    const controller = new AbortController();
    async function* eventChunks() {
        yield Buffer.from('data: {"type":"response.created"}\n\n');
        controller.abort();
        yield Buffer.from('data: {"type":"response.completed"}\n\n');
    }

    const events = [];
    for await (const event of parseRelayResponsesSSEEvents(eventChunks(), controller.signal)) {
        events.push(event);
    }

    assert.deepEqual(events, [
        {
            type: 'response.created',
            data: {type: 'response.created'}
        }
    ]);
});
