/**
 * Qoder prompt-builder 单元测试
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPrompt,
    buildToolsDescription,
    buildToolSystemPrompt
} from '../src/services/qoder/prompt-builder.js';

test('buildPrompt - simple user/assistant messages', () => {
    const prompt = buildPrompt([
        {role: 'user', content: 'Hello'},
        {role: 'assistant', content: 'Hi there'}
    ], {});
    assert.match(prompt, /\[1\] USER: Hello/);
    assert.match(prompt, /\[2\] ASSISTANT: Hi there/);
    assert.match(prompt, /\[ASSISTANT\]:/);
});

test('buildPrompt - extracts and uses OpenAI system message', () => {
    const prompt = buildPrompt([
        {role: 'system', content: 'You are helpful.'},
        {role: 'user', content: 'Hi'}
    ], {});
    assert.match(prompt, /\[SYSTEM\]/);
    assert.match(prompt, /You are helpful\./);
    // system message should not appear as numbered message
    assert.doesNotMatch(prompt, /\[1\] SYSTEM:/);
});

test('buildPrompt - Anthropic-style top-level system', () => {
    const prompt = buildPrompt([
        {role: 'user', content: 'Hi'}
    ], {systemPrompt: 'Custom system'});
    assert.match(prompt, /Custom system/);
});

test('buildPrompt - tools inject instructions', () => {
    const tools = [
        {type: 'function', function: {name: 'search', description: 'Search web', parameters: {type: 'object', properties: {q: {type: 'string'}}}}}
    ];
    const prompt = buildPrompt([{role: 'user', content: 'Find info'}], {tools});
    assert.match(prompt, /tool_calls/);
    assert.match(prompt, /search/);
});

test('buildPrompt - no tools, no system adds minimal guidance', () => {
    const prompt = buildPrompt([{role: 'user', content: 'Hi'}], {});
    assert.match(prompt, /helpful assistant/);
});

test('buildPrompt - empty messages still produces output', () => {
    const prompt = buildPrompt([], {});
    assert.match(prompt, /\[ASSISTANT\]:/);
});

test('buildPrompt - handles multi-modal content blocks', () => {
    const messages = [{
        role: 'user',
        content: [
            {type: 'text', text: 'Look at this image'},
            {type: 'image_url', image_url: {url: 'https://example.com/x.png'}}
        ]
    }];
    const prompt = buildPrompt(messages, {});
    assert.match(prompt, /Look at this image/);
    assert.match(prompt, /\[image\]/);
});

test('buildPrompt - handles tool_use block', () => {
    const messages = [{
        role: 'assistant',
        content: [
            {type: 'text', text: 'Calling tool'},
            {type: 'tool_use', id: 'c1', name: 'search', input: {q: 'foo'}}
        ]
    }];
    const prompt = buildPrompt(messages, {});
    assert.match(prompt, /Calling tool/);
    assert.match(prompt, /\[tool_call:search/);
});

test('buildPrompt - handles tool_result block', () => {
    const messages = [{
        role: 'user',
        content: [
            {type: 'tool_result', content: 'result data', tool_use_id: 'c1'}
        ]
    }];
    const prompt = buildPrompt(messages, {});
    assert.match(prompt, /\[tool_result/);
});

test('buildToolsDescription - OpenAI function format', () => {
    const tools = [{type: 'function', function: {name: 'f', description: 'desc', parameters: {type: 'object'}}}];
    const result = buildToolsDescription(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'f');
    assert.equal(result[0].description, 'desc');
    assert.deepEqual(result[0].parameters, {type: 'object'});
});

test('buildToolsDescription - flat format', () => {
    const tools = [{name: 'f', description: 'd', parameters: {}}];
    const result = buildToolsDescription(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'f');
});

test('buildToolsDescription - filters out nulls', () => {
    const tools = [null, {name: 'f', description: 'd', parameters: {}}];
    const result = buildToolsDescription(tools);
    assert.equal(result.length, 1);
});

test('buildToolSystemPrompt - empty tools', () => {
    assert.equal(buildToolSystemPrompt([]), '');
});

test('buildToolSystemPrompt - produces instruction template', () => {
    const result = buildToolSystemPrompt([{name: 'f', description: 'd', parameters: {}}]);
    assert.match(result, /tool_calls/);
    assert.match(result, /f/);
    assert.match(result, /Rules:/);
});

test('buildPrompt - appendToolInstruction=false skips tool injection', () => {
    const tools = [{type: 'function', function: {name: 'search', parameters: {}}}];
    const prompt = buildPrompt([{role: 'user', content: 'Hi'}], {tools, appendToolInstruction: false});
    assert.doesNotMatch(prompt, /tool_calls/);
});