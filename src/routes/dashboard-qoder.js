/**
 * Qoder 渠道管理面板路由
 *
 * 提供 PAT 凭证的 CRUD API：
 *   GET    /dashboard/tenants/:id/qoder/credentials             列出所有凭证
 *   POST   /dashboard/tenants/:id/qoder/credentials             新增凭证
 *   POST   /dashboard/tenants/:id/qoder/credentials/delete      删除凭证（index）
 *   POST   /dashboard/tenants/:id/qoder/credentials/active      设为活跃（index）
 *   POST   /dashboard/tenants/:id/qoder/credentials/toggle      启用/禁用
 *   POST   /dashboard/tenants/:id/qoder/credentials/move-up     上移
 *   POST   /dashboard/tenants/:id/qoder/credentials/move-down   下移
 *
 * OAuth2 浏览器认证 API：
 *   GET    /dashboard/tenants/:id/qoder/auth/start              启动 OAuth2 设备流程
 *   POST   /dashboard/tenants/:id/qoder/auth/poll               轮询认证状态
 *   POST   /dashboard/tenants/:id/qoder/auth/save               保存浏览器认证 token
 *
 * @module routes/dashboard-qoder
 */

import {randomUUID, createHash} from 'crypto';
import logger from '../utils/logger.js';
import {unifiedTenantManager} from '../services/gateway/index.js';
import {
    BLOCKED_DOMAINS,
    getQoderBaseUrl,
    getExtraBaseUrls,
    getModelsForHost,
    isPersonalHost,
    getCustomSiteLabel,
    getQoderCredentialService
} from '../services/qoder/index.js';

// Qoder CLI client_id（CN 和 INTL 均使用同一个，基于 qodercli 源码逆向）
// qodercli 源码: client_id=${I?wWs:DWs}，I 默认 true → 始终用 wWs
const QODER_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';

const qoderCredentialService = getQoderCredentialService(unifiedTenantManager);

// 添加凭证后自动启用 Qoder service（避免 service 未启用导致 API 调用 503）
async function ensureQoderServiceEnabled(tenantId) {
    try {
        const tenant = unifiedTenantManager.getTenant(tenantId);
        const profile = tenant?.serviceProfiles?.find(item => item.service_type === 'qoder');
        if (!profile?.enabled) {
            await unifiedTenantManager.setServiceEnabled(tenantId, 'qoder', true);
        }
    } catch (error) {
        logger.warn(`Failed to auto-enable Qoder service for tenant ${tenantId}: ${error.message}`);
    }
}

// OAuth2 认证状态存储
const authStates = new Map();
const AUTH_STATE_TTL = 30 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [state, value] of authStates) {
        if (now - value.createdAt > AUTH_STATE_TTL) authStates.delete(state);
    }
}, 10 * 60 * 1000).unref();

function sendJson(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

/**
 * 生成 PKCE code_verifier（43~128 字符的随机字符串）
 * @returns {string}
 */
function generateCodeVerifier() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const length = 43 + Math.floor(Math.random() * 85); // 43~127
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * 根据 code_verifier 生成 S256 code_challenge
 * @param {string} codeVerifier
 * @returns {string}
 */
function generateCodeChallenge(codeVerifier) {
    const hash = createHash('sha256').update(codeVerifier).digest();
    return hash.toString('base64url');
}

// ─── OAuth2 认证流程 ─────────────────────────────────────────

async function startAuth(req, res, tenantId) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const baseUrl = getQoderBaseUrl(url.searchParams.get('base_url'));
    const host = new URL(baseUrl).host;
    if (BLOCKED_DOMAINS.includes(host)) {
        return sendJson(res, 400, {error: `域名 ${host} 已废弃，不允许添加凭证`});
    }

    // 生成 PKCE 参数
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // 生成设备标识和随机数
    const machineId = randomUUID();
    const nonce = randomUUID();

    // 构造回调 URL（与 qodercli 完全一致：challenge + challenge_method + nonce + machine_id + client_id）
    // 注意：不传 directLogin，qodercli 源码中没有此参数
    const callbackUrl = `${baseUrl}/device/selectAccounts?challenge=${codeChallenge}&challenge_method=S256&nonce=${nonce}&machine_id=${machineId}&client_id=${QODER_CLIENT_ID}`;

    // 构造用户登录 URL（先跳 /users/sign-in，登录成功后自动跳回 /device/selectAccounts）
    const authUrl = `${baseUrl}/users/sign-in?oauth_callback=${encodeURIComponent(callbackUrl)}`;

    // 存储认证状态
    const authState = randomUUID();
    authStates.set(authState, {
        createdAt: Date.now(),
        tenantId,
        baseUrl,
        challenge: codeChallenge,
        codeVerifier,
        machineId,
        nonce
    });

    return sendJson(res, 200, {
        success: true,
        auth_state: authState,
        verification_uri_complete: authUrl,
        verification_uri: baseUrl,
        expires_in: 1800,
        interval: 5
    });
}

