async function readStreamBody(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function readRelayRequestBody(req) {
    return readStreamBody(req);
}

export function readRelayResponseBody(stream) {
    return readStreamBody(stream);
}

export function parseRelaySSEBlock(block) {
    const lines = block.split(/\r?\n/);
    let event;
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
        }
    }

    return {event, data: dataLines.join('\n')};
}

export function getRelaySSEEventType(event, parsed) {
    return event || parsed?.type;
}

export async function* parseRelayResponsesSSEEvents(stream, signal) {
    let buffer = '';
    for await (const chunk of stream) {
        if (signal?.aborted) break;
        buffer += chunk.toString('utf8');
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';

        for (const part of parts) {
            const {event, data} = parseRelaySSEBlock(part);
            if (!data || data === '[DONE]') continue;
            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; }
            yield {type: getRelaySSEEventType(event, parsed), data: parsed};
        }
    }
}
