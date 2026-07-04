/**
 * Qoder CLI 子进程管理（核心差异点）
 *
 * 与 Codebuddy 走 HTTP API 完全相反，Qoder 通过 spawn 本地 `qodercli`/`qoderclicn`
 * 子进程执行推理。本文件封装：
 *   - CLI 参数组装（--print / --output-format / --model / --append-system-prompt 等）
 *   - 环境变量注入（PAT 写入 QODER_PAT_*）
 *   - 流式 / 非流式 stdout 解析
 *   - 子进程超时、临时附件文件清理
 *
 * 设计参考：
 *   - 每次请求 spawn 新进程（无状态，避免进程复用问题）
 *   - 流式通过 `--output-format stream-json` 逐行 JSON 输出实现
 *   - 工具调用通过 prompt 注入 + 输出解析（见 tool-parser.js）
 *
 * @module services/qoder/qoder-cli
 */

import {spawn} from 'child_process';
import {writeFileSync, mkdtempSync, unlinkSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import logger from '../../utils/logger.js';
import {
    getQoderBackend,
    getQoderCliPath,
    getQoderCliBinary,
    getQoderCliTimeoutMs,
    isQoderStreamEnabled
} from './config.js';
import {parseToolCallOutput} from './tool-parser.js';

const DEFAULT_BACKEND = getQoderBackend();

/**
 * 构造子进程环境变量
 *
 * - QODER_PAT 是 Qoder CLI 识别的 Personal Access Token 环境变量
 * - cn / global 走不同 PAT
 * - 其他环境变量透传 PATH / HOME / LANG 等基础变量
 */
export function buildChildEnv(credential, options = {}) {
    const env = {...process.env};
    const backend = options.backend || credential?.backend || DEFAULT_BACKEND;
    const pat = credential?.bearer_token || '';

    // 双后端共用同一个字段名，由 CLI 内部按 binary 区分
    if (pat) env.QODER_PAT = pat;

    // 屏蔽可能干扰的代理变量（如需走代理可由调用方在外部 unset）
    return env;
}

/**
 * 构造 spawn 参数数组
 *
 * 必须按这个顺序：基础标志 → 模型 → 系统提示 → 附件 → 指令（用 `--` 分隔）
 */
export function buildCliArgs({prompt, model, systemPrompt, attachmentPath, stream = false, maxTokens = -1}) {
    const args = ['--print'];

    // 输出格式：流式 / 非流式
    args.push('--output-format', stream ? 'stream-json' : 'json');

    // 模型
    if (model) args.push('--model', model);

    // 跳过权限确认（非交互模式必需）
    args.push('--dangerously-skip-permissions');

    // 追加系统提示（工具调用指令由 prompt-builder 生成）
    if (systemPrompt) {
        args.push('--append-system-prompt', systemPrompt);
    }

    // 附件：base64 / 文件路径通过 --attachment 传入，避免命令行过长
    if (attachmentPath) {
        args.push('--attachment', attachmentPath);
    }

    // 单条最大 token（CLI 支持 --max-tokens，-1 时不传）
    if (typeof maxTokens === 'number' && maxTokens > 0) {
        args.push('--max-tokens', String(maxTokens));
    }

    // 用 `--` 把指令放在末尾，避免与上面的 flag 混淆
    args.push('--', prompt);

    return args;
}

/**
 * 把过长的 prompt 写入临时文件，返回文件路径
 *
 * CLI 命令行长度有限（Windows ~8K），附件内容超长时通过文件传递。
 * 调用方负责清理（见 spawnQoderChild 的 finally 块）。
 *
 * @returns {string|null} 临时文件路径，未写入时返回 null
 */
function maybeWritePromptToFile(prompt) {
    if (!prompt || prompt.length < 4096) return null;
    const dir = mkdtempSync(join(tmpdir(), 'qoder-prompt-'));
    const filePath = join(dir, 'prompt.txt');
    writeFileSync(filePath, prompt, 'utf8');
    return filePath;
}

/**
 * 启动 Qoder CLI 子进程
 *
 * @param {Object} options
 * @param {string} options.prompt - 发送给 CLI 的指令
 * @param {string} options.model - CLI 模型名
 * @param {string} [options.systemPrompt] - 追加的系统提示
 * @param {Object} options.credential - {bearer_token, backend}
 * @param {boolean} [options.stream] - 是否流式
 * @param {number} [options.maxTokens] - 单条最大 token
 * @param {number} [options.timeoutMs] - 超时毫秒数
 * @returns {{child: import('child_process').ChildProcess, cleanup: Function}}
 */
export function spawnQoderChild({
    prompt,
    model,
    systemPrompt,
    credential,
    stream = false,
    maxTokens = -1,
    timeoutMs
}) {
    const backend = credential?.backend || DEFAULT_BACKEND;
    const cliPath = getQoderCliPath(backend);
    const binary = getQoderCliBinary(backend);

    const attachmentPath = maybeWritePromptToFile(prompt);

    // 如果用临时文件，指令里改为引用文件路径（CLI 会自动读取）
    const finalPrompt = attachmentPath ? `@${attachmentPath}` : prompt;

    const args = buildCliArgs({
        prompt: finalPrompt,
        model,
        systemPrompt,
        attachmentPath: null, // 已经在 prompt 里引用，不重复
        stream,
        maxTokens
    });

    const env = buildChildEnv(credential, {backend});
    const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : getQoderCliTimeoutMs();

    logger.debug(
        `Spawning Qoder CLI: ${cliPath} ${args.slice(0, 6).join(' ')}... ` +
        `(binary=${binary}, stream=${stream}, timeout=${timeout}ms)`
    );

    const child = spawn(cliPath, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    const cleanup = () => {
        if (attachmentPath) {
            try {
                unlinkSync(attachmentPath);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    logger.warn(`Failed to remove Qoder prompt temp file: ${error.message}`);
                }
            }
        }
    };

    // 超时控制
    const timer = setTimeout(() => {
        logger.warn(`Qoder CLI timeout after ${timeout}ms, killing child`);
        try { child.kill('SIGKILL'); } catch {}
    }, timeout);
    timer.unref?.();

    child.on('exit', () => {
        clearTimeout(timer);
        cleanup();
    });

    return {child, cleanup, binary};
}

/**
 * 非流式调用：等子进程结束，收集完整输出
 *
 * @returns {Promise<{content: string, toolCalls: Array, raw: string, model: string}>}
 */
export function runQoderCli({prompt, model, systemPrompt, credential, maxTokens, timeoutMs}) {
    return new Promise((resolve, reject) => {
        const {child} = spawnQoderChild({
            prompt,
            model,
            systemPrompt,
            credential,
            stream: false,
            maxTokens,
            timeoutMs
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });

        child.on('error', (err) => {
            reject(err);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                const err = new Error(
                    `Qoder CLI exited with code ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`
                );
                err.code = code;
                err.stderr = stderr;
                reject(err);
                return;
            }

            try {
                const parsed = parseNonStreamOutput(stdout);
                const toolCalls = parseToolCallOutput(parsed.content);
                resolve({
                    content: parsed.content,
                    toolCalls,
                    raw: stdout,
                    model
                });
            } catch (err) {
                // 解析失败也返回原始文本，避免单个解析错误阻塞请求
                logger.warn(`Qoder CLI non-stream parse failed: ${err.message}, returning raw text`);
                const toolCalls = parseToolCallOutput(stdout);
                resolve({content: stdout.trim(), toolCalls, raw: stdout, model});
            }
        });
    });
}

