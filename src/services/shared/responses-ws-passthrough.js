import {connectResponsesWebSocket} from './responses-ws-client.js';
import logger from '../../utils/logger.js';

const OPEN = 1;

function closeReason(reason) {
    if (Buffer.isBuffer(reason)) return reason.toString('utf8');
    if (typeof reason === 'string') return reason;
    return '';
}

function safeSend(socket, data) {
    if (socket?.readyState !== OPEN) return false;
    socket.send(data);
    return true;
}

function safeClose(socket, code = 1000, reason = '') {
    if (!socket || socket.readyState !== OPEN) return;
    try {
        socket.close(code, closeReason(reason));
    } catch {}
}

function isValidJsonFrame(raw) {
    try {
        JSON.parse(raw.toString('utf8'));
        return true;
    } catch {
        return false;
    }
}

function sendInvalidJsonError(socket) {
    safeSend(socket, JSON.stringify({
        type: 'error',
        error: {message: 'Invalid JSON message', code: 'invalid_request'}
    }));
}

export function relayResponsesWebSocketPair(clientWs, upstreamWs) {
    let closing = false;

    const closePeer = (peer, code, reason) => {
        if (closing) return;
        closing = true;
        safeClose(peer, code || 1000, reason);
    };

    clientWs.on('message', (raw) => {
        if (!isValidJsonFrame(raw)) {
            sendInvalidJsonError(clientWs);
            return;
        }
        safeSend(upstreamWs, raw);
    });

    upstreamWs.on('message', (raw) => {
        safeSend(clientWs, raw);
    });

    clientWs.on('close', (code, reason) => closePeer(upstreamWs, code, reason));
    upstreamWs.on('close', (code, reason) => closePeer(clientWs, code, reason));

    clientWs.on('error', (error) => {
        logger.warn(`Responses WS passthrough: client error: ${error.message}`);
        closePeer(upstreamWs, 1011, 'Client error');
    });

    upstreamWs.on('error', (error) => {
        logger.warn(`Responses WS passthrough: upstream error: ${error.message}`);
        closePeer(clientWs, 1011, 'Upstream error');
    });
}

export async function passthroughResponsesWebSocket(clientWs, {
    url,
    headers,
    agent,
    rejectUnauthorized = true,
    connect = connectResponsesWebSocket
}) {
    let upstreamWs;
    try {
        upstreamWs = await connect(url, headers, agent, undefined, rejectUnauthorized);
    } catch (error) {
        logger.warn(`Responses WS passthrough: upstream connect failed: ${error.message}`);
        safeClose(clientWs, 1011, 'Upstream WebSocket connect failed');
        return null;
    }

    relayResponsesWebSocketPair(clientWs, upstreamWs);
    return upstreamWs;
}
