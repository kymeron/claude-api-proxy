import {isNetworkError} from '../../utils/http-client.js';

export function sendCodebuddyJsonResponse(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

export function sendCodebuddyOpenAIError(res, status, message, type = 'api_error') {
    if (res.headersSent) {
        try { res.end(); } catch {}
        return;
    }
    sendCodebuddyJsonResponse(res, status, {
        error: {
            message,
            type,
            code: status
        }
    });
}

export function sendCodebuddyAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendCodebuddyJsonResponse(res, status, {
        type: 'error',
        error: {
            type: errorType,
            message
        }
    });
}

export function codebuddyUpstreamErrorStatus(error) {
    if (Number.isInteger(error?.status) && error.status >= 400) return error.status;
    return isNetworkError(error) ? 502 : 500;
}
