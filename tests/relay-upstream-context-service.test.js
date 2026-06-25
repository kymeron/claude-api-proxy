import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {ProviderUpstreamError} from '../src/services/providers/index.js';
import {
    callRelayUpstream,
    createRelayUpstreamContextResolver,
    getRelayProtocolErrorMessage,
    relayUpstreamErrorStatus,
    resolveRelayUpstreamContext
} from '../src/services/relay/upstream-context.js';

test('resolveRelayUpstreamContext rejects missing tenant id', async () => {
    const result = await resolveRelayUpstreamContext({
        req: {},
        tenantManager: {}
    });

    assert.deepEqual(result, {
        error: {
            status: 503,
            message: 'Relay tenant system is not enabled'
        }
    });
});

test('resolveRelayUpstreamContext returns tenant upstream context', async () => {
    const upstream = {name: 'primary', protocol: 'chat'};
    const upstreamManager = {
        getActiveUpstream: () => upstream
    };
    const tenantManager = {
        getUpstreamManager: async (tenantId) => {
            assert.equal(tenantId, 42);
            return upstreamManager;
        }
    };

    const result = await resolveRelayUpstreamContext({
        req: {tenantId: 42},
        tenantManager
    });

    assert.deepEqual(result, {
        upstream,
        tenantId: 42,
        upstreamManager
    });
});

test('createRelayUpstreamContextResolver binds the tenant manager for route usage', async () => {
    const upstream = {name: 'primary', protocol: 'chat'};
    const upstreamManager = {
        getActiveUpstream: () => upstream
    };
    const resolve = createRelayUpstreamContextResolver({
        getUpstreamManager: async () => upstreamManager
    });

    assert.deepEqual(
        await resolve({tenantId: 42}),
        {upstream, tenantId: 42, upstreamManager}
    );
});

test('resolveRelayUpstreamContext rejects tenants without active upstream', async () => {
    const result = await resolveRelayUpstreamContext({
        req: {tenantId: 42},
        tenantManager: {
            getUpstreamManager: async () => ({
                getActiveUpstream: () => null
            })
        }
    });

    assert.equal(result.error.status, 503);
    assert.match(result.error.message, /上游|upstream/i);
});

test('callRelayUpstream returns successful upstream responses', async () => {
    const upstream = {name: 'primary'};
    const response = {status: 200, body: Readable.from([Buffer.from('ok')])};

    assert.deepEqual(
        await callRelayUpstream(upstream, async (actual) => {
            assert.equal(actual, upstream);
            return response;
        }),
        {response, upstream}
    );
});

test('callRelayUpstream throws response body for failed upstream responses', async () => {
    await assert.rejects(
        callRelayUpstream(
            {name: 'primary'},
            async () => ({status: 503, body: Readable.from([Buffer.from('upstream failed')])})
        ),
        /503.*upstream failed/
    );
});

test('relayUpstreamErrorStatus maps provider and network errors', () => {
    assert.equal(relayUpstreamErrorStatus(new ProviderUpstreamError('bad gateway', 429)), 429);
    assert.equal(relayUpstreamErrorStatus(Object.assign(new Error('invalid json'), {status: 502})), 502);
    assert.equal(relayUpstreamErrorStatus(Object.assign(new Error('network'), {code: 'ECONNRESET'})), 502);
    assert.equal(relayUpstreamErrorStatus(new Error('unknown')), 500);
});

test('getRelayProtocolErrorMessage describes protocol mismatches', () => {
    assert.equal(
        getRelayProtocolErrorMessage({protocol: 'anthropic'}, 'anthropic', '/relay/v1/messages'),
        null
    );
    assert.match(
        getRelayProtocolErrorMessage({protocol: 'chat'}, 'anthropic', '/relay/v1/messages'),
        /\/relay\/v1\/messages/
    );
});
