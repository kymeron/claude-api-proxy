# Responses WebSocket Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `off/ctx_pool` Responses WebSocket behavior with official URL handling and compatibility for `?ws=true`; treat legacy `passthrough` as `ctx_pool`.

**Architecture:** Keep `ctx_pool` as the default pooled protocol bridge. Relay Responses WS ingress should stay on the stateful bridge so conversation state can be recorded. Preserve OpenAI official URL semantics while allowing upstream query flags.

**Tech Stack:** Node.js ESM, `ws`, `node:test`, existing Relay shared services.

---

### Task 1: Protocol Tests

**Files:**
- Modify: `tests/relay-responses-ws.test.js`
- Modify: `tests/responses-ws-client.test.js`
- [ ] Add failing tests for `?ws=true` URL preservation, direct `/responses` URL handling, mode normalization, and payload preservation.
- [ ] Run targeted tests and confirm failures are caused by missing behavior.

### Task 2: Shared Helpers

**Files:**
- Create: `src/services/shared/responses-ws-mode.js`
- Modify: `src/services/shared/responses-ws-client.js`
- [ ] Implement mode normalization and legacy `passthrough` compatibility.
- [ ] Preserve valid Responses fields in WS payloads while removing only `stream` and `background`.

### Task 3: Relay Wiring

**Files:**
- Modify: `src/services/relay/api.js`
- Modify: `src/routes/relay.js`

- [ ] Fix `buildResponsesWebSocketUrl()` to parse URLs and preserve queries.
- [ ] Add optional mode metadata to Relay WS handling.
- [ ] Keep `/relay/v1/responses` WS ingress on the stateful bridge for `responses_ws` upstreams.

### Task 4: Verification

**Files:**
- Test command: `npm test`

- [ ] Run targeted WS tests.
- [ ] Run full `npm test`.
- [ ] Review `git diff` for unrelated edits before reporting.
