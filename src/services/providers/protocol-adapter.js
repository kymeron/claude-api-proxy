/**
 * Provider protocol adapter facade.
 * Keeps upstream transport code decoupled from the protocol core file layout.
 * @module services/providers/protocol-adapter
 */

export {
    normalizePayload,
    normalizeResponsesPayload
} from '../../core/protocol/index.js';
