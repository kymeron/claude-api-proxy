/**
 * Relay upstream context and call helpers.
 * Keeps route handlers focused on protocol handling instead of gateway/provider plumbing.
 * @module services/relay/upstream-context
 */

import {
    normalizeUpstreamProtocol,
    ProviderUpstreamError
} from '../providers/index.js';
import {isNetworkError, readBody} from '../../utils/http-client.js';

export function relayUpstreamErrorStatus(error) {
    if (error instanceof ProviderUpstreamError && error.status) return error.status;
    if (Number.isInteger(error?.status) && error.status >= 400) return error.status;
    if (isNetworkError(error)) return 502;
    return 500;
}

export function getRelayProtocolErrorMessage(upstream, expectedProtocol, endpoint) {
    const protocol = normalizeUpstreamProtocol(upstream?.protocol);
    if (protocol === expectedProtocol) return null;
    if (expectedProtocol === 'anthropic') {
        return `当前上游协议为 ${protocol}，请改用 ${endpoint} 或切换上游类型`;
    }
    return `当前上游协议为 ${protocol}，该端点需要 ${expectedProtocol} 上游支持`;
}

export async function resolveRelayUpstreamContext({req, tenantManager}) {
    const tenantId = req.tenantId;
    if (!tenantId) {
        return {error: {status: 503, message: 'Relay tenant system is not enabled'}};
    }

    const upstreamManager = await tenantManager.getUpstreamManager(tenantId);
    if (!upstreamManager) {
        return {error: {status: 503, message: 'Tenant upstream manager not found'}};
    }

    const upstream = upstreamManager.getActiveUpstream();
    if (!upstream) {
        return {
            error: {
                status: 503,
                message: '未配置可用上游，请在管理面板 /dashboard 配置'
            }
        };
    }

    return {upstream, tenantId, upstreamManager};
}

export function createRelayUpstreamContextResolver(tenantManager) {
    return (req) => resolveRelayUpstreamContext({req, tenantManager});
}

export async function callRelayUpstream(upstream, fn) {
    const response = await fn(upstream);
    if (response.status >= 200 && response.status < 300) {
        return {response, upstream};
    }
    const errorBody = await readBody(response.body);
    throw new Error(`上游「${upstream.name}」返回 HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
}
