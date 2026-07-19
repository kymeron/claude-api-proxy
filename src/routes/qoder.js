/**
 * Qoder route entrypoint.
 *
 * 极简路由表层：创建路由运行时，导出 HTTP 和 WS 处理函数。
 * 业务逻辑全部在 services/qoder/route-runtime.js 内部。
 *
 * @module routes/qoder
 */

import {
    resolveCredential,
    unifiedTenantManager
} from '../services/gateway/index.js';
import {createQoderRouteRuntime} from '../services/qoder/index.js';
import logger from '../utils/logger.js';

const qoderRuntime = createQoderRouteRuntime({
    tenantManager: unifiedTenantManager,
    resolveCredential,
    logger
});

export const {handleQoderResponsesWS} = qoderRuntime;

export async function routeQoderRequest(req, res) {
    return qoderRuntime.routeQoderRequest(req, res);
}