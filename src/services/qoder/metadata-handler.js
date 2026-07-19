/**
 * Qoder 元数据 handler
 *
 * - handleOpenAIModels: 返回 Qoder 模型清单（OpenAI 格式）
 * - handleAnthropicCountTokens: 估算 token 数（Qoder CLI 不支持）
 * - handleAnthropicModels: 返回 Qoder 模型清单（Anthropic 格式）
 *
 * 与 codebuddy 同名文件形态对齐，但不需要从上游拉模型列表（Qoder 模型是静态的）。
 *
 * @module services/qoder/metadata-handler
 */

import {getQoderModels} from './config.js';

export function createQoderMetadataHandlers({
    authenticateAndGetCredential,
    sendOpenAIError,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    logger = console
}) {
    function getQoderModelList() {
        return getQoderModels().map((model) => ({
            id: model.id,
            name: model.name || model.id,
            tools: model.tools !== false,
            owned_by: 'qoder'
        }));
    }

    async function handleOpenAIModels(req, res) {
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (authResult.error) {
                sendOpenAIError(
                    res,
                    authResult.error.status,
                    authResult.error.message,
                    authResult.error.status === 401 ? 'authentication_error' : 'api_error'
                );
                return;
            }

            const data = getQoderModelList().map((model) => ({
                id: model.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'qoder'
            }));

            sendJson(res, 200, {object: 'list', data});
        } catch (error) {
            logger.error('Failed to get Qoder OpenAI models:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicCountTokens(req, res) {
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));

            // 简单估算：JSON 序列化后字符数 / 4（与 codebuddy 一致）
            const text = JSON.stringify(anthropicPayload.messages || []);
            const estimatedTokens = Math.ceil(text.length / 4);

            sendJson(res, 200, {input_tokens: estimatedTokens});
        } catch (error) {
            logger.error('Failed to count Qoder tokens:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicModels(req, res) {
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const data = getQoderModelList().map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: 'qoder',
                name: model.name,
                capabilities: {}
            }));

            sendJson(res, 200, {data, object: 'list'});
        } catch (error) {
            logger.error('Failed to get Qoder Anthropic models:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    return {
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels
    };
}