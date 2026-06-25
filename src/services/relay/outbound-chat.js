import {injectBehaviorRules as defaultInjectBehaviorRules} from './anthropic-adapter.js';
import {
    mergeConsecutiveAssistantMessages as defaultMergeConsecutiveAssistantMessages,
    stripDynamicReminders as defaultStripDynamicReminders
} from './protocol-adapter.js';

export function cloneRelayJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function prepareRelayOutboundChatRequest(chatRequest, {
    model,
    stream,
    injectBehaviorRules = defaultInjectBehaviorRules,
    stripDynamicReminders = defaultStripDynamicReminders,
    mergeConsecutiveAssistantMessages = defaultMergeConsecutiveAssistantMessages
} = {}) {
    const outbound = cloneRelayJson(chatRequest || {});
    outbound.model = model || outbound.model;
    if (stream !== undefined) outbound.stream = stream;
    outbound.messages = injectBehaviorRules(outbound.messages || [], outbound.model);
    outbound.messages = stripDynamicReminders(outbound.messages);
    mergeConsecutiveAssistantMessages(outbound.messages);
    return outbound;
}
