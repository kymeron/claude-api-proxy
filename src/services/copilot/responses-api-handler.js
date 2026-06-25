function writeResponsesSSE(res, event) {
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export function createCopilotResponsesAPIHandler({
    getCopilotNetworkOptions,
    ensureCopilotAuth,
    sendOpenAIError,
    sendJson,
    sendResponsesProtocolError,
    upstreamErrorStatus,
    isResponsesProtocolError,
    parseBody,
    extractConversationKey,
    sanitizeResponsesInput,
    ensureResponsesWebSocketSupported,
    createResponsesWS,
    copilotState,
    createResponsesToResponsesStreamBridge,
    convertResponsesUsageToChat,
    extractCacheHitTokens,
    releaseWSConnection,
    discardWSConnection,
    responsesRequestToChat,
    createChatCompletions,
    readBody,
    createChatToResponsesStreamBridge,
    chatResponseToResponses,
    copilotStore,
    logger = console
}) {
    return async function handleResponsesAPI(req, res) {
        try {
            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;
            const authResult = await ensureCopilotAuth(networkOptions);
            if (authResult.error) {
                sendOpenAIError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const responsesReq = JSON.parse(body);

            logger.info(`Copilot Responses request - model: ${responsesReq.model}, stream: ${responsesReq.stream}`);

            const conversationKey = extractConversationKey(req, responsesReq);

            if (Array.isArray(responsesReq.input)) {
                responsesReq.input = sanitizeResponsesInput(responsesReq.input, responsesReq.model);
            }

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

                if (responsesReq.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    });

                    const responsesToResponsesBridge = createResponsesToResponsesStreamBridge({model: responsesReq.model});
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
                            const responseEvents = responsesToResponsesBridge.feed(event.type, event.data);
                            for (const ev of responseEvents) {
                                writeResponsesSSE(res, ev);
                            }
                        }
                        if (!responsesToResponsesBridge.finished) {
                            for (const ev of responsesToResponsesBridge.finish()) {
                                writeResponsesSSE(res, ev);
                            }
                        }
                        releaseWSConnection(wsResult.conn);
                    } catch (err) {
                        discardWSConnection(wsResult.conn);
                        throw err;
                    }

                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
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
                        const usage = completedData.response.usage || {};
                        const chatUsage = convertResponsesUsageToChat(usage);
                        const inputTokens = chatUsage.prompt_tokens || 0;
                        const outputTokens = chatUsage.completion_tokens || 0;
                        const cacheHitTokens = extractCacheHitTokens(chatUsage);
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                        sendJson(res, 200, completedData.response);
                    } else {
                        sendOpenAIError(res, 502, 'No response.completed event received from upstream');
                    }
                }
            } catch (wsError) {
                if (isResponsesProtocolError(wsError)) {
                    logger.warn(`Copilot Responses: WS protocol error: ${wsError.message}`);
                    sendResponsesProtocolError(res, wsError);
                    return;
                }

                if (res.headersSent) {
                    logger.warn(`Copilot Responses: WS stream failed after response started: ${wsError.message}`);
                    if (!res.destroyed && !res.writableEnded) {
                        res.end();
                    }
                    return;
                }

                logger.warn(`Copilot Responses: WS failed, falling back to HTTP POST: ${wsError.message}`);

                const chatReq = responsesRequestToChat(responsesReq);
                const response = await createChatCompletions(
                    authResult.copilotToken,
                    copilotState.vsCodeVersion,
                    chatReq,
                    copilotState.accountType,
                    proxyUrl,
                    networkOptions
                );

                if (response.status >= 400) {
                    const errorBody = await readBody(response.body);
                    sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                    return;
                }

                if (responsesReq.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    });

                    const chatToResponsesBridge = createChatToResponsesStreamBridge({model: responsesReq.model});
                    let buffer = Buffer.alloc(0);
                    let streamInputTokens = 0;
                    let streamOutputTokens = 0;
                    let streamCacheHitTokens = 0;

                    response.body.on('data', (chunk) => {
                        buffer = Buffer.concat([buffer, chunk]);
                        let start = 0;
                        let newLineIndex;
                        while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                            const line = buffer.toString('utf8', start, newLineIndex).trim();
                            start = newLineIndex + 1;
                            if (!line || line.startsWith(':')) continue;
                            if (!line.startsWith('data: ')) continue;
                            const raw = line.slice(6).trim();
                            if (raw === '[DONE]') continue;

                            let data;
                            try {
                                data = JSON.parse(raw);
                            } catch {
                                continue;
                            }

                            if (data.usage) {
                                streamInputTokens = data.usage.prompt_tokens || 0;
                                streamOutputTokens = data.usage.completion_tokens || 0;
                                streamCacheHitTokens = extractCacheHitTokens(data.usage);
                            }
                            const events = chatToResponsesBridge.feed(data);
                            for (const ev of events) {
                                writeResponsesSSE(res, ev);
                            }
                        }
                        if (start > 0) buffer = buffer.subarray(start);
                    });

                    response.body.on('end', () => {
                        if (!chatToResponsesBridge.finished) {
                            for (const ev of chatToResponsesBridge.finish()) {
                                writeResponsesSSE(res, ev);
                            }
                        }
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                        copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                        res.end();
                    });

                    response.body.on('error', (err) => {
                        logger.error('Responses stream error (fallback):', err);
                        res.end();
                    });
                } else {
                    const responseBody = await readBody(response.body);
                    const chatResponse = JSON.parse(responseBody);

                    const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                    const outputTokens = chatResponse.usage?.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);

                    sendJson(res, 200, chatResponseToResponses(chatResponse));
                }
            }
        } catch (error) {
            logger.error('Copilot: Failed to handle Responses API:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
