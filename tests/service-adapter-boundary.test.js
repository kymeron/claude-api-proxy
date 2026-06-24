import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const servicesRoot = path.join(repoRoot, 'src', 'services');

async function listJsFiles(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    const nested = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    }));
    return nested.flat();
}

test('product services name protocol shims as adapters instead of translators', async () => {
    const files = await listJsFiles(servicesRoot);
    const forbiddenFiles = files
        .map((file) => path.relative(repoRoot, file).replaceAll('\\', '/'))
        .filter((file) => /(?:^|\/)(?:.*-)?translator\.js$/.test(path.basename(file)));

    assert.deepEqual(forbiddenFiles, []);
});

test('routes do not depend on another product service API for shared helpers', async () => {
    const checkedRoutes = [
        'src/routes/relay.js',
        'src/routes/copilot.js'
    ];
    const violations = [];

    for (const route of checkedRoutes) {
        const source = await readFile(path.join(repoRoot, route), 'utf8');
        if (/services\/codebuddy\/api\.js/.test(source.replaceAll('\\', '/'))) {
            violations.push(route);
        }
    }

    assert.deepEqual(violations, []);
});

test('relay and codebuddy anthropic adapters delegate request conversion to core protocol', async () => {
    const checkedAdapters = [
        'src/services/relay/anthropic-adapter.js',
        'src/services/codebuddy/anthropic-adapter.js'
    ];
    const privateRequestHelpers = /\bfunction\s+(?:translateMessages|handleUserMessage|handleAssistantMessage|translateTools|resolveThinkingConfig)\b/;
    const violations = [];

    for (const adapter of checkedAdapters) {
        const source = await readFile(path.join(repoRoot, adapter), 'utf8');
        if (privateRequestHelpers.test(source)) {
            violations.push(adapter);
        }
    }

    assert.deepEqual(violations, []);
});
