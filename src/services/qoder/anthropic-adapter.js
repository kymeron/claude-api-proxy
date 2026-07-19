/**
 * Qoder Anthropic adapter
 *
 * 与 codebuddy 同名文件形态对齐：thin wrapper around protocol-engine 的
 * `anthropicRequestToChat` / `openAIToAnthropic`，加上 `injectBehaviorRules` 透传。
 *
 * @module services/qoder/anthropic-adapter
 */

import logger from '../../utils/logger.js';
import {injectBehaviorRules} from '../shared/behavior-rules.js';
import {
    anthropicRequestToChat,
    openAIToAnthropic as sharedOpenAIToAnthropic
} from './protocol-adapter.js';

export function anthropicToOpenAI(anthropicPayload) {
    return anthropicRequestToChat(anthropicPayload, {
        cleanToolSchema: true,
        logger
    });
}

export function openAIToAnthropic(openAIResponse) {
    return sharedOpenAIToAnthropic(openAIResponse, {logger});
}

export {injectBehaviorRules};