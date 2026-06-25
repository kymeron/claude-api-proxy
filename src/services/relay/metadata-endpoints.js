import {parseUpstreamJson as parseRelayUpstreamJson} from '../shared/upstream-json.js';

export function createRelayMetadataHandlers({
    authenticateAndGetUpstream,
    getUpstreamModels,
    getAnthropicRequestHeaders,
    isAnthropicUpstream,
    isResponsesUpstream,
    isResponsesWebSocketUpstream,
    createAnthropicCountTokens,
    callUpstream,
    readResponseBody,
    parseBody,
    sanitizeAnthropicPayload,
    mapAnthropicModelsToOpenAI,
    mapOpenAIModelsToAnthropic,
    getProtocolErrorMessage,
    upstreamErrorStatus,
    sendJson,
    sendOpenAIError,
    sendAnthropicError,
    logger = console
}) {
    async function handleOpenAIModels(req, res) {
        try {
            const authResult = await authenticateAndGetUpstream(req);
            if (authResult.error) {
                sendOpenAIError(res, authResult.error.status, authResult.error.message);
                return;
            }
            const modelsData = await getUpstreamModels(authResult.upstream, getAnthropicRequestHeaders(req));
            sendJson(
                res,
                200,
                isAnthropicUpstream(authResult.upstream) ? mapAnthropicModelsToOpenAI(modelsData) : modelsData
            );
        } catch (error) {
            logger.error('Relay: Failed to get OpenAI models:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicModels(req, res) {
        try {
            const authResult = await authenticateAndGetUpstream(req);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }
            const modelsData = await getUpstreamModels(authResult.upstream, getAnthropicRequestHeaders(req));
            sendJson(
                res,
                200,
                isAnthropicUpstream(authResult.upstream) ? modelsData : mapOpenAIModelsToAnthropic(modelsData)
            );
        } catch (error) {
            logger.error('Relay: Failed to get Anthropic models:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicCountTokens(req, res) {
        try {
            const authResult = await authenticateAndGetUpstream(req);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }
            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));

            if (isAnthropicUpstream(authResult.upstream)) {
                const {response} = await callUpstream(authResult.upstream, (up) =>
                    createAnthropicCountTokens(anthropicPayload, up, getAnthropicRequestHeaders(req))
                );
                const responseBody = await readResponseBody(response.body);
                sendJson(res, 200, parseRelayUpstreamJson(responseBody));
                return;
            }

            if (isResponsesUpstream(authResult.upstream) || isResponsesWebSocketUpstream(authResult.upstream)) {
                sendAnthropicError(
                    res,
                    400,
                    getProtocolErrorMessage(authResult.upstream, 'anthropic', '/relay/v1/responses')
                );
                return;
            }

            const text = JSON.stringify(anthropicPayload.messages);
            const estimatedTokens = Math.ceil(text.length / 4);
            sendJson(res, 200, {input_tokens: estimatedTokens});
        } catch (error) {
            logger.error('Relay: Failed to count tokens:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    return {
        handleOpenAIModels,
        handleAnthropicModels,
        handleAnthropicCountTokens
    };
}
