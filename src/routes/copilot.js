/**
 * Copilot 路由处理器 - 支持 OpenAI 和 Anthropic 双格式的聊天补全和模型列表 API
 * @module routes/copilot
 */

import {ensureCopilotToken, isAuthenticated} from '../services/copilot/auth.js';
import {createChatCompletions, getModels} from '../services/copilot/copilot-api.js';
import {copilotState} from '../services/copilot/state.js';
import {copilotStore} from '../services/copilot/copilot-store.js';
import {readBody, isNetworkError} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic,
    translateStreamChunk,
    createStreamState
} from '../services/copilot/anthropic-translator.js';
import {
    responsesRequestToChat,
    chatResponseToResponses,
    createResponsesStreamState,
    chatChunkToResponsesEvents,
    compactRequestToChat,
    chatResponseToCompact
} from '../transformer/responses-translator.js';
import {
    estimateMessageTokens,
    estimateContentBlockTokens
} from '../utils/token-estimation.js';
import {aggregateStreamResponse} from '../services/codebuddy/api.js';
import logger from '../utils/logger.js';
import {appendFileSync, mkdirSync, existsSync} from 'fs';
import {join} from 'path';

const CACHE_DEBUG_FILE = join(process.cwd(), '.copilot', 'cache_debug.jsonl');

function logCacheDebug(entry) {
    try {
        const dir = join(process.cwd(), '.copilot');
        if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
        appendFileSync(CACHE_DEBUG_FILE, JSON.stringify({ts: new Date().toISOString(), ...entry}) + '\n');
    } catch {}
}

/* ==================== 工具函数 ==================== */

/**
 * 从上游 usage 中提取缓存命中 token 数
 */
function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

function extractProxyFromHeaders(req) {
    // 优先从 store 读取代理配置
    const storeProxy = copilotStore.getProxyUrl();
    if (storeProxy) return storeProxy;

    // 兼容：从请求头读取（仅本地请求）
    const proxy = req.headers['x-copilot-proxy'];
    if (!proxy) return undefined;
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') {
        return proxy;
    }
    return undefined;
}

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function sendOpenAIError(res, status, message, type = 'api_error') {
    sendJson(res, status, {error: {message, type, code: status}});
}

function sendAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendJson(res, status, {type: 'error', error: {type: errorType, message}});
}

function upstreamErrorStatus(err) {
    return isNetworkError(err) ? 502 : 500;
}

/**
 * API Key 鉴权
 */
function authenticateRequest(req) {
    // 优先从 Authorization: Bearer 提取
    const auth = req.headers['authorization'];
    let token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth;

    // 兼容 x-api-key（CherryStudio 等 Anthropic 客户端）
    if (!token) {
        token = req.headers['x-api-key'];
    }

    if (!token) return false;
    return copilotStore.authenticate(token);
}

async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/* ==================== 鉴权 ==================== */

async function authenticateAndGetToken(req) {
    // API Key 鉴权
    if (!authenticateRequest(req)) {
        return {error: {status: 401, message: 'Invalid API Key. Check your API key or visit /copilotFE.'}};
    }

    // Copilot 认证检查
    if (!isAuthenticated()) {
        return {error: {status: 401, message: 'Not authenticated. Please visit /copilotFE to authenticate with GitHub.'}};
    }

    try {
        const proxyUrl = copilotStore.getProxyUrl();
        const copilotToken = await ensureCopilotToken(proxyUrl);
        return {copilotToken};
    } catch (error) {
        return {error: {status: 503, message: error.message}};
    }
}

/* ==================== OpenAI 模式 ==================== */

/**
 * 处理 OpenAI 格式的 /copilot/v1/chat/completions 请求
 */
