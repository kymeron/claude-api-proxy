export function sendRelayJsonResponse(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

export function sendRelayOpenAIError(res, status, message, type = 'api_error') {
    sendRelayJsonResponse(res, status, {error: {message, type, code: status}});
}

export function sendRelayAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendRelayJsonResponse(res, status, {type: 'error', error: {type: errorType, message}});
}

export function sendRelayStateMissingOpenAIError(res, error) {
    sendRelayJsonResponse(res, 400, {
        error: {
            message: error.message,
            type: 'invalid_request_error',
            code: 'state_missing'
        }
    });
}

export function toRelayResponsesWebSocketStateMissingError(error) {
    return Object.assign(error, {
        name: 'ResponsesWebSocketError',
        event: {
            type: 'error',
            error: {
                message: error.message,
                code: 'state_missing'
            }
        }
    });
}

export function sendRelayResponsesWebSocketProtocolError(res, error) {
    const event = error?.event || {
        type: 'error',
        status: error?.status || 400,
        error: {message: error?.message || 'Responses WebSocket request failed'}
    };

    if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        }
        return;
    }

    sendRelayJsonResponse(res, event.status || error?.status || 400, event);
}
