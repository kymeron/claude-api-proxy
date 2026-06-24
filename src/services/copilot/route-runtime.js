import {ensureCopilotToken, isAuthenticated} from './auth.js';
import {createChatCompletions, createResponsesWS, releaseWSConnection, discardWSConnection, getModels} from './copilot-api.js';
import {copilotState} from './state.js';
import {copilotStore} from './copilot-store.js';
import {readBody} from '../../utils/http-client.js';
import {
    anthropicToOpenAI,
    anthropicToResponses,
    openAIToAnthropic
} from './anthropic-adapter.js';
import {
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
    responsesRequestToChat,
    responsesResponseToChat,
    sanitizeAnthropicPayload,
    sanitizeResponsesInput
} from './protocol-adapter.js';
import {
    estimateMessageTokens,
    estimateContentBlockTokens
} from '../../utils/token-estimation.js';
import {handleWSConnection} from '../shared/index.js';
import {
    currentCopilotContext,
    runCopilotTenantContext,
    runWithCopilotContext
} from './runtime.js';
import {
    copilotUpstreamErrorStatus as upstreamErrorStatus,
    isCopilotResponsesProtocolError as isResponsesProtocolError,
    sendCopilotAnthropicError as sendAnthropicError,
    sendCopilotJsonResponse as sendJson,
    sendCopilotOpenAIError as sendOpenAIError,
    sendCopilotResponsesProtocolError as sendResponsesProtocolError
} from './response-writer.js';
import {extractCopilotConversationKey as extractConversationKey} from './conversation-key.js';
import {createCopilotNetworkOptionsResolver} from './network-options.js';
import {createCopilotAuthResolver} from './auth-context.js';
import {
    ensureCopilotResponsesWebSocketSupported as ensureResponsesWebSocketSupported,
    supportsCopilotResponsesWebSocket
} from './model-support.js';
import {createCopilotMetadataHandlers} from './metadata-handler.js';
import {createCopilotChatCompletionsHandler} from './chat-completions-handler.js';
import {createCopilotResponsesCompactHandler} from './responses-compact-handler.js';
import {createCopilotAnthropicMessagesHandler} from './anthropic-messages-handler.js';
import {createCopilotResponsesAPIHandler} from './responses-api-handler.js';
import {createCopilotResponsesWebSocketHandler} from './responses-websocket-handler.js';
import defaultLogger from '../../utils/logger.js';

