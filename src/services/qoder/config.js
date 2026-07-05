/**
 * Qoder 渠道配置
 *
 * 对齐 Codebuddy 配置模式，支持区域切换（CN / INTL）、
 * 自定义站点标签、模型覆盖、请求头构建等功能。
 *
 * @module services/qoder/config
 */

import logger from '../../utils/logger.js';

const DEFAULT_CUSTOM_SITE_LABEL = '自定义站';

// ─── 区域与后端 ───────────────────────────────────────────────

/**
 * 获取当前激活的区域
 * 优先读取 QODER_REGION，向后兼容 QODER_CLI_BACKEND
 * @returns {'cn' | 'intl'}
 */
export function getQoderBackend() {
    const value = (process.env.QODER_REGION || process.env.QODER_CLI_BACKEND || 'cn').toLowerCase();
    // 向后兼容：旧值 'global' 映射为 'intl'
    if (value === 'global' || value === 'intl') return 'intl';
    return 'cn';
}

// ─── 基础 URL ────────────────────────────────────────────────

/**
 * 获取 Qoder 基础 URL
 * 优先级：baseUrl 参数 > QODER_DEFAULT_BASE_URL 环境变量 > 区域默认值
 * @param {string} [baseUrl] - 可选，优先使用传入值
 * @returns {string}
 */
export function getQoderBaseUrl(baseUrl) {
    if (baseUrl) return baseUrl;
    return (
        process.env.QODER_DEFAULT_BASE_URL ||
        (getQoderBackend() === 'intl' ? 'https://qoder.com' : 'https://qoder.com.cn')
    );
}

/**
 * 解析额外的基础 URL 列表
 * QODER_EXTRA_BASE_URLS 以逗号分隔
 * @returns {string[]}
 */
export function getExtraBaseUrls() {
    return process.env.QODER_EXTRA_BASE_URLS
        ? process.env.QODER_EXTRA_BASE_URLS.split(',')
              .map((u) => u.trim())
              .filter(Boolean)
        : [];
}

// ─── 禁止域名 ────────────────────────────────────────────────

/**
 * 禁止使用的上游域名（默认为空，可通过环境变量配置）
 */
export const BLOCKED_DOMAINS = [];

// ─── 模型清单 ────────────────────────────────────────────────

/**
 * CN 区域可用模型
 */
