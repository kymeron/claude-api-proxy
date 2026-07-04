/**
 * Qoder 路由运行时工厂
 *
 * P3 阶段：在工厂内部装配所有基础 handler（chat / anthropic / metadata）。
 * P4 阶段：通过 `handlers` 注入 Responses 系列（compact / api / ws）。
 *
 * @module services/qoder/route-runtime
 */

import defaultLogger from '../../utils/logger.js';
import {getQoderCredentialService} from './credential-service.js';
import {createQoderCredentialResolver, createQoderTenantCredentialManagerResolver} from './credential-context.js';
import {createQoderUsageRecorder} from './usage.js';
import {
    sendQoderJsonResponse as sendJson,
    sendQoderOpenAIError as sendOpenAIError,
    sendQoderAnthropicError as sendAnthropicError,
    qoderUpstreamErrorStatus as upstreamErrorStatus
} from './response-writer.js';
import {mapQoderModelName as mapModelName} from './model-mapping.js';
import {resolveQoderConversationId as resolveConversationId} from './conversation-key.js';
import {createQoderChatCompletionsHandler} from './chat-completions-handler.js';
import {createQoderAnthropicMessagesHandler} from './anthropic-messages-handler.js';
import {createQoderMetadataHandlers} from './metadata-handler.js';
import {anthropicToOpenAI, openAIToAnthropic} from './anthropic-adapter.js';
import {sanitizeAnthropicPayload as defaultSanitizeAnthropicPayload} from './protocol-adapter.js';

/**
 * 读取 HTTP 请求体（UTF-8 字符串）
 */
export async function readQoderRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * 创建 Qoder 路由运行时
 *
 * @param {Object} options
 * @param {Object} options.tenantManager - 租户管理器（unifiedTenantManager）
 * @param {Function} options.resolveCredential - 从 headers + 凭证列表解析单个凭证
 * @param {Object} [options.logger] - 日志器
 * @param {Object} [options.handlers] - 由 P4 注入的 handler 集合：
 *   - handleResponsesCompact
 *   - handleResponsesAPI
 *   - handleQoderResponsesWS
 * @param {Function} [options.sanitizeAnthropicPayload] - Anthropic payload 清洗（默认从 protocol-adapter 拿）
 */
