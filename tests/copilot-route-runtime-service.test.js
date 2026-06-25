import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createCopilotRouteRuntime,
    readCopilotRequestBody
} from '../src/services/copilot/route-runtime.js';

test('createCopilotRouteRuntime exposes route-facing Copilot handlers', () => {
    const logger = {error: () => {}, warn: () => {}, info: () => {}, debug: () => {}};
    const runtime = createCopilotRouteRuntime({logger});

    for (const key of [
        'sendJson',
        'sendOpenAIError',
        'sendAnthropicError',
        'supportsResponsesWebSocket',
        'handleRoot',
        'handleOpenAIModels',
        'handleAnthropicCountTokens',
        'handleAnthropicModels',
        'handleOpenAIChatCompletions',
        'handleAnthropicMessages',
        'handleResponsesCompact',
        'handleResponsesAPI',
        'handleCopilotResponsesWS',
        'routeCopilotRequest'
    ]) {
        assert.equal(typeof runtime[key], 'function', key);
    }
});

test('readCopilotRequestBody joins request chunks as utf8 text', async () => {
    async function* chunks() {
        yield Buffer.from('hel');
        yield Buffer.from('lo');
    }

    const body = await readCopilotRequestBody(chunks());

    assert.equal(body, 'hello');
});