export async function readCopilotRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function createCopilotRouteRuntime({logger = defaultLogger} = {}) {
    const getCopilotNetworkOptions = createCopilotNetworkOptionsResolver({store: copilotStore});
    const ensureCopilotAuth = createCopilotAuthResolver({
        isAuthenticated,
        ensureCopilotToken,
        store: copilotStore
    });

    const {
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels
    } = createCopilotMetadataHandlers({
        getCopilotNetworkOptions,
        ensureCopilotAuth,
        getModels,
        copilotState,
        sendOpenAIError,
        sendAnthropicError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCopilotRequestBody,
        sanitizeAnthropicPayload,
        estimateMessageTokens,
        estimateContentBlockTokens,
        logger
    });

    const handleOpenAIChatCompletions = createCopilotChatCompletionsHandler({
        getCopilotNetworkOptions,
        ensureCopilotAuth,
        sendOpenAIError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCopilotRequestBody,
        chatRequestToResponses,
        extractConversationKey,
        ensureResponsesWebSocketSupported,
        createResponsesWS,
        copilotState,
        createResponsesToChatStreamBridge,
        convertResponsesUsageToChat,
        extractCacheHitTokens,
        releaseWSConnection,
        discardWSConnection,
        responsesResponseToChat,
        createChatCompletions,
        readBody,
        estimateMessageTokens,
        copilotStore,
        logger
    });

    const handleResponsesCompact = createCopilotResponsesCompactHandler({
        getCopilotNetworkOptions,
        ensureCopilotAuth,
        sendOpenAIError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCopilotRequestBody,
        compactRequestToChat,
        createChatCompletions,
        copilotState,
        readBody,
        extractCacheHitTokens,
        copilotStore,
        chatResponseToCompact,
        logger
    });

    const handleResponsesAPI = createCopilotResponsesAPIHandler({
        getCopilotNetworkOptions,
        ensureCopilotAuth,
        sendOpenAIError,
        sendJson,
        sendResponsesProtocolError,
        upstreamErrorStatus,
        isResponsesProtocolError,
        parseBody: readCopilotRequestBody,
        extractConversationKey,
        sanitizeResponsesInput,
        ensureResponsesWebSocketSupported,
        createResponsesWS,
        copilotState,
        createResponsesToResponsesStreamBridge,
        convertResponsesUsageToChat,
        extractCacheHitTokens,
        releaseWSConnection,
        discardWSConnection,
        responsesRequestToChat,
        createChatCompletions,
        readBody,
        createChatToResponsesStreamBridge,
        chatResponseToResponses,
        copilotStore,
        logger
    });

    const handleAnthropicMessages = createCopilotAnthropicMessagesHandler({
        getCopilotNetworkOptions,
        ensureCopilotAuth,
        sendAnthropicError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCopilotRequestBody,
        sanitizeAnthropicPayload,
        extractConversationKey,
        anthropicToResponses,
        ensureResponsesWebSocketSupported,
        createResponsesWS,
        copilotState,
        createResponsesToAnthropicStreamBridge,
        convertResponsesUsageToChat,
        extractCacheHitTokens,
        releaseWSConnection,
        discardWSConnection,
        responsesResponseToChat,
        openAIToAnthropic,
        copilotStore,
        estimateMessageTokens,
        anthropicToOpenAI,
        createChatCompletions,
        readBody,
        createChatToAnthropicStreamBridge,
        logger
    });

    const handleCopilotResponsesWSInContext = createCopilotResponsesWebSocketHandler({
        handleWSConnection,
        currentCopilotContext,
        runWithCopilotContext,
        isAuthenticated,
        getCopilotNetworkOptions,
        ensureCopilotToken,
        extractConversationKey,
        sanitizeResponsesInput,
        supportsResponsesWebSocket: supportsCopilotResponsesWebSocket,
        createResponsesWS,
        copilotState,
        discardWSConnection,
        releaseWSConnection,
        responsesRequestToChat,
        createChatCompletions,
        readBody,
        createChatToResponsesStreamBridge,
        copilotStore,
        logger
    });

    function handleRoot(req, res) {
        sendJson(res, 200, {
            name: 'GitHub Copilot API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic', 'responses'],
            authenticated: isAuthenticated(),
            user: copilotState.userInfo,
            endpoints: {
                openai: {
                    chatCompletions: 'POST /copilot/v1/chat/completions - OpenAI format',
                    responses: 'POST /copilot/v1/responses - OpenAI Responses API',
                    responsesCompact: 'POST /copilot/v1/responses/compact - Responses Compact API',
                    models: 'GET /copilot/v1/models - OpenAI format models'
                },
                anthropic: {
                    messages: 'POST /copilot/anthropic/v1/messages - Claude format',
                    countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                    models: 'GET /copilot/anthropic/v1/models - Claude format models'
                }
            },
            configuration: {
                tokenSource: isAuthenticated() ? 'tenant credential database' : 'not configured'
            }
        });
    }

    async function routeCopilotRequestInContext(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const method = req.method;

        logger.info(`Copilot request: ${method} ${pathname}`);

        if (pathname.startsWith('/copilot/anthropic')) {
            const anthropicPath = pathname.replace('/copilot/anthropic', '');

            if (anthropicPath === '' || anthropicPath === '/') {
                sendJson(res, 200, {
                    name: 'Copilot API Proxy - Anthropic Mode',
                    version: '1.0.0',
                    endpoints: {
                        messages: 'POST /copilot/anthropic/v1/messages',
                        countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                        models: 'GET /copilot/anthropic/v1/models'
                    }
                });
                return;
            }

            if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
            if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') return handleAnthropicCountTokens(req, res);
            if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

            sendAnthropicError(res, 404, 'Endpoint not found');
            return;
        }

        if (pathname === '/copilot/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
        if (pathname === '/copilot/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
        if (pathname === '/copilot/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
        if (pathname === '/copilot/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

        if (pathname === '/copilot' || pathname === '/copilot/') return handleRoot(req, res);

        sendOpenAIError(res, 404, 'Endpoint not found');
    }

    async function routeCopilotRequest(req, res) {
        try {
            return await runCopilotTenantContext(
                req.tenantId,
                () => routeCopilotRequestInContext(req, res)
            );
        } catch (error) {
            logger.error(`Copilot tenant context failed: ${error.message}`);
            sendOpenAIError(res, 503, error.message);
        }
    }

    async function handleCopilotResponsesWS(clientWs, req) {
        try {
            return await runCopilotTenantContext(
                req.tenantId,
                () => handleCopilotResponsesWSInContext(clientWs, req)
            );
        } catch (error) {
            logger.error(`Copilot WebSocket tenant context failed: ${error.message}`);
            clientWs.close(1011, error.message.slice(0, 120));
        }
    }

    return {
        sendJson,
        sendOpenAIError,
        sendAnthropicError,
        supportsResponsesWebSocket: supportsCopilotResponsesWebSocket,
        handleRoot,
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels,
        handleOpenAIChatCompletions,
        handleAnthropicMessages,
        handleResponsesCompact,
        handleResponsesAPI,
        handleCopilotResponsesWS,
        routeCopilotRequest
    };
}
