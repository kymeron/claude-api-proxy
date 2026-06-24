/**
 * Copilot 路由处理器 - 支持 OpenAI 和 Anthropic 双格式的聊天补全和模型列表 API
 * @module routes/copilot
 */

import {ensureCopilotToken, isAuthenticated} from '../services/copilot/auth.js';
import {createChatCompletions, createResponsesWS, releaseWSConnection, discardWSConnection, getModels} from '../services/copilot/copilot-api.js';
import {copilotState} from '../services/copilot/state.js';
import {copilotStore} from '../services/copilot/copilot-store.js';
import {readBody} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    anthropicToResponses,
    openAIToAnthropic
} from '../services/copilot/anthropic-adapter.js';
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
} from '../services/copilot/protocol-adapter.js';
import {
    estimateMessageTokens,
    estimateContentBlockTokens
} from '../utils/token-estimation.js';
import {handleWSConnection} from '../services/shared/index.js';
import {
    currentCopilotContext,
    runCopilotTenantContext,
    runWithCopilotContext
} from '../services/copilot/runtime.js';
import {
    copilotUpstreamErrorStatus as upstreamErrorStatus,
    isCopilotResponsesProtocolError as isResponsesProtocolError,
    sendCopilotAnthropicError as sendAnthropicError,
    sendCopilotJsonResponse as sendJson,
    sendCopilotOpenAIError as sendOpenAIError,
    sendCopilotResponsesProtocolError as sendResponsesProtocolError
} from '../services/copilot/response-writer.js';
import {extractCopilotConversationKey as extractConversationKey} from '../services/copilot/conversation-key.js';
import {createCopilotNetworkOptionsResolver} from '../services/copilot/network-options.js';
import {createCopilotAuthResolver} from '../services/copilot/auth-context.js';
import {
    ensureCopilotResponsesWebSocketSupported as ensureResponsesWebSocketSupported,
    supportsCopilotResponsesWebSocket
} from '../services/copilot/model-support.js';
import {createCopilotMetadataHandlers} from '../services/copilot/metadata-handler.js';
import {createCopilotChatCompletionsHandler} from '../services/copilot/chat-completions-handler.js';
import {createCopilotResponsesCompactHandler} from '../services/copilot/responses-compact-handler.js';
import {createCopilotAnthropicMessagesHandler} from '../services/copilot/anthropic-messages-handler.js';
import {createCopilotResponsesAPIHandler} from '../services/copilot/responses-api-handler.js';
import logger from '../utils/logger.js';

const getCopilotNetworkOptions = createCopilotNetworkOptionsResolver({store: copilotStore});
const ensureCopilotAuth = createCopilotAuthResolver({
    isAuthenticated,
    ensureCopilotToken,
    store: copilotStore
});

export const supportsResponsesWebSocket = supportsCopilotResponsesWebSocket;

/**
 * API Key 鉴权（已移除，统一由网关层处理）
 */

async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

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
    parseBody,
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
    parseBody,
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
    parseBody,
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
    parseBody,
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
    parseBody,
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

/* ==================== WebSocket 端点 ==================== */

/**
 * 处理 Copilot Responses API WebSocket 连接
 * 客户端通过 WS 连接 /copilot/v1/responses，发送标准 Responses API WS 协议
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {http.IncomingMessage} req - 原始 HTTP 请求
 */
