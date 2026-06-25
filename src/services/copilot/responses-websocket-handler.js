function createResponsesWebSocketError(message, code = 'server_error', eventMessage = message) {
    return Object.assign(new Error(message), {
        name: 'ResponsesWSError',
        event: {
            type: 'error',
            error: {message: eventMessage, code}
        }
    });
}

export function createCopilotResponsesWebSocketHandler({
    handleWSConnection,
    currentCopilotContext,
    runWithCopilotContext,
    isAuthenticated,
    getCopilotNetworkOptions,
    ensureCopilotToken,
    extractConversationKey,
    sanitizeResponsesInput,
    supportsResponsesWebSocket,
    createResponsesWS,
    copilotState,
    discardWSConnection,
    releaseWSConnection,
    responsesRequestToChat,
    createChatCompletions,
    readBody,
    createChatToResponsesStreamBridge,
    copilotStore,
    logger = console
}) {
    return function handleCopilotResponsesWSInContext(clientWs, req) {
        const tenantContext = currentCopilotContext();
        handleWSConnection(clientWs, {
            authenticate: () => true,
            runInContext: callback => runWithCopilotContext(tenantContext, callback),
            req,
            handleRequest: async function* handleCopilotResponsesWSRequest(payload, authResult, {signal}) {
                if (!isAuthenticated()) {
                    throw createResponsesWebSocketError(
                        'Not authenticated. Open the Copilot tab in /dashboard to connect GitHub.',
                        'unauthorized',
                        'Not authenticated'
                    );
                }

                const networkOptions = getCopilotNetworkOptions(req);
                const proxyUrl = networkOptions.proxyUrl;

                try {
                    const copilotToken = await ensureCopilotToken(proxyUrl, networkOptions);
                    const conversationKey = extractConversationKey(req, payload);

                    if (Array.isArray(payload.input)) {
                        payload = {...payload, input: sanitizeResponsesInput(payload.input, payload.model)};
                    }

                    if (supportsResponsesWebSocket(payload.model)) {
                        try {
                            const wsResult = await createResponsesWS(
                                copilotToken,
                                copilotState.vsCodeVersion,
                                payload,
                                copilotState.accountType,
                                proxyUrl,
                                {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
                            );

                            const eventStream = wsResult.eventStream;
                            const conn = wsResult.conn;
                            let connHandled = false;
                            try {
                                for await (const event of eventStream) {
                                    if (signal?.aborted) {
                                        discardWSConnection(conn);
                                        connHandled = true;
                                        return;
                                    }
                                    yield event;
                                }
                            } catch (err) {
                                discardWSConnection(conn);
                                connHandled = true;
                                throw err;
                            } finally {
                                if (!connHandled) releaseWSConnection(conn);
                            }
                            return;
                        } catch (wsError) {
                            logger.warn(`Copilot WS: WS failed, falling back to HTTP: ${wsError.message}`);
                        }
                    }

                    const chatReq = responsesRequestToChat(payload);
                    chatReq.stream = true;

                    const response = await createChatCompletions(
                        copilotToken,
                        copilotState.vsCodeVersion,
                        chatReq,
                        copilotState.accountType,
                        proxyUrl,
                        networkOptions
                    );

                    if (response.status >= 400) {
                        const errorBody = await readBody(response.body);
                        throw createResponsesWebSocketError(
                            `Upstream error: ${errorBody.slice(0, 500)}`,
                            'upstream_error',
                            `Upstream error: ${response.status}`
                        );
                    }

                    const chatToResponsesBridge = createChatToResponsesStreamBridge({model: payload.model});
                    let buffer = Buffer.alloc(0);

                    for await (const chunk of response.body) {
                        if (signal?.aborted) break;
                        buffer = Buffer.concat([buffer, chunk]);
                        let start = 0;
                        let newLineIndex;
                        while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                            const line = buffer.toString('utf8', start, newLineIndex).trim();
                            start = newLineIndex + 1;
                            if (!line || line.startsWith(':') || !line.startsWith('data: ')) continue;
                            const raw = line.slice(6).trim();
                            if (raw === '[DONE]') continue;

                            let data;
                            try {
                                data = JSON.parse(raw);
                            } catch {
                                continue;
                            }

                            const events = chatToResponsesBridge.feed(data);
                            for (const ev of events) {
                                yield {type: ev.event, data: ev.data};
                            }
                        }
                        if (start > 0) buffer = buffer.subarray(start);
                    }

                    if (!chatToResponsesBridge.finished) {
                        for (const ev of chatToResponsesBridge.finish()) {
                            yield {type: ev.event, data: ev.data};
                        }
                    }
                } catch (error) {
                    logger.error('Copilot WS: handleRequest error:', error);
                    throw error;
                }
            },
            onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
                copilotStore.incrementApiCallCount();
                copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model);
            }
        });
    };
}
