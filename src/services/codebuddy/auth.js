/**
 * CodeBuddy 凭证管理
 * @module services/codebuddy/auth
 */

import {credentialStore} from './credential-store.js';

/**
 * 获取下一个可用凭证
 * @returns {Object|null} 凭证数据或 null
 */
export function getCredential() {
    return credentialStore.getNextCredential();
}

/**
 * 标记上次使用的凭证为 429 限速
 * @param {number} [durationMs] - 限速持续时间（毫秒）
 */
export function markLastReturnedRateLimited(durationMs) {
    credentialStore.markLastReturnedRateLimited(durationMs);
}

/**
 * 获取上次返回的凭证索引
 * @returns {number|null}
 */
export function getLastReturnedIndex() {
    return credentialStore.getLastReturnedIndex();
}
