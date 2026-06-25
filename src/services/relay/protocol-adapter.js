/**
 * Relay protocol adapter facade.
 * Keeps route handlers decoupled from the protocol core file layout.
 * @module services/relay/protocol-adapter
 */

export {
    anthropicRequestToChat,
    anthropicResponseToChat,
    buildConversationAnchorKey,
    canonicalFromAnthropicRequest,
    canonicalFromAnthropicResponse,
    canonicalFromAnthropicStreamChatResponse,
    chatRequestToAnthropic,
    chatRequestToRelayResponses,
    chatResponseToAnthropic,
    chatResponseToCompact,
    chatResponseToRelayResponses,
    compactRequestToChat,
    createAnthropicStreamAccumulator,
    createChatStreamAccumulator,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesStreamAccumulator,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    extractCacheHitTokens,
    extractInputTokens,
    getRelayConversationDiagnostics,
    limitResponsesInputItems,
    mapStopReason,
    mergeConsecutiveAssistantMessages,
    openAIToAnthropic,
    responsesResponseToRelayChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload,
    streamAnthropicSSEToChatChunks,
    stripDynamicReminders
} from '#protocol-engine';
