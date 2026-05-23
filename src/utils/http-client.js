/**
 * HTTP 客户端封装模块
 * 使用 Node.js 原生 http/https 模块
 * 作为代理中间层，不做重试，直接透传结果
 * @module utils/http-client
 */

import https from 'https';
import http from 'http';
import {URL} from 'url';
import {createGunzip, createInflate, createBrotliDecompress} from 'zlib';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import logger from './logger.js';

// ==================== 连接池配置 ====================
const POOL_CONFIG = {
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000,
    scheduling: 'fifo'
};

const globalAgents = {
    http: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 15000,
        maxSockets: POOL_CONFIG.maxSockets,
        maxFreeSockets: POOL_CONFIG.maxFreeSockets,
        timeout: POOL_CONFIG.timeout,
        scheduling: POOL_CONFIG.scheduling
    }),
    https: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 15000,
        maxSockets: POOL_CONFIG.maxSockets,
        maxFreeSockets: POOL_CONFIG.maxFreeSockets,
        timeout: POOL_CONFIG.timeout,
        scheduling: POOL_CONFIG.scheduling
    })
};

const proxyAgentCache = new Map();

function getProxyAgent(proxyUrl, isHttps) {
    const cacheKey = `${proxyUrl}:${isHttps ? 'https' : 'http'}`;

    if (proxyAgentCache.has(cacheKey)) {
        return proxyAgentCache.get(cacheKey);
    }

    let agent;
    try {
        if (proxyUrl.startsWith('socks')) {
            agent = new SocksProxyAgent(proxyUrl);
        } else {
            agent = new HttpsProxyAgent(proxyUrl);
        }

        agent.maxSockets = POOL_CONFIG.maxSockets;
        agent.maxFreeSockets = POOL_CONFIG.maxFreeSockets;

        proxyAgentCache.set(cacheKey, agent);
        return agent;
    } catch (err) {
        logger.warn(`代理配置失败: ${err.message}`);
        return null;
    }
}

/**
 * 发送 HTTP 请求，不重试，直接透传结果
 * @param {string} url - 请求 URL
 * @param {object} options - 请求选项
 * @param {string} options.method - HTTP 方法
 * @param {object} options.headers - 请求头
 * @param {string} [options.body] - 请求体
 * @param {number} [options.timeout] - 请求超时时间（毫秒），默认 120000
 * @returns {Promise<{status: number, headers: object, body: import('stream').Readable}>}
 */
export function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            logger.error(`无效的 URL: "${url}"`);
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const protocol = isHttps ? https : http;

        const headers = {...options.headers};

        let agent;
        if (options.agent) {
            agent = options.agent;
        } else {
            const proxyUrl = options.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
            if (proxyUrl) {
                agent = getProxyAgent(proxyUrl, isHttps);
            } else {
                agent = isHttps ? globalAgents.https : globalAgents.http;
            }
        }

        let hasAcceptEncoding = false;
        for (const key in headers) {
            if (key.toLowerCase() === 'accept-encoding') {
                hasAcceptEncoding = true;
                break;
            }
        }
        if (!hasAcceptEncoding) {
            headers['Accept-Encoding'] = 'gzip, deflate, br';
        }

        const requestTimeout = options.timeout || 120000;

        const requestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers,
            agent: agent || undefined,
            rejectUnauthorized: 'rejectUnauthorized' in options
                ? options.rejectUnauthorized
                : process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
        };

        const req = protocol.request(requestOptions, (res) => {
            let responseBody = res;
            const contentEncodingKey = Object.keys(res.headers).find((key) => key.toLowerCase() === 'content-encoding');
            const encoding = contentEncodingKey ? res.headers[contentEncodingKey] : null;

            if (encoding) {
                const encodingLower = encoding.toLowerCase();

                try {
                    let decompressStream = null;
                    if (encodingLower.includes('br')) {
                        decompressStream = createBrotliDecompress();
                    } else if (encodingLower.includes('gzip')) {
                        decompressStream = createGunzip();
                    } else if (encodingLower.includes('deflate')) {
                        decompressStream = createInflate();
                    }

                    if (decompressStream) {
                        decompressStream.on('error', (decompressErr) => {
                            logger.warn(`解压流错误: ${decompressErr.message}，回退到原始响应`);
                            decompressStream.destroy();
                        });
                        responseBody = res.pipe(decompressStream);
                        delete res.headers[contentEncodingKey];
                    }
                } catch (decompressErr) {
                    logger.warn(`解压初始化失败: ${decompressErr.message}`);
                }
            }

            resolve({
                status: res.statusCode,
                headers: res.headers,
                body: responseBody
            });
        });

        let isDone = false;
        const done = (err) => {
            if (!isDone) {
                isDone = true;
                reject(err);
            }
        };

        req.setTimeout(requestTimeout, () => {
            logger.error(`请求超时 (${requestTimeout}ms): ${url}`);
            req.destroy();
            done(new Error(`Request timeout after ${requestTimeout}ms`));
        });

        req.on('error', (err) => {
            logger.error(`请求错误: ${err.message}`);
            done(err);
        });

        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}

/**
 * 读取响应体为字符串
 */
export function readBody(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
            const buffer = Buffer.concat(chunks);
            resolve(buffer.toString('utf8'));
        });
        stream.on('error', reject);
    });
}

/**
 * 读取响应体为 JSON
 */
export async function readJson(stream) {
    const data = await readBody(stream);

    if (!data || data.trim() === '') {
        logger.error('响应体为空');
        throw new Error('Empty response body - 上游服务返回空响应，可能是 URL 路径错误导致 404');
    }

    try {
        return JSON.parse(data);
    } catch (e) {
        logger.error(`JSON 解析失败，原始数据: "${data.substring(0, 200)}..."`);
        throw new Error(`Invalid JSON response: ${e.message}. Raw data: ${data.substring(0, 100)}`);
    }
}
