import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopilotChatCompletionsHandler} from '../src/services/copilot/chat-completions-handler.js';

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
        },
        on(event, handler) {
            this.calls.push(['on', event, handler]);
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
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'gpt-5.1',
            messages: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        chatRequestToResponses: (payload) => {
            calls.push(['chatRequestToResponses', payload]);
            return {model: payload.model, input: payload.messages};
        },
        extractConversationKey: (...args) => {
            calls.push(['extractConversationKey', args]);
            return 'conv-1';
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
            accountType: 'individual',
            copilotToken: 'state-token'
        },
        createResponsesToChatStreamBridge: () => ({
            completed: false,
            feed: (type) => type === 'response.completed'
                ? [{id: 'chunk-1', choices: [{delta: {content: 'hi'}}]}]
                : [],
            finish: () => [{id: 'chunk-2', choices: [{delta: {}, finish_reason: 'stop'}]}]
        }),
        convertResponsesUsageToChat: () => ({prompt_tokens: 5, completion_tokens: 7}),
        extractCacheHitTokens: () => 2,
        releaseWSConnection: (conn) => calls.push(['releaseWSConnection', conn]),
        discardWSConnection: (conn) => calls.push(['discardWSConnection', conn]),
        responsesResponseToChat: () => ({
            id: 'chatcmpl-1',
            choices: [{message: {content: 'hi'}}],
            usage: {prompt_tokens: 5, completion_tokens: 7}
        }),
        createChatCompletions: async (...args) => {
            calls.push(['createChatCompletions', args]);
            return {status: 200, body: null};
        },
        readBody: async () => '{}',
        estimateMessageTokens: () => 11,
        copilotStore: store,
        logger: {
            info: (...args) => calls.push(['logInfo', args]),
            warn: (...args) => calls.push(['logWarn', args]),
            error: (...args) => calls.push(['logError', args])
        },
        ...overrides
    };
}

test('handleOpenAIChatCompletions returns auth errors without reading the body', async () => {
    const res = createResponse();
    let parsedBody = false;
    const deps = createBaseDeps({
        ensureCopilotAuth: async () => ({error: {status: 401, message: 'Unauthorized'}}),
        parseBody: async () => {
            parsedBody = true;
            return '{}';
        }
    });
    const handler = createCopilotChatCompletionsHandler(deps);

    await handler({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', 'authentication_error']]);
});

test('handleOpenAIChatCompletions returns non-stream Responses WS completions as Chat', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handler = createCopilotChatCompletionsHandler(deps);

    await handler({headers: {'x-session-id': 'conv-1'}}, res);

    assert.equal(deps.calls.some((call) => call[0] === 'releaseWSConnection'), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'incrementTokenUsage')?.[1],
        [5, 7, 2]
    );
    assert.equal(res.calls[0][0], 'json');
    assert.equal(res.calls[0][1], 200);
    assert.equal(res.calls[0][2].choices[0].message.content, 'hi');
});

test('handleOpenAIChatCompletions streams Responses WS events as Chat chunks', async () => {
    const res = createResponse();
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'gpt-5.1',
            messages: [{role: 'user', content: 'hello'}],
            stream: true
        })
    });
    const handler = createCopilotChatCompletionsHandler(deps);

    await handler({headers: {}}, res);

    assert.equal(res.calls[0][0], 'writeHead');
    assert.equal(res.calls.some((call) => call[0] === 'write' && call[1].includes('[DONE]')), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordDailyUsage')?.[1],
        [5, 7, 2, undefined]
    );
});
