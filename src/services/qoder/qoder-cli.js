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
import {writeFileSync, unlinkSync} from 'fs';
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
 * - QODER_PERSONAL_ACCESS_TOKEN 是 Qoder CLI 识别的 PAT 环境变量
 * - 不同后端（cn / global）使用不同账号的 PAT
 * - 其他环境变量透传 PATH / HOME / LANG 等基础变量
 */
export function buildChildEnv(credential, options = {}) {
    const env = {...process.env};
    const backend = options.backend || credential?.backend || DEFAULT_BACKEND;
    const pat = credential?.bearer_token || '';

    // CLI 识别 QODER_PERSONAL_ACCESS_TOKEN
    if (pat) env.QODER_PERSONAL_ACCESS_TOKEN = pat;

    return env;
}

/**
 * 构造 spawn 参数数组
 *
 * 实际 CLI 接口（v1.0.37）：
 *   qodercli -p "<prompt>" --output-format json|stream-json -m <model> \
 *             --dangerously-skip-permissions --append-system-prompt <text> \
 *             --attachment <file> --max-output-tokens <n>
 *
 * @param {Object} options
 * @param {string} options.prompt - 发送给 CLI 的指令
 * @param {string} options.model - CLI 模型名
 * @param {string} [options.systemPrompt] - 追加的系统提示
 * @param {string} [options.attachmentPath] - 附件文件路径
 * @param {boolean}[options.stream] - 是否流式（--output-format stream-json）
 * @param {number} [options.maxTokens] - 单条最大 token（>0 时传 --max-output-tokens）
 * @param {boolean} [options.useStdin] - 是否通过 stdin 传入 prompt
 */
export function buildCliArgs({prompt, model, systemPrompt, attachmentPath, stream = false, maxTokens = -1, useStdin = false}) {
    const args = [];

    // 非交互模式（必须）
    args.push('-p');

    // 输出格式
    args.push('--output-format', stream ? 'stream-json' : 'json');

    // 输入格式：通过 stdin 传入时显式声明
    if (useStdin) {
        args.push('--input-format', 'text');
    }

    // 模型
    if (model) args.push('-m', model);

    // 跳过权限确认
    args.push('--dangerously-skip-permissions');

    // 追加系统提示
    if (systemPrompt) {
        args.push('--append-system-prompt', systemPrompt);
    }

    // 附件
    if (attachmentPath) {
        args.push('--attachment', attachmentPath);
    }

    // 单条最大 token
    if (typeof maxTokens === 'number' && maxTokens > 0) {
        args.push('--max-output-tokens', String(maxTokens));
    }

    // 指令：走 stdin 时不放在命令行参数里，避免命令行超长
    if (!useStdin) {
        args.push(prompt);
    }

    return args;
}

/**
 * 判断 prompt 是否需要走 stdin 路径
 *
 * CLI 命令行长度有限（Windows ~8K，类 Unix 也建议 <128KB）。
 * 长 prompt 通过 stdin + --input-format text 传递，避免命令行超长，
 * 也避免被 Qoder CLI 当成 "@文件路径"附件读取。
 *
 * @returns {boolean}
 */
function shouldUseStdin(prompt) {
    if (!prompt) return false;
    return prompt.length >= 4096;
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

    // 长 prompt 走 stdin（避免命令行超长 + 避免 "@文件路径"被当成附件读取）
    const useStdin = shouldUseStdin(prompt);
    const attachmentPath = null; // 已不再使用临时文件附件路径，保留变量用于 cleanup / 日志

    const args = buildCliArgs({
        prompt,
        model,
        systemPrompt,
        attachmentPath,
        stream,
        maxTokens,
        useStdin
    });

    const env = buildChildEnv(credential, {backend});
    const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : getQoderCliTimeoutMs();

    logger.debug(
        `Spawning Qoder CLI: ${cliPath} ${args.slice(0, 6).join(' ')}... ` +
        `(binary=${binary}, stream=${stream}, useStdin=${useStdin}, timeout=${timeout}ms)`
    );

    const child = spawn(cliPath, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });

    // 通过 stdin 写入 prompt
    if (useStdin) {
        try {
            child.stdin.end(prompt);
        } catch (error) {
            logger.warn(`Failed to write Qoder prompt to stdin: ${error.message}`);
        }
    }

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
                case 'system': {
                    // 初始化事件：包含 tools / model / permissionMode 等元数据
                    // 解析这个事件可以拿到 CLI 实际生效的工具列表，但目前只记录日志
                    logger.debug(`Qoder CLI init: model=${evt.model}, tools=${(evt.tools || []).length}`);
                    break;
                }
                case 'assistant': {
                    // 流式 assistant 消息
                    const message = evt.message || {};
                    const content = Array.isArray(message.content) ? message.content : [];
                    for (const block of content) {
                        if (block?.type === 'text' && typeof block.text === 'string') {
                            fullContent += block.text;
                            onDelta?.({type: 'content', text: block.text});
                        } else if (block?.type === 'tool_use') {
                            // CLI 原生 tool_use（来自内置工具调用，不是客户端定义的 tools）
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
                case 'user': {
                    // 工具结果回传（CLI 内置工具）
                    const message = evt.message || {};
                    const content = Array.isArray(message.content) ? message.content : [];
                    for (const block of content) {
                        if (block?.type === 'tool_result') {
                            const resultContent = typeof block.content === 'string'
                                ? block.content
                                : JSON.stringify(block.content || '');
                            onDelta?.({type: 'tool_result', content: resultContent});
                        }
                    }
                    break;
                }
                case 'result': {
                    // 最终结果事件
                    if (typeof evt.result === 'string') {
                        // CLI 有时 result 字段是完整的最终输出；只有当流中没有累积内容时才使用
                        if (!fullContent) {
                            fullContent = evt.result;
                            onDelta?.({type: 'content', text: evt.result});
                        }
                    }
                    if (evt.usage) {
                        onDelta?.({type: 'usage', usage: evt.usage});
                    }
                    break;
                }
                default:
                    // 未知事件：尝试提取 text/content
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
 * 实际 CLI 1.0.37 返回结构：
 *   {
 *     "type": "result",
 *     "subtype": "success",
 *     "is_error": false,
 *     "result": "实际回答内容",
 *     "session_id": "...",
 *     "stop_reason": "end_turn",
 *     "usage": {input_tokens, output_tokens, ...},
 *     ...
 *   }
 */
function parseNonStreamOutput(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return {content: ''};

    try {
        const parsed = JSON.parse(trimmed);
        return extractContentFromJson(parsed);
    } catch {
        // 容错：如果是多行 JSON，尝试截取第一段
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

    // 错误情况：is_error=true，result 是错误描述
    if (parsed.is_error && typeof parsed.result === 'string') {
        return {content: parsed.result, isError: true};
    }

    // 正常 result 字段
    if (typeof parsed.result === 'string') return {content: parsed.result};

    // 备选字段名
    if (typeof parsed.content === 'string') return {content: parsed.content};
    if (typeof parsed.text === 'string') return {content: parsed.text};

    // Anthropic 风格 content blocks
    if (Array.isArray(parsed.content)) {
        const texts = parsed.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text);
        if (texts.length) return {content: texts.join('')};
    }

    // OpenAI-style message.content
    if (parsed.message) {
        return extractContentFromJson(parsed.message);
    }

    return {content: ''};
}