async function pollAuth(req, res, tenantId) {
    const {auth_state: authState} = await readRequestBody(req);
    const record = authStates.get(authState);
    if (!authState || !record || Number(record.tenantId) !== Number(tenantId)) {
        return sendJson(res, 400, {status: 'error', message: '认证状态不存在或已过期'});
    }

    // 检查认证状态是否已超时
    if (Date.now() - record.createdAt > AUTH_STATE_TTL) {
        authStates.delete(authState);
        return sendJson(res, 400, {status: 'error', message: '认证已超时，请重新发起'});
    }

    try {
        // 策略1: 轮询 Qoder 设备 token 端点
        const accessToken = await tryDeviceTokenPoll(record);
        if (accessToken) {
            logger.info(`Qoder auth poll: 获取到 token，准备保存 (tenantId=${tenantId})`);
            return await saveTokenFromPoll(res, tenantId, authState, record, accessToken);
        }

        // 策略2: 检查 CLI 本地 auth 目录是否已写入新凭证
        const localToken = await tryReadLocalAuthToken(record);
        if (localToken) {
            logger.info(`Qoder auth poll: 从本地文件获取到 token，准备保存 (tenantId=${tenantId})`);
            return await saveTokenFromPoll(res, tenantId, authState, record, localToken);
        }

        // 未获取到 token，继续等待
        return sendJson(res, 200, {status: 'pending', message: '等待用户登录'});
    } catch (error) {
        logger.error(`Qoder auth poll failed: ${error.message}`);
        return sendJson(res, 200, {status: 'pending', message: '等待用户登录'});
    }
}

/**
 * 轮询 Qoder 设备 token 端点获取 access_token
 *
 * Qoder 设备授权流程（基于 qodercli 源码逆向）：
 *   1. 构造登录 URL: {baseUrl}/device/selectAccounts?challenge={code_challenge}&challenge_method=S256&nonce={nonce}&machine_id={machine_id}&client_id={client_id}
 *   2. 用户在浏览器完成登录
 *   3. 轮询 OpenAPI 网关: GET {openapiBase}/api/v1/deviceToken/poll?nonce={nonce}&verifier={code_verifier}&challenge_method=S256
 *   4. 404 = 等待中；200 + {token: "..."} = 成功
 *
 * OpenAPI 网关：
 *   - INTL: https://openapi.qoder.sh
 *   - CN:   https://openapi.qoder.com.cn
 *
 * client_id：
 *   - INTL: e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
 *   - CN:   e93fe488-5778-4c35-a6fc-0f54ed7b3139
 */
