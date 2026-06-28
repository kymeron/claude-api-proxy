/**
 * 通用 Responses API WebSocket 服务端处理器
 * 处理客户端 WS 连接，实现标准 Responses API WS 协议
 * 协议规范：客户端发送 response.create，服务端返回事件流
 * @module services/shared/responses-ws-server
 */

import logger from '../../utils/logger.js';
import {extractCacheHitTokens} from './protocol-adapter.js';

// 客户端 WS 心跳间隔，防止中间代理（Nginx/ALB）因空闲超时静默切断连接
const PING_INTERVAL = 25000;
// 客户端断连后，等待上游 generator 自行清理的超时时间
const CLEANUP_TIMEOUT = 5000;

/**
 * 处理客户端 WS 连接，实现标准 Responses API WS 协议
 *
 * 协议流程：
 * 1. 客户端发送 {"type": "response.create", ...payload}
 * 2. 服务端调用 handleRequest 获取事件流
 * 3. 服务端逐个将事件通过 WS 发送给客户端
 * 4. 发送 response.completed 或 error 后，请求结束
 * 5. 连接保持，客户端可发送新的 response.create
 * 6. 客户端可发送 {"type": "response.cancel"} 取消当前请求
 *
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {object} options
 * @param {function} options.authenticate - 鉴权函数 (req) => boolean | object，返回 false 表示拒绝
 * @param {function} options.handleRequest - 请求处理函数
 *   签名: async (payload, authResult, {signal}) => AsyncIterable<{type, data}> | {eventStream: AsyncIterable, conn?: object}
 * @param {import('http').IncomingMessage} options.req - 原始 HTTP 请求（用于鉴权）
 * @param {function} [options.onUsage] - 用量记录回调 (inputTokens, outputTokens, cacheHitTokens, model) => void
 * @param {function} [options.onClose] - 连接关闭回调
 */
export function handleWSConnection(clientWs, options) {
    const {authenticate, handleRequest, req, onUsage, onClose, runInContext} = options;

    let currentAbortController = null;
    let isProcessing = false;
    let closed = false;
    let pingTimer = null;
    let cleanupTimer = null;

    // 鉴权
    const authResult = authenticate(req);
    if (!authResult) {
        safeClientSend(clientWs, {
            type: 'error',
            error: {message: 'Authentication failed', code: 'unauthorized'}
        });
        setTimeout(() => {
            try { clientWs.close(4001, 'Authentication failed'); } catch {}
        }, 100);
        return;
    }

    // 启动客户端 WS 心跳，防止中间代理因空闲超时静默切断连接
    function startPing() {
        stopPing();
        pingTimer = setInterval(() => {
            if (clientWs.readyState === 1) {
                try { clientWs.ping(); } catch { stopPing(); }
            } else {
                stopPing();
            }
        }, PING_INTERVAL);
    }
    function stopPing() {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    }
    function stopCleanup() {
        if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
    }
    startPing();

    clientWs.on('pong', () => {
        // 收到 pong 说明连接存活，无需额外操作，心跳定时器持续运行
    });

    clientWs.on('message', async (raw) => {
        if (closed) return;

        let message;
        try {
            message = JSON.parse(raw.toString('utf8'));
        } catch (e) {
            logger.warn('WS server: Failed to parse client message:', e.message);
            safeClientSend(clientWs, {
                type: 'error',
                error: {message: 'Invalid JSON message', code: 'invalid_request'}
            });
            return;
        }

        if (message.type === 'response.create') {
            if (isProcessing) {
                safeClientSend(clientWs, {
                    type: 'error',
                    error: {message: 'A response is already being processed', code: 'conflict'}
                });
                return;
            }
            await _processRequest(clientWs, message, authResult, handleRequest, {
                onUsage,
                runInContext,
                getAbortController: () => currentAbortController,
                setAbortController: (ac) => { currentAbortController = ac; },
                setProcessing: (v) => { isProcessing = v; },
                isClosed: () => closed,
                clearCleanupTimer: () => { if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; } },
            });
        } else if (message.type === 'response.cancel') {
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }
        } else {
            logger.warn(`WS server: Unknown message type: ${message.type}`);
        }
    });

    clientWs.on('close', () => {
        closed = true;
        stopPing();
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        // 客户端断连后设置清理超时，确保上游 generator 资源被释放
        if (isProcessing) {
            cleanupTimer = setTimeout(() => {
                logger.info('WS server: cleanup timeout reached, forcing upstream connection cleanup');
            }, CLEANUP_TIMEOUT);
        }
        if (onClose) onClose();
    });

    clientWs.on('error', (err) => {
        logger.warn(`WS server: Client connection error: ${err.message}`);
        closed = true;
        stopPing();
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
    });
}

export function bindAsyncIterableContext(eventStream, runInContext) {
    if (!runInContext) return eventStream;
    const iterator = eventStream[Symbol.asyncIterator]();
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next(value) {
            return runInContext(() => iterator.next(value));
        },
        return(value) {
            if (typeof iterator.return !== 'function') return Promise.resolve({done: true, value});
            return runInContext(() => iterator.return(value));
        },
        throw(error) {
            if (typeof iterator.throw !== 'function') return Promise.reject(error);
            return runInContext(() => iterator.throw(error));
        }
    };
}

function safeClientSend(ws, data) {
    if (ws?.readyState !== 1) return false;
    try {
        ws.send(typeof data === 'string' ? data : JSON.stringify(data));
        return true;
    } catch {
        return false;
    }
}

function getResponseEventType(event) {
    if (!event || typeof event !== 'object') return undefined;
    if (event.type && event.type !== 'message') return event.type;
    return event.data?.type || event.type;
}

/**
 * 处理单个 response.create 请求
 */
