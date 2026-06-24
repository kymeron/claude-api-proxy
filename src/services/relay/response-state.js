import {limitResponsesInputItems} from './protocol-adapter.js';
import logger from '../../utils/logger.js';

export function recordRelayCompletedResponseState({
    conversationStore,
    tenantId,
    conversationKey,
    response,
    sourceCanonicalSession
}) {
    if (!response || !conversationKey) return;
    conversationStore.recordResponsesResponse({
        tenantId,
        conversationKey,
        response,
        sourceCanonicalSession
    });
}

export function createRelayCompletedResponseRecorder(conversationStore) {
    return (tenantId, conversationKey, response, sourceCanonicalSession) =>
        recordRelayCompletedResponseState({
            conversationStore,
            tenantId,
            conversationKey,
            response,
            sourceCanonicalSession
        });
}

export function limitRelayResponsesPassthroughPayload(payload, {
    previousResponseId,
    requestType,
    conversationKey,
    logger: activeLogger = logger,
    limitInputItems = limitResponsesInputItems
} = {}) {
    const limited = limitInputItems(payload, {previousResponseId});
    if (!limited.truncated) return limited.payload;

    activeLogger.info(
        `Responses passthrough: truncated input items ${limited.originalLength}->${limited.retainedLength}`
        + `${requestType ? ` requestType=${requestType}` : ''}`
        + `${conversationKey ? ` conversationKey=${conversationKey}` : ''}`
        + ` previous_response_id=${limited.previousResponseId}`
    );
    return limited.payload;
}

export function createRelayResponsesPassthroughLimiter({
    logger: activeLogger = logger,
    limitInputItems = limitResponsesInputItems
} = {}) {
    return (payload, options = {}) =>
        limitRelayResponsesPassthroughPayload(payload, {
            ...options,
            logger: activeLogger,
            limitInputItems
        });
}

export async function collectRelayResponsesWebSocketResponse(wsResult, {
    releaseConnection,
    discardConnection
} = {}) {
    if (typeof releaseConnection !== 'function' || typeof discardConnection !== 'function') {
        throw new TypeError('Responses WebSocket connection handlers are required');
    }

    let completedData = null;
    try {
        for await (const event of wsResult.eventStream) {
            if (event.type === 'response.completed') {
                completedData = event.data;
            }
        }
        releaseConnection(wsResult.conn);
    } catch (error) {
        discardConnection(wsResult.conn);
        throw error;
    }

    if (!completedData?.response) {
        throw new Error('No response.completed event received from upstream');
    }
    return completedData.response;
}

export function createRelayResponsesWebSocketCollector({
    releaseConnection,
    discardConnection
}) {
    return (wsResult) =>
        collectRelayResponsesWebSocketResponse(wsResult, {
            releaseConnection,
            discardConnection
        });
}
