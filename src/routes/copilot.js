/**
 * Copilot route entrypoint.
 * @module routes/copilot
 */

import {createCopilotRouteRuntime} from '../services/copilot/index.js';
import {unifiedTenantManager} from '../services/gateway/index.js';
import logger from '../utils/logger.js';

const copilotRuntime = createCopilotRouteRuntime({
    tenantManager: unifiedTenantManager,
    logger
});

export const supportsResponsesWebSocket = copilotRuntime.supportsResponsesWebSocket;
export const {handleCopilotResponsesWS} = copilotRuntime;

export async function routeCopilotRequest(req, res) {
    return copilotRuntime.routeCopilotRequest(req, res);
}
