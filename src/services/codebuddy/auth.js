/**
 * CodeBuddy 单租户鉴权中间件
 * @module services/codebuddy/auth
 */

import logger from '../../utils/logger.js';
import {credentialStore} from './credential-store.js';

/**
 * 从请求头鉴权
 * @param {Object} headers - 请求头对象
 * @returns {Object} 鉴权结果：{authenticated: true} | {authenticated: false, error: string}
 */
export function authenticateRequest(headers) {
    let apiKey = null;

    // 优先从 Authorization: Bearer 提取
    const auth = headers['authorization'];
    if (auth) {
        apiKey = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    }

    // 兼容 x-api-key
    if (!apiKey) {
        apiKey = headers['x-api-key'];
    }

    if (!apiKey) {
        return {authenticated: false, error: 'Missing API key. Set Authorization: Bearer <key>'};
    }

    if (!credentialStore.authenticate(apiKey)) {
        logger.warn('Authentication failed: invalid API key');
        return {authenticated: false, error: 'Invalid API key'};
    }

    return {authenticated: true};
}

/**
 * 获取下一个可用凭证
 * @returns {Object|null} 凭证数据或 null
 */
export function getCredential() {
    return credentialStore.getNextCredential();
}
