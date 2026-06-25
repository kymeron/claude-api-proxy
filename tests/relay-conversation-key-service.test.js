import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildConversationAnchorKey
} from '../src/services/relay/protocol-adapter.js';
import {
    extractConversationKey,
    extractConversationKeyFromPayload,
    normalizeConversationKey
} from '../src/services/relay/conversation-key.js';

function requestWithHeaders(headers, relayClientConnectionId) {
    return {headers, relayClientConnectionId};
}

test('normalizeConversationKey trims non-empty strings only', () => {
    assert.equal(normalizeConversationKey(' session-1 '), 'session-1');
    assert.equal(normalizeConversationKey('   '), undefined);
    assert.equal(normalizeConversationKey(null), undefined);
});

test('extractConversationKeyFromPayload reads direct and metadata session ids', () => {
    assert.equal(
        extractConversationKeyFromPayload({session_id: 'payload-session'}),
        'payload-session'
    );
    assert.equal(
        extractConversationKeyFromPayload({metadata: {threadId: 'thread-1'}}),
        'thread-1'
    );
});

test('extractConversationKey prefers request headers over payload ids', () => {
    const key = extractConversationKey(
        requestWithHeaders({'x-session-id': ' header-session '}),
        {session_id: 'payload-session'},
        {tenantId: 7}
    );

    assert.equal(key, 'header-session');
});

test('extractConversationKey falls back to payload ids', () => {
    const key = extractConversationKey(
        requestWithHeaders({}),
        {metadata: {conversation_id: 'payload-conversation'}},
        {tenantId: 7}
    );

    assert.equal(key, 'payload-conversation');
});

test('extractConversationKey uses canonical anchor fallback with client connection id', () => {
    const req = requestWithHeaders({}, 'client-1');
    const payload = {
        messages: [{role: 'user', content: 'hello'}]
    };

    assert.equal(
        extractConversationKey(req, payload, {tenantId: 7}),
        buildConversationAnchorKey(payload, {tenantId: 7, clientConnectionId: 'client-1'})
    );
});
