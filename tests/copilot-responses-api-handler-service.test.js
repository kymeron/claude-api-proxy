import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopilotResponsesAPIHandler} from '../src/services/copilot/responses-api-handler.js';

function createResponse() {
    return {
        calls: [],
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        writeHead(status, headers) {
            this.headersSent = true;
            this.calls.push(['writeHead', status, headers]);
        },
        write(chunk) {
            this.calls.push(['write', chunk]);
        },
        end(body) {
            this.writableEnded = true;
            this.calls.push(['end', body]);
        }
    };
}

async function* events(items) {
    for (const item of items) {
        yield item;
    }
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    const store = {
        incrementApiCallCount: () => calls.push(['incrementApiCallCount']),
        incrementTokenUsage: (...args) => calls.push(['incrementTokenUsage', args]),
        recordDailyUsage: (...args) => calls.push(['recordDailyUsage', args])
    };

    return {
        calls,
        getCopilotNetworkOptions: () => ({proxyUrl: 'http://proxy.test', rejectUnauthorized: false}),
        ensureCopilotAuth: async () => ({copilotToken: 'token-1'}),
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        sendResponsesProtocolError: (res, error) => res.calls.push(['responses-protocol-error', error.message]),
        upstreamErrorStatus: (error) => error.status || 500,
        isResponsesProtocolError: () => false,
        parseBody: async () => JSON.stringify({
            model: 'gpt-5.1',
            input: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        extractConversationKey: (...args) => {
            calls.push(['extractConversationKey', args]);
            return 'conv-1';
        },
        sanitizeResponsesInput: (input, model) => {
            calls.push(['sanitizeResponsesInput', input, model]);
            return input;
        },
        ensureResponsesWebSocketSupported: (model) => calls.push(['ensureResponsesWebSocketSupported', model]),
        createResponsesWS: async (...args) => {
            calls.push(['createResponsesWS', args]);
            return {
                conn: {id: 'conn-1'},
                eventStream: events([
                    {
                        type: 'response.completed',
                        data: {response: {id: 'resp-1', usage: {input_tokens: 5, output_tokens: 7}}}
                    }
                ])
            };
        },
        copilotState: {
            vsCodeVersion: '1.109.2',
            accountType: 'individual'
        },
        createResponsesToResponsesStreamBridge: () => ({
            finished: false,
            feed: (type) => type === 'response.completed'
                ? [{event: 'response.output_text.delta', data: {type: 'response.output_text.delta', delta: 'hi'}}]
                : [],
            finish: () => [{event: 'response.completed', data: {type: 'response.completed'}}]
        }),
        convertResponsesUsageToChat: () => ({prompt_tokens: 5, completion_tokens: 7}),
        extractCacheHitTokens: () => 2,
        releaseWSConnection: (conn) => calls.push(['releaseWSConnection', conn]),
        discardWSConnection: (conn) => calls.push(['discardWSConnection', conn]),
        responsesRequestToChat: (request) => ({model: request.model, messages: request.input, stream: request.stream}),
        createChatCompletions: async (...args) => {
            calls.push(['createChatCompletions', args]);
            return {status: 200, body: null};
        },
        readBody: async () => JSON.stringify({
            id: 'chatcmpl-1',
            choices: [{message: {content: 'fallback'}}],
            usage: {prompt_tokens: 3, completion_tokens: 4}
        }),
        createChatToResponsesStreamBridge: () => ({
            finished: true,
            feed: () => [],
            finish: () => []
        }),
        chatResponseToResponses: (response) => ({id: 'resp-from-chat', usage: response.usage}),
        copilotStore: store,
        logger: {
            info: (...args) => calls.push(['logInfo', args]),
            warn: (...args) => calls.push(['logWarn', args]),
            error: (...args) => calls.push(['logError', args])
        },
        ...overrides
    };
}

test('handleResponsesAPI returns OpenAI auth errors without reading the body', async () => {
    const res = createResponse();
    let parsedBody = false;
    const handler = createCopilotResponsesAPIHandler(createBaseDeps({
        ensureCopilotAuth: async () => ({error: {status: 401, message: 'Unauthorized'}}),
        parseBody: async () => {
            parsedBody = true;
            return '{}';
        }
    }));

    await handler({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', undefined]]);
});

test('handleResponsesAPI returns non-stream Responses WS completions as Responses', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handler = createCopilotResponsesAPIHandler(deps);

    await handler({headers: {}}, res);

    assert.equal(deps.calls.some((call) => call[0] === 'releaseWSConnection'), true);
    assert.equal(deps.calls.some((call) => call[0] === 'sanitizeResponsesInput'), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'incrementTokenUsage')?.[1],
        [5, 7, 2]
    );
    assert.deepEqual(res.calls[0], ['json', 200, {id: 'resp-1', usage: {input_tokens: 5, output_tokens: 7}}]);
});

test('handleResponsesAPI maps invalid fallback upstream JSON to 502', async () => {
    const res = createResponse();
    const deps = createBaseDeps({
        ensureResponsesWebSocketSupported: () => {
            throw new Error('unsupported');
        },
        readBody: async () => 'not-json'
    });
    const handler = createCopilotResponsesAPIHandler(deps);

    await handler({headers: {}}, res);

    assert.deepEqual(res.calls, [[
        'openai-error',
        502,
        'Upstream returned invalid JSON',
        undefined
    ]]);
});

test('handleResponsesAPI streams Responses WS events as Responses SSE', async () => {
    const res = createResponse();
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'gpt-5.1',
            input: [{role: 'user', content: 'hello'}],
            stream: true
        })
    });
    const handler = createCopilotResponsesAPIHandler(deps);

    await handler({headers: {}}, res);

    assert.equal(res.calls[0][0], 'writeHead');
    assert.equal(res.calls.some((call) => call[0] === 'write' && call[1].includes('response.output_text.delta')), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordDailyUsage')?.[1],
        [5, 7, 2, undefined]
    );
});
