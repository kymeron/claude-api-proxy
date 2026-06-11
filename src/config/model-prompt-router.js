/**
 * 模型ID → 厂商提示词路由
 * 根据真实模型ID（resolveModel/mapModelName 后的值）匹配对应厂商的提示词配置
 * 使用正则前缀匹配，不硬编码版本号，新增模型版本时无需改代码
 * @module config/model-prompt-router
 */

import {getBehaviorRules as getDeepSeekRules} from './deepseek.js';
import {getBehaviorRules as getGLMRules} from './glm.js';
import {getBehaviorRules as getKimiRules} from './kimi.js';
import {getBehaviorRules as getMiniMaxRules} from './minimax.js';
import {getBehaviorRules as getDefaultRules} from './system-prompts.js';

/**
 * 模型ID正则 → 厂商提示词获取函数
 * 顺序决定匹配优先级，首个匹配生效
 */
const MODEL_RULES_MAP = [
    {pattern: /^deepseek-/i,  getRules: getDeepSeekRules},
    {pattern: /^glm-/i,       getRules: getGLMRules},
    {pattern: /^kimi-/i,      getRules: getKimiRules},
    {pattern: /^minimax-/i,   getRules: getMiniMaxRules},
];

/**
 * 根据真实模型ID返回对应的行为规则文本
 * 匹配规则：模型ID正则匹配，未匹配则返回通用规则（向后兼容）
 *
 * @param {string} modelId - 真实模型ID（resolveModel/mapModelName 后的值）
 * @returns {string} 行为规则文本
 */
export function getBehaviorRulesForModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return getDefaultRules();
    for (const {pattern, getRules} of MODEL_RULES_MAP) {
        if (pattern.test(modelId)) return getRules();
    }
    return getDefaultRules();
}

