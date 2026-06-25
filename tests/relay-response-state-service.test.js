import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectRelayResponsesWebSocketResponse,
    createRelayCompletedResponseRecorder,
    createRelayResponsesPassthroughLimiter,
    createRelayResponsesWebSocketCollector,
    limitRelayResponsesPassthroughPayload,
    recordRelayCompletedResponseState
} from '../src/services/relay/response-state.js';

function createConversationStoreRecorder() {
    const calls = [];
    return {
        calls,
        store: {
            recordResponsesResponse: (payload) => calls.push(payload)
        }
    };
}

function createConnectionRecorder() {
    const calls = [];
    return {
        calls,
        deps: {
            releaseConnection: (conn) => calls.push(['release', conn]),
            discardConnection: (conn) => calls.push(['discard', conn])
        }
    };
}

async function* completedEventStream(response) {
    yield {type: 'response.created', data: {response: {id: 'draft'}}};
    yield {type: 'response.completed', data: {response}};
}

test('recordRelayCompletedResponseState saves completed Responses state', () => {
    const {calls, store} = createConversationStoreRecorder();
    const response = {id: 'resp_1'};
    const sourceCanonicalSession = {turns: [{role: 'user'}]};

    recordRelayCompletedResponseState({
        conversationStore: store,
        tenantId: 42,
        conversationKey: 'tenant:42:conv',
        response,
        sourceCanonicalSession
    });

    assert.deepEqual(calls, [{
        tenantId: 42,
        conversationKey: 'tenant:42:conv',
        response,
        sourceCanonicalSession
    }]);
});

test('recordRelayCompletedResponseState ignores missing response or conversation key', () => {
    const {calls, store} = createConversationStoreRecorder();

    recordRelayCompletedResponseState({
        conversationStore: store,
        tenantId: 42,
        conversationKey: '',
        response: {id: 'resp_1'}
    });
    recordRelayCompletedResponseState({
        conversationStore: store,
        tenantId: 42,
        conversationKey: 'tenant:42:conv',
        response: null
    });

    assert.deepEqual(calls, []);
});

test('createRelayCompletedResponseRecorder preserves route-facing positional API', () => {
    const {calls, store} = createConversationStoreRecorder();
    const recordCompletedResponseState = createRelayCompletedResponseRecorder(store);

    recordCompletedResponseState(42, 'tenant:42:conv', {id: 'resp_1'}, {turns: []});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tenantId, 42);
    assert.equal(calls[0].conversationKey, 'tenant:42:conv');
});

test('limitRelayResponsesPassthroughPayload returns the limited payload and logs truncation context', () => {
    const logs = [];
    const limitedPayload = {
        model: 'gpt-5',
        input: [{role: 'user', content: 'latest'}],
        previous_response_id: 'resp_prev'
    };

    const result = limitRelayResponsesPassthroughPayload(
        {model: 'gpt-5', input: new Array(4).fill({role: 'user', content: 'x'})},
        {
            previousResponseId: 'resp_prev',
            requestType: 'ResponsesPassthrough',
            conversationKey: 'tenant:42:conv',
            logger: {info: (message) => logs.push(message)},
            limitInputItems: (payload, options) => {
                assert.equal(options.previousResponseId, 'resp_prev');
                assert.equal(payload.model, 'gpt-5');
                return {
                    truncated: true,
                    payload: limitedPayload,
                    originalLength: 4,
                    retainedLength: 1,
                    previousResponseId: 'resp_prev'
                };
            }
        }
    );

    assert.equal(result, limitedPayload);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Responses passthrough: truncated input items 4->1/);
    assert.match(logs[0], /requestType=ResponsesPassthrough/);
    assert.match(logs[0], /conversationKey=tenant:42:conv/);
    assert.match(logs[0], /previous_response_id=resp_prev/);
});

test('createRelayResponsesPassthroughLimiter binds logger and limiter dependencies', () => {
    const logs = [];
    const limitResponsesPassthroughPayload = createRelayResponsesPassthroughLimiter({
        logger: {info: (message) => logs.push(message)},
        limitInputItems: () => ({
            truncated: false,
            payload: {model: 'gpt-5', input: []}
        })
    });

    assert.deepEqual(
        limitResponsesPassthroughPayload({model: 'gpt-5', input: []}),
        {model: 'gpt-5', input: []}
    );
    assert.deepEqual(logs, []);
});

test('collectRelayResponsesWebSocketResponse returns completed response and releases connection', async () => {
    const {calls, deps} = createConnectionRecorder();
    const response = {id: 'resp_1', usage: {input_tokens: 1}};

    const result = await collectRelayResponsesWebSocketResponse(
        {conn: 'conn-1', eventStream: completedEventStream(response)},
        deps
    );

    assert.equal(result, response);
    assert.deepEqual(calls, [['release', 'conn-1']]);
});

test('createRelayResponsesWebSocketCollector preserves route-facing collector API', async () => {
    const {calls, deps} = createConnectionRecorder();
    const collectResponsesWebSocketResponse = createRelayResponsesWebSocketCollector(deps);

    assert.deepEqual(
        await collectResponsesWebSocketResponse({
            conn: 'conn-1',
            eventStream: completedEventStream({id: 'resp_1'})
        }),
        {id: 'resp_1'}
    );
    assert.deepEqual(calls, [['release', 'conn-1']]);
});

test('collectRelayResponsesWebSocketResponse discards connection when event stream fails', async () => {
    const {calls, deps} = createConnectionRecorder();
    const failure = new Error('upstream socket failed');
    async function* failingEventStream() {
        yield {type: 'response.created', data: {}};
        throw failure;
    }

    await assert.rejects(
        collectRelayResponsesWebSocketResponse(
            {conn: 'conn-1', eventStream: failingEventStream()},
            deps
        ),
        failure
    );
    assert.deepEqual(calls, [['discard', 'conn-1']]);
});

test('collectRelayResponsesWebSocketResponse releases connection before rejecting missing completion', async () => {
    const {calls, deps} = createConnectionRecorder();
    async function* incompleteEventStream() {
        yield {type: 'response.created', data: {}};
    }

    await assert.rejects(
        collectRelayResponsesWebSocketResponse(
            {conn: 'conn-1', eventStream: incompleteEventStream()},
            deps
        ),
        /No response\.completed event received/
    );
    assert.deepEqual(calls, [['release', 'conn-1']]);
});
