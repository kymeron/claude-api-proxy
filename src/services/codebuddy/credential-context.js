import {resolveCredential as defaultResolveCredential} from '../gateway/index.js';

export async function resolveCodebuddyCredentialContext({req, tenantManager, resolveCredential = defaultResolveCredential}) {
    const tenantId = req.tenantId;
    if (!tenantId) {
        return {error: {status: 503, message: 'CodeBuddy tenant system is not enabled'}};
    }

    const {credentials, activeIndex} = (await tenantManager.listCodebuddyCredentials)
        ? await tenantManager.listCodebuddyCredentials(tenantId)
        : {credentials: [], activeIndex: -1};

    const credential = resolveCredential(req.headers, credentials, activeIndex);

    if (!credential) {
        return {error: {status: 503, message: 'No available credentials for tenant'}};
    }

    return {credential, tenantId};
}

export function createCodebuddyCredentialResolver({tenantManager, resolveCredential = defaultResolveCredential}) {
    return (req) => resolveCodebuddyCredentialContext({req, tenantManager, resolveCredential});
}

export async function resolveCodebuddyTenantCredentialManager({req, tenantManager}) {
    const tenantId = req.tenantId;
    if (!tenantId) return {error: {status: 401, message: 'Unauthorized'}};
    const manager = (await tenantManager.getCodebuddyCredentialManager)
        ? await tenantManager.getCodebuddyCredentialManager(tenantId)
        : null;
    if (!manager) return {error: {status: 404, message: 'Tenant credential manager not available'}};
    return {manager, tenantId};
}

export function createCodebuddyTenantCredentialManagerResolver({tenantManager}) {
    return (req) => resolveCodebuddyTenantCredentialManager({req, tenantManager});
}
