import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const providersRoot = path.join(repoRoot, 'src', 'services', 'providers');

async function listJsFiles(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    const nested = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    }));
    return nested.flat();
}

test('providers expose upstream transport APIs from provider boundary', async () => {
    assert.equal((await stat(providersRoot)).isDirectory(), true);

    const providers = await import(pathToFileURL(path.join(providersRoot, 'index.js')).href);

    assert.equal(typeof providers.UpstreamManager, 'function');
    assert.equal(typeof providers.ProviderUpstreamError, 'function');
    assert.equal(typeof providers.createChatCompletions, 'function');
    assert.equal(typeof providers.createResponsesWebSocket, 'function');
    assert.equal(typeof providers.normalizeUpstreamProtocol, 'function');
    assert.equal(typeof providers.aggregateStreamResponse, 'function');
});

test('providers do not import product wrappers or routes', async () => {
    const files = await listJsFiles(providersRoot);
    assert.ok(files.length > 0, 'expected provider files');

    const forbiddenImports = [
        /from\s+['"][^'"]*(?:routes|services\/(?:relay|copilot|codebuddy|gateway))\//,
        /import\([^)]*['"][^'"]*(?:routes|services\/(?:relay|copilot|codebuddy|gateway))\//
    ];

    const violations = [];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const pattern of forbiddenImports) {
            if (pattern.test(source.replaceAll('\\', '/'))) {
                violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
                break;
            }
        }
    }

    assert.deepEqual(violations, []);
});