export function createQoderRouteRuntime({
    tenantManager,
    resolveCredential,
    logger = defaultLogger,
    handlers = {},
    sanitizeAnthropicPayload: sanitizeAnthropicPayloadOpt
} = {}) {
    if (!tenantManager) {
        throw new Error('createQoderRouteRuntime requires a tenantManager');
    }
    if (typeof resolveCredential !== 'function') {
        throw new Error('createQoderRouteRuntime requires resolveCredential');
    }
    if (typeof resolveCredential !== 'function') {
        throw new Error('createQoderRouteRuntime requires resolveCredential');
    }

    const credentialService = getQoderCredentialService(tenantManager);
    const authenticateAndGetCredential = createQoderCredentialResolver({
        credentialService,
        resolveCredential
    });
    const resolveTenantManager = createQoderTenantCredentialManagerResolver({credentialService});
    const {recordUsage: recordQoderUsage} = createQoderUsageRecorder(tenantManager);

    // === 装配 P3 handler ===
    const sanitizeAnthropicPayload = sanitizeAnthropicPayloadOpt || defaultSanitizeAnthropicPayload;

    const handleOpenAIChatCompletions = createQoderChatCompletionsHandler({
        authenticateAndGetCredential,
        tenantManager,
        sendOpenAIError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readQoderRequestBody,
        mapModelName,
        resolveConversationId,
        recordUsage: recordQoderUsage,
        logger
    });

    const handleAnthropicMessages = createQoderAnthropicMessagesHandler({
        authenticateAndGetCredential,
        tenantManager,
        sendAnthropicError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readQoderRequestBody,
        sanitizeAnthropicPayload,
        anthropicToOpenAI,
        mapModelName,
        resolveConversationId,
        openAIToAnthropic,
        recordUsage: recordQoderUsage,
        logger
    });

    const {
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels
    } = createQoderMetadataHandlers({
        authenticateAndGetCredential,
        sendOpenAIError,
        sendAnthropicError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readQoderRequestBody,
        sanitizeAnthropicPayload,
        logger
    });

    // === P4 Responses handler（P4 注入；未注入时返回 503） ===
    const notReadyHandler = (req, res) => {
        sendOpenAIError(res, 503, 'Qoder Responses handler not yet wired (P4 in progress)');
    };

    const handleResponsesCompact = handlers.handleResponsesCompact || notReadyHandler;
    const handleResponsesAPI = handlers.handleResponsesAPI || notReadyHandler;
    const handleQoderResponsesWS = handlers.handleQoderResponsesWS || (() => {});

    function handleRoot(req, res) {
        const tenantCount = tenantManager.listTenants().length;
        sendJson(res, 200, {
            name: 'Qoder API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic'],
            tenantCount,
            endpoints: {
                openai: {
                    chatCompletions: 'POST /qoder/v1/chat/completions - OpenAI format',
                    responses: 'POST /qoder/v1/responses - Responses API',
                    responsesCompact: 'POST /qoder/v1/responses/compact - Responses Compact API',
                    models: 'GET /qoder/v1/models - OpenAI format models'
                },
                anthropic: {
                    messages: 'POST /qoder/anthropic/v1/messages - Claude format',
                    countTokens: 'POST /qoder/anthropic/v1/messages/count_tokens',
                    models: 'GET /qoder/anthropic/v1/models - Claude format models'
                }
            }
        });
    }

    async function routeQoderRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const method = req.method;

        // Anthropic 子路径
        if (pathname.startsWith('/qoder/anthropic')) {
            const anthropicPath = pathname.replace('/qoder/anthropic', '');

            if (anthropicPath === '/v1/messages' && method === 'POST') {
                return handleAnthropicMessages(req, res);
            }
            if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') {
                return handleAnthropicCountTokens(req, res);
            }
            if (anthropicPath === '/v1/models' && method === 'GET') {
                return handleAnthropicModels(req, res);
            }
            if (anthropicPath === '' || anthropicPath === '/') {
                sendJson(res, 200, {
                    name: 'Qoder API Proxy - Anthropic Mode',
                    version: '1.0.0',
                    endpoints: {
                        messages: 'POST /qoder/anthropic/v1/messages',
                        countTokens: 'POST /qoder/anthropic/v1/messages/count_tokens',
                        models: 'GET /qoder/anthropic/v1/models'
                    }
                });
                return;
            }

            sendAnthropicError(res, 404, 'Endpoint not found');
            return;
        }

        // OpenAI / Responses 子路径
        if (pathname === '/qoder/v1/chat/completions' && method === 'POST') {
            return handleOpenAIChatCompletions(req, res);
        }
        if (pathname === '/qoder/v1/responses/compact' && method === 'POST') {
            return handleResponsesCompact(req, res);
        }
        if (pathname === '/qoder/v1/responses' && method === 'POST') {
            return handleResponsesAPI(req, res);
        }
        if (pathname === '/qoder/v1/models' && method === 'GET') {
            return handleOpenAIModels(req, res);
        }

        // 根路径 / 健康检查
        if (pathname === '/qoder' || pathname === '/qoder/'
            || pathname === '/qoder/v1' || pathname === '/qoder/v1/') {
            return handleRoot(req, res);
        }

        sendOpenAIError(res, 404, 'Endpoint not found');
    }

    return {
        // 内部依赖（供 P3 handler 复用）
        _internal: {
            tenantManager,
            logger,
            credentialService,
            authenticateAndGetCredential,
            resolveTenantManager,
            recordQoderUsage,
            mapModelName,
            resolveConversationId,
            sendJson,
            sendOpenAIError,
            sendAnthropicError,
            upstreamErrorStatus,
            parseBody: readQoderRequestBody
        },
        // 公开 handler（供 routes/qoder.js 使用）
        sendJson,
        sendOpenAIError,
        sendAnthropicError,
        handleRoot,
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels,
        handleOpenAIChatCompletions,
        handleAnthropicMessages,
        handleResponsesCompact,
        handleResponsesAPI,
        handleQoderResponsesWS,
        routeQoderRequest
    };
}