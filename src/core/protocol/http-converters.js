import {convertResponsesUsageToChat, mergeConsecutiveAssistantMessages} from './responses.js';
import {cleanJsonSchema} from '../../utils/helpers.js';
import {
    extractCacheHitTokens,
    extractInputTokens,
    mapContent,
    mapStopReason,
    normalizeClaudeModelAlias,
    openAIUsageToAnthropicUsage,
    prependThinkingHint,
    prependToolThinkingHint,
    sortObjectKeys,
    translateToolChoice
} from './shared.js';
import {
    appendChatResponseToCanonical,
    canonicalFromAnthropicResponse,
    canonicalFromChatRequest,
    canonicalFromResponsesResponse,
    renderCanonicalToAnthropic,
    renderCanonicalToChat,
    renderCanonicalToResponses
} from './canonical/session.js';
import {streamAnthropicSSEToChatChunks} from './stream/canonical-stream.js';

export function chatContentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content ? JSON.stringify(content) : '';
    return content
        .map((part) => part?.text || part?.input_text || part?.output_text || '')
        .filter(Boolean)
        .join('\n');
}

export function chatRequestToAnthropic(chatReq) {
    const chatMessages = cloneChatMessages(chatReq.messages || []);
    mergeConsecutiveAssistantMessages(chatMessages);
    const canonical = canonicalFromChatRequest({...chatReq, messages: chatMessages});
    const rendered = renderCanonicalToAnthropic(canonical);

    const payload = {
        ...rendered,
        max_tokens: chatReq.max_tokens || chatReq.max_completion_tokens || 4096,
        stream: chatReq.stream,
        temperature: chatReq.temperature,
        top_p: chatReq.top_p
    };
    if (Array.isArray(chatReq.stop)) payload.stop_sequences = chatReq.stop;
    else if (typeof chatReq.stop === 'string') payload.stop_sequences = [chatReq.stop];

    if (!payload.tools || payload.tools.length === 0) delete payload.tools;
    if (!payload.tool_choice) delete payload.tool_choice;
    return payload;
}

export function chatRequestToRelayResponses(chatReq = {}) {
    const chatMessages = cloneChatMessages(chatReq.messages || []);
    mergeConsecutiveAssistantMessages(chatMessages);
    const rendered = renderCanonicalToResponses(canonicalFromChatRequest({...chatReq, messages: chatMessages}));
    const payload = {
        ...rendered,
        stream: chatReq.stream,
        temperature: chatReq.temperature,
        top_p: chatReq.top_p
    };

    if (chatReq.max_tokens !== undefined) payload.max_output_tokens = chatReq.max_tokens;
    if (chatReq.reasoning_effort) payload.reasoning = {effort: chatReq.reasoning_effort};
    if (chatReq.store !== undefined) payload.store = chatReq.store;
    if (chatReq.response_format) payload.text = {format: chatReq.response_format};
    if (!payload.tools || payload.tools.length === 0) {
        delete payload.tools;
        delete payload.tool_choice;
        delete payload.parallel_tool_calls;
    }
    return payload;
}

export function anthropicRequestToChat(anthropicPayload = {}, options = {}) {
    const modelMapper = options.modelMapper || normalizeClaudeModelAlias;
    const model = modelMapper(anthropicPayload.model);
    const renderOptions = {...options, model};
    const openAIPayload = {
        model,
        messages: translateAnthropicMessagesToChat(anthropicPayload.messages, anthropicPayload.system, renderOptions),
        max_tokens: anthropicPayload.max_tokens,
        temperature: anthropicPayload.temperature,
        top_p: anthropicPayload.top_p,
        stream: anthropicPayload.stream,
        stop: anthropicPayload.stop_sequences
    };

    if (anthropicPayload.tools) {
        openAIPayload.tools = anthropicToolsToChatTools(anthropicPayload.tools, renderOptions);
    }

    if (anthropicPayload.tool_choice) {
        openAIPayload.tool_choice = translateToolChoice(anthropicPayload.tool_choice);
    }

    if (options.disableReasoningForModel?.(model, anthropicPayload)) {
        openAIPayload.reasoning_effort = '';
    } else {
        const thinkingConfig = resolveAnthropicThinkingConfig(anthropicPayload);
        if (thinkingConfig.disabled) {
            openAIPayload.reasoning_effort = '';
        } else if (thinkingConfig.effort) {
            openAIPayload.reasoning_effort = thinkingConfig.effort;
        }
    }

    return openAIPayload;
}

function anthropicToolsToChatTools(anthropicTools, options = {}) {
    return anthropicTools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: options.cleanToolSchema ? cleanJsonSchema(tool.input_schema) : tool.input_schema
        }
    }));
}

