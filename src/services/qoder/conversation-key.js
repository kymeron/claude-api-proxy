/**
 * Qoder 会话 ID 解析
 *
 * 客户端可能在以下位置传入会话标识：
 * - Header: x-conversation-id, x-session-id, x-chat-id, x-thread-id
 * - Body: conversation_id, conversationId, session_id, thread_id (顶层或 metadata)
 *
 * 没有显式 ID 时，回退到基于 payload + tenant 派生的稳定 anchor，
 * 让同一会话始终复用同一 Qoder PAT（session affinity → KV Cache 命中）。
 *
 * @module services/qoder/conversation-key
 */

import {buildConversationAnchorKey} from './protocol-adapter.js';

export function normalizeQoderConversationId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function extractQoderConversationIdFromPayload(payload) {
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
        const normalized = normalizeQoderConversationId(candidate);
        if (normalized) return normalized;
    }
    return undefined;
}

export function resolveQoderConversationId(req, messages, payload = {}, meta = {}) {
    const headerCandidates = [
        req.headers['x-conversation-id'],
        req.headers['x-session-id'],
        req.headers['x-chat-id'],
        req.headers['x-thread-id']
    ];

    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeQoderConversationId(value);
        if (normalized) return normalized;
    }

    const payloadResult = extractQoderConversationIdFromPayload(payload);
    if (payloadResult) return payloadResult;

    const keyMeta = {
        ...meta,
        ...(req.qoderClientConnectionId && !meta.clientConnectionId
            ? {clientConnectionId: req.qoderClientConnectionId}
            : {})
    };

    const anchorPayload =
        payload && typeof payload === 'object'
            ? {...payload, messages: Array.isArray(messages) ? messages : payload.messages}
            : {messages};
    return buildConversationAnchorKey(anchorPayload, keyMeta);
}