async function tryDeviceTokenPoll(record) {
    const isCn = record.baseUrl.includes('qoder.com.cn');

    // OpenAPI 网关地址（基于 qodercli 源码逆向）
    // INTL: https://openapi.qoder.sh
    // CN:   https://openapi.qoder.com.cn
    // 404 = 等待中（"device token not found"）
    // 200 + {token: "..."} = 成功
    const openApiBase = isCn ? 'https://openapi.qoder.com.cn' : 'https://openapi.qoder.sh';

    // 轮询参数：nonce + verifier + challenge_method
    // 注意：qodercli 源码中轮询 URL 不传 challenge 和 machine_id，只传 nonce + verifier
    const query = new URLSearchParams({
        nonce: record.nonce,
        verifier: record.codeVerifier,
        challenge_method: 'S256'
    });

    const pollUrl = `${openApiBase}/api/v1/deviceToken/poll?${query.toString()}`;
    logger.info(`Qoder auth poll: GET ${pollUrl.replace(record.codeVerifier, '***')}`);
    try {
        const response = await fetch(pollUrl, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'User-Agent': 'qodercli/1.0'
            }
        });

        // 404 = 等待中（qodercli 源码明确：404 视为 pending）
        // 响应体: {"errorCode":"NotFound","errorMessage":"device token not found",...}
        if (response.status === 404) {
            logger.debug(`Qoder deviceTokenPoll → 404 (等待中)`);
            return null;
        }

        if (!response.ok) {
            logger.debug(`Qoder deviceTokenPoll → HTTP ${response.status}`);
            return null;
        }

        const result = await response.json();

        // qodercli 源码: if(i.token && "string"==typeof i.token) return i
        // 响应中 token 字段名就是 "token"
        const token = result.token
            || result.access_token
            || result.accessToken
            || result.device_token
            || result.data?.token
            || result.data?.access_token;

        if (token && typeof token === 'string') {
            logger.info(`Qoder auth: 从 ${openApiBase}/api/v1/deviceToken/poll 获取到 token`);
            record._tokenResponse = result;
            return token;
        }

        logger.debug(`Qoder deviceTokenPoll 响应无 token: ${JSON.stringify(result).slice(0, 200)}`);
    } catch (error) {
        logger.debug(`Qoder deviceTokenPoll 请求失败: ${error.message}`);
    }

    return null;
}

/**
 * 尝试从 CLI 本地 auth 目录读取已保存的 token
 *
 * qodercli 登录成功后，token 存储在：
 *   - macOS: Keychain（Qoder Safe Storage）—— 无法直接读取
 *   - Linux: Secret Service API / libsecret
 *   - 降级: 环境变量或 .qoder/.auth/ 目录下的文件
 *
 * 本函数检查 .qoder/.auth/ 目录是否有新增的 token 文件，
 * 以及 ~/.qoder/.cache/endpoint-cache.json 是否包含 token 信息。
 * 这是一种尽力而为的回退策略。
 */
async function tryReadLocalAuthToken(record) {
    try {
        const {homedir} = await import('os');
        const {readdir, readFile, stat} = await import('fs/promises');
        const {join} = await import('path');

        const isCn = record.baseUrl.includes('qoder.com.cn');
        const homeDir = homedir();
        const authDir = join(homeDir, isCn ? '.qoderworkcn' : '.qoder', '.auth');

        // 检查 auth 目录中是否有 token 相关文件
        try {
            const files = await readdir(authDir);
            for (const file of files) {
                if (file === 'machine_id') continue;
                // 读取非 machine_id 文件（可能是 token 文件）
                try {
                    const content = await readFile(join(authDir, file), 'utf8');
                    const trimmed = content.trim();
                    // 简单判断：如果内容像 token（长度 > 20 且不含空行）
                    if (trimmed.length > 20 && !trimmed.includes('\n')) {
                        logger.info(`Qoder auth: 从本地 ${join(authDir, file)} 读取到 token`);
                        return trimmed;
                    }
                    // 尝试 JSON 解析
                    try {
                        const json = JSON.parse(trimmed);
                        const token = json.access_token || json.accessToken || json.token || json.bearer_token;
                        if (token && typeof token === 'string' && token.length > 20) {
                            logger.info(`Qoder auth: 从本地 ${join(authDir, file)} JSON 中提取 token`);
                            return token;
                        }
                    } catch {}
                } catch {}
            }
        } catch {
            // auth 目录不存在或无权限，忽略
        }

        // 检查 endpoint-cache.json 是否有 token（不太可能，但作为尽力回退）
        try {
            const cacheFile = join(homeDir, isCn ? '.qoderworkcn' : '.qoder', '.cache', 'endpoint-cache.json');
            const content = await readFile(cacheFile, 'utf8');
            const json = JSON.parse(content);
            // endpoint-cache 通常不含 token，但检查一下
            const token = json.token || json.access_token;
            if (token && typeof token === 'string' && token.length > 20) {
                return token;
            }
        } catch {}

    } catch (error) {
        logger.debug(`Qoder auth: 本地 token 读取失败: ${error.message}`);
    }
    return null;
}

