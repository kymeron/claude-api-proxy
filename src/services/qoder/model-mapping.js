/**
 * Qoder 模型名映射
 *
 * Qoder CLI 接收的模型名是固定的（见 config.js 中的 QODER_MODELS）。
 * 客户端发来的模型名如果不在白名单内，会通过本映射重定向：
 * - 与白名单精确匹配 → 原样转发
 * - 匹配别名（如 gpt-* / claude-*） → 映射到 default fallback
 * - 完全未知 → 返回 null（由调用方决定是否回退到 'auto'）
 *
 * 设计原则：CLI 不支持的模型直接交给 auto 决策，避免请求直接失败。
 *
 * @module services/qoder/model-mapping
 */

/**
 * 模型别名表：把客户端常见的别名映射到 Qoder CLI 支持的模型
 */
const ALIAS_MAP = {
    // OpenAI 系列别名（多数客户端默认模型）
    'gpt-4': 'auto',
    'gpt-4o': 'auto',
    'gpt-4o-mini': 'qwen3.6-flash',
    'gpt-4-turbo': 'auto',
    'gpt-3.5-turbo': 'qwen3.6-flash',
    'o1': 'auto',
    'o1-mini': 'qwen3.6-flash',
    'o3-mini': 'qwen3.6-flash',

    // Anthropic 系列别名
    'claude-3-5-sonnet': 'auto',
    'claude-3-5-haiku': 'qwen3.6-flash',
    'claude-3-opus': 'auto',
    'claude-sonnet-4': 'auto',
    'claude-haiku-4': 'qwen3.6-flash'
};

/**
 * 把客户端模型名映射为 Qoder CLI 模型名
 *
 * @param {string} model - 客户端请求的模型名
 * @param {string} [fallback='auto'] - 未知模型回退目标
 * @returns {string|null} 返回 null 表示客户端传了无效模型
 */
export function mapQoderModelName(model, fallback = 'auto') {
    if (!model || typeof model !== 'string') return fallback;
    const trimmed = model.trim();
    if (!trimmed) return fallback;

    const lower = trimmed.toLowerCase();

    // 1. 别名表精确命中
    if (ALIAS_MAP[lower]) return ALIAS_MAP[lower];

    // 2. 通配符匹配（gpt-*, claude-* 等）
    if (lower.startsWith('gpt-') || lower.includes('mini')) {
        return 'deepseek-v4-flash';
    }
    if (lower.startsWith('claude-')) {
        return 'auto';
    }

    // 3. 原样返回（调用方会与白名单对比做最终校验）
    return trimmed;
}

/**
 * 判断模型是否需要工具调用降级（非原生 tools）
 * 用于 handlers 在收到 tools 参数时选择 prompt 注入路径
 *
 * @param {string} model
 * @param {Array<{id: string, tools: boolean}>} modelList
 * @returns {boolean}
 */
export function isQoderModelToolsDisabled(model, modelList) {
    if (!model || !Array.isArray(modelList)) return false;
    const found = modelList.find((item) => item.id === model);
    return found ? found.tools === false : false;
}