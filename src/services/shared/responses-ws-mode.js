export const RESPONSES_WS_MODE_OFF = 'off';
export const RESPONSES_WS_MODE_CTX_POOL = 'ctx_pool';
export const RESPONSES_WS_MODE_PASSTHROUGH = 'passthrough';

const LEGACY_CTX_POOL_MODES = new Set(['shared', 'dedicated', RESPONSES_WS_MODE_PASSTHROUGH]);
const VALID_RESPONSES_WS_MODES = new Set([
    RESPONSES_WS_MODE_OFF,
    RESPONSES_WS_MODE_CTX_POOL
]);

export function normalizeResponsesWebSocketMode(value, fallback = RESPONSES_WS_MODE_CTX_POOL) {
    const normalizedFallback = VALID_RESPONSES_WS_MODES.has(String(fallback || '').trim().toLowerCase())
        ? String(fallback).trim().toLowerCase()
        : RESPONSES_WS_MODE_CTX_POOL;

    if (typeof value !== 'string') return normalizedFallback;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return normalizedFallback;
    if (LEGACY_CTX_POOL_MODES.has(normalized)) return RESPONSES_WS_MODE_CTX_POOL;
    if (VALID_RESPONSES_WS_MODES.has(normalized)) return normalized;
    return normalizedFallback;
}

export function resolveResponsesWebSocketMode(upstream = {}, fallback) {
    const envFallback = normalizeResponsesWebSocketMode(
        process.env.RESPONSES_WS_MODE || process.env.RELAY_RESPONSES_WS_MODE,
        fallback || RESPONSES_WS_MODE_CTX_POOL
    );
    let queryMode;
    try {
        if (upstream.base_url) {
            const url = new URL(upstream.base_url);
            queryMode = url.searchParams.get('ws_mode') || url.searchParams.get('responses_ws_mode');
        }
    } catch {}

    const configured =
        upstream.ws_mode ||
        upstream.responses_ws_mode ||
        upstream.openai_ws_mode ||
        upstream.extra?.ws_mode ||
        upstream.extra?.responses_ws_mode ||
        queryMode;

    return normalizeResponsesWebSocketMode(configured, envFallback);
}

export function shouldUseResponsesWebSocketPassthrough(upstream = {}, fallback) {
    const protocol = String(upstream.protocol || '').trim().toLowerCase();
    return protocol === 'responses_ws' &&
        resolveResponsesWebSocketMode(upstream, fallback) === RESPONSES_WS_MODE_PASSTHROUGH;
}
