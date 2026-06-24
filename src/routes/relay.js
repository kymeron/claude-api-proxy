/**
 * Relay 路由处理�?- 支持 OpenAI �?Anthropic 双格式的聊天补全和模型列�?API
 * @module routes/relay
 */

import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {
    createChatCompletions,
    createResponses,
    createResponsesWebSocket,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    createAnthropicMessages,
    createAnthropicCountTokens,
    getUpstreamModels,
    isAnthropicUpstream,
    isResponsesUpstream,
    isResponsesWebSocketUpstream,
    aggregateStreamResponse
} from '../services/providers/index.js';
import {
    anthropicToOpenAI,
    injectBehaviorRules
} from '../services/relay/anthropic-adapter.js';
import {extractConversationKey} from '../services/relay/conversation-key.js';
import {createRelayUsageRecorder} from '../services/relay/usage.js';
import {
    callRelayUpstream as callUpstream,
    createRelayUpstreamContextResolver,
    getRelayProtocolErrorMessage as getProtocolErrorMessage,
    relayUpstreamErrorStatus as upstreamErrorStatus
} from '../services/relay/upstream-context.js';
import {
    createRelayCompletedResponseRecorder,
    createRelayResponsesPassthroughLimiter,
    createRelayResponsesWebSocketCollector
} from '../services/relay/response-state.js';
import {
    sendRelayAnthropicError as sendAnthropicError,
    sendRelayJsonResponse as sendJson,
    sendRelayOpenAIError as sendOpenAIError,
    sendRelayResponsesWebSocketProtocolError as sendResponsesWebSocketProtocolError,
    sendRelayStateMissingOpenAIError as sendStateMissingOpenAIError,
    toRelayResponsesWebSocketStateMissingError as toResponsesWebSocketStateMissingError
} from '../services/relay/response-writer.js';
import {
    getRelaySSEEventType as getSSEEventType,
    parseRelayResponsesSSEEvents as parseResponsesSSEEvents,
    parseRelaySSEBlock as parseSSEBlock,
    readRelayRequestBody as parseBody,
    readRelayResponseBody as readResponseBody
} from '../services/relay/stream-events.js';
import {
    getAnthropicRequestHeaders,
    mapAnthropicModelsToOpenAI,
    mapOpenAIModelsToAnthropic
} from '../services/relay/model-metadata.js';
import {createRelayMetadataHandlers} from '../services/relay/metadata-endpoints.js';
import {createRelayChatCompletionsHandler} from '../services/relay/chat-completions-handler.js';
import {createRelayAnthropicMessagesHandler} from '../services/relay/anthropic-messages-handler.js';
import {createRelayResponsesAPIHandler} from '../services/relay/responses-api-handler.js';
import {createRelayResponsesCompactHandler} from '../services/relay/responses-compact-handler.js';
import {createRelayResponsesWebSocketHandler} from '../services/relay/responses-websocket-handler.js';
import {prepareRelayOutboundChatRequest} from '../services/relay/outbound-chat.js';
import {createRelayContextCompaction} from '../services/relay/context-compaction.js';
import {
    estimateRelayAnthropicInputTokens as estimateAnthropicInputTokens,
    handleRelayAnthropicUsageEvent as handleAnthropicUsageEvent
} from '../services/relay/anthropic-usage.js';
import {
    streamRelayResponsesEventsAsAnthropic as streamResponsesEventsAsAnthropic,
    writeRelayAnthropicEvent as writeAnthropicEvent
} from '../services/relay/anthropic-stream.js';
import {createRelayOpenAIStreamPassthrough} from '../services/relay/openai-stream.js';
import {
    anthropicResponseToChat,
    rewriteOpenAIStream,
    stripDynamicReminders,
    sanitizeAnthropicPayload,
    extractCacheHitTokens,
    extractInputTokens,
    compactRequestToChat,
    chatResponseToCompact,
    mergeConsecutiveAssistantMessages,
    createAnthropicStreamAccumulator,
    createChatStreamAccumulator,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    streamAnthropicSSEToChatChunks,
    createResponsesStreamAccumulator,
    canonicalFromAnthropicRequest,
    canonicalFromAnthropicResponse,
    canonicalFromAnthropicStreamChatResponse,
    getRelayConversationDiagnostics,
    chatResponseToAnthropic,
    chatResponseToRelayResponses,
    chatRequestToRelayResponses,
    chatRequestToAnthropic,
    responsesResponseToRelayChat
} from '../services/relay/protocol-adapter.js';
import {
    handleWSConnection,
    isResponsesWebSocketProtocolError
} from '../services/shared/index.js';
import {
    RelayStateMissingError,
    relayConversationStore,
    prepareResponsesContinuationPayload
} from '../services/session/index.js';
import logger from '../utils/logger.js';

