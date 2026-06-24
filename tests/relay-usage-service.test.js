import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRelayUsageRecorder,
    recordRelayResponsesUsage,
    recordRelayUsage
} from '../src/services/relay/usage.js';

function createTenantManagerRecorder() {
    const calls = [];
    return {
        calls,
        manager: {
            incrementApiCallCount: (...args) => calls.push(['api', ...args]),
            incrementTokenUsage: (...args) => calls.push(['tokens', ...args]),
            recordDailyUsage: (...args) => calls.push(['daily', ...args])
        }
    };
}

test('recordRelayUsage records relay-scoped counters and daily usage', () => {
    const {calls, manager} = createTenantManagerRecorder();

    recordRelayUsage({
        tenantManager: manager,
        tenantId: 42,
        inputTokens: 11,
        outputTokens: 7,
        cacheHitTokens: 3,
        model: 'relay-model'
    });

    assert.deepEqual(calls, [
        ['api', 42, 'relay'],
        ['tokens', 42, 'relay', 11, 7, 3],
        ['daily', 42, 'relay', 11, 7, 3, 0, 'relay-model']
    ]);
});

test('recordRelayUsage ignores missing tenant id', () => {
    const {calls, manager} = createTenantManagerRecorder();

    recordRelayUsage({
        tenantManager: manager,
        tenantId: null,
        inputTokens: 11,
        outputTokens: 7,
        cacheHitTokens: 3,
        model: 'relay-model'
    });

    assert.deepEqual(calls, []);
});

test('recordRelayResponsesUsage extracts Responses usage fields for relay usage', () => {
    const {calls, manager} = createTenantManagerRecorder();

    recordRelayResponsesUsage({
        tenantManager: manager,
        tenantId: 42,
        usage: {
            input_tokens: 20,
            output_tokens: 9,
            input_tokens_details: {cached_tokens: 5}
        },
        model: 'responses-model'
    });

    assert.deepEqual(calls, [
        ['api', 42, 'relay'],
        ['tokens', 42, 'relay', 20, 9, 5],
        ['daily', 42, 'relay', 20, 9, 5, 0, 'responses-model']
    ]);
});

test('createRelayUsageRecorder keeps the route-facing positional API small', () => {
    const {calls, manager} = createTenantManagerRecorder();
    const recorder = createRelayUsageRecorder(manager);

    recorder.recordUsage(42, 4, 2, 1, 'chat-model');
    recorder.recordResponsesUsage(42, {
        input_tokens: 6,
        output_tokens: 3,
        input_tokens_details: {cached_tokens: 2}
    }, 'responses-model');

    assert.deepEqual(calls, [
        ['api', 42, 'relay'],
        ['tokens', 42, 'relay', 4, 2, 1],
        ['daily', 42, 'relay', 4, 2, 1, 0, 'chat-model'],
        ['api', 42, 'relay'],
        ['tokens', 42, 'relay', 6, 3, 2],
        ['daily', 42, 'relay', 6, 3, 2, 0, 'responses-model']
    ]);
});
