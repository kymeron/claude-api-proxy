import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopilotResponsesWebSocketHandler} from '../src/services/copilot/responses-websocket-handler.js';

async function collect(iterable) {
    const events = [];
    for await (const event of iterable) {
        events.push(event);
    }
    return events;
}

async function* events(items) {
    for (const item of items) {
        yield item;
    }
}

async function* chunks(...items) {
    for (const item of items) {
        yield Buffer.from(item);
    }
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    let capturedOptions = null;
    const store = {
        incrementApiCallCount: () => calls.push(['incrementApiCallCount']),
        incrementTokenUsage: (...args) => calls.push(['incrementTokenUsage', args]),
        recordDailyUsage: (...args) => calls.push(['recordDailyUsage', args])
    };

    return {
        calls,
        get capturedOptions() {
            return capturedOptions;
        },
        handleWSConnection: (clientWs, options) => {
            calls.push(['handleWSConnection', clientWs]);
            capturedOptions = options;
        },
        currentCopilotContext: () => ({tenantId: 42}),
        runWithCopilotContext: (context, callback) => {
            calls.push(['runWithCopilotContext', context]);
            return callback();
        },
        isAuthenticated: () => true,
        getCopilotNetworkOptions: () => ({proxyUrl: 'http://proxy.test', rejectUnauthorized: false}),
        ensureCopilotToken: async (...args) => {
            calls.push(['ensureCopilotToken', args]);
            return 'token-1';
        },
        extractConversationKey: (...args) => {
            calls.push(['extractConversationKey', args]);
            return 'conv-1';
        },
        sanitizeResponsesInput: (input, model) => {
            calls.push(['sanitizeResponsesInput', input, model]);
            return input;
        },
        supportsResponsesWebSocket: () => true,
        createResponsesWS: async (...args) => {
            calls.push(['createResponsesWS', args]);
            return {
                conn: {id: 'conn-1'},
                eventStream: events([
                    {type: 'response.created', data: {response: {id: 'resp-1'}}},
                    {type: 'response.completed', data: {response: {id: 'resp-1'}}}
                ])
            };
        },
        copilotState: {
            vsCodeVersion: '1.109.2',
            accountType: 'individual'
        },
        discardWSConnection: (conn) => calls.push(['discardWSConnection', conn]),
        releaseWSConnection: (conn) => calls.push(['releaseWSConnection', conn]),
        responsesRequestToChat: (payload) => ({
            model: payload.model,
            messages: payload.input,
            stream: payload.stream
        }),
        createChatCompletions: async (token, version, payload) => {
            calls.push(['createChatCompletions', token, version, payload]);
            return {status: 200, body: chunks('data: {"id":"chunk_1"}\n\n')};
        },
        readBody: async () => 'upstream failed',
        createChatToResponsesStreamBridge: () => ({
            finished: false,
            feed(data) {
                calls.push(['bridgeFeed', data]);
                return [{
                    event: 'response.completed',
                    data: {response: {id: `resp_from_${data.id}`}}
                }];
            },
            finish() {
                this.finished = true;
                calls.push(['bridgeFinish']);
                return [];
            }
        }),
        copilotStore: store,
        logger: {
            warn: (...args) => calls.push(['logWarn', args]),
            error: (...args) => calls.push(['logError', args])
        },
        ...overrides
    };
}

test('handleCopilotResponsesWS maps unauthenticated requests to Responses WebSocket errors', async () => {
    const deps = createBaseDeps({isAuthenticated: () => false});
    const handleCopilotResponsesWS = createCopilotResponsesWebSocketHandler(deps);
    const req = {headers: {}};

    handleCopilotResponsesWS({id: 'client'}, req);

    await assert.rejects(
        () => collect(deps.capturedOptions.handleRequest({model: 'gpt-5.1'}, null, {signal: {aborted: false}})),
        (error) => {
            assert.equal(error.name, 'ResponsesWSError');
            assert.equal(error.message, 'Not authenticated. Open the Copilot tab in /dashboard to connect GitHub.');
            assert.equal(error.event.error.message, 'Not authenticated');
            assert.equal(error.event.error.code, 'unauthorized');
            return true;
        }
    );
});

test('handleCopilotResponsesWS relays supported Responses WS events and releases the connection', async () => {
    const deps = createBaseDeps();
    const handleCopilotResponsesWS = createCopilotResponsesWebSocketHandler(deps);
    const req = {headers: {'x-session-id': 'conv-1'}};

    handleCopilotResponsesWS({id: 'client'}, req);
    const eventsOut = await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-5.1',
        input: [{role: 'user', content: 'hello'}]
    }, null, {signal: {aborted: false}}));

    assert.deepEqual(eventsOut, [
        {type: 'response.created', data: {response: {id: 'resp-1'}}},
        {type: 'response.completed', data: {response: {id: 'resp-1'}}}
    ]);
    assert.equal(deps.calls.some((call) => call[0] === 'sanitizeResponsesInput'), true);
    assert.equal(deps.calls.some((call) => call[0] === 'releaseWSConnection'), true);
    assert.equal(deps.calls.some((call) => call[0] === 'discardWSConnection'), false);

    deps.capturedOptions.onUsage(3, 4, 2, 'gpt-5.1');
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordDailyUsage')?.[1],
        [3, 4, 2, 'gpt-5.1']
    );
});

test('handleCopilotResponsesWS falls back to Chat SSE and bridges Responses events', async () => {
    const deps = createBaseDeps({
        supportsResponsesWebSocket: () => false
    });
    const handleCopilotResponsesWS = createCopilotResponsesWebSocketHandler(deps);
    const req = {headers: {}};

    handleCopilotResponsesWS({id: 'client'}, req);
    const eventsOut = await collect(deps.capturedOptions.handleRequest({
        model: 'claude-sonnet-4',
        input: [{role: 'user', content: 'hello'}]
    }, null, {signal: {aborted: false}}));

    const createCall = deps.calls.find((call) => call[0] === 'createChatCompletions');
    assert.equal(createCall[3].stream, true);
    assert.deepEqual(eventsOut, [{
        type: 'response.completed',
        data: {response: {id: 'resp_from_chunk_1'}}
    }]);
    assert.equal(deps.calls.some((call) => call[0] === 'bridgeFeed'), true);
    assert.equal(deps.calls.some((call) => call[0] === 'bridgeFinish'), true);
});
