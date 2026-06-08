import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'events';
import {relayResponsesWebSocketPair} from '../src/services/shared/responses-ws-passthrough.js';

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.sent = [];
        this.closed = null;
    }

    send(data) {
        this.sent.push(data.toString());
    }

    close(code, reason) {
        this.readyState = 3;
        this.closed = {code, reason};
        this.emit('close', code, reason);
    }
}

test('relayResponsesWebSocketPair forwards client and upstream frames', () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();

    relayResponsesWebSocketPair(client, upstream);

    client.emit('message', Buffer.from(JSON.stringify({type: 'response.create', input: 'hello'})));
    upstream.emit('message', Buffer.from(JSON.stringify({type: 'response.completed', response: {id: 'resp_1'}})));

    assert.deepEqual(upstream.sent.map(item => JSON.parse(item)), [
        {type: 'response.create', input: 'hello'}
    ]);
    assert.deepEqual(client.sent.map(item => JSON.parse(item)), [
        {type: 'response.completed', response: {id: 'resp_1'}}
    ]);
});

test('relayResponsesWebSocketPair closes upstream when client closes', () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();

    relayResponsesWebSocketPair(client, upstream);
    client.emit('close', 1000, Buffer.from('client done'));

    assert.deepEqual(upstream.closed, {code: 1000, reason: 'client done'});
});

test('relayResponsesWebSocketPair rejects invalid client JSON frames', () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();

    relayResponsesWebSocketPair(client, upstream);
    client.emit('message', Buffer.from('not json'));

    assert.equal(upstream.sent.length, 0);
    assert.deepEqual(client.sent.map(item => JSON.parse(item)), [
        {type: 'error', error: {message: 'Invalid JSON message', code: 'invalid_request'}}
    ]);
});
