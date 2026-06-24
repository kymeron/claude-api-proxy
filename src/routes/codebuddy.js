/**
 * CodeBuddy 路由处理器 - 支持 OpenAI 直出和 Claude 兼容模式
 * @module routes/codebuddy
 */

import {createChatCompletions, getModels} from '../services/codebuddy/api.js';
import {aggregateStreamResponse} from '../services/providers/index.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic
} from '../services/codebuddy/anthropic-adapter.js';
import {
    chatResponseToResponses,
    chatResponseToCompact,
    compactRequestToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    extractCacheHitTokens,
    responsesRequestToChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload
} from '../services/codebuddy/protocol-adapter.js';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {BLOCKED_DOMAINS, getCodebuddyBaseUrl, isPersonalHost} from '../services/codebuddy/config.js';
import {handleWSConnection} from '../services/shared/index.js';
import {
    codebuddyUpstreamErrorStatus as upstreamErrorStatus,
    sendCodebuddyAnthropicError as sendAnthropicError,
    sendCodebuddyJsonResponse as sendJson,
    sendCodebuddyOpenAIError as sendOpenAIError
} from '../services/codebuddy/response-writer.js';
import {resolveCodebuddyConversationId as resolveConversationId} from '../services/codebuddy/conversation-key.js';
import {prepareCodebuddyOutboundChatRequest} from '../services/codebuddy/outbound-chat.js';
import {
    createCodebuddyCredentialResolver,
    createCodebuddyTenantCredentialManagerResolver
} from '../services/codebuddy/credential-context.js';
import {
    createCodebuddyUsageRecorder
} from '../services/codebuddy/usage.js';
import {mapCodebuddyModelName as mapModelName} from '../services/codebuddy/model-mapping.js';
import {createCodebuddyChatCompletionsHandler} from '../services/codebuddy/chat-completions-handler.js';
import {createCodebuddyAnthropicMessagesHandler} from '../services/codebuddy/anthropic-messages-handler.js';
import {createCodebuddyResponsesCompactHandler} from '../services/codebuddy/responses-compact-handler.js';
import {createCodebuddyResponsesAPIHandler} from '../services/codebuddy/responses-api-handler.js';
import {createCodebuddyResponsesWebSocketHandler} from '../services/codebuddy/responses-websocket-handler.js';
import {createCodebuddyMetadataHandlers} from '../services/codebuddy/metadata-handler.js';
import logger from '../utils/logger.js';

const authenticateAndGetCredential = createCodebuddyCredentialResolver({tenantManager: unifiedTenantManager});
const resolveTenantManager = createCodebuddyTenantCredentialManagerResolver({tenantManager: unifiedTenantManager});
const {recordUsage: recordCodebuddyUsage} = createCodebuddyUsageRecorder(unifiedTenantManager);


async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}


const handleOpenAIChatCompletions = createCodebuddyChatCompletionsHandler({
    authenticateAndGetCredential,
    tenantManager: unifiedTenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    mapModelName,
    resolveConversationId,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    rewriteOpenAIStream,
    aggregateStreamResponse,
    extractCacheHitTokens,
    recordUsage: recordCodebuddyUsage,
    logger
});

const handleAnthropicMessages = createCodebuddyAnthropicMessagesHandler({
    authenticateAndGetCredential,
    tenantManager: unifiedTenantManager,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    anthropicToOpenAI,
    mapModelName,
    resolveConversationId,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    createChatToAnthropicStreamBridge,
    aggregateStreamResponse,
    extractCacheHitTokens,
    openAIToAnthropic,
    recordUsage: recordCodebuddyUsage,
    logger
});

const handleResponsesCompact = createCodebuddyResponsesCompactHandler({
    authenticateAndGetCredential,
    tenantManager: unifiedTenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    resolveConversationId,
    compactRequestToChat,
    mapModelName,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    aggregateStreamResponse,
    extractCacheHitTokens,
    recordUsage: recordCodebuddyUsage,
    chatResponseToCompact,
    logger
});

const handleResponsesAPI = createCodebuddyResponsesAPIHandler({
    authenticateAndGetCredential,
    tenantManager: unifiedTenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    getCodebuddyBaseUrl,
    isPersonalHost,
    resolveConversationId,
    responsesRequestToChat,
    mapModelName,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    createChatToResponsesStreamBridge,
    aggregateStreamResponse,
    extractCacheHitTokens,
    recordUsage: recordCodebuddyUsage,
    chatResponseToResponses,
    logger
});

export const handleCodebuddyResponsesWS = createCodebuddyResponsesWebSocketHandler({
    handleWSConnection,
    resolveCredentialContext: authenticateAndGetCredential,
    tenantManager: unifiedTenantManager,
    getCodebuddyBaseUrl,
    isPersonalHost,
    resolveConversationId,
    responsesRequestToChat,
    mapModelName,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    createChatToResponsesStreamBridge,
    recordUsage: recordCodebuddyUsage,
    logger
});

const {
    handleOpenAIModels,
    handleAnthropicCountTokens,
    handleAnthropicModels
} = createCodebuddyMetadataHandlers({
    authenticateAndGetCredential,
    getModels,
    sendOpenAIError,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    logger
});

/**
 * 获取租户的凭证管理器（用于凭证管理端点）
 */


/**
 * 处理凭证管理端点 - 基于租户体系
 */