const {
    recordResponsesUsage,
    recordUsage
} = createRelayUsageRecorder(unifiedTenantManager);
const authenticateAndGetUpstream = createRelayUpstreamContextResolver(unifiedTenantManager);
const recordCompletedResponseState = createRelayCompletedResponseRecorder(relayConversationStore);
const limitResponsesPassthroughPayload = createRelayResponsesPassthroughLimiter({logger});
const collectResponsesWebSocketResponse = createRelayResponsesWebSocketCollector({
    releaseConnection: releaseResponsesWebSocketConnection,
    discardConnection: discardResponsesWebSocketConnection
});
const {invokeWithRelayContextCompaction} = createRelayContextCompaction({
    conversationStore: relayConversationStore,
    logger,
    isAnthropicUpstream,
    chatRequestToAnthropic,
    createAnthropicMessages,
    createChatCompletions,
    callUpstream,
    getAnthropicRequestHeaders,
    readResponseBody,
    anthropicResponseToChat,
    recordUsage,
    extractCacheHitTokens
});
const streamOpenAIPassthrough = createRelayOpenAIStreamPassthrough({
    conversationStore: relayConversationStore,
    recordUsage,
    logger
});
const {
    handleOpenAIModels,
    handleAnthropicModels,
    handleAnthropicCountTokens
} = createRelayMetadataHandlers({
    authenticateAndGetUpstream,
    getUpstreamModels,
    getAnthropicRequestHeaders,
    isAnthropicUpstream,
    isResponsesUpstream,
    isResponsesWebSocketUpstream,
    createAnthropicCountTokens,
    callUpstream,
    readResponseBody,
    parseBody,
    sanitizeAnthropicPayload,
    mapAnthropicModelsToOpenAI,
    mapOpenAIModelsToAnthropic,
    getProtocolErrorMessage,
    upstreamErrorStatus,
    sendJson,
    sendOpenAIError,
    sendAnthropicError,
    logger
});
const handleOpenAIChatCompletions = createRelayChatCompletionsHandler({
    authenticateAndGetUpstream,
    unifiedTenantManager,
    sendOpenAIError,
    sendJson,
    sendStateMissingOpenAIError,
    sendResponsesWebSocketProtocolError,
    upstreamErrorStatus,
    parseBody,
    injectBehaviorRules,
    stripDynamicReminders,
    mergeConsecutiveAssistantMessages,
    extractConversationKey,
    relayConversationStore,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createChatStreamAccumulator,
    streamAnthropicSSEToChatChunks,
    parseSSEBlock,
    canonicalFromAnthropicStreamChatResponse,
    recordUsage,
    extractCacheHitTokens,
    readResponseBody,
    anthropicResponseToChat,
    chatRequestToAnthropic,
    chatRequestToRelayResponses,
    prepareResponsesContinuationPayload,
    createResponsesWebSocket,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    createResponsesToChatStreamBridge,
    createResponsesStreamAccumulator,
    collectResponsesWebSocketResponse,
    recordCompletedResponseState,
    recordResponsesUsage,
    responsesResponseToRelayChat,
    createResponses,
    getSSEEventType,
    extractInputTokens,
    createChatCompletions,
    streamOpenAIPassthrough,
    RelayStateMissingError,
    isResponsesWebSocketProtocolError,
    logger
});
const handleAnthropicMessages = createRelayAnthropicMessagesHandler({
    authenticateAndGetUpstream,
    unifiedTenantManager,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    anthropicToOpenAI,
    injectBehaviorRules,
    stripDynamicReminders,
    mergeConsecutiveAssistantMessages,
    extractConversationKey,
    relayConversationStore,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createAnthropicStreamAccumulator,
    parseSSEBlock,
    handleAnthropicUsageEvent,
    anthropicResponseToChat,
    recordUsage,
    estimateAnthropicInputTokens,
    readResponseBody,
    extractInputTokens,
    extractCacheHitTokens,
    chatRequestToRelayResponses,
    prepareResponsesContinuationPayload,
    createResponsesWebSocket,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    createResponsesStreamAccumulator,
    streamResponsesEventsAsAnthropic,
    recordCompletedResponseState,
    recordResponsesUsage,
    collectResponsesWebSocketResponse,
    responsesResponseToRelayChat,
    chatResponseToAnthropic,
    createResponses,
    parseResponsesSSEEvents,
    createChatCompletions,
    createChatToAnthropicStreamBridge,
    createChatStreamAccumulator,
    writeAnthropicEvent,
    aggregateStreamResponse,
    logger
});
const handleResponsesAPI = createRelayResponsesAPIHandler({
    authenticateAndGetUpstream,
    sendOpenAIError,
    sendJson,
    sendStateMissingOpenAIError,
    sendResponsesWebSocketProtocolError,
    upstreamErrorStatus,
    parseBody,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    extractConversationKey,
    relayConversationStore,
    unifiedTenantManager,
    invokeWithRelayContextCompaction,
    prepareRelayOutboundChatRequest,
    chatRequestToAnthropic,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createChatToResponsesStreamBridge,
    createResponsesStreamAccumulator,
    createChatStreamAccumulator,
    streamAnthropicSSEToChatChunks,
    parseSSEBlock,
    canonicalFromAnthropicStreamChatResponse,
    recordCompletedResponseState,
    recordUsage,
    extractCacheHitTokens,
    readResponseBody,
    anthropicResponseToChat,
    chatResponseToRelayResponses,
    canonicalFromAnthropicResponse,
    createResponsesWebSocket,
    limitResponsesPassthroughPayload,
    createResponsesToResponsesStreamBridge,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    recordResponsesUsage,
    collectResponsesWebSocketResponse,
    createResponses,
    getSSEEventType,
    extractInputTokens,
    createChatCompletions,
    aggregateStreamResponse,
    RelayStateMissingError,
    isResponsesWebSocketProtocolError,
    logger
});

