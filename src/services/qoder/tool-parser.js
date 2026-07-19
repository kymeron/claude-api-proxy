/**
 * Qoder 工具调用解析
 *
 * CLI 不支持原生 tool_calls，通过 prompt 注入要求它输出如下格式：
 *
 *   ```json
 *   {"tool_calls":[{"id":"call_001","name":"get_weather","arguments":{"city":"Beijing"}}]}
 *   ```
 *
 * 解析策略：
 *   1. 优先匹配 markdown JSON 代码块 ```json ... ```
 *   2. 退化为花括号平衡扫描：找所有顶层 {...} 块，尝试 JSON.parse
 *   3. 对每个解析成功的对象，提取 tool_calls 字段
 *
 * @module services/qoder/tool-parser
 */

import {
    getQoderJsonDepthLimit
} from './config.js';

const JSON_BLOCK_REGEX = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;

/**
 * 把 CLI 输出中的工具调用解析为标准结构
 *
 * @returns {Array<{id: string, name: string, arguments: Object, raw: Object}>}
 */
export function parseToolCallOutput(output) {
    if (!output || typeof output !== 'string') return [];

    const candidates = collectJsonCandidates(output);
    const toolCalls = [];

    for (const jsonText of candidates) {
        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            continue;
        }

        if (!parsed || typeof parsed !== 'object') continue;

        // 1. 顶层 tool_calls
        if (Array.isArray(parsed.tool_calls)) {
            for (const tc of parsed.tool_calls) {
                const normalized = normalizeToolCall(tc);
                if (normalized) toolCalls.push(normalized);
            }
            continue;
        }

        // 2. 顶层是数组 [{...}, {...}]
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (item && Array.isArray(item.tool_calls)) {
                    for (const tc of item.tool_calls) {
                        const normalized = normalizeToolCall(tc);
                        if (normalized) toolCalls.push(normalized);
                    }
                }
            }
            continue;
        }

        // 3. 单个 tool_call 对象
        const single = normalizeToolCall(parsed);
        if (single) toolCalls.push(single);
    }

    return toolCalls;
}

function normalizeToolCall(tc) {
    if (!tc || typeof tc !== 'object') return null;

    const name = tc.name || tc.function?.name;
    if (!name || typeof name !== 'string') return null;

    let args = tc.arguments ?? tc.input ?? tc.function?.arguments ?? {};
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            args = {};
        }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        args = {};
    }

    return {
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: String(name),
        arguments: args,
        raw: tc
    };
}

/**
 * 收集文本中所有可能的 JSON 候选
 *
 * 步骤：
 *   1. 提取 ```json ... ``` 代码块
 *   2. 用花括号平衡算法扫描剩余文本中的 {...} 块
 */
function collectJsonCandidates(text) {
    const candidates = [];
    const seen = new Set();

    // 1. markdown 代码块
    let match;
    JSON_BLOCK_REGEX.lastIndex = 0;
    while ((match = JSON_BLOCK_REGEX.exec(text)) !== null) {
        const block = match[1];
        if (!seen.has(block)) {
            seen.add(block);
            candidates.push(block);
        }
    }

    // 2. 花括号平衡扫描（覆盖纯文本中嵌入的 JSON）
    const depthLimit = getQoderJsonDepthLimit();
    const balanced = extractBalancedJsonWithToolCalls(text, depthLimit);
    for (const block of balanced) {
        if (!seen.has(block)) {
            seen.add(block);
            candidates.push(block);
        }
    }

    return candidates;
}

/**
 * 花括号平衡算法：扫描文本中所有顶层 {...} 块
 *
 * 简单实现：从每个 `{` 开始配对，遇到字符串字面量时跳过内部 `{`/`}`。
 *
 * @param {string} text
 * @param {number} depthLimit - 最大嵌套深度（防止恶意输入）
 * @returns {string[]}
 */
export function extractBalancedJsonWithToolCalls(text, depthLimit = 32) {
    if (!text || typeof text !== 'string') return [];

    const results = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];

        if (ch === '{') {
            // 找到匹配的右括号
            const start = i;
            let depth = 1;
            let j = i + 1;
            let inString = false;
            let escape = false;

            while (j < len && depth > 0) {
                const c = text[j];

                if (inString) {
                    if (escape) {
                        escape = false;
                    } else if (c === '\\') {
                        escape = true;
                    } else if (c === '"') {
                        inString = false;
                    }
                } else {
                    if (c === '"') {
                        inString = true;
                    } else if (c === '{') {
                        depth++;
                        if (depth > depthLimit) break;
                    } else if (c === '}') {
                        depth--;
                    }
                }
                j++;
            }

            if (depth === 0) {
                const block = text.slice(start, j);
                results.push(block);
                i = j;
            } else {
                // 未匹配完成，跳过这个 `{`
                i++;
            }
        } else if (ch === '"') {
            // 跳过字符串字面量
            let j = i + 1;
            let escape = false;
            while (j < len) {
                const c = text[j];
                if (escape) {
                    escape = false;
                } else if (c === '\\') {
                    escape = true;
                } else if (c === '"') {
                    break;
                }
                j++;
            }
            i = j + 1;
        } else {
            i++;
        }
    }

    return results;
}