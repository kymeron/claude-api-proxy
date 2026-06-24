import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createCodebuddyRouteRuntime,
    readCodebuddyRequestBody
} from '../src/services/codebuddy/route-runtime.js';

test('createCodebuddyRouteRuntime exposes route-facing CodeBuddy handlers', () => {
    const tenantManager = {
        listTenants: () => [],
        isEnabled: () => true
    };
    const logger = {error: () => {}, warn: () => {}, info: () => {}, debug: () => {}};
    const runtime = createCodebuddyRouteRuntime({tenantManager, logger});

    for (const key of [
        'sendJson',
        'sendOpenAIError',
        'sendAnthropicError',
        'handleCredentials',
        'handleRoot',
        'handleOpenAIModels',
        'handleAnthropicCountTokens',
        'handleAnthropicModels',
        'handleOpenAIChatCompletions',
        'handleAnthropicMessages',
        'handleResponsesCompact',
        'handleResponsesAPI',
        'handleCodebuddyResponsesWS',
        'routeCodebuddyRequest'
    ]) {
        assert.equal(typeof runtime[key], 'function', key);
    }
});

test('readCodebuddyRequestBody joins request chunks as utf8 text', async () => {
    async function* chunks() {
        yield Buffer.from('hel');
        yield Buffer.from('lo');
    }

    const body = await readCodebuddyRequestBody(chunks());

    assert.equal(body, 'hello');
});