function resolveAnthropicThinkingConfig(anthropicPayload) {
    const thinking = anthropicPayload.thinking;

    if (thinking?.type === 'disabled') {
        return {disabled: true, effort: ''};
    }

    let effort = null;
    const outputEffort = anthropicPayload.output_config?.effort;
    if (outputEffort && typeof outputEffort === 'string') {
        const effortMap = {low: 'low', medium: 'medium', high: 'high', max: 'high'};
        const mapped = effortMap[outputEffort.toLowerCase()];
        if (mapped) {
            effort = mapped;
        }
    }

    if (!effort && thinking) {
        if (thinking.type === 'adaptive') {
            effort = 'high';
        } else if (thinking.type === 'enabled' && thinking.budget_tokens) {
            if (thinking.budget_tokens <= 4000) effort = 'low';
            else if (thinking.budget_tokens <= 16000) effort = 'medium';
            else effort = 'high';
        }
    }

    return {disabled: false, effort};
}

function translateAnthropicMessagesToChat(anthropicMessages = [], system, options = {}) {
    const messages = [];

    if (system) {
        if (typeof system === 'string') {
            messages.push({role: 'system', content: system});
        } else if (Array.isArray(system)) {
            const systemText = system
                .map((block) => (typeof block?.text === 'string' ? block.text.trim() : ''))
                .filter(Boolean)
                .join('\n\n');
            if (systemText) {
                messages.push({role: 'system', content: systemText});
            }
        }
    }

    let lastAssistantMessage = null;
    for (const message of Array.isArray(anthropicMessages) ? anthropicMessages : []) {
        if (message.role === 'user') {
            const userMessages = handleAnthropicUserMessage(message, lastAssistantMessage, options);
            messages.push(...userMessages);
            lastAssistantMessage = null;
        } else {
            const assistantMessages = handleAnthropicAssistantMessage(message, options);
            messages.push(...assistantMessages);
            if (assistantMessages.length > 0 && assistantMessages[0].tool_calls) {
                lastAssistantMessage = assistantMessages[0];
            } else {
                lastAssistantMessage = null;
            }
        }
    }

    return options.messagePostProcessor ? options.messagePostProcessor(messages, {model: options.model}) : messages;
}

function handleAnthropicUserMessage(message, previousAssistantMessage = null, options = {}) {
    const messages = [];

    if (typeof message.content === 'string') {
        messages.push({role: 'user', content: prependThinkingHint(message.content)});
    } else if (Array.isArray(message.content)) {
        const toolResults = message.content.filter((block) => block.type === 'tool_result');
        const otherBlocks = message.content.filter((block) => block.type !== 'tool_result');

        if (toolResults.length > 0) {
            const resultMap = new Map();
            for (const block of toolResults) {
                let content = '';
                if (typeof block.content === 'string') {
                    content = block.content;
                } else if (block.content != null) {
                    content = JSON.stringify(block.content);
                }
                resultMap.set(block.tool_use_id, prependToolThinkingHint(content));
            }

            if (options.orderToolResultsByAssistant !== false && previousAssistantMessage?.tool_calls) {
                const orderedIds = previousAssistantMessage.tool_calls.map((toolCall) => toolCall.id);
                for (const toolId of orderedIds) {
                    if (resultMap.has(toolId)) {
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolId,
                            content: resultMap.get(toolId)
                        });
                        resultMap.delete(toolId);
                    }
                }
            }

            for (const [toolId, content] of resultMap) {
                messages.push({
                    role: 'tool',
                    tool_call_id: toolId,
                    content
                });
            }
        }

        if (otherBlocks.length > 0) {
            messages.push({
                role: 'user',
                content: prependThinkingHint(mapContent(otherBlocks))
            });
        }
    }

    return messages;
}

function handleAnthropicAssistantMessage(message, options = {}) {
    if (typeof message.content === 'string') {
        return [{role: 'assistant', content: message.content}];
    }

    if (!Array.isArray(message.content)) {
        return [{role: 'assistant', content: null}];
    }

    const toolUseBlocks = message.content.filter((block) => block.type === 'tool_use');
    const textBlocks = message.content.filter((block) => block.type === 'text');
    const thinkingBlocks = message.content.filter((block) => block.type === 'thinking');

    const allText = textBlocks
        .map((block) => block.text)
        .filter(Boolean)
        .join('\n\n');

    const result = {
        role: 'assistant',
        content: allText || (toolUseBlocks.length > 0 ? '' : null)
    };

    const reasoningText = thinkingBlocks
        .map((block) => block.thinking)
        .filter(Boolean)
        .join('\n\n');
    if (reasoningText) {
        result.reasoning_content = reasoningText;
    }

    if (toolUseBlocks.length > 0) {
        result.tool_calls = toolUseBlocks.map((block) => {
            let args = '{}';
            if (block.input !== undefined && block.input !== null) {
                try {
                    const input = options.sortToolInput === false ? block.input : sortObjectKeys(block.input);
                    args = JSON.stringify(input);
                } catch (e) {
                    options.logger?.warn?.(`Failed to stringify tool input for ${block.name}:`, e.message);
                    args = '{}';
                }
            }
            return {
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: args
                }
            };
        });
    }

    return [result];
}

