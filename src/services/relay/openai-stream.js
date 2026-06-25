import {
    createChatStreamAccumulator as defaultCreateChatStreamAccumulator,
    rewriteOpenAIStream as defaultRewriteOpenAIStream
} from './protocol-adapter.js';

export function streamRelayOpenAIPassthrough(response, res, {
    tenantId,
    model = 'unknown',
    conversationKey = null,
    conversationStore = null,
    recordUsage = () => {},
    logger = undefined,
    createChatStreamAccumulator = defaultCreateChatStreamAccumulator,
    rewriteOpenAIStream = defaultRewriteOpenAIStream
} = {}) {
    const chatAccumulator = createChatStreamAccumulator({model});
    rewriteOpenAIStream(
        res,
        response.body,
        (inputTokens, outputTokens, cacheHitTokens) => {
            const chatResponse = chatAccumulator.toChatResponse();
            if (chatResponse && conversationKey) {
                conversationStore?.recordChatResponse?.({
                    tenantId,
                    conversationKey,
                    response: chatResponse
                });
            }
            recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, model);
        },
        (chunk) => chatAccumulator.feed(chunk),
        {logger}
    );
}

export function createRelayOpenAIStreamPassthrough({
    conversationStore,
    recordUsage,
    logger,
    createChatStreamAccumulator = defaultCreateChatStreamAccumulator,
    rewriteOpenAIStream = defaultRewriteOpenAIStream
} = {}) {
    return (response, res, tenantId, _tenantInfo = '', model = 'unknown', conversationKey = null) =>
        streamRelayOpenAIPassthrough(response, res, {
            tenantId,
            model,
            conversationKey,
            conversationStore,
            recordUsage,
            logger,
            createChatStreamAccumulator,
            rewriteOpenAIStream
        });
}
