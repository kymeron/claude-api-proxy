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
    sendCodebuddyJsonResponse(res, status, {
        type: 'error',
        error: {
            type: status === 401 ? 'authentication_error' : 'api_error',
            message
        }
    });
}

export function codebuddyUpstreamErrorStatus(error) {
    return isNetworkError(error) ? 502 : 500;
}