function handleCopilotResponsesWSInContext(clientWs, req) {
    const tenantContext = currentCopilotContext();
    handleWSConnection(clientWs, {
        authenticate: () => true,
        runInContext: callback => runWithCopilotContext(tenantContext, callback),
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            // Copilot 认证
            if (!isAuthenticated()) {
                throw Object.assign(new Error('Not authenticated. Open the Copilot tab in /dashboard to connect GitHub.'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: 'Not authenticated', code: 'unauthorized'}}
                });
            }

            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;

            try {
                const copilotToken = await ensureCopilotToken(proxyUrl, networkOptions);
                const conversationKey = extractConversationKey(req, payload);

                // 净化 input
                if (Array.isArray(payload.input)) {
                    payload = {...payload, input: sanitizeResponsesInput(payload.input, payload.model)};
                }

                // 尝试 WS 模式（GPT 系列模型）
                if (supportsResponsesWebSocket(payload.model)) {
                    try {
                        const wsResult = await createResponsesWS(
                            copilotToken,
                            copilotState.vsCodeVersion,
                            payload,
                            copilotState.accountType,
                            proxyUrl,
                            {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
                        );

                        const eventStream = wsResult.eventStream;
                        const conn = wsResult.conn;

                        // 注意：必须用 finally 释放连接
                        // 否则 WS server 在收到 response.completed 后 break，会触发 generator return()，
                        // try 块尾部的 releaseWSConnection 永远到不了，连接将一直 busy 烂在池里
                        let connHandled = false;
                        try {
                            for await (const event of eventStream) {
                                if (signal?.aborted) {
                                    discardWSConnection(conn);
                                    connHandled = true;
                                    return;
                                }
                                yield event;
                            }
                        } catch (err) {
                            discardWSConnection(conn);
                            connHandled = true;
                            throw err;
                        } finally {
                            if (!connHandled) releaseWSConnection(conn);
                        }
                        return;
                    } catch (wsError) {
                        logger.warn(`Copilot WS: WS failed, falling back to HTTP: ${wsError.message}`);
                    }
                }

                // HTTP 回退：Responses → Chat Completions → Responses 事件转换
                const chatReq = responsesRequestToChat(payload);
                chatReq.stream = true;

                const response = await createChatCompletions(
                    copilotToken,
                    copilotState.vsCodeVersion,
                    chatReq,
                    copilotState.accountType,
                    proxyUrl,
                    networkOptions
                );

                if (response.status >= 400) {
                    const errorBody = await readBody(response.body);
                    throw Object.assign(new Error(`Upstream error: ${errorBody.slice(0, 500)}`), {
                        name: 'ResponsesWSError',
                        event: {type: 'error', error: {message: `Upstream error: ${response.status}`, code: 'upstream_error'}}
                    });
                }

                // 将 Chat SSE 流转换为 Responses WS 事件
                const chatToResponsesBridge = createChatToResponsesStreamBridge({model: payload.model});
                let buffer = Buffer.alloc(0);

                for await (const chunk of response.body) {
                    if (signal?.aborted) break;
                    buffer = Buffer.concat([buffer, chunk]);
                    let start = 0;
                    let newLineIndex;
                    while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                        const line = buffer.toString('utf8', start, newLineIndex).trim();
                        start = newLineIndex + 1;
                        if (!line || line.startsWith(':') || !line.startsWith('data: ')) continue;
                        const raw = line.slice(6).trim();
                        if (raw === '[DONE]') continue;

                        let data;
                        try { data = JSON.parse(raw); } catch { continue; }

                        const events = chatToResponsesBridge.feed(data);
                        for (const ev of events) {
                            yield {type: ev.event, data: ev.data};
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                }

                if (!chatToResponsesBridge.finished) {
                    for (const ev of chatToResponsesBridge.finish()) {
                        yield {type: ev.event, data: ev.data};
                    }
                }
            } catch (error) {
                logger.error('Copilot WS: handleRequest error:', error);
                throw error;
            }
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            copilotStore.incrementApiCallCount();
            copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model);
        }
    });
}

/* ==================== 根路径 ==================== */

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

/* ==================== 主路由 ==================== */

async function routeCopilotRequestInContext(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    logger.info(`Copilot request: ${method} ${pathname}`);

    // ========== Anthropic 模式 ==========
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

    // ========== OpenAI 模式 ==========
    if (pathname === '/copilot/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/copilot/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
    if (pathname === '/copilot/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
    if (pathname === '/copilot/v1/models' && method === 'GET') {
        return handleOpenAIModels(req, res);
    }

    // ========== 根路径 ==========
    if (pathname === '/copilot' || pathname === '/copilot/') return handleRoot(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}

export async function routeCopilotRequest(req, res) {
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

export async function handleCopilotResponsesWS(clientWs, req) {
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
