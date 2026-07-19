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
 *
 * 目标值必须与 CN_MODELS / INTL_MODELS 中的 id 一致（大小写敏感）。
 */
const ALIAS_MAP = {
    // OpenAI 系列别名（多数客户端默认模型）
    'gpt-4': 'Auto',
    'gpt-4o': 'Auto',
    'gpt-4o-mini': 'Qwen3.6-Flash',
    'gpt-4-turbo': 'Auto',
    'gpt-3.5-turbo': 'Qwen3.6-Flash',
    'o1': 'Auto',
    'o1-mini': 'Qwen3.6-Flash',
    'o3-mini': 'Qwen3.6-Flash',

    // Anthropic 系列别名
    'claude-3-5-sonnet': 'Auto',
    'claude-3-5-haiku': 'Qwen3.6-Flash',
    'claude-3-opus': 'Auto',
    'claude-sonnet-4': 'Auto',
    'claude-haiku-4': 'Qwen3.6-Flash',

    // 兼容旧的小写模型 ID（早期 config.js 使用小写）
    'auto': 'Auto',
    'qwen3.6-flash': 'Qwen3.6-Flash',
    'qwen3.6-plus': 'Qwen3.7-Plus',
    'qwen3.7-max': 'Qwen3.7-Max',
    'deepseek-v4-flash': 'DeepSeek-V4-Flash',
    'deepseek-v4-pro': 'DeepSeek-V4-Pro',
    'glm-5.1': 'GLM-5.2',
    'kimi-k2.6': 'Kimi-K2.7-Code',
    // MiniMax 系列前缀归一化
    'minimax-m3': 'Auto',
    'minimax-m2.7': 'MiniMax-M2.7',
    'minimax-m2': 'Auto'
};

/**
 * 把客户端模型名映射为 Qoder CLI 模型名
 *
 * @param {string} model - 客户端请求的模型名
 * @param {string} [fallback='Auto'] - 未知模型回退目标
 * @returns {string|null} 返回 null 表示客户端传了无效模型
 */
export function mapQoderModelName(model, fallback = 'Auto') {
    if (!model || typeof model !== 'string') return fallback;
    const trimmed = model.trim();
    if (!trimmed) return fallback;

    const lower = trimmed.toLowerCase();

    // 1. 别名表精确命中
    if (ALIAS_MAP[lower]) return ALIAS_MAP[lower];

    // 2. 通配符匹配（gpt-*, claude-* 等）
    if (lower.startsWith('gpt-') || lower.includes('mini')) {
        return 'DeepSeek-V4-Flash';
    }
    if (lower.startsWith('claude-')) {
        return 'Auto';
    }
    if (lower.startsWith('minimax-')) {
        // 未知的 MiniMax 型号降级到 Auto，避免 CLI 报 Invalid model
        return 'Auto';
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