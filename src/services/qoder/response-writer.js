/**
 * Qoder 响应写入器
 *
 * 与 codebuddy 形态一致：JSON / OpenAI 错误 / Anthropic 错误 + 上游错误码推断。
 *
 * @module services/qoder/response-writer
 */

import {isNetworkError} from '../../utils/http-client.js';

export function sendQoderJsonResponse(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

export function sendQoderOpenAIError(res, status, message, type = 'api_error') {
    if (res.headersSent) {
        try { res.end(); } catch {}
        return;
    }
    sendQoderJsonResponse(res, status, {
        error: {
            message,
            type,
            code: status
        }
    });
}

export function sendQoderAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendQoderJsonResponse(res, status, {
        type: 'error',
        error: {
            type: errorType,
            message
        }
    });
}

/**
 * 把子进程相关错误归类成 HTTP 状态码
 *
 * - CLI 未安装 / 路径错误 → 503（服务不可用）
 * - 子进程超时 → 504（网关超时）
 * - 解析失败 → 502（上游错误）
 * - 网络错误（理论上 CLI 不走网络，但保留兼容） → 502
 * - 其他 → 500
 */
export function qoderUpstreamErrorStatus(error) {
    if (Number.isInteger(error?.status) && error.status >= 400) return error.status;

    const code = error?.code || '';
    const message = error?.message || '';

    if (code === 'ENOENT' || /ENOENT/.test(message)) return 503;
    if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(message)) return 504;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 502;
    if (code === 'EPIPE') return 502;

    if (isNetworkError(error)) return 502;
    return 500;
}