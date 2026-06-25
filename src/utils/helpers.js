import {randomBytes} from 'crypto';

/**
 * Generic helper utilities.
 * @module utils/helpers
 */

export function generateId(prefix) {
    const id = randomBytes(16).toString('hex');
    return prefix ? `${prefix}_${id}` : id;
}

export function buildUrl(baseUrl, endpoint) {
    let finalUrl = baseUrl;
    let finalEndpoint = endpoint;

    if (finalEndpoint.startsWith('/')) {
        finalEndpoint = finalEndpoint.slice(1);
    }

    if (!finalUrl.endsWith('/')) {
        finalUrl += '/';
    }

    let url = finalUrl + finalEndpoint;
    let prev;
    do {
        prev = url;
        url = url.replace(/\/(v\d+)\/v\d+\//g, '/$1/');
    } while (url !== prev);
    return url;
}
