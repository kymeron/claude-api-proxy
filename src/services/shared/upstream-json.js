export function parseUpstreamJson(responseBody) {
    try {
        return JSON.parse(responseBody);
    } catch {
        const error = new Error('Upstream returned invalid JSON');
        error.status = 502;
        error.code = 'upstream_invalid_json';
        throw error;
    }
}