/**
 * 从 poll 成功获取的 token 保存到数据库
 */
async function saveTokenFromPoll(res, tenantId, authState, record, accessToken) {
    const tokenData = record._tokenResponse?.data || record._tokenResponse || {};
    const manager = await qoderCredentialService.getCredentialManager(tenantId);
    if (!manager) return sendJson(res, 404, {status: 'error', message: '租户不存在'});

    const backend = record.baseUrl.includes('qoder.com.cn') ? 'cn' : 'intl';
    const userId = tokenData.user_id || tokenData.email || tokenData.preferred_username || '';

    const saved = await manager.addCredentialWithData({
        name: tokenData.name || userId || 'OAuth2 凭证',
        bearer_token: accessToken,
        backend,
        base_url: record.baseUrl,
        user_id: userId,
        created_at: Math.floor(Date.now() / 1000)
    });

    authStates.delete(authState);
    if (saved) {
        await qoderCredentialService.refreshCredentials(tenantId);
        await ensureQoderServiceEnabled(tenantId);
    }
    return sendJson(res, saved ? 200 : 500, {
        status: saved ? 'success' : 'error',
        message: saved ? '认证成功，凭证已保存' : '凭证保存失败'
    });
}

async function saveBrowserAuth(req, res, tenantId) {
    const {base_url: rawBaseUrl, token_data: tokenData} = await readRequestBody(req);
    const baseUrl = getQoderBaseUrl(rawBaseUrl);
    const host = new URL(baseUrl).host;
    if (BLOCKED_DOMAINS.includes(host)) {
        return sendJson(res, 400, {status: 'error', message: `域名 ${host} 已废弃，不允许添加凭证`});
    }

    const accessToken = tokenData?.accessToken || tokenData?.access_token;
    if (!accessToken) {
        return sendJson(res, 400, {status: 'error', message: '缺少 access_token'});
    }

    // 根据 baseUrl 判断 backend
    const backend = baseUrl.includes('qoder.com.cn') ? 'cn' : 'intl';

    const manager = await qoderCredentialService.getCredentialManager(tenantId);
    if (!manager) return sendJson(res, 404, {status: 'error', message: '租户不存在'});

    const userId = tokenData.user_id || tokenData.email || tokenData.preferred_username || '';

    const saved = await manager.addCredentialWithData({
        name: tokenData.name || userId || '',
        bearer_token: accessToken,
        backend,
        base_url: baseUrl,
        user_id: userId,
        created_at: Math.floor(Date.now() / 1000)
    });

    if (saved) {
        await qoderCredentialService.refreshCredentials(tenantId);
        await ensureQoderServiceEnabled(tenantId);
    }
    return sendJson(res, saved ? 200 : 500, {
        status: saved ? 'success' : 'error',
        message: saved ? '凭证已保存' : '凭证保存失败'
    });
}

// ─── 管理选项 ────────────────────────────────────────────────

export function getQoderAdminOptions() {
    const defaults = [getQoderBaseUrl()];
    return [...new Set([...defaults, ...getExtraBaseUrls()])].map(url => ({
        url,
        host: new URL(url).host,
        personal: isPersonalHost(new URL(url).host),
        label: isPersonalHost(new URL(url).host) ? '个人站' : getCustomSiteLabel(url),
        models: getModelsForHost(url)
    }));
}

