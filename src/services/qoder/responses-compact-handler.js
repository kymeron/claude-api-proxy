/**
 * Qoder Responses Compact handler
 *
 * 与 codebuddy 同名 handler 形态对齐，但上游从 HTTP API 换成 CLI 子进程。
 *
 * @module services/qoder/responses-compact-handler
 */

import {buildPrompt} from './prompt-builder.js';
import {runQoderCli} from './qoder-cli.js';
import {prepareQoderOutboundChatRequest} from './outbound-chat.js';
import {estimateMessageTokens} from '../../utils/token-estimation.js';

export function createQoderResponsesCompactHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    resolveConversationId,
    compactRequestToChat,
    mapModelName,
    prepareOutbound = prepareQoderOutboundChatRequest,
    runCli = runQoderCli,
    recordUsage,
    chatResponseToCompact,
    logger = console
}) {
    return async function handleResponsesCompact(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (!authResult.error) {
                const tenant = await tenantManager.getTenant(authResult.tenantId);
                if (tenant?.name && tenant?.username) {
                    tenantInfo = `${tenant.name}(${tenant.username})`;
                }
            }
            if (authResult.error) {
                sendOpenAIError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const compactReq = JSON.parse(body);
            const conversationId = resolveConversationId(req, compactReq.input, compactReq, {
                tenantId: authResult.tenantId
            });

            const chatReq = compactRequestToChat(compactReq);
            if (chatReq.model) chatReq.model = mapModelName(chatReq.model);
            prepareOutbound(chatReq);

            const prompt = buildPrompt(chatReq.messages || [], {
                system: typeof chatReq.system === 'string' ? chatReq.system : undefined,
                tools: chatReq.tools,
                appendToolInstruction: true
            });

            const result = await runCli({
                prompt,
                model: chatReq.model,
                credential: authResult.credential,
                maxTokens: chatReq.max_tokens
            });

            const inputTokens = estimateMessageTokens(chatReq.messages || []);
            const outputTokens = estimateMessageTokens([{role: 'assistant', content: result.content}]);

            recordUsage(
                authResult.tenantId,
                inputTokens,
                outputTokens,
                0,
                0,
                chatReq.model,
                compactReq.model
            );

            // 把 CLI 输出转成 OpenAI chat 响应，再走 chatResponseToCompact
            const chatResponse = {
                id: `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: chatReq.model,
                choices: [{
                    index: 0,
                    message: {role: 'assistant', content: result.content || null},
                    finish_reason: (result.toolCalls && result.toolCalls.length) ? 'tool_calls' : 'stop'
                }],
                usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens
                }
            };

            sendJson(res, 200, chatResponseToCompact(chatResponse));
        } catch (error) {
            logger.error(`Failed to handle Qoder Responses Compact${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}