async function handleCredentials(req, res, method, pathname) {
    try {
        // GET /v1/credentials - 列出所有凭证
        if (method === 'GET' && pathname === '/v1/credentials') {
            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const credentials = resolved.manager.getCredentialsInfo();
            sendJson(res, 200, {credentials});
            return;
        }

        // GET /v1/credentials/current - 获取当前凭证
        if (method === 'GET' && pathname === '/v1/credentials/current') {
            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const info = resolved.manager.getCurrentCredentialInfo();
            sendJson(res, 200, info);
            return;
        }

        // POST /v1/credentials - 添加新凭证
        if (method === 'POST' && pathname === '/v1/credentials') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (!data.bearer_token) {
                sendOpenAIError(res, 400, 'bearer_token is required');
                return;
            }

            // 阻止使用已废弃域名
            const credentialHost = new URL(getCodebuddyBaseUrl(data.base_url)).host;
            if (BLOCKED_DOMAINS.includes(credentialHost)) {
                sendOpenAIError(res, 400, `域名 ${credentialHost} 已废弃，不允许添加凭证`);
                return;
            }

            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const success = await resolved.manager.addCredentialWithData(data, data.filename);
            if (success) {
                unifiedTenantManager.syncCredentialCount(resolved.tenantId);
                sendJson(res, 200, {message: 'Credential added successfully'});
            } else {
                sendOpenAIError(res, 500, 'Failed to save credential');
            }
            return;
        }

        // POST /v1/credentials/select - 手动选择凭证
        if (method === 'POST' && pathname === '/v1/credentials/select') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const success = await resolved.manager.setActiveCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} set as active`});
            } else {
                sendOpenAIError(res, 400, 'Invalid credential index');
            }
            return;
        }

        // POST /v1/credentials/delete - 删除凭证
        if (method === 'POST' && pathname === '/v1/credentials/delete') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const success = await resolved.manager.deleteCredential(data.index);
            if (success) {
                unifiedTenantManager.syncCredentialCount(resolved.tenantId);
                sendJson(res, 200, {message: `Credential #${data.index + 1} deleted successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid index or failed to delete credential');
            }
            return;
        }

        sendOpenAIError(res, 404, 'Credential endpoint not found');
    } catch (error) {
        logger.error('Credential management error:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理根路径 - 服务信息
 */
function handleRoot(req, res) {
    const tenantCount = unifiedTenantManager.listTenants().length;
    sendJson(res, 200, {
        name: 'CodeBuddy API Proxy',
        version: '1.0.0',
        modes: ['openai', 'anthropic'],
        tenantCount,
        endpoints: {
            openai: {
                chatCompletions: 'POST /codebuddy/v1/chat/completions - OpenAI format',
                responses: 'POST /codebuddy/v1/responses - Responses API',
                responsesCompact: 'POST /codebuddy/v1/responses/compact - Responses Compact API',
                models: 'GET /codebuddy/v1/models - OpenAI format models'
            },
            anthropic: {
                messages: 'POST /codebuddy/anthropic/v1/messages - Claude format',
                countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                models: 'GET /codebuddy/anthropic/v1/models - Claude format models'
            },
            credentials: 'GET/POST /codebuddy/v1/credentials - Manage credentials'
        }
    });
}

/* ==================== WebSocket 端点 ==================== */


/**
 * 主路由处理函数
 */
export async function routeCodebuddyRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 凭证管理端点（两个模式共用）==========
    if (pathname.startsWith('/codebuddy/v1/credentials')) {
        return handleCredentials(req, res, method, pathname.replace('/codebuddy', ''));
    }

    // ========== Anthropic 模式（Claude 格式）==========
    if (pathname.startsWith('/codebuddy/anthropic')) {
        const anthropicPath = pathname.replace('/codebuddy/anthropic', '');

        if (anthropicPath === '/v1/messages' && method === 'POST') {
            return handleAnthropicMessages(req, res);
        }

        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') {
            return handleAnthropicCountTokens(req, res);
        }

        if (anthropicPath === '/v1/models' && method === 'GET') {
            return handleAnthropicModels(req, res);
        }

        // Anthropic 模式的根路径
        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'CodeBuddy API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /codebuddy/anthropic/v1/messages',
                    countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                    models: 'GET /codebuddy/anthropic/v1/models'
                }
            });
            return;
        }

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    // ========== OpenAI 模式（默认）==========
    // 注意：所有非 anthropic 路径都走 OpenAI 模式

    if (pathname === '/codebuddy/v1/chat/completions' && method === 'POST') {
        return handleOpenAIChatCompletions(req, res);
    }

    if (pathname === '/codebuddy/v1/responses/compact' && method === 'POST') {
        return handleResponsesCompact(req, res);
    }

    if (pathname === '/codebuddy/v1/responses' && method === 'POST') {
        return handleResponsesAPI(req, res);
    }

    if (pathname === '/codebuddy/v1/models' && method === 'GET') {
        return handleOpenAIModels(req, res);
    }

    // OpenAI 模式的根路径
    if (
        pathname === '/codebuddy' ||
        pathname === '/codebuddy/' ||
        pathname === '/codebuddy/v1' ||
        pathname === '/codebuddy/v1/'
    ) {
        return handleRoot(req, res);
    }

    // 未匹配到任何路由
    sendOpenAIError(res, 404, 'Endpoint not found');
}
