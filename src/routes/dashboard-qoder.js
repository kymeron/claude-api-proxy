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
 * @module routes/dashboard-qoder
 */

import logger from '../utils/logger.js';
import {unifiedTenantManager} from '../services/gateway/index.js';
import {getQoderCredentialService} from '../services/qoder/index.js';

const qoderCredentialService = getQoderCredentialService(unifiedTenantManager);

function sendJson(res, status, data) {
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
 * 派发 /dashboard/tenants/:id/qoder/* 子路径
 *
 * @returns {boolean} 是否处理了请求
 */
export async function handleQoderAdminRoute(req, res, tenantId, subPath) {
    const qoderMatch = subPath.match(/^\/qoder(\/.*)?$/);
    if (!qoderMatch) return false;

    const tail = qoderMatch[1] || '';
    const method = req.method;

    // 列出凭证
    if (tail === '/credentials' && method === 'GET') {
        try {
            const data = await qoderCredentialService.listCredentials(tenantId);
            // 隐藏完整 token，仅返回预览
            const credentials = (data.credentials || []).map(cred => ({
                id: cred.id,
                index: cred.index,
                enabled: cred.enabled,
                name: cred.name || '',
                backend: cred.backend || 'cn',
                tokenPreview: cred.bearer_token
                    ? `${cred.bearer_token.slice(0, 4)}...${cred.bearer_token.slice(-4)}`
                    : ''
            }));
            return sendJson(res, 200, {
                credentials,
                activeIndex: data.activeIndex
            });
        } catch (err) {
            logger.error('List Qoder credentials failed:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 新增凭证
    if (tail === '/credentials' && method === 'POST') {
        try {
            const body = await readRequestBody(req);
            const {name, bearer_token, backend} = body;
            if (!bearer_token || typeof bearer_token !== 'string') {
                return sendJson(res, 400, {error: 'bearer_token 必填'});
            }
            const manager = await qoderCredentialService.getCredentialManager(tenantId);
            const ok = await manager.addCredentialWithData({
                name: (name || '').trim(),
                bearer_token,
                backend: ['cn', 'global'].includes(backend) ? backend : 'cn'
            });
            if (!ok) return sendJson(res, 500, {error: '保存失败'});
            return sendJson(res, 200, {message: '凭证已添加'});
        } catch (err) {
            logger.error('Add Qoder credential failed:', err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    // 删除 / 切换活跃 / 启用切换 / 上下移
    const actionMatch = tail.match(/^\/credentials\/(delete|active|toggle|move-up|move-down)$/);
    if (actionMatch && method === 'POST') {
        try {
            const action = actionMatch[1];
            const body = await readRequestBody(req);
            const {index} = body;
            if (!Number.isInteger(index) || index < 0) {
                return sendJson(res, 400, {error: 'index 必填且为非负整数'});
            }

            const manager = await qoderCredentialService.getCredentialManager(tenantId);

            if (action === 'delete') {
                const ok = await manager.deleteCredential(index);
                return sendJson(res, ok ? 200 : 500, ok ? {message: '已删除'} : {error: '删除失败'});
            }
            if (action === 'active') {
                const ok = await manager.setActiveCredential(index);
                return sendJson(res, ok ? 200 : 500, ok ? {message: '已切换活跃凭证'} : {error: '切换失败'});
            }
            if (action === 'toggle') {
                const result = await manager.toggleCredentialDisable(index);
                return sendJson(res, 200, {message: '已更新', disabled: result.disabled});
            }
            if (action === 'move-up' || action === 'move-down') {
                const ok = await manager.moveCredential(index, action === 'move-up' ? 'up' : 'down');
                return sendJson(res, ok ? 200 : 500, ok ? {message: '顺序已更新'} : {error: '移动失败'});
            }
        } catch (err) {
            logger.error(`Qoder credential ${actionMatch[1]} failed:`, err);
            return sendJson(res, 500, {error: err.message});
        }
    }

    return false;
}