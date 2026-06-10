import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {UpstreamManager} from '../src/services/relay/upstream-manager.js';

function createServer() {
    return new Promise((resolve, reject) => {
        const server = new WebSocketServer({host: '127.0.0.1', port: 0});
        server.once('error', reject);
        server.once('listening', () => {
            server.off('error', reject);
            resolve(server);
        });
    });
}

test('testUpstream verifies responses_ws upstreams through a WebSocket response', async () => {
    const server = await createServer();
    const port = server.address().port;
    test.after(() => new Promise((resolve) => server.close(resolve)));

    server.on('connection', (socket) => {
        socket.once('message', (raw) => {
            const request = JSON.parse(raw.toString('utf8'));
            assert.equal(request.type, 'response.create');
            assert.equal(request.model, 'gpt-test');

            socket.send(JSON.stringify({
                type: 'response.created',
                response: {id: 'resp_test', model: request.model}
            }));
            socket.send(JSON.stringify({
                type: 'response.completed',
                response: {
                    id: 'resp_test',
                    model: request.model,
                    usage: {input_tokens: 1, output_tokens: 1}
                }
            }));
        });
    });

    const manager = new UpstreamManager({tenantId: 1});
    manager.upstreams = [{
        name: 'Local Responses WS',
        protocol: 'responses_ws',
        base_url: `ws://127.0.0.1:${port}/v1`,
        api_key: 'sk-test',
        models: ['gpt-test'],
        enabled: true
    }];

    const result = await manager.testUpstream(0);

    assert.deepEqual(result, {
        success: true,
        message: '连接成功 (protocol: responses_ws, model: gpt-test)'
    });
});
