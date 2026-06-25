import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sendRelayAnthropicError,
    sendRelayJsonResponse,
    sendRelayOpenAIError,
    sendRelayResponsesWebSocketProtocolError,
    sendRelayStateMissingOpenAIError,
    toRelayResponsesWebSocketStateMissingError
} from '../src/services/relay/response-writer.js';

function createResponse(options = {}) {
    const calls = [];
    const res = {
        calls,
        headersSent: options.headersSent ?? false,
        destroyed: options.destroyed ?? false,
        writableEnded: options.writableEnded ?? false,
        writeHead(status, headers) {
            this.headersSent = true;
            calls.push(['writeHead', status, headers]);
        },
        end(body) {
            this.writableEnded = true;
            calls.push(['end', body]);
        },
        write(chunk) {
            calls.push(['write', chunk]);
        }
    };
    return res;
}

function jsonBody(res) {
    const endCall = res.calls.find((call) => call[0] === 'end');
    return JSON.parse(endCall[1]);
}

test('sendRelayJsonResponse writes JSON once when headers are open', () => {
    const res = createResponse();

    sendRelayJsonResponse(res, 201, {ok: true});

    assert.deepEqual(res.calls[0], ['writeHead', 201, {'Content-Type': 'application/json'}]);
    assert.deepEqual(jsonBody(res), {ok: true});
});

test('sendRelayJsonResponse does nothing after headers are already sent', () => {
    const res = createResponse({headersSent: true});

    sendRelayJsonResponse(res, 200, {ok: true});

    assert.deepEqual(res.calls, []);
});

test('sendRelayOpenAIError writes OpenAI-compatible error payloads', () => {
    const res = createResponse();

    sendRelayOpenAIError(res, 401, 'Missing API key', 'authentication_error');

    assert.deepEqual(jsonBody(res), {
        error: {
            message: 'Missing API key',
            type: 'authentication_error',
            code: 401
        }
    });
});

test('sendRelayAnthropicError maps status codes to Anthropic error types', () => {
    const unauthorized = createResponse();
    const overloaded = createResponse();
    const generic = createResponse();

    sendRelayAnthropicError(unauthorized, 401, 'Unauthorized');
    sendRelayAnthropicError(overloaded, 503, 'Busy');
    sendRelayAnthropicError(generic, 400, 'Bad request');

    assert.equal(jsonBody(unauthorized).error.type, 'authentication_error');
    assert.equal(jsonBody(overloaded).error.type, 'overloaded_error');
    assert.equal(jsonBody(generic).error.type, 'api_error');
});

test('sendRelayStateMissingOpenAIError uses the Responses continuation error shape', () => {
    const res = createResponse();

    sendRelayStateMissingOpenAIError(res, new Error('previous response is unknown'));

    assert.deepEqual(jsonBody(res), {
        error: {
            message: 'previous response is unknown',
            type: 'invalid_request_error',
            code: 'state_missing'
        }
    });
});

test('toRelayResponsesWebSocketStateMissingError wraps state errors as WS protocol errors', () => {
    const error = new Error('previous response is unknown');

    const wrapped = toRelayResponsesWebSocketStateMissingError(error);

    assert.equal(wrapped, error);
    assert.equal(wrapped.name, 'ResponsesWebSocketError');
    assert.deepEqual(wrapped.event, {
        type: 'error',
        error: {
            message: 'previous response is unknown',
            code: 'state_missing'
        }
    });
});

test('sendRelayResponsesWebSocketProtocolError writes JSON before streaming starts', () => {
    const res = createResponse();
    const event = {type: 'error', status: 422, error: {message: 'bad event'}};

    sendRelayResponsesWebSocketProtocolError(res, {event});

    assert.deepEqual(res.calls[0], ['writeHead', 422, {'Content-Type': 'application/json'}]);
    assert.deepEqual(jsonBody(res), event);
});

test('sendRelayResponsesWebSocketProtocolError writes SSE when headers were already sent', () => {
    const res = createResponse({headersSent: true});
    const event = {type: 'error', error: {message: 'late failure'}};

    sendRelayResponsesWebSocketProtocolError(res, {event});

    assert.deepEqual(res.calls, [
        ['write', `event: error\ndata: ${JSON.stringify(event)}\n\n`],
        ['end', undefined]
    ]);
});
