export function createCodebuddyMetadataHandlers({
    authenticateAndGetCredential,
    getModels,
    sendOpenAIError,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    logger = console
}) {
    async function handleOpenAIModels(req, res) {
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (authResult.error) {
                sendOpenAIError(
                    res,
                    authResult.error.status,
                    authResult.error.message,
                    authResult.error.status === 401 ? 'authentication_error' : 'api_error'
                );
                return;
            }

            const modelsData = await getModels(authResult.credential);
            sendJson(res, 200, {
                object: 'list',
                data: modelsData.data.map((model) => ({
                    id: model.id,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'codebuddy'
                }))
            });
        } catch (error) {
            logger.error('Failed to get OpenAI models:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicCountTokens(req, res) {
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));
            const text = JSON.stringify(anthropicPayload.messages);
            const estimatedTokens = Math.ceil(text.length / 4);

            sendJson(res, 200, {input_tokens: estimatedTokens});
        } catch (error) {
            logger.error('Failed to count tokens:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicModels(req, res) {
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const modelsData = await getModels(authResult.credential);
            sendJson(res, 200, {
                data: modelsData.data.map((model) => ({
                    id: model.id,
                    object: 'model',
                    created: 0,
                    owned_by: 'codebuddy',
                    name: model.name,
                    capabilities: {}
                })),
                object: 'list'
            });
        } catch (error) {
            logger.error('Failed to get Anthropic models:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    return {
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels
    };
}
