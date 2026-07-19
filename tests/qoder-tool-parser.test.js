/**
 * Qoder 工具调用解析单元测试
 *
 * 覆盖场景：
 *  - markdown 代码块提取
 *  - 裸 JSON 提取
 *  - 嵌套对象（深度花括号）
 *  - 字符串内嵌大括号
 *  - 多 tool_calls
 *  - 无 tool_calls
 *  - 异常 JSON（不影响后续）
 *  - 单个 tool_call 对象
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    parseToolCallOutput,
    extractBalancedJsonWithToolCalls
} from '../src/services/qoder/tool-parser.js';

test('parseToolCallOutput - markdown code block', () => {
    const text = `
I'll search for that.

\`\`\`json
{"tool_calls":[{"id":"call_001","name":"search","arguments":{"q":"weather"}}]}
\`\`\`
`;
    const result = parseToolCallOutput(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'search');
    assert.deepEqual(result[0].arguments, {q: 'weather'});
    assert.equal(result[0].id, 'call_001');
});

test('parseToolCallOutput - bare JSON in text', () => {
    const text = `Output: {"tool_calls":[{"id":"c1","name":"calc","arguments":{"x":1}}]} end`;
    const result = parseToolCallOutput(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'calc');
    assert.equal(result[0].arguments.x, 1);
});

test('parseToolCallOutput - nested object', () => {
    const text = `{"tool_calls":[{"id":"c1","name":"f","arguments":{"a":{"b":{"c":"d"}}}}]}`;
    const result = parseToolCallOutput(text);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].arguments, {a: {b: {c: 'd'}}});
});

test('parseToolCallOutput - string containing braces', () => {
    const text = `noise {"tool_calls":[{"id":"c1","name":"g","arguments":{"msg":"hello {world}"}}]} more`;
    const result = parseToolCallOutput(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'g');
    assert.equal(result[0].arguments.msg, 'hello {world}');
});

test('parseToolCallOutput - empty', () => {
    assert.deepEqual(parseToolCallOutput(''), []);
    assert.deepEqual(parseToolCallOutput(null), []);
    assert.deepEqual(parseToolCallOutput(undefined), []);
});

test('parseToolCallOutput - no tool_calls returns empty', () => {
    const text = 'Just plain text answer.';
    assert.deepEqual(parseToolCallOutput(text), []);
});

test('parseToolCallOutput - multiple tool calls', () => {
    const text = `{
        "tool_calls": [
            {"id": "c1", "name": "search", "arguments": {"q": "foo"}},
            {"id": "c2", "name": "calc", "arguments": {"x": 1}}
        ]
    }`;
    const result = parseToolCallOutput(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'search');
    assert.equal(result[1].name, 'calc');
});

test('parseToolCallOutput - input field alias', () => {
    const text = `{"tool_calls":[{"id":"c1","name":"f","input":{"a":1}}]}`;
    const result = parseToolCallOutput(text);
    assert.equal(result[0].arguments.a, 1);
});

test('parseToolCallOutput - function.arguments string', () => {
    const text = `{"tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{\\"a\\":1}"}}]}`;
    const result = parseToolCallOutput(text);
    assert.equal(result[0].name, 'f');
    assert.equal(result[0].arguments.a, 1);
});

test('parseToolCallOutput - invalid JSON in middle does not crash', () => {
    const text = `valid1 {"tool_calls":[{"id":"c1","name":"a","arguments":{}}]} garbage {not valid json} valid2 {"tool_calls":[{"id":"c2","name":"b","arguments":{}}]}`;
    const result = parseToolCallOutput(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'a');
    assert.equal(result[1].name, 'b');
});

test('extractBalancedJsonWithToolCalls - simple', () => {
    const text = 'noise {"a":1, "b":2} noise {"c":3}';
    const result = extractBalancedJsonWithToolCalls(text);
    assert.equal(result.length, 2);
    assert.equal(result[0], '{"a":1, "b":2}');
    assert.equal(result[1], '{"c":3}');
});

test('extractBalancedJsonWithToolCalls - string with braces', () => {
    const text = 'a {"a":1, "b":"x{y}z"} b';
    const result = extractBalancedJsonWithToolCalls(text);
    assert.equal(result.length, 1);
    assert.equal(result[0], '{"a":1, "b":"x{y}z"}');
});

test('extractBalancedJsonWithToolCalls - unbalanced stops gracefully', () => {
    const text = '{"a":1, "b":{"c":2'; // never closes
    const result = extractBalancedJsonWithToolCalls(text);
    // Either empty or partial; we don't require a specific count, just no throw
    assert.ok(Array.isArray(result));
});

test('extractBalancedJsonWithToolCalls - depth limit prevents runaway', () => {
    // Build a deeply nested object past default limit
    let text = '';
    for (let i = 0; i < 50; i++) text += '{"a":';
    for (let i = 0; i < 50; i++) text += '}';
    const result = extractBalancedJsonWithToolCalls(text, 10);
    assert.ok(Array.isArray(result));
});

test('parseToolCallOutput - handles missing name gracefully', () => {
    const text = `{"tool_calls":[{"id":"c1","arguments":{"x":1}}]}`; // no name
    const result = parseToolCallOutput(text);
    assert.equal(result.length, 0);
});