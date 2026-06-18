import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'fs';
import {getBehaviorRulesForModel} from '../src/config/model-prompt-router.js';

const MODEL_IDS = [
    'unknown-model',
    'glm-5.2',
    'deepseek-v4-pro',
    'kimi-k2',
    'minimax-m1'
];

function promptFor(modelId) {
    return getBehaviorRulesForModel(modelId);
}

const PROMPT_FILES = [
    'src/config/system-prompts.js',
    'src/config/glm.js',
    'src/config/deepseek.js',
    'src/config/kimi.js',
    'src/config/minimax.js'
];

test('all model prompts keep anti-assumption and clarification discipline explicit', () => {
    for (const modelId of MODEL_IDS) {
        const prompt = promptFor(modelId);
        assert.match(prompt, /不要把猜测包装成事实/, modelId);
        assert.match(prompt, /最小必要问题集/, modelId);
        assert.match(prompt, /1-3 个问题/, modelId);
        assert.match(prompt, /每个问题.*改变方案、边界或执行结果/, modelId);
        assert.match(prompt, /问题超过 3 个/, modelId);
    }
});

test('all model prompts keep hard search tiers instead of vague tool guidance', () => {
    for (const modelId of MODEL_IDS) {
        const prompt = promptFor(modelId);
        assert.match(prompt, /0 次外部搜索/, modelId);
        assert.match(prompt, /1 次搜索/, modelId);
        assert.match(prompt, /3-5 次工具调用或来源检查/, modelId);
        assert.match(prompt, /5-10 次工具调用或来源检查/, modelId);
        assert.match(prompt, /20\+ 次来源/, modelId);
        assert.match(prompt, /达到当前问题所需的最低证据量/, modelId);
        assert.match(prompt, /仍不确定时，明确说明不确定/, modelId);
    }
});

test('model prompts merge rules into semantic modules without standalone contract blocks', () => {
    assert.equal(existsSync('src/config/shared-behavior-contract.js'), false);

    for (const file of PROMPT_FILES) {
        const source = readFileSync(file, 'utf8');
        assert.doesNotMatch(source, /shared-behavior-contract/);
        assert.doesNotMatch(source, /SHARED_BEHAVIOR_CONTRACT/);
        assert.doesNotMatch(source, /behavior-contract/);
        assert.doesNotMatch(source, /动态上下文信号/);
        assert.doesNotMatch(source, /保留 sessionId/);
        assert.doesNotMatch(source, /保留 <session-id>/);
        assert.doesNotMatch(source, /保留 <session_knowledge>/);
        assert.doesNotMatch(source, /不搬移 <system-reminder>/);
        assert.doesNotMatch(source, /不排序 <system-reminder>/);
        assert.doesNotMatch(source, /不合并不同 reminder/);
    }
});

test('all model prompts keep currentness verification in model-owned rules', () => {
    for (const modelId of MODEL_IDS) {
        const prompt = promptFor(modelId);
        assert.match(prompt, /最新、当前、今天、现在、最近、仍然、是否支持、是否还有效/, modelId);
        assert.match(prompt, /不熟悉的产品、模型、库、版本、专有名词/, modelId);
    }
});

test('all model prompts preserve reasoning depth while reducing visible process chatter', () => {
    for (const modelId of MODEL_IDS) {
        const prompt = promptFor(modelId);
        assert.match(prompt, /简单.*1-2步/, modelId);
        assert.match(prompt, /中等.*3-5步/, modelId);
        assert.match(prompt, /复杂.*5-10步/, modelId);
        assert.match(prompt, /不要向用户展示完整隐藏思维链/, modelId);
        assert.match(prompt, /只输出结论、关键依据、必要步骤和不确定性/, modelId);
        assert.match(prompt, /减少.*过程性废话/, modelId);
    }
});

test('dynamic context retention remains transformer-owned rather than prompt-owned', () => {
    for (const modelId of MODEL_IDS) {
        const prompt = promptFor(modelId);
        assert.doesNotMatch(prompt, /动态上下文信号/, modelId);
        assert.doesNotMatch(prompt, /保留 sessionId/, modelId);
        assert.doesNotMatch(prompt, /保留 <session-id>/, modelId);
        assert.doesNotMatch(prompt, /不搬移 <system-reminder>/, modelId);
    }

    const stripTests = readFileSync('tests/strip-dynamic-reminders.test.js', 'utf8');
    assert.match(stripTests, /preserves Claude Code session identity/);
    assert.match(stripTests, /preserves bookkeeping system-reminders/);
    assert.match(stripTests, /does not relocate skills hooks mcp or deferred tool reminders/);
});

test('prompts do not reintroduce assumption-friendly shortcuts', () => {
    for (const modelId of MODEL_IDS) {
        const prompt = promptFor(modelId);
        assert.match(prompt, /不引入"低风险假设"/, modelId);
        assert.match(prompt, /不引入"先尽量回答模糊问题"/, modelId);
        assert.doesNotMatch(prompt, /(?:允许|采用|可以|默认).*低风险假设/, modelId);
        assert.doesNotMatch(prompt, /(?:允许|采用|可以|默认).*先尽量回答模糊问题/, modelId);
    }
});

test('relay compactor still preserves reasoning_content summaries for tool-call history', () => {
    const compactor = readFileSync('src/services/relay/context-compactor.js', 'utf8');

    assert.match(compactor, /reasoning_content/);
    assert.match(compactor, /parts\.push\(`reasoning:\\n\$\{message\.reasoning_content\}`\)/);
});
