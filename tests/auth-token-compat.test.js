import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateRequest as authenticateCodebuddyRequest} from '../src/services/codebuddy/auth.js';
import {authenticateRequest as authenticateRelayRequest} from '../src/services/relay/auth.js';
import {routeCopilotRequest} from '../src/routes/copilot.js';
import {credentialStore} from '../src/services/codebuddy/credential-store.js';
import {relayStore} from '../src/services/relay/relay-store.js';
import {copilotStore} from '../src/services/copilot/copilot-store.js';

const codebuddyApiKey = credentialStore.getApiKeyInfo().apiKeyPlain;
const relayApiKey = relayStore.getApiKeyInfo().apiKeyPlain;
const copilotApiKey = copilotStore.getApiKeyInfo().apiKeyPlain;

async function routeCopilotWithHeaders(headers) {
    let statusCode;
    let body = '';
    const req = {
        method: 'GET',
        url: '/copilot/v1/models',
        headers: {host: '127.0.0.1', ...headers},
        socket: {remoteAddress: '127.0.0.1'}
    };
    const res = {
        writeHead(status) {
            statusCode = status;
        },
        end(data = '') {
            body = data;
        }
    };

    await routeCopilotRequest(req, res);
    return {statusCode, body: JSON.parse(body)};
}

test('auth accepts Claude Code ANTHROPIC_AUTH_TOKEN through Authorization bearer', async () => {
    assert.deepEqual(authenticateCodebuddyRequest({authorization: `Bearer ${codebuddyApiKey}`}), {authenticated: true});
    assert.deepEqual(authenticateRelayRequest({authorization: `Bearer ${relayApiKey}`}), {authenticated: true});

    const copilotResult = await routeCopilotWithHeaders({authorization: `Bearer ${copilotApiKey}`});
    assert.notEqual(copilotResult.body.error?.message, 'Invalid API Key. Check your API key or visit /copilotFE.');
});

test('auth accepts Claude Code ANTHROPIC_API_KEY through x-api-key', async () => {
    assert.deepEqual(authenticateCodebuddyRequest({'x-api-key': codebuddyApiKey}), {authenticated: true});
    assert.deepEqual(authenticateRelayRequest({'x-api-key': relayApiKey}), {authenticated: true});

    const copilotResult = await routeCopilotWithHeaders({'x-api-key': copilotApiKey});
    assert.notEqual(copilotResult.body.error?.message, 'Invalid API Key. Check your API key or visit /copilotFE.');
});

test('Authorization bearer takes precedence over x-api-key compatibility header', async () => {
    assert.deepEqual(authenticateCodebuddyRequest({authorization: `Bearer ${codebuddyApiKey}`, 'x-api-key': 'sk-stale'}), {authenticated: true});
    assert.deepEqual(authenticateRelayRequest({authorization: `Bearer ${relayApiKey}`, 'x-api-key': 'sk-stale'}), {authenticated: true});

    const copilotResult = await routeCopilotWithHeaders({authorization: `Bearer ${copilotApiKey}`, 'x-api-key': 'sk-stale'});
    assert.notEqual(copilotResult.body.error?.message, 'Invalid API Key. Check your API key or visit /copilotFE.');
});