function cloneChatMessages(messages) {
    return messages.map((message) => {
        if (!message || typeof message !== 'object') return message;
        return JSON.parse(JSON.stringify(message));
    });
}

export function anthropicUsageToChatUsage(usage) {
    const promptTokens = extractInputTokens(usage);
    const completionTokens = usage?.output_tokens || 0;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
            cached_tokens: extractCacheHitTokens(usage)
        }
    };
}

export function anthropicStopReasonToChat(stopReason) {
    return {end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls'}[stopReason] || 'stop';
}

export function anthropicResponseToChat(anthropicResponse, modelFallback) {
    const session = canonicalFromAnthropicResponse({
        ...anthropicResponse,
        model: anthropicResponse.model || modelFallback
    });
    const rendered = renderCanonicalToChat(session);
    const message = [...(rendered.messages || [])].reverse().find((item) => item?.role === 'assistant')
        || {role: 'assistant', content: null};

    return {
        id: anthropicResponse.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicResponse.model || modelFallback || 'unknown',
        choices: [{index: 0, message, finish_reason: anthropicStopReasonToChat(anthropicResponse.stop_reason)}],
        usage: anthropicUsageToChatUsage(anthropicResponse.usage)
    };
}

export function chatResponseToAnthropic(chatResponse = {}) {
    const choice = chatResponse.choices?.[0];
    if (!choice) {
        return {
            id: chatResponse.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: chatResponse.model || 'unknown',
            content: [{type: 'text', text: 'Empty response from upstream API'}],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: openAIUsageToAnthropicUsage(chatResponse.usage)
        };
    }

    const session = appendChatResponseToCanonical(
        canonicalFromChatRequest({model: chatResponse.model, messages: []}),
        chatResponse
    );
    const rendered = renderCanonicalToAnthropic(session);
    const message = [...(rendered.messages || [])].reverse().find((item) => item?.role === 'assistant');

    return {
        id: chatResponse.id,
        type: 'message',
        role: 'assistant',
        model: chatResponse.model,
        content: message?.content?.length ? message.content : [{type: 'text', text: ''}],
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: openAIUsageToAnthropicUsage(chatResponse.usage)
    };
}

export function chatResponseToRelayResponses(chatResponse = {}) {
    const choice = chatResponse.choices?.[0];
    const session = appendChatResponseToCanonical(
        canonicalFromChatRequest({model: chatResponse.model, messages: []}),
        chatResponse
    );
    const rendered = renderCanonicalToResponses(session);
    const output = [];
    let index = 0;

    for (const item of rendered.input || []) {
        if (item?.role === 'assistant') {
            output.push({
                type: 'message',
                id: `msg_${Date.now()}_${index++}`,
                status: 'completed',
                role: 'assistant',
                content: item.content || []
            });
            continue;
        }
        if (item?.type === 'reasoning') {
            output.push({
                ...item,
                id: item.id || `rs_${Date.now()}_${index++}`,
                status: 'completed'
            });
            continue;
        }
        if (item?.type === 'function_call') {
            output.push({
                ...item,
                id: item.id || `fc_${Date.now()}_${index++}`,
                status: item.status || 'completed'
            });
        }
    }

    return {
        id: `resp_${Date.now()}`,
        object: 'response',
        created_at: chatResponse.created || Math.floor(Date.now() / 1000),
        status: chatResponse.error ? 'failed' : (choice?.finish_reason === 'length' ? 'incomplete' : 'completed'),
        error: chatResponse.error || null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: chatResponse.model || 'unknown',
        output,
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: null,
        store: false,
        temperature: null,
        tool_choice: null,
        tools: [],
        top_p: null,
        truncation: null,
        usage: chatUsageToResponsesUsage(chatResponse.usage),
        user: null,
        metadata: {}
    };
}

export function responsesResponseToRelayChat(response = {}) {
    const session = canonicalFromResponsesResponse(response);
    const rendered = renderCanonicalToChat(session);
    const message = [...(rendered.messages || [])].reverse().find((item) => item?.role === 'assistant')
        || {role: 'assistant', content: null};
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

    return {
        id: response.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: response.created_at || Math.floor(Date.now() / 1000),
        model: response.model || 'unknown',
        choices: [{
            index: 0,
            message,
            finish_reason: hasToolCalls ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop'
        }],
        usage: convertResponsesUsageToChat(response.usage)
    };
}

function chatUsageToResponsesUsage(usage = {}) {
    return {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        input_tokens_details: {
            cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0
        },
        output_tokens_details: {
            reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0
        }
    };
}

export async function* anthropicStreamToChatChunks(stream, parseSSEBlock, signal) {
    yield* streamAnthropicSSEToChatChunks(stream, parseSSEBlock, signal);
}
