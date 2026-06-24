export function createCopilotChatCompletionsHandler({
    getCopilotNetworkOptions,
    ensureCopilotAuth,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    chatRequestToResponses,
    extractConversationKey,
    ensureResponsesWebSocketSupported,
    createResponsesWS,
    copilotState,
    createResponsesToChatStreamBridge,
    convertResponsesUsageToChat,
    extractCacheHitTokens,
    releaseWSConnection,
    discardWSConnection,
    responsesResponseToChat,
    createChatCompletions,
    readBody,
    estimateMessageTokens,
    copilotStore,
    logger = console
}) {
    return async function handleOpenAIChatCompletions(req, res) {
        try {
            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;
            const authResult = await ensureCopilotAuth(networkOptions);
            if (authResult.error) {
                sendOpenAIError(
                    res,
                    authResult.error.status,
                    authResult.error.message,
                    authResult.error.status === 401 ? 'authentication_error' : 'api_error'
                );
                return;
            }

            const body = await parseBody(req);
            const openAIPayload = JSON.parse(body);

            logger.info(`Copilot OpenAI request - model: ${openAIPayload.model}, stream: ${openAIPayload.stream}`);

            const conversationKey = extractConversationKey(req, openAIPayload);
            const responsesReq = chatRequestToResponses(openAIPayload);

            try {
                ensureResponsesWebSocketSupported(responsesReq.model);
                const wsResult = await createResponsesWS(
                    authResult.copilotToken,
                    copilotState.vsCodeVersion,
                    responsesReq,
                    copilotState.accountType,
                    proxyUrl,
                    {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
                );

                if (openAIPayload.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    });

                    const responsesToChatBridge = createResponsesToChatStreamBridge({model: openAIPayload.model});
                    let streamInputTokens = 0;
                    let streamOutputTokens = 0;
                    let streamCacheHitTokens = 0;
                    try {
                        for await (const event of wsResult.eventStream) {
                            if (event.type === 'response.completed' && event.data?.response?.usage) {
                                const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                                streamInputTokens = chatUsage.prompt_tokens || 0;
                                streamOutputTokens = chatUsage.completion_tokens || 0;
                                streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                            }
                            const chatChunks = responsesToChatBridge.feed(event.type, event.data);
                            for (const chunk of chatChunks) {
                                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                            }
                        }
                        if (!responsesToChatBridge.completed) {
                            for (const chunk of responsesToChatBridge.finish()) {
                                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                            }
                        }
                        res.write('data: [DONE]\n\n');
                        releaseWSConnection(wsResult.conn);
                    } catch (err) {
                        discardWSConnection(wsResult.conn);
                        throw err;
                    }

                    if (streamInputTokens > 0 || streamOutputTokens > 0) {
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                        copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                    } else {
                        copilotStore.incrementApiCallCount();
                        const estimated = estimateMessageTokens(openAIPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    res.end();
                } else {
                    let completedData = null;
                    try {
                        for await (const event of wsResult.eventStream) {
                            if (event.type === 'response.completed') {
                                completedData = event.data;
                            }
                        }
                        releaseWSConnection(wsResult.conn);
                    } catch (err) {
                        discardWSConnection(wsResult.conn);
                        throw err;
                    }

                    if (completedData?.response) {
                        const chatResponse = responsesResponseToChat(completedData.response);
                        const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                        const outputTokens = chatResponse.usage?.completion_tokens || 0;
                        const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                        sendJson(res, 200, chatResponse);
                    } else {
                        sendOpenAIError(res, 502, 'No response.completed event received from upstream');
                    }
                }
            } catch (wsError) {
                if (res.headersSent) {
                    logger.warn(`Copilot OpenAI: WS stream failed after response started: ${wsError.message}`);
                    if (!res.destroyed && !res.writableEnded) {
                        res.end();
                    }
                    return;
                }

                logger.warn(`Copilot OpenAI: WS failed, falling back to HTTP POST: ${wsError.message}`);

                const response = await createChatCompletions(
                    copilotState.copilotToken,
                    copilotState.vsCodeVersion,
                    openAIPayload,
                    copilotState.accountType,
                    proxyUrl,
                    networkOptions
                );

                if (response.status >= 400) {
                    const errorBody = await readBody(response.body);
                    sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                    return;
                }

                if (openAIPayload.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    });

                    let streamInputTokens = 0;
                    let streamOutputTokens = 0;
                    let streamCacheHitTokens = 0;
                    let lineBuffer = '';

                    response.body.on('data', (chunk) => {
                        res.write(chunk);
                        lineBuffer += chunk.toString('utf8');
                        const lines = lineBuffer.split('\n');
                        lineBuffer = lines.pop();
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed.startsWith('data: ')) continue;
                            const raw = trimmed.slice(6).trim();
                            if (raw === '[DONE]') continue;
                            try {
                                const data = JSON.parse(raw);
                                if (data.usage) {
                                    streamInputTokens = data.usage.prompt_tokens || 0;
                                    streamOutputTokens = data.usage.completion_tokens || 0;
                                    streamCacheHitTokens = extractCacheHitTokens(data.usage);
                                }
                            } catch {}
                        }
                    });

                    response.body.on('end', () => {
                        if (lineBuffer.trim()) {
                            res.write(lineBuffer);
                        }
                        if (streamInputTokens > 0 || streamOutputTokens > 0) {
                            copilotStore.incrementApiCallCount();
                            copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                            copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                        } else {
                            copilotStore.incrementApiCallCount();
                            const estimated = estimateMessageTokens(openAIPayload.messages || []);
                            copilotStore.incrementTokenUsage(estimated, 0, 0);
                            copilotStore.recordDailyUsage(estimated, 0, 0);
                        }
                        res.end();
                    });

                    response.body.on('error', (err) => {
                        logger.error('Copilot OpenAI stream error (fallback):', err);
                        res.end();
                    });

                    res.on('close', () => {
                        if (response.body && !response.body.destroyed) {
                            response.body.destroy();
                        }
                    });
                } else {
                    const responseBody = await readBody(response.body);
                    let parsed;
                    try {
                        parsed = JSON.parse(responseBody);
                    } catch {
                        sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                        return;
                    }
                    const inputTokens = parsed.usage?.prompt_tokens || 0;
                    const outputTokens = parsed.usage?.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(parsed.usage);
                    copilotStore.incrementApiCallCount();
                    if (inputTokens > 0 || outputTokens > 0) {
                        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                    } else {
                        const estimated = estimateMessageTokens(openAIPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    sendJson(res, 200, parsed);
                }
            }
        } catch (error) {
            logger.error('Copilot: Failed to handle OpenAI chat completions:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