async function handleOpenAIChatCompletions(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(req);
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

        logger.info(`Copilot OpenAI request - model: ${openAIPayload.model}, stream: ${openAIPayload.stream}`);

        const response = await createChatCompletions(
            copilotState.copilotToken,
            copilotState.vsCodeVersion,
            openAIPayload,
            copilotState.accountType,
            proxyUrl
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;
            let lineBuffer = '';

            response.body.on('data', (chunk) => {
                res.write(chunk);
                lineBuffer += chunk.toString('utf8');
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    const raw = trimmed.slice(6).trim();
                    if (raw === '[DONE]') continue;
                    try {
                        const data = JSON.parse(raw);
                        if (data.usage) {
                            streamInputTokens = data.usage.prompt_tokens || 0;
                            streamOutputTokens = data.usage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(data.usage);
                            logCacheDebug({mode: 'openai_stream', model: data.model, usage: data.usage});
                        }
                    } catch {}
                }
            });

            response.body.on('end', () => {
                if (lineBuffer.trim()) {
                    res.write(lineBuffer);
                }
                if (streamInputTokens > 0 || streamOutputTokens > 0) {
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                } else {
                    copilotStore.incrementApiCallCount();
                    const estimated = estimateMessageTokens(openAIPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Copilot OpenAI stream error:', err);
                res.end();
            });

            res.on('close', () => {
                if (response.body && !response.body.destroyed) {
                    response.body.destroy();
                }
            });
        } else {
            const responseBody = await readBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                return;
            }
            const inputTokens = parsed.usage?.prompt_tokens || 0;
            const outputTokens = parsed.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(parsed.usage);
            if (parsed.usage) {
                logCacheDebug({mode: 'openai_nonstream', model: parsed.model, usage: parsed.usage});
            }
            copilotStore.incrementApiCallCount();
            if (inputTokens > 0 || outputTokens > 0) {
                copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
            } else {
                const estimated = estimateMessageTokens(openAIPayload.messages || []);
                copilotStore.incrementTokenUsage(estimated, 0, 0);
                copilotStore.recordDailyUsage(estimated, 0, 0);
            }
            sendJson(res, 200, parsed);
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle OpenAI chat completions:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI 格式的 /copilot/v1/models 请求
 */
async function handleOpenAIModels(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            copilotState.accountType,
            proxyUrl
        );

        sendJson(res, 200, {
            object: 'list',
            data: (modelsData.data || []).map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'copilot'
            }))
        });
    } catch (error) {
        logger.error('Copilot: Failed to get OpenAI models:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Anthropic 模式 ==================== */

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        logger.info(`Copilot Anthropic request - model: ${anthropicPayload.model}, stream: ${anthropicPayload.stream}`);

        const openAIPayload = anthropicToOpenAI(anthropicPayload);

        const response = await createChatCompletions(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            openAIPayload,
            copilotState.accountType,
            proxyUrl
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendAnthropicError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        if (anthropicPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const state = createStreamState();
            let buffer = '';
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;

            const processLines = (lines) => {
                for (const line of lines) {
                    if (res.destroyed) return;

                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6);

                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const openAIChunk = JSON.parse(data);
                            const anthropicEvents = translateStreamChunk(openAIChunk, state);

                            if (openAIChunk.usage) {
                                streamInputTokens = openAIChunk.usage.prompt_tokens || streamInputTokens;
                                streamOutputTokens = openAIChunk.usage.completion_tokens || streamOutputTokens;
                                streamCacheHitTokens = extractCacheHitTokens(openAIChunk.usage) || streamCacheHitTokens;
                                logCacheDebug({mode: 'anthropic_stream', model: openAIChunk.model, usage: openAIChunk.usage});
                            }

                            for (const event of anthropicEvents) {
                                if (res.destroyed) return;
                                res.write(`event: ${event.type}\n`);
                                res.write(`data: ${JSON.stringify(event)}\n\n`);
                            }
                        } catch (e) {
                            logger.error('Failed to parse chunk:', e);
                        }
                    }
                }
            };

            response.body.on('data', (chunk) => {
                try {
                    if (res.destroyed) return;

                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    processLines(lines);
                } catch (error) {
                    logger.error('Stream processing error:', error);
                }
            });

            response.body.on('end', () => {
                if (buffer.trim()) {
                    try {
                        processLines([buffer]);
                    } catch (error) {
                        logger.error('Failed to process remaining buffer:', error);
                    }
                    buffer = '';
                }
                // 记录用量
                if (streamInputTokens > 0 || streamOutputTokens > 0) {
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                } else {
                    copilotStore.incrementApiCallCount();
                    const estimated = estimateMessageTokens(openAIPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                if (!res.destroyed) {
                    res.end();
                }
            });

            response.body.on('error', (error) => {
                logger.error('Stream error:', error);
                if (!res.destroyed) {
                    res.end();
                }
            });

            res.on('close', () => {
                if (response.body && !response.body.destroyed) {
                    response.body.destroy();
                }
            });
        } else {
            const responseBody = await readBody(response.body);
            const openAIResponse = JSON.parse(responseBody);
            const anthropicResponse = openAIToAnthropic(openAIResponse);
            const inputTokens = openAIResponse.usage?.prompt_tokens || 0;
            const outputTokens = openAIResponse.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(openAIResponse.usage);
            if (openAIResponse.usage) {
                logCacheDebug({mode: 'anthropic_nonstream', model: openAIResponse.model, usage: openAIResponse.usage});
            }
            copilotStore.incrementApiCallCount();
            if (inputTokens > 0 || outputTokens > 0) {
                copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);
            } else {
                const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                copilotStore.incrementTokenUsage(estimated, 0, 0);
                copilotStore.recordDailyUsage(estimated, 0, 0);
            }
            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        let totalTokens = 0;

        if (Array.isArray(anthropicPayload.messages)) {
            totalTokens += estimateMessageTokens(anthropicPayload.messages);
        }

        if (anthropicPayload.system) {
            if (typeof anthropicPayload.system === 'string') {
                totalTokens += Math.ceil(anthropicPayload.system.length / 4);
            } else if (Array.isArray(anthropicPayload.system)) {
                for (const block of anthropicPayload.system) {
                    totalTokens += estimateContentBlockTokens(block);
                }
            }
        }

        if (Array.isArray(anthropicPayload.tools)) {
            for (const tool of anthropicPayload.tools) {
                totalTokens += Math.ceil((tool.name || '').length / 4);
                totalTokens += Math.ceil((tool.description || '').length / 4);
                if (tool.input_schema) {
                    const schemaStr = JSON.stringify(tool.input_schema);
                    totalTokens += Math.ceil(schemaStr.length / 2);
                }
            }
        }

        sendJson(res, 200, {input_tokens: totalTokens});
    } catch (error) {
        logger.error('Copilot: Failed to count tokens:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            copilotState.accountType,
            proxyUrl
        );

        sendJson(res, 200, {
            object: 'list',
            data: (modelsData.data || []).map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'copilot',
                name: model.name,
                capabilities: model.capabilities || {}
            }))
        });
    } catch (error) {
        logger.error('Copilot: Failed to get Anthropic models:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses API 模式 ==================== */

/**
 * 处理 OpenAI Responses API 请求 (/copilot/v1/responses)
 */
async function handleResponsesAPI(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        // Responses -> Chat Completions
        const chatReq = responsesRequestToChat(responsesReq);

        const response = await createChatCompletions(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            chatReq,
            copilotState.accountType,
            proxyUrl
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        if (responsesReq.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const streamState = createResponsesStreamState();
            let buffer = Buffer.alloc(0);
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;
            let streamModel = '';

            response.body.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                let start = 0;
                let newLineIndex;
                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;
                    if (!line || line.startsWith(':')) continue;
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;

                    let data;
                    try { data = JSON.parse(raw); } catch { continue; }

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        logCacheDebug({mode: 'responses_stream', model: data.model, usage: data.usage});
                    }
                    if (data.model) streamModel = data.model;

                    const events = chatChunkToResponsesEvents(data, streamState);
                    for (const ev of events) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                if (!streamState.started || !streamState.finished) {
                    if (streamState.reasoningOpen) {
                        res.write(`event: response.reasoning_summary_part.done\ndata: ${JSON.stringify({type: 'response.reasoning_summary_part.done', output_index: streamState.outputIndex, summary_index: 0, item_id: streamState.reasoningItemId, part: {type: 'summary_text', text: streamState.reasoningText}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'reasoning', id: streamState.reasoningItemId, status: 'completed', summary: [{type: 'summary_text', text: streamState.reasoningText}]}})}\n\n`);
                        streamState.outputIndex++;
                    }
                    if (streamState.messageOpen) {
                        res.write(`event: response.content_part.done\ndata: ${JSON.stringify({type: 'response.content_part.done', output_index: streamState.outputIndex, content_index: 0, part: {type: 'output_text', text: streamState.textBuffer, annotations: []}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'message', id: streamState.currentMessageId, status: 'completed', role: 'assistant', content: [{type: 'output_text', text: streamState.textBuffer, annotations: []}]}})}\n\n`);
                    }
                    res.write(`event: response.completed\ndata: ${JSON.stringify({type: 'response.completed', response: {id: streamState.responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: streamModel || 'unknown', output: [], usage: {input_tokens: streamInputTokens, output_tokens: streamOutputTokens, total_tokens: streamInputTokens + streamOutputTokens}}})}\n\n`);
                }
                copilotStore.incrementApiCallCount();
                copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Responses stream error:', err);
                res.end();
            });
        } else {
            const responseBody = await readBody(response.body);
            const chatResponse = JSON.parse(responseBody);

            const inputTokens = chatResponse.usage?.prompt_tokens || 0;
            const outputTokens = chatResponse.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
            if (chatResponse.usage) {
                logCacheDebug({mode: 'responses_nonstream', model: chatResponse.model, usage: chatResponse.usage});
            }
            copilotStore.incrementApiCallCount();
            copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle Responses API:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses Compact API ==================== */

/**
 * 处理 OpenAI Responses Compact 请求 (/copilot/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        // Compact -> Chat Completions
        const chatReq = compactRequestToChat(compactReq);

        const response = await createChatCompletions(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            chatReq,
            copilotState.accountType,
            proxyUrl
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        const responseBody = await readBody(response.body);
        const chatResponse = JSON.parse(responseBody);

        const inputTokens = chatResponse.usage?.prompt_tokens || 0;
        const outputTokens = chatResponse.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
        copilotStore.incrementApiCallCount();
        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens);

        sendJson(res, 200, chatResponseToCompact(chatResponse));
    } catch (error) {
        logger.error('Copilot: Failed to handle Responses Compact:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
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
            tokenSource: isAuthenticated() ? '.copilot/github_token' : 'not configured'
        }
    });
}

/* ==================== 主路由 ==================== */

export async function routeCopilotRequest(req, res) {
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
    if (pathname === '/copilot/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    // ========== 根路径 ==========
    if (pathname === '/copilot' || pathname === '/copilot/') return handleRoot(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