/**
 * 派发 /dashboard/tenants/:id/qoder/* 子路径
 *
 * @returns {boolean} 是否处理了请求
 */
export async function handleQoderAdminRoute(req, res, tenantId, subPath) {
    if (!subPath.startsWith('/qoder/')) return false;

    const method = req.method;

    try {
        const tail = subPath.slice('/qoder'.length);

        // OAuth2 认证路由
        if (tail === '/auth/start' && method === 'GET') {
            await startAuth(req, res, tenantId);
            return true;
        }
        if (tail === '/auth/poll' && method === 'POST') {
            await pollAuth(req, res, tenantId);
            return true;
        }
        if (tail === '/auth/save' && method === 'POST') {
            await saveBrowserAuth(req, res, tenantId);
            return true;
        }

        // 列出凭证
        if (tail === '/credentials' && method === 'GET') {
            const data = await qoderCredentialService.listCredentials(tenantId);
            const credentials = (data.credentials || []).map(cred => ({
                id: cred.id,
                index: cred.index,
                enabled: cred.enabled,
                name: cred.name || '',
                backend: cred.backend || 'cn',
                base_url: cred.base_url || '',
                user_id: cred.user_id || '',
                credential_created_at: cred.credential_created_at || null,
                tokenPreview: cred.bearer_token
                    ? `${cred.bearer_token.slice(0, 4)}...${cred.bearer_token.slice(-4)}`
                    : ''
            }));
            sendJson(res, 200, {
                credentials,
                activeIndex: data.activeIndex
            });
            return true;
        }

        // 新增凭证
        if (tail === '/credentials' && method === 'POST') {
            const body = await readRequestBody(req);
            const {name, bearer_token, backend} = body;
            if (!bearer_token || typeof bearer_token !== 'string') {
                sendJson(res, 400, {error: 'bearer_token 必填'});
                return true;
            }
            const manager = await qoderCredentialService.getCredentialManager(tenantId);
            const ok = await manager.addCredentialWithData({
                name: (name || '').trim(),
                bearer_token,
                backend: ['cn', 'intl', 'global'].includes(backend) ? backend : 'cn'
            });
            if (ok) {
                await qoderCredentialService.refreshCredentials(tenantId);
                await ensureQoderServiceEnabled(tenantId);
            }
            sendJson(res, ok ? 200 : 500, ok ? {message: '凭证已添加'} : {error: '保存失败'});
            return true;
        }

        // 删除 / 切换活跃 / 启用切换 / 上下移
        const actionMatch = tail.match(/^\/credentials\/(delete|active|toggle|move-up|move-down)$/);
        if (actionMatch && method === 'POST') {
            const action = actionMatch[1];
            const body = await readRequestBody(req);
            const {index} = body;
            if (!Number.isInteger(index) || index < 0) {
                sendJson(res, 400, {error: 'index 必填且为非负整数'});
                return true;
            }

            const manager = await qoderCredentialService.getCredentialManager(tenantId);

            if (action === 'delete') {
                const ok = await manager.deleteCredential(index);
                sendJson(res, ok ? 200 : 500, ok ? {message: '已删除'} : {error: '删除失败'});
                return true;
            }
            if (action === 'active') {
                const ok = await manager.setActiveCredential(index);
                sendJson(res, ok ? 200 : 500, ok ? {message: '已切换活跃凭证'} : {error: '切换失败'});
                return true;
            }
            if (action === 'toggle') {
                const result = await manager.toggleCredentialDisable(index);
                sendJson(res, 200, {message: '已更新', disabled: result.disabled});
                return true;
            }
            if (action === 'move-up' || action === 'move-down') {
                const ok = await manager.moveCredential(index, action === 'move-up' ? 'up' : 'down');
                sendJson(res, ok ? 200 : 500, ok ? {message: '顺序已更新'} : {error: '移动失败'});
                return true;
            }
        }

        return false;
    } catch (error) {
        logger.error(`Qoder admin route failed (${subPath}):`, error);
        sendJson(res, 500, {error: error.message});
        return true;
    }
}
