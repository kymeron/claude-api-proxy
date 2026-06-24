import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
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
