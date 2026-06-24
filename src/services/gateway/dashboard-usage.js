import {Op} from 'sequelize';
import {models} from '../../db/models/index.js';

export function aggregateDashboardUsageRows(rows) {
    const totals = {apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, credit: 0};
    const monthly = new Map();
    const daily = new Map();
    const modelsByName = new Map();

    for (const row of rows) {
        const apiCalls = Number(row.api_calls || 0);
        const inputTokens = Number(row.input_tokens || 0);
        const outputTokens = Number(row.output_tokens || 0);
        const cacheHitTokens = Number(row.input_cache_hit || 0);
        const credit = Number(row.credit || 0);
        totals.apiCalls += apiCalls;
        totals.inputTokens += inputTokens;
        totals.outputTokens += outputTokens;
        totals.cacheHitTokens += cacheHitTokens;
        totals.credit += credit;

        const month = String(row.date || '').slice(0, 7);
        const day = row.date;
        const model = row.model || 'unknown';
        for (const [key, map] of [[month, monthly], [day, daily], [model, modelsByName]]) {
            if (!key) continue;
            const item = map.get(key) || {key, apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, credit: 0};
            item.apiCalls += apiCalls;
            item.inputTokens += inputTokens;
            item.outputTokens += outputTokens;
            item.cacheHitTokens += cacheHitTokens;
            item.credit += credit;
            map.set(key, item);
        }
    }

    const withRate = item => ({
        ...item,
        cacheHitRate: item.inputTokens > 0 ? Math.round((item.cacheHitTokens / item.inputTokens) * 1000) / 10 : 0
    });
    return {
        totals: withRate({...totals, totalTokens: totals.inputTokens + totals.outputTokens}),
        monthlyTrend: [...monthly.values()].sort((a, b) => a.key.localeCompare(b.key)).map(item => withRate({month: item.key, ...item})),
        dailyTrend: [...daily.values()].sort((a, b) => a.key.localeCompare(b.key)).map(item => withRate({date: item.key, ...item})),
        modelStats: [...modelsByName.values()].sort((a, b) => b.inputTokens - a.inputTokens).map(item => withRate({model: item.key, ...item}))
    };
}

export async function getDashboardUsageOverview({
    tenantManager,
    username,
    serviceType
}) {
    let tenantId = tenantManager.findTenantByUsername(username);
    if (!tenantId) tenantId = await tenantManager.createTenantForUser(username, username);
    const tenant = tenantManager.getTenant(tenantId);
    const serviceProfile = tenant?.serviceProfiles?.find(profile => profile.service_type === serviceType);
    if (!serviceProfile?.enabled && !tenantManager.isAdmin(username)) {
        return {ok: false, status: 403, error: 'Service is not enabled'};
    }

    await tenantManager._flushDirtyTenants();
    const rows = await models.TenantDailyUsage.findAll({
        where: {tenant_id: tenantId, service_type: serviceType},
        order: [['date', 'ASC'], ['model', 'ASC']],
        raw: true
    });
    const aggregated = aggregateDashboardUsageRows(rows);
    return {
        ok: true,
        service: serviceType,
        tenant,
        ...aggregated,
        recentRows: rows.slice(-100).reverse()
    };
}

export async function listDashboardTenantMonthlyUsage({
    tenantManager,
    tenantId,
    serviceType,
    month
}) {
    await tenantManager._flushDirtyTenants();
    const rows = await models.TenantDailyUsage.findAll({
        where: {
            tenant_id: tenantId,
            service_type: serviceType,
            date: {[Op.like]: `${month}-%`}
        },
        order: [['date', 'ASC'], ['model', 'ASC']]
    });
    return rows.map(row => row.toJSON());
}
