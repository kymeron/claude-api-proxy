/**
 * Qoder 协议适配门面
 *
 * 与 codebuddy 形态一致：仅 re-export，让 handler 与协议引擎核心解耦。
 * 这里集中处理跨 handler 共用的协议逻辑（流转换、payload 规范化、会话锚点）。
 *
 * @module services/qoder/protocol-adapter
 */

export {
    anthropicRequestToChat,
    buildConversationAnchorKey,
    chatResponseToCompact,
    chatResponseToResponses,
    compactRequestToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    extractCacheHitTokens,
    mergeConsecutiveAssistantMessages,
    normalizePayload,
    openAIToAnthropic,
    responsesRequestToChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload,
    stripDynamicReminders
} from '#protocol-engine';