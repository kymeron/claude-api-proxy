/**
 * Qoder 用量记录
 *
 * Qoder CLI 不返回 token 计数，因此 prompt_tokens / completion_tokens
 * 由调用方估算（utils/token-estimation.js）后传入本模块。
 *
 * @module services/qoder/usage
 */

export function pickQoderUsageModel(upstreamModel, clientModel) {
    if (upstreamModel && !upstreamModel.startsWith('ep-')) return upstreamModel;
    return clientModel || upstreamModel;
}

export function recordQoderUsage({
    tenantManager,
    tenantId,
    inputTokens,
    outputTokens,
    cacheHitTokens = 0,
    credit = 0,
    upstreamModel,
    clientModel
}) {
    if (!tenantId) return;
    tenantManager.incrementApiCallCount(tenantId, 'qoder');
    tenantManager.incrementTokenUsage(
        tenantId,
        'qoder',
        inputTokens,
        outputTokens,
        cacheHitTokens
    );
    tenantManager.incrementCreditUsage(tenantId, 'qoder', credit);
    tenantManager.recordDailyUsage(
        tenantId,
        'qoder',
        inputTokens,
        outputTokens,
        cacheHitTokens,
        credit,
        pickQoderUsageModel(upstreamModel, clientModel)
    );
}

export function createQoderUsageRecorder(tenantManager) {
    return {
        recordUsage(
            tenantId,
            inputTokens,
            outputTokens,
            cacheHitTokens = 0,
            credit = 0,
            upstreamModel,
            clientModel
        ) {
            return recordQoderUsage({
                tenantManager,
                tenantId,
                inputTokens,
                outputTokens,
                cacheHitTokens,
                credit,
                upstreamModel,
                clientModel
            });
        }
    };
}