/**
 * 流式调用：每收到一个 delta 就回调
 *
 * stream-json 输出格式（一行一个 JSON 对象）：
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"tool_use","name":"...","input":{...}}
 *   {"type":"tool_result","content":"..."}
 *   {"type":"result","result":"..."}
 *
 * @param {Object} options - 同 runQoderCli
 * @param {Function} onDelta - (chunk: {type: 'content'|'tool_call'|'tool_result', text?: string, toolCall?: Object}) => void
 * @returns {Promise<{content: string, toolCalls: Array}>}
 */
export function runQoderCliStream({prompt, model, systemPrompt, credential, maxTokens, timeoutMs}, onDelta) {
    return new Promise((resolve, reject) => {
        if (!isQoderStreamEnabled()) {
            // 流式被禁用 → 走非流式路径再一次性回调
            runQoderCli({prompt, model, systemPrompt, credential, maxTokens, timeoutMs})
                .then((result) => {
                    if (result.content) onDelta?.({type: 'content', text: result.content});
                    for (const tc of result.toolCalls) {
                        onDelta?.({type: 'tool_call', toolCall: tc});
                    }
                    resolve(result);
                })
                .catch(reject);
            return;
        }

        const {child} = spawnQoderChild({
            prompt,
            model,
            systemPrompt,
            credential,
            stream: true,
            maxTokens,
            timeoutMs
        });

        let buffer = '';
        let fullContent = '';
        const toolCalls = [];

        const processLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            let evt;
            try {
                evt = JSON.parse(trimmed);
            } catch {
                // 非 JSON 行当作纯文本累加
                fullContent += trimmed + '\n';
                onDelta?.({type: 'content', text: trimmed + '\n'});
                return;
            }

            switch (evt.type) {
                case 'assistant': {
                    const message = evt.message || {};
                    const content = Array.isArray(message.content) ? message.content : [];
                    for (const block of content) {
                        if (block?.type === 'text' && typeof block.text === 'string') {
                            fullContent += block.text;
                            onDelta?.({type: 'content', text: block.text});
                        } else if (block?.type === 'tool_use') {
                            const toolCall = {
                                id: block.id || `call_${Date.now()}_${toolCalls.length}`,
                                name: block.name,
                                arguments: block.input || {}
                            };
                            toolCalls.push(toolCall);
                            onDelta?.({type: 'tool_call', toolCall});
                        }
                    }
                    break;
                }
                case 'tool_use': {
                    const toolCall = {
                        id: evt.id || `call_${Date.now()}_${toolCalls.length}`,
                        name: evt.name,
                        arguments: evt.input || evt.arguments || {}
                    };
                    toolCalls.push(toolCall);
                    onDelta?.({type: 'tool_call', toolCall});
                    break;
                }
                case 'tool_result': {
                    onDelta?.({type: 'tool_result', content: evt.content || ''});
                    break;
                }
                case 'result': {
                    // 最终结果（部分 CLI 在流式末尾输出）
                    if (typeof evt.result === 'string' && !fullContent) {
                        fullContent = evt.result;
                        onDelta?.({type: 'content', text: evt.result});
                    }
                    break;
                }
                case 'error':
                case 'error_event': {
                    logger.warn(`Qoder CLI stream error event: ${JSON.stringify(evt).slice(0, 200)}`);
                    break;
                }
                default:
                    // 未知事件类型：尝试提取 text 字段
                    if (typeof evt.text === 'string') {
                        fullContent += evt.text;
                        onDelta?.({type: 'content', text: evt.text});
                    } else if (typeof evt.content === 'string') {
                        fullContent += evt.content;
                        onDelta?.({type: 'content', text: evt.content});
                    }
            }
        };

        child.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                processLine(line);
            }
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });

        child.on('error', (err) => {
            reject(err);
        });

        child.on('close', (code) => {
            // 处理最后一行（无换行结尾）
            if (buffer.trim()) processLine(buffer);

            if (code !== 0) {
                const err = new Error(
                    `Qoder CLI exited with code ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`
                );
                err.code = code;
                err.stderr = stderr;
                reject(err);
                return;
            }

            resolve({content: fullContent, toolCalls});
        });
    });
}

