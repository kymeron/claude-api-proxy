/**
 * Qoder Prompt 构建器
 *
 * Qoder CLI 不理解 OpenAI / Anthropic 的 messages 格式，需要把消息数组
 * 序列化成单条文本指令。同时把工具定义注入到 system prompt 中，让 CLI
 * 按照约定格式输出 tool_call JSON（由 tool-parser.js 解析）。
 *
 * 三路径策略：
 *   1. 客户端已传 system prompt → 直接使用，不注入额外指令
 *   2. 无 system prompt 且无 tools → 添加最简引导（"请直接回答..."）
 *   3. 有 tools → 在 system prompt 注入工具格式指令
 *
 * @module services/qoder/prompt-builder
 */

/**
 * 工具调用指令模板（注入到 system prompt）
 *
 * 要求 CLI 输出形如：
 *   ```json
 *   {"tool_calls": [{"id": "...", "name": "...", "arguments": {...}}]}
 *   ```
 *
 * 解析在 tool-parser.js 完成。
 */
const TOOL_INSTRUCTION_TEMPLATE = `When you need to call a tool, output ONLY the following JSON block and nothing else on that line:

\`\`\`json
{"tool_calls":[{"id":"<unique-id>","name":"<tool-name>","arguments":{...}}]}
\`\`\`

Rules:
- Generate a unique id for each tool call (e.g. "call_001", "call_002")
- Pass arguments as a JSON object with parameter names as keys
- After outputting tool_calls, STOP and wait for tool results
- Do NOT wrap tool_calls output in any prose before or after
- If you do not need any tool, just answer normally without the JSON block

Available tools:
{TOOLS_JSON}
`;

/**
 * 序列化单条消息为文本
 *
 * 简化策略：保留 role + content，不处理 tool_calls / tool 角色等。
 * 这些场景由调用方在 buildPrompt 中通过 system prompt 单独处理。
 */
function serializeMessage(message, index) {
    const role = message?.role || 'user';
    let content = message?.content;

    if (Array.isArray(content)) {
        // 多模态 / Anthropic content blocks → 提取 text 字段
        content = content
            .map((block) => {
                if (typeof block === 'string') return block;
                if (block?.type === 'text' && typeof block.text === 'string') return block.text;
                if (block?.type === 'image') return '[image]';
                if (block?.type === 'image_url') return '[image]';
                if (block?.type === 'tool_use') {
                    return `[tool_call:${block.name}:${JSON.stringify(block.input || {}).slice(0, 200)}]`;
                }
                if (block?.type === 'tool_result') {
                    const resultContent = typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content);
                    return `[tool_result:${resultContent.slice(0, 500)}]`;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    if (content == null) content = '';
    if (typeof content !== 'string') content = JSON.stringify(content);

    return `[${index + 1}] ${role.toUpperCase()}: ${content.trim()}`;
}

/**
 * 构造工具列表的 JSON 描述（喂给 CLI）
 *
 * 只保留 name + description + parameters(JSON Schema 简化版)，
 * 让 CLI 知道有哪些工具可用，但又不至于 prompt 过长。
 */
export function buildToolsDescription(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';

    return tools
        .map((tool) => {
            if (!tool) return null;
            if (tool.type === 'function' && tool.function) {
                return {
                    name: tool.function.name,
                    description: tool.function.description || '',
                    parameters: tool.function.parameters || {}
                };
            }
            return {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.parameters || {}
            };
        })
        .filter(Boolean);
}

/**
 * 把工具定义注入到 system prompt
 *
 * @returns {string} 追加在原 system prompt 之上的工具指令
 */
export function buildToolSystemPrompt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    const toolsJson = JSON.stringify(buildToolsDescription(tools), null, 2);
    return TOOL_INSTRUCTION_TEMPLATE.replace('{TOOLS_JSON}', toolsJson);
}

/**
 * 提取客户端传入的 system 消息文本
 *
 * OpenAI 风格：messages 里 role=system 的项
 * Anthropic 风格：顶层 system 字段
 */
function extractClientSystemPrompt(messages, options = {}) {
    // Anthropic 风格 system 字段
    if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim()) {
        return options.systemPrompt.trim();
    }

    // 顶层 system 字段
    if (typeof options.system === 'string' && options.system.trim()) {
        return options.system.trim();
    }

    // 从 messages 里找 role=system 的项（OpenAI 风格）
    if (Array.isArray(messages)) {
        const systemMessages = messages
            .filter((m) => m && m.role === 'system')
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .filter(Boolean);
        if (systemMessages.length) return systemMessages.join('\n\n').trim();
    }

    return '';
}

/**
 * 构造单条发送给 Qoder CLI 的 prompt
 *
 * @param {Array} messages - OpenAI 风格 messages
 * @param {Object} options
 * @param {string} [options.systemPrompt] - Anthropic 风格 system
 * @param {string} [options.system] - 顶层 system 字段
 * @param {Array}  [options.tools] - 工具定义（OpenAI 风格）
 * @param {boolean}[options.appendToolInstruction] - 是否追加工具指令（默认 true）
 * @returns {string}
 */
export function buildPrompt(messages, options = {}) {
    const tools = Array.isArray(options.tools) ? options.tools : [];
    const clientSystem = extractClientSystemPrompt(messages, options);
    const appendToolInstruction = options.appendToolInstruction !== false;

    // 过滤掉 role=system 的消息（已经被合并到 system）
    const conversationMessages = (Array.isArray(messages) ? messages : [])
        .filter((m) => m && m.role !== 'system');

    // 拼接 system prompt
    let systemPrompt = clientSystem;

    // 三路径策略
    if (!systemPrompt && tools.length === 0) {
        // 路径 2：无 system，无 tools → 最小引导
        systemPrompt = 'You are a helpful assistant. Please answer the user\'s question directly and concisely.';
    }

    if (appendToolInstruction && tools.length > 0) {
        const toolInstruction = buildToolSystemPrompt(tools);
        systemPrompt = systemPrompt
            ? `${systemPrompt}\n\n${toolInstruction}`
            : toolInstruction;
    }

    // 序列化对话消息
    const conversationText = conversationMessages
        .map((m, i) => serializeMessage(m, i))
        .join('\n\n');

    // 最终 prompt 结构
    const parts = [];
    if (systemPrompt) parts.push(`[SYSTEM]\n${systemPrompt}`);
    parts.push(conversationText || '(empty conversation)');
    parts.push('[ASSISTANT]:');

    return parts.join('\n\n');
}

/**
 * 把工具结果格式化为可追加到 prompt 的字符串
 *
 * 用途：多轮工具调用循环中，把上一轮的 tool_result 喂回给 CLI。
 */
export function formatToolResult(toolResult) {
    if (!toolResult) return '';
    if (typeof toolResult === 'string') return toolResult;

    const id = toolResult.id || toolResult.tool_call_id || '';
    const name = toolResult.name || '';
    let content = toolResult.content;

    if (typeof content !== 'string') {
        content = JSON.stringify(content);
    }

    return `[TOOL_RESULT id=${id} name=${name}]\n${content}`;
}