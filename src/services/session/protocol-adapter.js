/**
 * Session protocol adapter facade.
 * Keeps session storage code decoupled from the protocol core file layout.
 * @module services/session/protocol-adapter
 */

export {
    appendAnthropicResponseToCanonical,
    appendChatResponseToCanonical,
    appendResponsesResponseToCanonical,
    canonicalFromChatRequest,
    canonicalFromResponsesRequest,
    canonicalFromResponsesResponse,
    convertResponsesUsageToChat,
    createResponsesInputDelta,
    limitResponsesInputItems,
    preserveCanonicalResponseToolMappings,
    preserveCanonicalToolMappings,
    renderCanonicalToChat,
    renderCanonicalToResponses
} from '#protocol-engine';
