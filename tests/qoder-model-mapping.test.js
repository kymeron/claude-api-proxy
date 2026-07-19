/**
 * Qoder 模型映射与配置单元测试
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    mapQoderModelName,
    isQoderModelToolsDisabled
} from '../src/services/qoder/model-mapping.js';

import {
    QODER_MODELS,
    getQoderBackend,
    getQoderCliBinary,
    getQoderModels,
    getQoderToolMaxRounds,
    isQoderStreamEnabled,
    getQoderCliTimeoutMs
} from '../src/services/qoder/config.js';

test('mapQoderModelName - passes through known model', () => {
    assert.equal(mapQoderModelName('qwen3.7-max'), 'qwen3.7-max');
});

test('mapQoderModelName - maps gpt-4 to auto', () => {
    assert.equal(mapQoderModelName('gpt-4'), 'auto');
});

test('mapQoderModelName - maps gpt-4o-mini to flash', () => {
    assert.equal(mapQoderModelName('gpt-4o-mini'), 'qwen3.6-flash');
});

test('mapQoderModelName - maps claude- to auto', () => {
    assert.equal(mapQoderModelName('claude-sonnet-4'), 'auto');
    assert.equal(mapQoderModelName('claude-3-5-haiku'), 'qwen3.6-flash');
});

test('mapQoderModelName - handles invalid input', () => {
    assert.equal(mapQoderModelName(null), 'auto');
    assert.equal(mapQoderModelName(undefined), 'auto');
    assert.equal(mapQoderModelName(''), 'auto');
});

test('mapQoderModelName - preserves unknown model', () => {
    assert.equal(mapQoderModelName('custom-model-xyz'), 'custom-model-xyz');
});

test('mapQoderModelName - fallback parameter', () => {
    assert.equal(mapQoderModelName(null, 'qwen3.7-max'), 'qwen3.7-max');
});

test('isQoderModelToolsDisabled - returns false for tools-capable model', () => {
    const list = [{id: 'qwen3.7-max', tools: true}];
    assert.equal(isQoderModelToolsDisabled('qwen3.7-max', list), false);
});

test('isQoderModelToolsDisabled - returns true for non-tools model', () => {
    const list = [{id: 'qwen3.6-flash', tools: false}];
    assert.equal(isQoderModelToolsDisabled('qwen3.6-flash', list), true);
});

test('isQoderModelToolsDisabled - returns false for unknown model', () => {
    const list = [{id: 'qwen3.7-max', tools: true}];
    assert.equal(isQoderModelToolsDisabled('unknown', list), false);
});

test('QODER_MODELS - includes auto', () => {
    assert.ok(QODER_MODELS.find(m => m.id === 'auto'));
});

test('QODER_MODELS - includes effort variants', () => {
    assert.ok(QODER_MODELS.find(m => m.id === 'qwen3.7-max-effort-high'));
});

test('getQoderBackend - default cn', () => {
    // 清空 env 变量以确保默认值
    const saved = process.env.QODER_CLI_BACKEND;
    delete process.env.QODER_CLI_BACKEND;
    assert.equal(getQoderBackend(), 'cn');
    if (saved) process.env.QODER_CLI_BACKEND = saved;
});

test('getQoderBackend - global', () => {
    const saved = process.env.QODER_CLI_BACKEND;
    process.env.QODER_CLI_BACKEND = 'global';
    assert.equal(getQoderBackend(), 'global');
    if (saved) process.env.QODER_CLI_BACKEND = saved;
    else delete process.env.QODER_CLI_BACKEND;
});

test('getQoderCliBinary - both backends return qodercli', () => {
    // 现实情况：@qoder-ai/qodercli npm 包只提供 qodercli 单一二进制
    // 后端通过 PAT 账号区域区分
    assert.equal(getQoderCliBinary('cn'), 'qodercli');
    assert.equal(getQoderCliBinary('global'), 'qodercli');
});

test('getQoderModels - returns default list when env unset', () => {
    const saved = process.env.QODER_MODELS;
    delete process.env.QODER_MODELS;
    const list = getQoderModels();
    assert.ok(Array.isArray(list));
    assert.ok(list.length > 0);
    if (saved) process.env.QODER_MODELS = saved;
});

test('getQoderModels - parses JSON override', () => {
    const saved = process.env.QODER_MODELS;
    process.env.QODER_MODELS = JSON.stringify([{id: 'custom', name: 'Custom', tools: true}]);
    const list = getQoderModels();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'custom');
    if (saved) process.env.QODER_MODELS = saved;
    else delete process.env.QODER_MODELS;
});

test('getQoderModels - falls back to default on invalid JSON', () => {
    const saved = process.env.QODER_MODELS;
    process.env.QODER_MODELS = 'not-json{';
    const list = getQoderModels();
    assert.equal(list, QODER_MODELS);
    if (saved) process.env.QODER_MODELS = saved;
    else delete process.env.QODER_MODELS;
});

test('getQoderToolMaxRounds - default 10', () => {
    const saved = process.env.QODER_TOOL_MAX_ROUNDS;
    delete process.env.QODER_TOOL_MAX_ROUNDS;
    assert.equal(getQoderToolMaxRounds(), 10);
    if (saved) process.env.QODER_TOOL_MAX_ROUNDS = saved;
});

test('isQoderStreamEnabled - default true', () => {
    const saved = process.env.QODER_STREAM_ENABLED;
    delete process.env.QODER_STREAM_ENABLED;
    assert.equal(isQoderStreamEnabled(), true);
    if (saved) process.env.QODER_STREAM_ENABLED = saved;
});

test('getQoderCliTimeoutMs - default 300000', () => {
    const saved = process.env.QODER_CLI_TIMEOUT_MS;
    delete process.env.QODER_CLI_TIMEOUT_MS;
    assert.equal(getQoderCliTimeoutMs(), 300000);
    if (saved) process.env.QODER_CLI_TIMEOUT_MS = saved;
});