export const CN_MODELS = [
    {id: 'auto', name: 'Auto', tools: true, vision: false},
    {id: 'qwen3.7-max', name: 'Qwen3.7-Max', tools: true, vision: false},
    {id: 'glm-5.1', name: 'GLM-5.1', tools: true, vision: false},
    {id: 'kimi-k2.6', name: 'Kimi-K2.6', tools: true, vision: false},
    {id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', tools: true, vision: false},
    {id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', tools: false, vision: false},
    {id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', tools: true, vision: false},
    {id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', tools: false, vision: false},
    {id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max (Low)', tools: true, vision: false},
    {id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max (Medium)', tools: true, vision: false},
    {id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max (High)', tools: true, vision: false},
    {id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max (Max)', tools: true, vision: false}
];

/**
 * INTL 区域可用模型
 */
export const INTL_MODELS = [
    {id: 'auto', name: 'Auto', tools: true, vision: false},
    {id: 'glm-5.1', name: 'GLM-5.1', tools: true, vision: false},
    {id: 'kimi-k2.6', name: 'Kimi-K2.6', tools: true, vision: false},
    {id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', tools: true, vision: false},
    {id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', tools: false, vision: false}
];

/**
 * 向后兼容：QODER_MODELS 等价于当前区域的模型列表
 */
export const QODER_MODELS = CN_MODELS;

// ─── 模型辅助函数 ────────────────────────────────────────────

function normalizeOverrideHost(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
        return new URL(input).host;
    } catch {
        return input;
    }
}

function modelCapability(model, keys, fallback) {
    for (const key of keys) {
        if (model[key] !== undefined) return Boolean(model[key]);
    }
    return fallback;
}

/**
 * 获取当前区域的默认模型列表
 * @returns {Array<{id: string, name: string, tools: boolean, vision: boolean}>}
 */
function getRegionModels() {
    return getQoderBackend() === 'intl' ? INTL_MODELS : CN_MODELS;
}

/**
 * 用户可通过 QODER_MODELS 覆盖默认模型清单（JSON 数组）
 * 覆盖格式：'[{"id":"custom","name":"Custom","tools":true}]'
 * 未设置时按区域选择默认列表
 */
export function getQoderModels() {
    const raw = process.env.QODER_MODELS;
    if (!raw) return getRegionModels();
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return getRegionModels();
        return parsed
            .map((model) => ({
                id: String(model.id || '').trim(),
                name: String(model.name || model.id || '').trim(),
                tools: model.tools !== false,
                vision: modelCapability(model, ['vision', 'supportsVision', 'supports_vision'], false)
            }))
            .filter((model) => model.id);
    } catch (error) {
        logger.warn(`Invalid QODER_MODELS JSON: ${error.message}`);
        return getRegionModels();
    }
}

/**
 * 解析 QODER_MODEL_OVERRIDES（JSON: host → model array）
 * @returns {Object<string, Array<{id: string, name: string, tools: boolean, vision: boolean}>>}
 */
export function getHostModelOverrides() {
    const raw = process.env.QODER_MODEL_OVERRIDES;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed || {}).map(([host, models]) => {
            const normalizedHost = normalizeOverrideHost(host);
            const normalizedModels = Array.isArray(models)
                ? models
                    .map(model => ({
                        id: String(model.id || '').trim(),
                        name: String(model.name || model.id || '').trim(),
                        tools: modelCapability(model, ['tools', 'tool', 'supportsTools', 'supports_tool'], true),
                        vision: modelCapability(model, ['vision', 'supportsVision', 'supports_vision'], false)
                    }))
                    .filter(model => model.id)
                : [];
            return [normalizedHost, normalizedModels];
        }).filter(([host, models]) => host && models.length);
        return Object.fromEntries(entries);
    } catch (error) {
        logger.warn(`Invalid QODER_MODEL_OVERRIDES JSON: ${error.message}`);
        return {};
    }
}

/**
 * 根据上游域名获取可用模型列表
 * 优先级：特定站点覆盖 > 区域默认模型
 * @param {string} [baseUrl] - 上游基础 URL
 * @returns {Array<{id: string, name: string, tools: boolean, vision: boolean}>}
 */
export function getModelsForHost(baseUrl) {
    const resolved = getQoderBaseUrl(baseUrl);
    const host = new URL(resolved).host;

    const hostModelOverrides = getHostModelOverrides();
    if (hostModelOverrides[host]) {
        return hostModelOverrides[host];
    }

    return getRegionModels();
}

// ─── 个人版判断 ──────────────────────────────────────────────

// 个人版官方域名
const PERSONAL_HOSTS = ['qoder.com.cn', 'qoder.com'];

/**
 * 判断上游域名是否为个人版
 * @param {string} host - 域名（不含端口和协议）
 * @returns {boolean} true = 个人版
 */
export function isPersonalHost(host) {
    return PERSONAL_HOSTS.includes(host);
}

// ─── 自定义站点标签 ──────────────────────────────────────────

/**
 * 解析 QODER_CUSTOM_SITE_LABELS（JSON: host → label）
 * @returns {Object<string, string>}
 */
export function getCustomSiteLabels() {
    const raw = process.env.QODER_CUSTOM_SITE_LABELS;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return Object.fromEntries(Object.entries(parsed || {})
            .map(([host, label]) => [normalizeOverrideHost(host), String(label || '').trim()])
            .filter(([host, label]) => host && label));
    } catch (error) {
        logger.warn(`Invalid QODER_CUSTOM_SITE_LABELS JSON: ${error.message}`);
        return {};
    }
}

/**
 * 获取指定 URL 的自定义站点标签
 * @param {string} [url] - 站点 URL
 * @returns {string}
 */
export function getCustomSiteLabel(url) {
    const labels = getCustomSiteLabels();
    const host = normalizeOverrideHost(url || getQoderBaseUrl());
    return labels[host] || DEFAULT_CUSTOM_SITE_LABEL;
}

// ─── CLI 配置 ────────────────────────────────────────────────

/**
 * 获取 CLI 二进制名称
 * CN → qoderclicn，INTL → qodercli
 * @param {string} [backend] - 区域，默认使用当前区域
 * @returns {string}
 */
export function getQoderCliBinary(backend = getQoderBackend()) {
    return backend === 'intl' ? 'qodercli' : 'qoderclicn';
}

/**
 * CLI 可执行文件路径
 * - 优先读取 QODER_CLI_PATH
 * - 否则使用 PATH 中的 qoderclicn / qodercli
 * @param {string} [backend] - 区域，默认使用当前区域
 * @returns {string}
 */
export function getQoderCliPath(backend = getQoderBackend()) {
    if (process.env.QODER_CLI_PATH) return process.env.QODER_CLI_PATH;
    return getQoderCliBinary(backend);
}

// ─── 默认模型与用户 ──────────────────────────────────────────

/**
 * 默认模型：未指定或未知模型时使用 'auto'（CLI 自行分配下游模型）
 */
export function getQoderDefaultModel() {
    return process.env.QODER_DEFAULT_MODEL || 'auto';
}

/**
 * 获取默认用户 ID
 * 读取 QODER_DEFAULT_USER_ID 环境变量，默认 'unknown'
 * @returns {string}
 */
export function getQoderDefaultUserId() {
    return process.env.QODER_DEFAULT_USER_ID || 'unknown';
}

// ─── 行为开关 ────────────────────────────────────────────────

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

// ─── 请求头构建 ──────────────────────────────────────────────

/**
 * 生成 Qoder 请求头
 * 根据上游域名自动区分个人版/企业版：
 * - 个人版（qoder.com.cn / qoder.com）：只传基础头，X-Product = "SaaS"
 * - 企业版（其他域名）：额外传 X-Enterprise-Id / X-Tenant-Id / X-Department-Info
 *
 * @param {string} token - Bearer token
 * @param {Object} [opts] - 可选参数
 * @param {string} [opts.baseUrl] - 上游基础 URL
 * @param {string} [opts.userId] - 用户 ID
 * @param {string} [opts.enterpriseId] - 企业 ID（企业版需要）
 * @param {string} [opts.departmentInfo] - 部门全称（企业版需要）
 * @param {string} [opts.domain] - 认证域（企业版需要）
 * @param {string} [opts.conversationId] - 会话 ID
 * @param {string} [opts.conversationRequestId] - 会话请求 ID
 * @param {string} [opts.conversationMessageId] - 会话消息 ID
 * @param {string} [opts.requestId] - 请求 ID
 * @returns {Object} 请求头
 */
export function qoderHeaders(token, opts = {}) {
    const {
        conversationId,
        conversationRequestId,
        conversationMessageId,
        requestId,
        userId = getQoderDefaultUserId(),
        enterpriseId,
        departmentInfo,
        domain,
        baseUrl
    } = opts;

    const resolvedBaseUrl = getQoderBaseUrl(baseUrl);
    const host = new URL(resolvedBaseUrl).host;
    const personal = isPersonalHost(host);

    const headers = {
        Host: host,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Authorization: `Bearer ${token}`,
        'X-Domain': domain || host,
        'X-Product': 'SaaS',
        'X-User-Id': userId,
        'X-Region': getQoderBackend(),
        'X-Session-ID': userId || 'unknown'
    };

    // 企业版额外头部
    if (!personal) {
        if (enterpriseId) {
            headers['X-Enterprise-Id'] = enterpriseId;
            headers['X-Tenant-Id'] = enterpriseId;
        }
        if (departmentInfo) {
            headers['X-Department-Info'] = departmentInfo;
        }
    }

    if (conversationId) {
        headers['X-Conversation-ID'] = conversationId;
    }
    if (conversationRequestId) {
        headers['X-Conversation-Request-ID'] = conversationRequestId;
    }
    if (conversationMessageId) {
        headers['X-Conversation-Message-ID'] = conversationMessageId;
    }
    if (requestId) {
        headers['X-Request-ID'] = requestId;
    }

    return headers;
}
