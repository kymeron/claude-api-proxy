import logger from '../../utils/logger.js';

export async function handleStreamResponse(stream, onChunk, onError) {
    return new Promise((resolve, reject) => {
        let buffer = '';

        stream.on('data', (chunk) => {
            try {
                buffer += chunk.toString('utf8');

                // Process complete SSE lines.
                while (buffer.includes('\n')) {
                    const lineEndIndex = buffer.indexOf('\n');
                    const line = buffer.slice(0, lineEndIndex);
                    buffer = buffer.slice(lineEndIndex + 1);

                    const trimmedLine = line.trim();
                    if (!trimmedLine || trimmedLine.startsWith(':')) {
                        continue;
                    }

                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6);

                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            onChunk(parsed);
                        } catch {
                            // ignore parse errors
                        }
                    }
                }
            } catch (error) {
                if (onError) {
                    onError(error);
                }
            }
        });

        stream.on('end', () => {
            // Process any remaining buffered data.
            if (buffer.trim()) {
                const trimmedBuffer = buffer.trim();
                if (trimmedBuffer.startsWith('data: ')) {
                    const data = trimmedBuffer.slice(6);
                    if (data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            onChunk(parsed);
                        } catch {
                            // ignore parse errors
                        }
                    }
                }
            }
            resolve();
        });

        stream.on('error', (error) => {
            if (onError) {
                onError(error);
            }
            reject(error);
        });
    });
}

export async function aggregateStreamResponse(stream, {logger: log = logger} = {}) {
    const aggregator = {
        id: null,
        model: null,
        content: '',
        reasoningContent: '',
        toolCalls: [],
        finishReason: null,
        usage: null
    };

    const toolCallMap = new Map();
    let currentToolId = null;

    await handleStreamResponse(
        stream,
        (chunk) => {
            aggregator.id = aggregator.id || chunk.id;
            aggregator.model = aggregator.model || chunk.model;

            if (chunk.usage) {
                aggregator.usage = chunk.usage;
            }

            const choices = chunk.choices || [];
            if (choices.length === 0) {
                return;
            }

            const choice = choices[0];

            if (choice.finish_reason) {
                aggregator.finishReason = choice.finish_reason;
            }

            const delta = choice.delta || {};

            if (delta.content) {
                aggregator.content += delta.content;
            }

            const reasoningText = delta.reasoning_content
                || (typeof delta.thinking === 'string' ? delta.thinking : null)
                || (typeof delta.thinking === 'object' && delta.thinking ? delta.thinking.content : null)
                || delta.reasoning;
            if (reasoningText) {
                aggregator.reasoningContent += reasoningText;
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const toolId = tc.id;

                    if (toolId) {
                        if (!toolCallMap.has(toolId)) {
                            toolCallMap.set(toolId, {
                                id: toolId,
                                type: tc.type || 'function',
                                function: {
                                    name: '',
                                    arguments: ''
                                }
                            });
                            currentToolId = toolId;
                        } else {
                            currentToolId = toolId;
                        }

                        if (tc.type) {
                            toolCallMap.get(toolId).type = tc.type;
                        }

                        const func = tc.function || {};
                        if (func.name) {
                            toolCallMap.get(toolId).function.name = func.name;
                        }
                        if (func.arguments) {
                            toolCallMap.get(toolId).function.arguments += func.arguments;
                        }
                    } else if (currentToolId && toolCallMap.has(currentToolId)) {
                        const func = tc.function || {};
                        if (func.name) {
                            toolCallMap.get(currentToolId).function.name = func.name;
                        }
                        if (func.arguments) {
                            toolCallMap.get(currentToolId).function.arguments += func.arguments;
                        }
                    }
                }
            }
        },
        (error) => {
            log.error('Stream processing error:', error);
        }
    );

    aggregator.toolCalls = Array.from(toolCallMap.values());

    for (const tc of aggregator.toolCalls) {
        try {
            if (tc.function.arguments) {
                JSON.parse(tc.function.arguments);
            }
        } catch (e) {
            let args = tc.function.arguments.trim();
            if (!args.endsWith('}') && args.includes('{')) {
                args += '}';
            }
            if (!args.endsWith(']') && args.includes('[')) {
                args += ']';
            }
            try {
                JSON.parse(args);
                tc.function.arguments = args;
            } catch (e2) {
                tc.function.arguments = '{}';
            }
        }
    }

    return aggregator;
}
