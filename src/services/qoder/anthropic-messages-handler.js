/**
 * Qoder Anthropic Messages handler
 *
 * 与 codebuddy 同名 handler 形态对齐，但上游从 HTTP API 换成 CLI 子进程。
 *
 * 流程：
 *   1. auth → 凭证
 *   2. parse body + sanitizeAnthropicPayload → anthropicPayload
 *   3. anthropicToOpenAI → openAIPayload
 *   4. mapModelName + resolveConversationId
 *   5. prepareOutbound
 *   6. buildPrompt + runQoderCli / runQoderCliStream
 *   7. 流式：合成的 OpenAI chunk 喂给 createChatToAnthropicStreamBridge
 *      非流式：合成的 OpenAI response 喂给 openAIToAnthropic
 *
 * @module services/qoder/anthropic-messages-handler
 */

import {buildPrompt} from './prompt-builder.js';
import {runQoderCli, runQoderCliStream} from './qoder-cli.js';
import {prepareQoderOutboundChatRequest} from './outbound-chat.js';
import {estimateMessageTokens} from '../../utils/token-estimation.js';
import {
    createChatToAnthropicStreamBridge,
    extractCacheHitTokens
} from './protocol-adapter.js';

function writeAnthropicEvent(res, event) {
    if (res.destroyed) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * 把 CLI delta 转成 OpenAI chat-completion chunk 格式
 * （用于喂给 createChatToAnthropicStreamBridge）
 */
function makeChatChunk({id, created, model, delta, finishReason = null}) {
    return {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{index: 0, delta, finish_reason: finishReason}]
    };
}

export function createQoderAnthropicMessagesHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    anthropicToOpenAI,
    mapModelName,
    resolveConversationId,
    prepareOutbound = prepareQoderOutboundChatRequest,
    runCli = runQoderCli,
    runCliStream = runQoderCliStream,
    createChatToAnthropicBridge = createChatToAnthropicStreamBridge,
    openAIToAnthropic,
    recordUsage,
    logger = console
}) {
    return async function handleAnthropicMessages(req, res) {
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
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));
            const tenant = await tenantManager.getTenant(authResult.tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

            const openAIPayload = anthropicToOpenAI(anthropicPayload);

            if (openAIPayload.model) {
                openAIPayload.model = mapModelName(openAIPayload.model);
            }

            const conversationId = resolveConversationId(req, anthropicPayload.messages, anthropicPayload, {
                tenantId: authResult.tenantId
            });

            prepareOutbound(openAIPayload);

            const prompt = buildPrompt(openAIPayload.messages || [], {
                system: typeof anthropicPayload.system === 'string'
                    ? anthropicPayload.system
                    : (typeof openAIPayload.system === 'string' ? openAIPayload.system : undefined),
                tools: openAIPayload.tools,
                appendToolInstruction: true
            });

            // === 流式 ===
            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const bridge = createChatToAnthropicBridge({model: anthropicPayload.model});
                const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const created = Math.floor(Date.now() / 1000);
                const model = anthropicPayload.model;

                let inputTokens = 0;
                let outputTokens = 0;
                let toolCallIndex = 0;

                try {
                    // 初始 role chunk
                    for (const event of bridge.feed(makeChatChunk({
                        id, created, model, delta: {role: 'assistant'}
                    }))) {
                        writeAnthropicEvent(res, event);
                    }

                    await runCliStream({
                        prompt,
                        model,
                        credential: authResult.credential,
                        maxTokens: anthropicPayload.max_tokens
                    }, (delta) => {
                        if (res.destroyed) return;

                        if (delta.type === 'content' && delta.text) {
                            for (const event of bridge.feed(makeChatChunk({
                                id, created, model, delta: {content: delta.text}
                            }))) {
                                writeAnthropicEvent(res, event);
                            }
                            outputTokens += estimateMessageTokens([{role: 'assistant', content: delta.text}]);
                        } else if (delta.type === 'tool_call' && delta.toolCall) {
                            for (const event of bridge.feed(makeChatChunk({
                                id, created, model,
                                delta: {
                                    tool_calls: [{
                                        index: toolCallIndex++,
                                        id: delta.toolCall.id,
                                        type: 'function',
                                        function: {
                                            name: delta.toolCall.name,
                                            arguments: JSON.stringify(delta.toolCall.arguments || {})
                                        }
                                    }]
                                }
                            }))) {
                                writeAnthropicEvent(res, event);
                            }
                        }
                    });

                    // 完成事件
                    for (const event of bridge.finish()) {
                        writeAnthropicEvent(res, event);
                    }

                    inputTokens = estimateMessageTokens(anthropicPayload.messages || []);

                    recordUsage(
                        authResult.tenantId,
                        inputTokens,
                        outputTokens,
                        0,
                        0,
                        model,
                        anthropicPayload.model
                    );
                } catch (streamErr) {
                    logger.error(`Qoder Anthropic stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, streamErr);
                    // 发送错误事件后结束
                    if (!res.destroyed) {
                        writeAnthropicEvent(res, {
                            type: 'error',
                            error: {
                                type: 'api_error',
                                message: streamErr.message || 'Stream error'
                            }
                        });
                    }
                }

                res.end();
                return;
            }

            // === 非流式 ===
            const result = await runCli({
                prompt,
                model: openAIPayload.model,
                credential: authResult.credential,
                maxTokens: anthropicPayload.max_tokens
            });

            const inputTokens = estimateMessageTokens(anthropicPayload.messages || []);
            const outputTokens = estimateMessageTokens([{role: 'assistant', content: result.content}]);

            recordUsage(
                authResult.tenantId,
                inputTokens,
                outputTokens,
                0,
                0,
                openAIPayload.model,
                openAIPayload.model
            );

            // 把 CLI 输出转成 OpenAI 响应，再走 openAIToAnthropic
            const openAIResponse = {
                id: `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: openAIPayload.model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: result.content || null
                    },
                    finish_reason: (result.toolCalls && result.toolCalls.length) ? 'tool_calls' : 'stop'
                }],
                usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens
                }
            };

            if (result.toolCalls && result.toolCalls.length) {
                openAIResponse.choices[0].message.tool_calls = result.toolCalls.map((tc, i) => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments || {})
                    },
                    index: i
                }));
            }

            sendJson(res, 200, openAIToAnthropic(openAIResponse));
        } catch (error) {
            logger.error(`Failed to handle Qoder Anthropic messages${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}