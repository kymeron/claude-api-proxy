import {buildConversationAnchorKey} from './protocol-adapter.js';

export function normalizeCodebuddyConversationId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function extractCodebuddyConversationIdFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined;
    const candidates = [
        payload.conversation_id,
        payload.conversationId,
        payload.session_id,
        payload.sessionId,
        payload.thread_id,
        payload.threadId,
        metadata?.conversation_id,
        metadata?.conversationId,
        metadata?.session_id,
        metadata?.sessionId,
        metadata?.thread_id,
        metadata?.threadId
    ];

    for (const candidate of candidates) {
        const normalized = normalizeCodebuddyConversationId(candidate);
        if (normalized) return normalized;
    }
    return undefined;
}

export function resolveCodebuddyConversationId(req, messages, payload = {}, meta = {}) {
    const headerCandidates = [
        req.headers['x-conversation-id'],
        req.headers['x-session-id'],
        req.headers['x-chat-id'],
        req.headers['x-thread-id']
    ];

    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeCodebuddyConversationId(value);
        if (normalized) return normalized;
    }

    const payloadResult = extractCodebuddyConversationIdFromPayload(payload);
    if (payloadResult) return payloadResult;

    const keyMeta = {
        ...meta,
        ...(req.codebuddyClientConnectionId && !meta.clientConnectionId
            ? {clientConnectionId: req.codebuddyClientConnectionId}
            : {})
    };

    const anchorPayload =
        payload && typeof payload === 'object'
            ? {...payload, messages: Array.isArray(messages) ? messages : payload.messages}
            : {messages};
    return buildConversationAnchorKey(anchorPayload, keyMeta);
}
