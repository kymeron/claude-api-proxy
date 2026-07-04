/**
 * Qoder 渠道公共边界（re-export）
 *
 * @module services/qoder
 */

export {TenantTokenManager} from './tenant-token-manager.js';

export {
    QODER_MODELS,
    getQoderModels,
    getQoderBackend,
    getQoderCliBinary,
    getQoderCliPath,
    getQoderDefaultModel,
    isQoderStreamEnabled,
    getQoderToolMaxRounds,
    getQoderCliTimeoutMs,
    getQoderJsonDepthLimit,
    getQoderMaxTokens
} from './config.js';

export {
    QoderCredentialService,
    createQoderCredentialService,
    getQoderCredentialService
} from './credential-service.js';

export {createQoderRouteRuntime} from './route-runtime.js';

export {mapQoderModelName, isQoderModelToolsDisabled} from './model-mapping.js';