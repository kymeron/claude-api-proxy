/**
 * Anthropic 到 OpenAI 格式转换模块
 * 用于 Claude Code 兼容性
 * @module services/copilot/anthropic-adapter
 */

import logger from '../../utils/logger.js';
import {translateToolChoice, mapContent, injectBehaviorRules, prependThinkingHint, prependToolThinkingHint, openAIToAnthropic as sharedOpenAIToAnthropic, normalizeClaudeModelAlias} from '../../core/protocol/shared.js';
import {anthropicRequestToResponses, responsesResponseToAnthropic} from '../../core/protocol/http-converters.js';

/**
 * 转换 Anthropic 请求到 OpenAI 格式
 */
export function anthropicToOpenAI(anthropicPayload, modelId) {
    const resolvedModel = modelId || translateModelName(anthropicPayload.model);
    const openAIPayload = {
        model: resolvedModel,
        messages: translateMessages(anthropicPayload.messages, anthropicPayload.system, resolvedModel),
        max_tokens: anthropicPayload.max_tokens,
        temperature: anthropicPayload.temperature,
        top_p: anthropicPayload.top_p,
        stream: anthropicPayload.stream,
        stop: anthropicPayload.stop_sequences
    };

    // 转换 tools
    if (anthropicPayload.tools) {
        openAIPayload.tools = anthropicPayload.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema
            }
        }));
    }

    // 转换 tool_choice
    if (anthropicPayload.tool_choice) {
        openAIPayload.tool_choice = translateToolChoice(anthropicPayload.tool_choice);
    }

    // 处理 thinking / reasoning_effort
    // haiku 系列不支持 reasoning_effort，设为空字符串让 normalizePayload 删除该字段
    const model = openAIPayload.model || '';
    if (model.includes('haiku')) {
        openAIPayload.reasoning_effort = '';
    } else {
        const thinkingConfig = resolveThinkingConfig(anthropicPayload);
        if (thinkingConfig.disabled) {
            openAIPayload.reasoning_effort = '';
        } else if (thinkingConfig.effort) {
            openAIPayload.reasoning_effort = thinkingConfig.effort;
        }
        // 否则不设置，让 normalizePayload 默认注入 'high'
    }

    return openAIPayload;
}

/**
 * 从 Anthropic 请求中解析 thinking 配置
 * 返回 { disabled: boolean, effort: string|null }
 */
function resolveThinkingConfig(anthropicPayload) {
    const thinking = anthropicPayload.thinking;

    if (thinking?.type === 'disabled') {
        return {disabled: true, effort: null};
    }

    let effort = null;

    const outputEffort = anthropicPayload.output_config?.effort;
    if (outputEffort && typeof outputEffort === 'string') {
        const effortMap = {low: 'low', medium: 'medium', high: 'high', max: 'high'};
        const mapped = effortMap[outputEffort.toLowerCase()];
        if (mapped) effort = mapped;
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

/**
 * 转换模型名称
 */
function translateModelName(model) {
    const alias = normalizeClaudeModelAlias(model);
    if (typeof alias !== 'string') return alias;
    if (alias.startsWith('claude-sonnet-4-')) {
        return alias.replace(/^claude-sonnet-4-.*/, 'claude-sonnet-4');
    }
    if (alias.startsWith('claude-opus-4-')) {
        return alias.replace(/^claude-opus-4-.*/, 'claude-opus-4');
    }
    return alias;
}

/**
 * 转换消息列表
 */
function translateMessages(anthropicMessages, system, modelId) {
    const messages = [];

    // 处理 system message（不注入行为规则，最后统一注入）
    if (system) {
        if (typeof system === 'string') {
            messages.push({ role: 'system', content: system });
        } else if (Array.isArray(system)) {
            // 将带 cache_control 的静态块放在前面，不带 cache_control 的动态块放在末尾
            // 使 OpenAI 兼容 API 能缓存更长的静态前缀（需 ≥1024 tokens）
            const cacheableBlocks = system.filter(b => b.type === 'text' && b.text && b.cache_control);
            const dynamicBlocks = system.filter(b => b.type === 'text' && b.text && !b.cache_control);
            const staticText = cacheableBlocks.map(b => b.text).join('\n\n');
            const dynamicText = dynamicBlocks.map(b => b.text).join('\n\n');
            const parts = [staticText, dynamicText].filter(Boolean);
            if (parts.length > 0) {
                messages.push({ role: 'system', content: parts.join('\n\n') });
            }
        }
    }

    // 处理其他消息
    if (!Array.isArray(anthropicMessages)) {
        return injectBehaviorRules(messages, modelId);
    }

    for (const message of anthropicMessages) {
        if (message.role === 'user') {
            messages.push(...handleUserMessage(message));
        } else {
            messages.push(...handleAssistantMessage(message));
        }
    }

    return injectBehaviorRules(messages, modelId);
}

/**
 * 处理用户消息
 */
function handleUserMessage(message) {
    const messages = [];

    if (typeof message.content === 'string') {
        messages.push({ role: 'user', content: prependThinkingHint(message.content) });
    } else if (Array.isArray(message.content)) {
        // 分离 tool_result 和其他内容
        const toolResults = message.content.filter(block => block.type === 'tool_result');
        const otherBlocks = message.content.filter(block => block.type !== 'tool_result');

        // tool_result 必须先处理，注入中文思考引导
        for (const block of toolResults) {
            let content = '';
            if (typeof block.content === 'string') {
                content = block.content;
            } else if (block.content != null) {
                content = JSON.stringify(block.content);
            }
            messages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: prependToolThinkingHint(content)
            });
        }

        // 处理其他内容，注入思考引导
        if (otherBlocks.length > 0) {
            messages.push({
                role: 'user',
                content: prependThinkingHint(mapContent(otherBlocks))
            });
        }
    }

    return messages;
}

/**
 * 处理助手消息
 */
function handleAssistantMessage(message) {
    if (typeof message.content === 'string') {
        return [{ role: 'assistant', content: message.content }];
    }

    if (!Array.isArray(message.content)) {
        return [{ role: 'assistant', content: null }];
    }

    // 提取不同类型的块
    const toolUseBlocks = message.content.filter(block => block.type === 'tool_use');
    const textBlocks = message.content.filter(block => block.type === 'text');
    const thinkingBlocks = message.content.filter(block => block.type === 'thinking');

    // 合并文本和思考内容
    const allText = textBlocks
        .map(b => b.text)
        .filter(Boolean)
        .join('\n\n');

    const result = {
        role: 'assistant',
        content: allText || (toolUseBlocks.length > 0 ? '' : null)
    };

    // 添加 tool_calls
    const reasoningText = thinkingBlocks
        .map(b => b.thinking)
        .filter(Boolean)
        .join('\n\n');
    if (reasoningText) {
        result.reasoning_content = reasoningText;
    }

    if (toolUseBlocks.length > 0) {
        result.tool_calls = toolUseBlocks.map(block => ({
            id: block.id,
            type: 'function',
            function: {
                name: block.name,
                arguments: JSON.stringify(block.input)
            }
        }));
    }

    return [result];
}

export function anthropicToResponses(anthropicPayload) {
    return anthropicRequestToResponses(anthropicPayload, {
        modelMapper: translateModelName
    });
}

export function responsesOutputToAnthropic(responsesRes) {
    return responsesResponseToAnthropic(responsesRes);
}

export {sharedOpenAIToAnthropic as openAIToAnthropic};