const handleResponsesCompact = createRelayResponsesCompactHandler({
    authenticateAndGetUpstream,
    sendOpenAIError,
    sendJson,
    sendResponsesWebSocketProtocolError,
    upstreamErrorStatus,
    parseBody,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    extractConversationKey,
    unifiedTenantManager,
    compactRequestToChat,
    injectBehaviorRules,
    stripDynamicReminders,
    mergeConsecutiveAssistantMessages,
    chatRequestToAnthropic,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    readResponseBody,
    anthropicResponseToChat,
    extractCacheHitTokens,
    recordUsage,
    chatResponseToCompact,
    chatRequestToRelayResponses,
    limitResponsesPassthroughPayload,
    createResponsesWebSocket,
    collectResponsesWebSocketResponse,
    recordResponsesUsage,
    responsesResponseToRelayChat,
    createResponses,
    extractInputTokens,
    createChatCompletions,
    aggregateStreamResponse,
    isResponsesWebSocketProtocolError,
    logger
});

export const handleRelayResponsesWS = createRelayResponsesWebSocketHandler({
    authenticateAndGetUpstream,
    unifiedTenantManager,
    handleWSConnection,
    recordUsage,
    extractConversationKey,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    relayConversationStore,
    RelayStateMissingError,
    toResponsesWebSocketStateMissingError,
    invokeWithRelayContextCompaction,
    prepareRelayOutboundChatRequest,
    chatRequestToAnthropic,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createChatToResponsesStreamBridge,
    createChatStreamAccumulator,
    createResponsesStreamAccumulator,
    streamAnthropicSSEToChatChunks,
    parseSSEBlock,
    canonicalFromAnthropicStreamChatResponse,
    recordCompletedResponseState,
    limitResponsesPassthroughPayload,
    createResponsesWebSocket,
    discardResponsesWebSocketConnection,
    releaseResponsesWebSocketConnection,
    createResponses,
    getSSEEventType,
    createChatCompletions
});

/* ==================== 工具函数 ==================== */





/* ==================== 鉴权 ==================== */

/* ==================== 处理函数 ==================== */

/**
 * 处理 OpenAI 格式�?/relay/v1/chat/completions 请求
 */
/**
 * 处理 Anthropic 格式�?/relay/anthropic/v1/messages 请求
 */
/* ==================== 流式响应辅助 ==================== */

/** OpenAI 上游流式透传（OpenAI 端点 �?OpenAI 上游），�?reasoning_content 做缓冲合�?*/
/* ==================== 其他端点 ==================== */

/* ==================== Responses API ==================== */

/**
 * 处理 Responses API 请求 (/relay/v1/responses)
 * �?Responses 格式转为 Chat Completions 发给上游，再将响应转�?Responses 格式
 */
/**
 * 处理 Responses Compact 请求 (/relay/v1/responses/compact)
 */
/* ==================== 主路由 ==================== */

export async function routeRelayRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/relay' || pathname === '/relay/') {
        sendJson(res, 200, {
            name: 'Relay API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic'],
            tenantEnabled: unifiedTenantManager.isEnabled(),
            endpoints: {
                openai: {
                    chatCompletions: 'POST /relay/v1/chat/completions - OpenAI format',
                    responses: 'POST /relay/v1/responses - Responses API',
                    responsesCompact: 'POST /relay/v1/responses/compact - Responses Compact API',
                    diagnostics: 'GET /relay/v1/diagnostics - Relay session diagnostics',
                    models: 'GET /relay/v1/models - OpenAI format models'
                },
                anthropic: {
                    messages: 'POST /relay/anthropic/v1/messages - Claude format',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models - Claude format models'
                }
            }
        });
        return;
    }

    if (pathname === '/relay/v1/diagnostics' && method === 'GET') {
        if (!req.tenantId) {
            sendOpenAIError(res, 401, 'Unauthorized', 'authentication_error');
            return;
        }
        sendJson(res, 200, getRelayConversationDiagnostics(relayConversationStore, {tenantId: req.tenantId}));
        return;
    }

    if (pathname.startsWith('/relay/anthropic')) {
        const anthropicPath = pathname.replace('/relay/anthropic', '');

        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'Relay API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /relay/anthropic/v1/messages',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models'
                }
            });
            return;
        }

        if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST')
            return handleAnthropicCountTokens(req, res);
        if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    if (pathname === '/relay/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/relay/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
    if (pathname === '/relay/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
    if (pathname === '/relay/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
