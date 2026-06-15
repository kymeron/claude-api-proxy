import {responsesRequestToChat, responsesResponseToChat} from '../../transformer/responses-translator.js';

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

export class RelayStateMissingError extends Error {
    constructor(previousResponseId) {
        super(`Missing relay conversation state for previous_response_id=${previousResponseId}`);
        this.name = 'RelayStateMissingError';
        this.code = 'state_missing';
        this.previousResponseId = previousResponseId;
    }
}

export class RelayConversationStore {
    constructor({ttlMs = DEFAULT_TTL_MS, now = () => Date.now()} = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.conversations = new Map();
        this.responseIndex = new Map();
    }

    saveChatRequest({tenantId, conversationKey, request}) {
        const key = this._conversationKey(tenantId, conversationKey);
        if (!key || !request) return null;

        const existing = this._getByConversationKey(tenantId, conversationKey);
        const state = {
            tenantId,
            conversationKey,
            chatRequest: cloneChatRequest(request),
            responses: new Set(existing?.responses || []),
            updatedAt: this.now()
        };
        this.conversations.set(key, state);
        return cloneState(state);
    }

    hydrateResponsesForFullHistory({tenantId, conversationKey, request}) {
        const previousResponseId = normalizeId(request?.previous_response_id);
        let state = null;

        if (previousResponseId) {
            state = this._getByResponseId(tenantId, previousResponseId);
            if (!state) throw new RelayStateMissingError(previousResponseId);
        } else {
            state = this._getByConversationKey(tenantId, conversationKey);
        }

        const visibleChat = responsesRequestToChat(request || {});
        const base = state?.chatRequest ? cloneChatRequest(state.chatRequest) : {model: request?.model, messages: []};
        const chatRequest = mergeChatRequests(base, visibleChat, request);
        const resolvedConversationKey = state?.conversationKey || conversationKey;

        if (resolvedConversationKey) {
            this.saveChatRequest({tenantId, conversationKey: resolvedConversationKey, request: chatRequest});
        }

        return {conversationKey: resolvedConversationKey, chatRequest};
    }

    prepareResponsesPassthrough({tenantId, conversationKey, request}) {
        const previousResponseId = normalizeId(request?.previous_response_id);
        const state = previousResponseId ? this._getByResponseId(tenantId, previousResponseId) : null;
        return {
            conversationKey: state?.conversationKey || conversationKey,
            request: {...request}
        };
    }

    recordResponsesResponse({tenantId, conversationKey, response}) {
        if (!response || !conversationKey) return null;

        const key = this._conversationKey(tenantId, conversationKey);
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const chatResponse = responsesResponseToChat(response);
        const nextRequest = appendAssistantFromChatResponse(existing?.chatRequest, chatResponse);
        const state = {
            tenantId,
            conversationKey,
            chatRequest: nextRequest,
            responses: new Set(existing?.responses || []),
            updatedAt: this.now()
        };

        if (response.id) {
            state.responses.add(response.id);
            this.responseIndex.set(this._responseKey(tenantId, response.id), key);
        }

        this.conversations.set(key, state);
        return cloneState(state);
    }

    recordChatResponse({tenantId, conversationKey, response}) {
        if (!response || !conversationKey) return null;
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const nextRequest = appendAssistantFromChatResponse(existing?.chatRequest, response);
        return this.saveChatRequest({tenantId, conversationKey, request: nextRequest});
    }

    _getByConversationKey(tenantId, conversationKey) {
        const key = this._conversationKey(tenantId, conversationKey);
        if (!key) return null;

        const state = this.conversations.get(key);
        if (!state) return null;

        if (this.now() - state.updatedAt > this.ttlMs) {
            this.conversations.delete(key);
            return null;
        }

        return state;
    }

    _getByResponseId(tenantId, responseId) {
        const stateKey = this.responseIndex.get(this._responseKey(tenantId, responseId));
        if (!stateKey) return null;

        const state = this.conversations.get(stateKey);
        if (!state) return null;

        if (this.now() - state.updatedAt > this.ttlMs) {
            this.conversations.delete(stateKey);
            this.responseIndex.delete(this._responseKey(tenantId, responseId));
            return null;
        }

        return state;
    }

    _conversationKey(tenantId, conversationKey) {
        if (!tenantId || !conversationKey) return null;
        return `${tenantId}:${conversationKey}`;
    }

    _responseKey(tenantId, responseId) {
        return `${tenantId}:${responseId}`;
    }
}

export const relayConversationStore = new RelayConversationStore();

function normalizeId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cloneChatRequest(request) {
    return clone(request) || {messages: []};
}

function cloneState(state) {
    return {
        ...state,
        chatRequest: cloneChatRequest(state.chatRequest),
        responses: new Set(state.responses || [])
    };
}

function mergeChatRequests(base, visibleChat, originalResponsesRequest) {
    const messages = [...(base.messages || []), ...(visibleChat.messages || [])];
    return {
        ...base,
        ...visibleChat,
        model: visibleChat.model || originalResponsesRequest?.model || base.model,
        messages,
        stream: originalResponsesRequest?.stream
    };
}

function appendAssistantFromChatResponse(existingRequest, chatResponse) {
    const base = cloneChatRequest(existingRequest || {model: chatResponse?.model, messages: []});
    const message = chatResponse?.choices?.[0]?.message;
    if (message) {
        base.messages = [...(base.messages || []), clone(message)];
    }
    return base;
}
