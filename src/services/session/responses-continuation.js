import {
    createResponsesInputDelta,
    limitResponsesInputItems
} from './protocol-adapter.js';
import logger from '../../utils/logger.js';

export function prepareResponsesContinuationPayload({
    conversationStore,
    tenantId,
    conversationKey,
    request,
    requestType,
    logger: log = logger
} = {}) {
    const prepared = conversationStore.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request
    });
    const stateConversationKey = prepared.conversationKey || conversationKey;
    const delta = createContinuationDelta(prepared.request, prepared);
    const previousResponseId = delta.deltaApplied
        ? prepared.lastResponseId
        : delta.deltaAttempted
            ? null
            : prepared.lastResponseId;
    const limited = limitResponsesInputItems(delta.request, {previousResponseId});

    if (limited.truncated) {
        log.info(
            `Responses continuation: truncated input items ${limited.originalLength}->${limited.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${limited.previousResponseId}`
        );
    }
    if (delta.deltaApplied) {
        log.info(
            `Responses continuation: delta input items ${delta.originalLength}->${delta.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${prepared.lastResponseId}`
        );
    } else if (delta.deltaAttempted) {
        log.info(
            `Responses continuation: delta input mismatch; websocket auto-link disabled`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${prepared.lastResponseId}`
        );
    }

    return {
        request: limited.payload,
        conversationKey: stateConversationKey,
        lastResponseId: prepared.lastResponseId,
        autoLink: !(delta.deltaAttempted && !delta.deltaApplied),
        deltaApplied: delta.deltaApplied,
        deltaAttempted: delta.deltaAttempted,
        deltaCoveredLength: delta.coveredLength,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        retainedLength: limited.retainedLength,
        droppedCount: limited.droppedCount
    };
}

function createContinuationDelta(request, prepared) {
    const previousResponseId = prepared?.lastResponseId;
    const previousInput = prepared?.lastResponseInput;
    const deltaAttempted = Boolean(
        previousResponseId
        && Array.isArray(previousInput)
        && previousInput.length > 0
        && Array.isArray(request?.input)
    );
    if (!deltaAttempted) {
        return {
            request,
            deltaAttempted: false,
            deltaApplied: false,
            originalLength: Array.isArray(request?.input) ? request.input.length : 0,
            retainedLength: Array.isArray(request?.input) ? request.input.length : 0,
            coveredLength: 0
        };
    }

    const delta = createResponsesInputDelta(request.input, previousInput);
    if (!delta.deltaApplied) {
        return {
            request,
            deltaAttempted: true,
            deltaApplied: false,
            originalLength: delta.originalLength,
            retainedLength: delta.retainedLength,
            coveredLength: 0
        };
    }

    return {
        request: {
            ...request,
            input: delta.input,
            previous_response_id: request.previous_response_id || previousResponseId
        },
        deltaAttempted: true,
        deltaApplied: true,
        originalLength: delta.originalLength,
        retainedLength: delta.retainedLength,
        coveredLength: delta.coveredLength
    };
}