async function _processRequest(clientWs, message, authResult, handleRequest, ctx) {
    ctx.setProcessing(true);
    const abortController = new AbortController();
    ctx.setAbortController(abortController);

    // 提取 payload：标准格式为 {type: "response.create", response: {...}, ...}
    // 兼容直接发送 payload 的格式
    let payload = message.response || message;
    if (message.response && typeof message.response === 'object') {
        // 标准格式：合并顶层字段（除 type 和 response）
        const {type, response, ...rest} = message;
        payload = {...rest, ...response};
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheHitTokens = 0;
    let model = 'unknown';
    let responseCompleted = false;

    try {
        const invoke = () => handleRequest(payload, authResult, {signal: abortController.signal});
        const result = ctx.runInContext ? await ctx.runInContext(invoke) : await invoke();

        // handleRequest 可以返回：
        // 1. AsyncIterable<{type, data}> - 直接迭代事件
        // 2. {eventStream: AsyncIterable, conn?: object} - 带连接对象的事件流
        let eventStream;
        if (result && result.eventStream) {
            eventStream = result.eventStream;
        } else {
            eventStream = result;
        }

        if (!eventStream || typeof eventStream[Symbol.asyncIterator] !== 'function') {
            safeClientSend(clientWs, {
                type: 'error',
                error: {message: 'Internal error: invalid event stream', code: 'server_error'}
            });
            return;
        }

        for await (const event of bindAsyncIterableContext(eventStream, ctx.runInContext)) {
            if (ctx.isClosed() || abortController.signal.aborted) break;
            const eventType = getResponseEventType(event);

            // 追踪 usage
            if (eventType === 'response.completed' && event.data?.response?.usage) {
                const usage = event.data.response.usage;
                inputTokens = usage.input_tokens || 0;
                outputTokens = usage.output_tokens || 0;
                cacheHitTokens = extractCacheHitTokens(usage);
            }
            if (eventType === 'response.created' && event.data?.response?.model) {
                model = event.data.response.model;
            }

            // 发送事件给客户端
            if (!safeClientSend(clientWs, event.data || event)) {
                logger.warn('WS server: failed to send event to client (connection closed)');
                break;
            }

            if (eventType === 'response.completed') {
                responseCompleted = true;
                break;
            }
        }

        // 事件流在没有 response.completed 的情况下结束 — 通知客户端
        if (!responseCompleted && !ctx.isClosed() && !abortController.signal.aborted) {
            logger.warn('WS server: event stream ended without response.completed, sending error to client');
            safeClientSend(clientWs, {
                type: 'error',
                error: {
                    message: 'stream closed before response.completed',
                    code: 'server_error'
                }
            });
        }
    } catch (err) {
        if (!ctx.isClosed()) {
            // 如果是 ResponsesWebSocketError，透传上游错误事件
            if (err.name === 'ResponsesWebSocketError' && err.event) {
                logger.warn(`WS server: upstream error: ${err.message}`);
                safeClientSend(clientWs, normalizeErrorEvent(err.event, err));
            } else {
                logger.warn(`WS server: request error: ${err.message}`);
                safeClientSend(clientWs, createErrorEventFromThrown(err));
            }
        }
    } finally {
        // 注意：WS 上游连接的释放由各服务的 handleRequest 生成器自行处理
        // （在 for-await 循环结束后调用 releaseResponsesWebSocketConnection/discardResponsesWebSocketConnection）

        // 清理断连超时定时器
        ctx.clearCleanupTimer();

        // 记录用量
        if (ctx.onUsage && (inputTokens > 0 || outputTokens > 0)) {
            const recordUsage = () => ctx.onUsage(inputTokens, outputTokens, cacheHitTokens, model);
            if (ctx.runInContext) ctx.runInContext(recordUsage);
            else recordUsage();
        }

        ctx.setProcessing(false);
        ctx.setAbortController(null);
    }
}

function createErrorEventFromThrown(error) {
    const status = normalizeHttpStatus(error?.status)
        || inferHttpStatusFromMessage(error?.message);
    const event = {
        type: 'error',
        error: {
            message: error?.message || 'Request failed',
            code: error?.code || errorCodeForHttpStatus(status) || 'server_error'
        }
    };
    if (status) event.status = status;
    return event;
}

function normalizeErrorEvent(event, error) {
    const normalized = {
        ...(event || {type: 'error'}),
        error: {...(event?.error || {})}
    };
    const status = normalizeHttpStatus(normalized.status)
        || normalizeHttpStatus(error?.status)
        || inferHttpStatusFromMessage(normalized.error?.message)
        || inferHttpStatusFromMessage(error?.message);
    if (status && !normalized.status) normalized.status = status;

    const inferredCode = errorCodeForHttpStatus(status);
    if (inferredCode && (!normalized.error.code || normalized.error.code === 'server_error')) {
        normalized.error.code = inferredCode;
    }
    if (!normalized.error.code) normalized.error.code = error?.code || 'server_error';
    if (!normalized.error.message) normalized.error.message = error?.message || 'Request failed';
    return normalized;
}

function normalizeHttpStatus(status) {
    const numeric = Number(status);
    return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : null;
}

function inferHttpStatusFromMessage(message) {
    if (typeof message !== 'string') return null;
    const match = message.match(/\bHTTP\s+(\d{3})\b/i);
    return match ? normalizeHttpStatus(match[1]) : null;
}

function errorCodeForHttpStatus(status) {
    switch (status) {
        case 400: return 'bad_request';
        case 401: return 'unauthorized';
        case 403: return 'forbidden';
        case 404: return 'not_found';
        case 408: return 'timeout';
        case 413: return 'request_too_large';
        case 429: return 'rate_limit_exceeded';
        default: return null;
    }
}
