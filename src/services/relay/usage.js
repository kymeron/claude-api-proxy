/**
 * Relay usage accounting helpers.
 * Keeps route handlers from knowing the tenant manager's usage write details.
 * @module services/relay/usage
 */

import {
    extractCacheHitTokens,
    extractInputTokens
} from './protocol-adapter.js';

export function recordRelayUsage({
    tenantManager,
    tenantId,
    inputTokens,
    outputTokens,
    cacheHitTokens = 0,
    model = 'unknown'
}) {
    if (!tenantId) return;
    tenantManager.incrementApiCallCount(tenantId, 'relay');
    tenantManager.incrementTokenUsage(
        tenantId,
        'relay',
        inputTokens,
        outputTokens,
        cacheHitTokens
    );
    tenantManager.recordDailyUsage(
        tenantId,
        'relay',
        inputTokens,
        outputTokens,
        cacheHitTokens,
        0,
        model
    );
}

export function recordRelayResponsesUsage({
    tenantManager,
    tenantId,
    usage,
    model
}) {
    recordRelayUsage({
        tenantManager,
        tenantId,
        inputTokens: extractInputTokens(usage),
        outputTokens: usage?.output_tokens || 0,
        cacheHitTokens: extractCacheHitTokens(usage),
        model
    });
}

export function createRelayUsageRecorder(tenantManager) {
    return {
        recordUsage(
            tenantId,
            inputTokens,
            outputTokens,
            cacheHitTokens = 0,
            model = 'unknown'
        ) {
            return recordRelayUsage({
                tenantManager,
                tenantId,
                inputTokens,
                outputTokens,
                cacheHitTokens,
                model
            });
        },

        recordResponsesUsage(tenantId, usage, model) {
            return recordRelayResponsesUsage({
                tenantManager,
                tenantId,
                usage,
                model
            });
        }
    };
}
