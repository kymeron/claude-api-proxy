/**
 * Copilot protocol adapter facade.
 * Keeps route handlers decoupled from the protocol core file layout.
 * @module services/copilot/protocol-adapter
 */

export {
    anthropicRequestToChat,
    anthropicRequestToResponses,
    chatRequestToResponses,
    chatResponseToCompact,
    chatResponseToResponses,
    compactRequestToChat,
    convertResponsesUsageToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesToAnthropicStreamBridge,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    extractCacheHitTokens,
    normalizeClaudeModelAlias,
    normalizePayload,
    openAIToAnthropic,
    responsesRequestToChat,
    responsesResponseToAnthropic,
    responsesResponseToChat,
    sanitizeAnthropicPayload,
    sanitizeResponsesInput
} from '../../core/protocol/index.js';
