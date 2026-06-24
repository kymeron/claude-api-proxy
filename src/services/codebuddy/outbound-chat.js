import {injectBehaviorRules} from './anthropic-adapter.js';
import {
    mergeConsecutiveAssistantMessages,
    stripDynamicReminders
} from './protocol-adapter.js';

export function prepareCodebuddyOutboundChatRequest(chatRequest, {model, stream} = {}) {
    if (model) chatRequest.model = model;
    if (stream !== undefined) chatRequest.stream = stream;
    chatRequest.messages = injectBehaviorRules(chatRequest.messages || [], chatRequest.model);
    chatRequest.messages = stripDynamicReminders(chatRequest.messages);
    mergeConsecutiveAssistantMessages(chatRequest.messages);
    return chatRequest;
}