/**
 * 解析 `--output-format json` 的非流式输出
 *
 * CLI 返回结构可能是：
 *   - 顶层是 {result: "..."} 或 {content: "..."}
 *   - 顶层是 {message: {content: [...]}}
 *   - 直接的纯文本（罕见）
 */
function parseNonStreamOutput(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return {content: ''};

    // 尝试解析为 JSON
    try {
        const parsed = JSON.parse(trimmed);
        return extractContentFromJson(parsed);
    } catch {
        // 多行 JSON（某些 CLI 会换行输出）
        const firstBrace = trimmed.indexOf('{');
        if (firstBrace >= 0) {
            try {
                const parsed = JSON.parse(trimmed.slice(firstBrace));
                return extractContentFromJson(parsed);
            } catch {
                /* fall through */
            }
        }
        return {content: trimmed};
    }
}

function extractContentFromJson(parsed) {
    if (!parsed || typeof parsed !== 'object') return {content: ''};

    if (typeof parsed.result === 'string') return {content: parsed.result};
    if (typeof parsed.content === 'string') return {content: parsed.content};
    if (typeof parsed.text === 'string') return {content: parsed.text};

    if (Array.isArray(parsed.content)) {
        const texts = parsed.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text);
        if (texts.length) return {content: texts.join('')};
    }

    if (parsed.message) {
        return extractContentFromJson(parsed.message);
    }

    return {content: ''};
}