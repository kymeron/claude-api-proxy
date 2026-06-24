export function pickCodebuddyUsageModel(upstreamModel, clientModel) {
    if (upstreamModel && !upstreamModel.startsWith('ep-')) return upstreamModel;
    return clientModel || upstreamModel;
}

export function recordCodebuddyUsage({
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
    tenantManager.incrementApiCallCount(tenantId, 'codebuddy');
    tenantManager.incrementTokenUsage(
        tenantId,
        'codebuddy',
        inputTokens,
        outputTokens,
        cacheHitTokens
    );
    tenantManager.incrementCreditUsage(tenantId, 'codebuddy', credit);
    tenantManager.recordDailyUsage(
        tenantId,
        'codebuddy',
        inputTokens,
        outputTokens,
        cacheHitTokens,
        credit,
        pickCodebuddyUsageModel(upstreamModel, clientModel)
    );
}

export function createCodebuddyUsageRecorder(tenantManager) {
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
            return recordCodebuddyUsage({
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
