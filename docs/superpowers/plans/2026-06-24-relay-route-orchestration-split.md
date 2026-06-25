# Relay Route Orchestration Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move relay route orchestration support out of `src/routes/relay.js` into focused relay service modules without changing protocol behavior.

**Architecture:** Keep protocol conversion in `src/protocol-engine` and relay protocol facades in `src/services/relay/protocol-adapter.js`. Extract route orchestration helpers into `src/services/relay/*` modules so HTTP handlers gradually become thin entrypoints over service APIs.

**Tech Stack:** Node.js ESM, `node:test`, existing service boundary tests, small commits after every green verification.

---

### Task 1: Relay Usage Service

**Files:**
- Create: `src/services/relay/usage.js`
- Modify: `src/routes/relay.js`
- Modify: `tests/service-adapter-boundary.test.js`
- Test: `tests/relay-usage-service.test.js`

- [ ] **Step 1: Write the failing service test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {recordRelayUsage, recordRelayResponsesUsage} from '../src/services/relay/usage.js';

test('recordRelayUsage records relay-scoped counters and daily usage', () => {
    const calls = [];
    const tenantManager = {
        incrementApiCallCount: (...args) => calls.push(['api', ...args]),
        incrementTokenUsage: (...args) => calls.push(['tokens', ...args]),
        recordDailyUsage: (...args) => calls.push(['daily', ...args])
    };

    recordRelayUsage({
        tenantManager,
        tenantId: 42,
        inputTokens: 11,
        outputTokens: 7,
        cacheHitTokens: 3,
        model: 'relay-model'
    });

    assert.deepEqual(calls, [
        ['api', 42, 'relay'],
        ['tokens', 42, 'relay', 11, 7, 3],
        ['daily', 42, 'relay', 11, 7, 3, 0, 'relay-model']
    ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/relay-usage-service.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/services/relay/usage.js`.

- [ ] **Step 3: Write minimal implementation**

Create `recordRelayUsage` and `recordRelayResponsesUsage`, then replace `recordUsage` and `recordResponsesUsage` in `src/routes/relay.js` with imports from the service.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/relay-usage-service.test.js tests/service-usage-isolation.test.js tests/auxiliary-endpoints-and-thinking.test.js`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/relay/usage.js src/routes/relay.js tests/relay-usage-service.test.js tests/service-adapter-boundary.test.js
git commit -m "抽离 Relay 用量记录服务"
```

### Task 2: Relay Conversation Key Service

**Files:**
- Create: `src/services/relay/conversation-key.js`
- Modify: `src/routes/relay.js`
- Test: `tests/relay-conversation-key-service.test.js`

- [ ] **Step 1: Write failing tests for header, payload metadata, and anchor fallback**
- [ ] **Step 2: Run test to verify module is missing**
- [ ] **Step 3: Move `normalizeConversationKey`, `extractConversationKeyFromPayload`, and `extractConversationKey` into the service with `buildConversationAnchorKey` injected or imported from relay protocol adapter**
- [ ] **Step 4: Run focused relay/session tests**
- [ ] **Step 5: Commit with message `抽离 Relay 会话键解析服务`**

### Task 3: Relay Upstream Context Service

**Files:**
- Create: `src/services/relay/upstream-context.js`
- Modify: `src/routes/relay.js`
- Test: `tests/relay-upstream-context-service.test.js`

- [ ] **Step 1: Write failing tests for auth error, missing upstream, and valid upstream context**
- [ ] **Step 2: Run test to verify module is missing**
- [ ] **Step 3: Move `authenticateAndGetUpstream`, `callUpstream`, `upstreamErrorStatus`, and protocol mismatch message helpers into the service**
- [ ] **Step 4: Run relay route and provider tests**
- [ ] **Step 5: Commit with message `抽离 Relay 上游上下文服务`**

### Task 4: Relay Handler Boundary Guard

**Files:**
- Modify: `tests/service-adapter-boundary.test.js`
- Optionally create: `src/services/relay/index.js`

- [ ] **Step 1: Add boundary tests that forbid `src/routes/relay.js` from calling `unifiedTenantManager.increment*`, `recordDailyUsage`, or `getUpstreamManager` directly**
- [ ] **Step 2: Verify the test fails before each extraction and passes after the service modules are wired**
- [ ] **Step 3: Export the new relay orchestration services from `src/services/relay/index.js` only if routes need a public product boundary**
- [ ] **Step 4: Run full verification**
- [ ] **Step 5: Commit with message `约束 Relay 路由编排边界`**
