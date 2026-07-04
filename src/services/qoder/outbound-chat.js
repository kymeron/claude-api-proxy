/**
 * Qoder 出站请求预处理
 *
 * 在调用 qoder-cli.js 之前对 OpenAI/Anthropic 风格 payload 做归一化：
 *   - 合并连续的同 role 消息（CLI 不喜欢连续 user/assistant 断裂）
 *   - 去掉 dynamic_reminders 等噪声
 *   - 限制消息数 / 单条长度，防止 prompt 爆炸
 *
 * 与 codebuddy 同名文件形态对齐，但少了"注入行为规则"步骤
 * （行为规则由 prompt-builder.js 在 system prompt 内统一处理）。
 *
 * @module services/qoder/outbound-chat
 */

import {
    mergeConsecutiveAssistantMessages,
    stripDynamicReminders
} from './protocol-adapter.js';
import {injectBehaviorRules} from '../shared/behavior-rules.js';

const MAX_MESSAGES = 200;
const MAX_CONTENT_LENGTH = 200_000; // 单条消息最大字符数

/**
 * 截断超长内容（保留头尾，避免丢失上下文）
 */
function truncateContent(content, maxLen) {
    if (typeof content !== 'string') return content;
    if (content.length <= maxLen) return content;
    const head = content.slice(0, Math.floor(maxLen / 2));
    const tail = content.slice(-Math.floor(maxLen / 2));
    return `${head}\n\n[...truncated ${content.length - maxLen} chars...]\n\n${tail}`;
}

/**
 * 截断过长的 messages 数组
 */
function trimMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const trimmed = messages.slice(-MAX_MESSAGES);
    return trimmed.map((m) => {
        if (!m || typeof m !== 'object') return m;
        if (typeof m.content === 'string' && m.content.length > MAX_CONTENT_LENGTH) {
            return {...m, content: truncateContent(m.content, MAX_CONTENT_LENGTH)};
        }
        return m;
    });
}

/**
 * 准备发送给 Qoder CLI 的 chat 请求
 *
 * @param {Object} chatRequest - OpenAI 风格 payload（已 mapModelName）
 * @param {Object} [options]
 * @param {string} [options.model] - 覆盖 model 字段
 * @param {boolean}[options.stream] - 覆盖 stream 字段
 * @returns {Object} 处理后的 payload（原地修改并返回）
 */
export function prepareQoderOutboundChatRequest(chatRequest, {model, stream} = {}) {
    if (!chatRequest || typeof chatRequest !== 'object') return chatRequest;

    if (model) chatRequest.model = model;
    if (stream !== undefined) chatRequest.stream = stream;

    chatRequest.messages = trimMessages(chatRequest.messages || []);

    chatRequest.messages = stripDynamicReminders(chatRequest.messages);
    mergeConsecutiveAssistantMessages(chatRequest.messages);

    // 行为规则注入（与 codebuddy 一致；空规则时 inject 内部直接透传）
    chatRequest.messages = injectBehaviorRules(chatRequest.messages, chatRequest.model);

    return chatRequest;
}