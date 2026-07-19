/**
 * Qoder OpenAI Chat Completions handler
 *
 * 与 codebuddy 同名 handler 的差异：
 * - 上游从"HTTP API"换成"CLI 子进程"
 * - 流式响应从"转发 SSE"换成"自己生成 SSE chunks"
 * - 用量统计里 token 数来自估算（CLI 不返回）
 *
 * 流程：
 *   1. auth → 凭证
 *   2. parse body → openAIPayload
 *   3. mapModelName + resolveConversationId
 *   4. prepareQoderOutboundChatRequest
 *   5. buildPrompt → 调用 runQoderCli / runQoderCliStream
 *   6. 解析 CLI 输出 → OpenAI Chat Completions 格式
 *   7. recordUsage
 *
 * @module services/qoder/chat-completions-handler
 */

import {buildPrompt} from './prompt-builder.js';
import {runQoderCli, runQoderCliStream} from './qoder-cli.js';
import {prepareQoderOutboundChatRequest} from './outbound-chat.js';
import {estimateMessageTokens} from '../../utils/token-estimation.js';

const TOOL_CALL_FINISH_REASON = 'tool_calls';

/**
 * 构造单条 OpenAI Chat Completion 响应（非流式）
 */
function buildChatCompletionResponse({content, toolCalls, model, fallbackModel, usage}) {
    const choices = [{
        index: 0,
        message: {
            role: 'assistant',
            content: content || null
        },
        finish_reason: (toolCalls && toolCalls.length) ? TOOL_CALL_FINISH_REASON : 'stop'
    }];

    if (toolCalls && toolCalls.length) {
        choices[0].message.tool_calls = toolCalls.map((tc, i) => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments || {})
            },
            index: i
        }));
    }

    return {
        id: `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || fallbackModel,
        choices,
        usage: usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
    };
}

/**
 * 把 CLI 的 delta 转成 OpenAI 流式 chunk（写入 res）
 */
function writeStreamChunk(res, {id, created, model, delta, finishReason = null}) {
    const chunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{index: 0, delta, finish_reason: finishReason}]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export function createQoderChatCompletionsHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    mapModelName,
    resolveConversationId,
    prepareOutbound = prepareQoderOutboundChatRequest,
    runCli = runQoderCli,
    runCliStream = runQoderCliStream,
    recordUsage,
    logger = console
}) {
    return async function handleOpenAIChatCompletions(req, res) {
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
                sendOpenAIError(
                    res,
                    authResult.error.status,
                    authResult.error.message,
                    authResult.error.status === 401 ? 'authentication_error' : 'api_error'
                );
                return;
            }

            const body = await parseBody(req);
            const openAIPayload = JSON.parse(body);

            if (openAIPayload.model) {
                openAIPayload.model = mapModelName(openAIPayload.model);
            }

            const conversationId = resolveConversationId(req, openAIPayload.messages, openAIPayload, {
                tenantId: authResult.tenantId
            });

            prepareOutbound(openAIPayload);

            const prompt = buildPrompt(openAIPayload.messages || [], {
                system: typeof openAIPayload.system === 'string' ? openAIPayload.system : undefined,
                tools: openAIPayload.tools,
                appendToolInstruction: true
            });

            const tenant = await tenantManager.getTenant(authResult.tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

            // === 流式 ===
            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const id = `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const created = Math.floor(Date.now() / 1000);
                const model = openAIPayload.model;

                // 初始 role chunk
                writeStreamChunk(res, {id, created, model, delta: {role: 'assistant'}});

                let inputTokens = 0;
                let outputTokens = 0;
                let toolCallIndex = 0;
                let emittedToolCalls = 0;

                try {
                    await runCliStream({
                        prompt,
                        model,
                        credential: authResult.credential,
                        maxTokens: openAIPayload.max_tokens
                    }, (delta) => {
                        if (res.destroyed) return;

                        if (delta.type === 'content' && delta.text) {
                            writeStreamChunk(res, {id, created, model, delta: {content: delta.text}});
                            outputTokens += estimateMessageTokens([{role: 'assistant', content: delta.text}]);
                        } else if (delta.type === 'tool_call' && delta.toolCall) {
                            emittedToolCalls++;
                            writeStreamChunk(res, {
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
                            });
                        }
                    });

                    // 估算 input tokens
                    inputTokens = estimateMessageTokens(openAIPayload.messages || []);

                    // finish chunk
                    writeStreamChunk(res, {
                        id, created, model,
                        delta: {},
                        finishReason: emittedToolCalls > 0 ? TOOL_CALL_FINISH_REASON : 'stop'
                    });
                    res.write(`data: [DONE]\n\n`);

                    recordUsage(
                        authResult.tenantId,
                        inputTokens,
                        outputTokens,
                        0,
                        0,
                        model,
                        openAIPayload.model
                    );
                } catch (streamErr) {
                    logger.error(`Qoder stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, streamErr);
                    // 发送错误 chunk 后结束
                    if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({
                            id, object: 'chat.completion.chunk', created, model,
                            choices: [{
                                index: 0,
                                delta: {content: `\n[Stream error: ${streamErr.message}]`},
                                finish_reason: 'stop'
                            }]
                        })}\n\n`);
                        res.write(`data: [DONE]\n\n`);
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
                maxTokens: openAIPayload.max_tokens
            });

            const inputTokens = estimateMessageTokens(openAIPayload.messages || []);
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

            sendJson(res, 200, buildChatCompletionResponse({
                content: result.content,
                toolCalls: result.toolCalls,
                model: openAIPayload.model,
                fallbackModel: openAIPayload.model,
                usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens
                }
            }));
        } catch (error) {
            logger.error(`Failed to handle Qoder OpenAI chat completions${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}