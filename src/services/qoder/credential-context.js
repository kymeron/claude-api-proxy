/**
 * Qoder 凭证解析
 *
 * 把"从请求头获取 API key → 查找租户 → 挑选一个 PAT"这件事封装起来。
 * 与 codebuddy 形态对齐，但 bearer_token / backend 是 Qoder 专属字段。
 *
 * @module services/qoder/credential-context
 */

function listCredentialRecords(credentialService, tenantId) {
    if (typeof credentialService.listCredentials === 'function') {
        return credentialService.listCredentials(tenantId);
    }
    return {credentials: [], activeIndex: -1};
}

function getCredentialManager(credentialService, tenantId) {
    if (typeof credentialService.getCredentialManager === 'function') {
        return credentialService.getCredentialManager(tenantId);
    }
    return null;
}

/**
 * @returns {Promise<{credential: {bearer_token: string, backend: string, name?: string}, tenantId: number}|{error: {status: number, message: string}}>}
 */
export async function resolveQoderCredentialContext({
    req,
    credentialService,
    resolveCredential
}) {
    const tenantId = req.tenantId;
    if (!tenantId) {
        return {error: {status: 503, message: 'Qoder tenant system is not enabled'}};
    }

    const {credentials, activeIndex} = await listCredentialRecords(credentialService, tenantId);
    const credential = resolveCredential(req.headers, credentials, activeIndex);

    if (!credential) {
        return {error: {status: 503, message: 'No available credentials for tenant'}};
    }

    if (!credential.bearer_token) {
        return {error: {status: 503, message: 'Qoder credential missing bearer_token'}};
    }

    return {credential, tenantId};
}

export function createQoderCredentialResolver({
    credentialService,
    resolveCredential
}) {
    return (req) => resolveQoderCredentialContext({
        req,
        credentialService,
        resolveCredential
    });
}

export async function resolveQoderTenantCredentialManager({req, credentialService}) {
    const tenantId = req.tenantId;
    if (!tenantId) return {error: {status: 401, message: 'Unauthorized'}};
    const manager = await getCredentialManager(credentialService, tenantId);
    if (!manager) return {error: {status: 404, message: 'Tenant credential manager not available'}};
    return {manager, tenantId};
}

export function createQoderTenantCredentialManagerResolver({credentialService}) {
    return (req) => resolveQoderTenantCredentialManager({req, credentialService});
}