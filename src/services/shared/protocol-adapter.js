/**
 * Shared service protocol adapter facade.
 * Keeps shared service utilities decoupled from the protocol core file layout.
 * @module services/shared/protocol-adapter
 */

export {
    extractCacheHitTokens,
    injectBehaviorRules,
    limitResponsesInputItems,
    sanitizeResponsesInput
} from '../../protocol-engine/index.js';
