/**
 * Qoder Responses WebSocket handler
 *
 * 与 codebuddy 同名 handler 形态对齐，但上游从 HTTP API 换成 CLI 子进程。
 *
 * 工作流程：
 *   1. 收到客户端 WS 连接 → 调用 handleWSConnection
 *   2. 收到 response.create 消息 → 解析 → responsesRequestToChat → chatReq
 *   3. buildPrompt + runCliStream（CLI delta 通过回调收集后 yield）
 *   4. CLI delta → 合成的 OpenAI chat chunk → createChatToResponsesStreamBridge
 *   5. 输出 Responses WS 事件
 *
 * @module services/qoder/responses-websocket-handler
 */

import {buildPrompt} from './prompt-builder.js';
import {runQoderCliStream} from './qoder-cli.js';
import {prepareQoderOutboundChatRequest} from './outbound-chat.js';
import {estimateMessageTokens} from '../../utils/token-estimation.js';
import {createChatToResponsesStreamBridge} from './protocol-adapter.js';

function defaultConnectionId() {
    return `qoder-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/**
 * 把 bridge.feed 的事件数组转成 {type, data} 格式（与 handleWSConnection 期望一致）
 */
function bridgeEventsToWire(events) {
    const result = [];
    for (const ev of events) {
        result.push({type: ev.event, data: ev.data});
    }
    return result;
}

export function createQoderResponsesWebSocketHandler({
    handleWSConnection,
    resolveCredentialContext,
    tenantManager,
    resolveConversationId,
    responsesRequestToChat,
    mapModelName,
    prepareOutbound = prepareQoderOutboundChatRequest,
    runCliStream = runQoderCliStream,
    createChatToResponsesBridge = createChatToResponsesStreamBridge,
    recordUsage,
    logger = console,
    makeConnectionId = defaultConnectionId
}) {
    return function handleQoderResponsesWS(clientWs, req) {
        req.qoderClientConnectionId = req.qoderClientConnectionId || makeConnectionId();

        handleWSConnection(clientWs, {
            authenticate: () => true,
            req,
            handleRequest: async function* handleQoderResponsesWSRequest(payload, authResult, {signal}) {
                const credentialResult = await resolveCredentialContext(req);
                if (credentialResult.error || !credentialResult.credential) {
                    throw Object.assign(new Error(credentialResult.error?.message || 'No credentials'), {
                        event: {
                            type: 'error',
                            error: {
                                message: credentialResult.error?.message || 'No available credentials for tenant',
                                code: 'no_credentials'
                            }
                        }
                    });
                }

                const tenantId = credentialResult.tenantId || req.tenantId;
                const {credential} = credentialResult;

                const conversationId = resolveConversationId(req, payload.input, payload, {tenantId});
                const chatReq = responsesRequestToChat(payload);
                if (chatReq.model) chatReq.model = mapModelName(chatReq.model);
                prepareOutbound(chatReq);
                chatReq.stream = true;

                const prompt = buildPrompt(chatReq.messages || [], {
                    system: typeof chatReq.system === 'string' ? chatReq.system : undefined,
                    tools: chatReq.tools,
                    appendToolInstruction: true
                });

                const bridge = createChatToResponsesBridge({model: chatReq.model});
                const id = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const created = Math.floor(Date.now() / 1000);
                const model = chatReq.model;

                let inputTokens = 0;
                let outputTokens = 0;
                let toolCallIndex = 0;

                // 收集 CLI deltas → 转 chat chunk → 转 Responses 事件 → yield
                // 由于 runCliStream 用回调，先收集到 buffer 再 yield
                const collected = [];

                // 初始 role chunk
                for (const ev of bridgeEventsToWire(bridge.feed(makeChatChunk({
                    id, created, model, delta: {role: 'assistant'}
                })))) {
                    collected.push(ev);
                }

                await runCliStream({
                    prompt,
                    model,
                    credential,
                    maxTokens: chatReq.max_tokens
                }, (delta) => {
                    if (signal?.aborted) return;

                    if (delta.type === 'content' && delta.text) {
                        const events = bridge.feed(makeChatChunk({
                            id, created, model, delta: {content: delta.text}
                        }));
                        for (const ev of bridgeEventsToWire(events)) collected.push(ev);
                        outputTokens += estimateMessageTokens([{role: 'assistant', content: delta.text}]);
                    } else if (delta.type === 'tool_call' && delta.toolCall) {
                        const events = bridge.feed(makeChatChunk({
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
                        }));
                        for (const ev of bridgeEventsToWire(events)) collected.push(ev);
                    }
                });

                // 把累积的事件 yield 出去
                for (const ev of collected) {
                    if (signal?.aborted) break;
                    yield ev;
                }

                // 完成事件
                for (const ev of bridgeEventsToWire(bridge.finish())) {
                    if (signal?.aborted) break;
                    yield ev;
                }

                inputTokens = estimateMessageTokens(chatReq.messages || []);
                recordUsage(
                    tenantId,
                    inputTokens,
                    outputTokens,
                    0,
                    0,
                    model,
                    model
                );
            },
            onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
                const tenantId = req.tenantId;
                if (!tenantId) return;
                recordUsage(
                    tenantId,
                    inputTokens,
                    outputTokens,
                    cacheHitTokens,
                    0,
                    model,
                    model
                );
            }
        });
    };
}