/**
 * Qoder Responses API handler
 *
 * 与 codebuddy 同名 handler 形态对齐，但上游从 HTTP API 换成 CLI 子进程。
 *
 * 流程：
 *   1. responsesReq → chatReq via responsesRequestToChat
 *   2. mapModelName + prepareOutbound
 *   3. buildPrompt + runCli / runCliStream
 *   4. 流式：合成 OpenAI chunk → createChatToResponsesStreamBridge → SSE
 *      非流式：构建 chatResponse → chatResponseToResponses
 *
 * @module services/qoder/responses-api-handler
 */

import {buildPrompt} from './prompt-builder.js';
import {runQoderCli, runQoderCliStream} from './qoder-cli.js';
import {prepareQoderOutboundChatRequest} from './outbound-chat.js';
import {estimateMessageTokens} from '../../utils/token-estimation.js';
import {createChatToResponsesStreamBridge} from './protocol-adapter.js';

function writeResponsesSSE(res, event) {
    if (res.destroyed) return;
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function makeChatChunk({id, created, model, delta, finishReason = null}) {
    return {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{index: 0, delta, finish_reason: finishReason}]
    };
}

export function createQoderResponsesAPIHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    resolveConversationId,
    responsesRequestToChat,
    mapModelName,
    prepareOutbound = prepareQoderOutboundChatRequest,
    runCli = runQoderCli,
    runCliStream = runQoderCliStream,
    createChatToResponsesBridge = createChatToResponsesStreamBridge,
    recordUsage,
    chatResponseToResponses,
    logger = console
}) {
    return async function handleResponsesAPI(req, res) {
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
            const responsesReq = JSON.parse(body);
            const conversationId = resolveConversationId(req, responsesReq.input, responsesReq, {
                tenantId: authResult.tenantId
            });

            const chatReq = responsesRequestToChat(responsesReq);
            if (chatReq.model) chatReq.model = mapModelName(chatReq.model);
            prepareOutbound(chatReq);

            const prompt = buildPrompt(chatReq.messages || [], {
                system: typeof chatReq.system === 'string' ? chatReq.system : undefined,
                tools: chatReq.tools,
                appendToolInstruction: true
            });

            // === 流式 ===
            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const bridge = createChatToResponsesBridge({model: responsesReq.model});
                const id = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const created = Math.floor(Date.now() / 1000);
                const model = responsesReq.model;

                let inputTokens = 0;
                let outputTokens = 0;
                let toolCallIndex = 0;

                try {
                    // 初始 role chunk
                    for (const event of bridge.feed(makeChatChunk({
                        id, created, model, delta: {role: 'assistant'}
                    }))) {
                        writeResponsesSSE(res, event);
                    }

                    await runCliStream({
                        prompt,
                        model,
                        credential: authResult.credential,
                        maxTokens: chatReq.max_tokens
                    }, (delta) => {
                        if (res.destroyed) return;

                        if (delta.type === 'content' && delta.text) {
                            for (const event of bridge.feed(makeChatChunk({
                                id, created, model, delta: {content: delta.text}
                            }))) {
                                writeResponsesSSE(res, event);
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
                                writeResponsesSSE(res, event);
                            }
                        }
                    });

                    // 完成事件
                    for (const event of bridge.finish()) {
                        writeResponsesSSE(res, event);
                    }

                    inputTokens = estimateMessageTokens(chatReq.messages || []);

                    recordUsage(
                        authResult.tenantId,
                        inputTokens,
                        outputTokens,
                        0,
                        0,
                        model,
                        responsesReq.model
                    );
                } catch (streamErr) {
                    logger.error(`Qoder Responses stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, streamErr);
                }

                res.end();
                return;
            }

            // === 非流式 ===
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
                responsesReq.model
            );

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

            if (result.toolCalls && result.toolCalls.length) {
                chatResponse.choices[0].message.tool_calls = result.toolCalls.map((tc, i) => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments || {})
                    },
                    index: i
                }));
            }

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        } catch (error) {
            logger.error(`Failed to handle Qoder Responses API${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}