/**
 * Qoder 渠道配置
 *
 * Qoder 与 Codebuddy 的核心差异：
 * - Codebuddy 走 HTTP API 直连腾讯上游
 * - Qoder 通过本地 CLI 子进程（qodercli / qoderclicn）执行
 *
 * 因此本文件不维护 baseUrl / 上游域名 / 请求头等 HTTP 配置，
 * 只关注 CLI 子进程所需的：后端类型、CLI 路径、模型清单、行为开关。
 *
 * @module services/qoder/config
 */

import logger from '../../utils/logger.js';

/**
 * Qoder 默认模型清单（参考 qoder-proxy）
 *
 * - "auto" 由 CLI 自行决定下游模型
 * - "*-effort-*" 是推理强度别名，目前 CLI 仅支持 qwen3.7-max 系列
 * - tools 字段表示是否支持原生工具调用；false 的模型只能走 prompt 注入方案
 */
export const QODER_MODELS = [
    {id: 'auto', name: 'Auto', tools: true},
    {id: 'qwen3.7-max', name: 'Qwen3.7-Max', tools: true},
    {id: 'glm-5.1', name: 'GLM-5.1', tools: true},
    {id: 'kimi-k2.6', name: 'Kimi-K2.6', tools: true},
    {id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', tools: true},
    {id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', tools: false},
    {id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', tools: true},
    {id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', tools: false},
    {id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max (Low)', tools: true},
    {id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max (Medium)', tools: true},
    {id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max (High)', tools: true},
    {id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max (Max)', tools: true}
];

/**
 * 用户可通过 QODER_MODELS 覆盖默认模型清单（JSON 数组）
 * 覆盖格式：'[{"id":"custom","name":"Custom","tools":true}]'
 */
export function getQoderModels() {
    const raw = process.env.QODER_MODELS;
    if (!raw) return QODER_MODELS;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return QODER_MODELS;
        return parsed
            .map((model) => ({
                id: String(model.id || '').trim(),
                name: String(model.name || model.id || '').trim(),
                tools: model.tools !== false
            }))
            .filter((model) => model.id);
    } catch (error) {
        logger.warn(`Invalid QODER_MODELS JSON: ${error.message}`);
        return QODER_MODELS;
    }
}

/**
 * 获取当前激活的后端类型
 * @returns {'cn' | 'global'}
 */
export function getQoderBackend() {
    const value = (process.env.QODER_CLI_BACKEND || 'cn').toLowerCase();
    return value === 'global' ? 'global' : 'cn';
}

/**
 * 后端切换映射
 *
 * 现实情况：npm 包 @qoder-ai/qodercli 只提供 `qodercli` 单一二进制，
 * 没有独立的 `qoderclicn`。后端通过环境变量 QODER_PERSONAL_ACCESS_TOKEN
 * 关联的账号区域区分（CN vs Global），CLI 二进制不变。
 *
 * 为向后兼容保留 getQoderCliBinary(backend) 接口。
 */
export function getQoderCliBinary(backend = getQoderBackend()) {
    // 历史 API：cn → 'qoderclicn'，但 npm 包无此二进制
    // 当前所有 backend 都返回 'qodercli'
    return 'qodercli';
}

/**
 * CLI 可执行文件路径
 * - 优先读取 QODER_CLI_PATH
 * - 否则使用 PATH 中的 qodercli/qoderclicn
 */
export function getQoderCliPath(backend = getQoderBackend()) {
    if (process.env.QODER_CLI_PATH) return process.env.QODER_CLI_PATH;
    return getQoderCliBinary(backend);
}

/**
 * 默认模型：未指定或未知模型时使用 'auto'（CLI 自行分配下游模型）
 */
export function getQoderDefaultModel() {
    return process.env.QODER_DEFAULT_MODEL || 'auto';
}

/**
 * 是否启用流式响应
 * 默认 true；可通过 QODER_STREAM_ENABLED=false 关闭（CLI 流式解析开销较高）
 */
export function isQoderStreamEnabled() {
    const raw = process.env.QODER_STREAM_ENABLED;
    if (raw === undefined) return true;
    return !['false', '0', 'no', 'off'].includes(raw.toLowerCase());
}

/**
 * 工具调用最大轮次（CLI 不支持原生 tool_calls，需在 prompt 内多轮循环）
 * 默认 10 轮
 */
export function getQoderToolMaxRounds() {
    const raw = parseInt(process.env.QODER_TOOL_MAX_ROUNDS || '10', 10);
    return Number.isInteger(raw) && raw > 0 ? raw : 10;
}

/**
 * 子进程超时（毫秒）
 * CLI 启动 + 推理可能较慢，默认 5 分钟
 */
export function getQoderCliTimeoutMs() {
    const raw = parseInt(process.env.QODER_CLI_TIMEOUT_MS || '300000', 10);
    return Number.isInteger(raw) && raw > 0 ? raw : 300000;
}

/**
 * 工具调用解析后允许的最大 JSON 嵌套深度
 * 默认 32，与 JSON.parse 行为一致
 */
export function getQoderJsonDepthLimit() {
    const raw = parseInt(process.env.QODER_JSON_DEPTH_LIMIT || '32', 10);
    return Number.isInteger(raw) && raw > 0 ? raw : 32;
}

/**
 * 单条响应最大 token 数（-1 表示由 CLI 决定）
 */
export function getQoderMaxTokens() {
    const raw = parseInt(process.env.QODER_MAX_TOKENS || '-1', 10);
    return Number.isInteger(raw) ? raw : -1;
}