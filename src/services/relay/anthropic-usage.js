import {
    extractCacheHitTokens as defaultExtractCacheHitTokens,
    extractInputTokens as defaultExtractInputTokens
} from './protocol-adapter.js';
import {estimateMessageTokens as defaultEstimateMessageTokens} from '../../utils/token-estimation.js';

export function handleRelayAnthropicUsageEvent(eventName, payload, usageState, {
    extractInputTokens = defaultExtractInputTokens,
    extractCacheHitTokens = defaultExtractCacheHitTokens
} = {}) {
    const usage = payload?.usage || payload?.message?.usage;
    if (!usage) return;

    if (usage.input_tokens !== undefined) {
        usageState.inputTokens = extractInputTokens(usage);
    }
    if (usage.output_tokens !== undefined) usageState.outputTokens = usage.output_tokens;
    usageState.cacheHitTokens = Math.max(usageState.cacheHitTokens, extractCacheHitTokens(usage));
    if (eventName === 'message_start' && payload?.message?.model) usageState.model = payload.message.model;
}

export function estimateRelayAnthropicInputTokens(payload, {
    estimateMessageTokens = defaultEstimateMessageTokens
} = {}) {
    const messages = [];
    if (typeof payload.system === 'string') {
        messages.push({role: 'system', content: payload.system});
    } else if (Array.isArray(payload.system)) {
        messages.push({role: 'system', content: payload.system});
    }
    messages.push(...(payload.messages || []));
    const messageTokens = estimateMessageTokens(messages);
    const toolTokens = Array.isArray(payload.tools)
        ? estimateMessageTokens(payload.tools.map((tool) => ({role: 'tool', content: JSON.stringify(tool)})))
        : 0;
    return messageTokens + toolTokens;
}
