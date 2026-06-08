# Responses WebSocket Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `off/ctx_pool/passthrough` Responses WebSocket behavior with official URL handling and compatibility for `?ws=true`.

**Architecture:** Keep `ctx_pool` as the default pooled protocol bridge. Add a narrow passthrough relay for Relay Responses WS ingress when the active upstream is `responses_ws`. Preserve OpenAI official URL semantics while allowing upstream query flags.

**Tech Stack:** Node.js ESM, `ws`, `node:test`, existing Relay shared services.

---

### Task 1: Protocol Tests

**Files:**
- Modify: `tests/relay-responses-ws.test.js`
- Modify: `tests/responses-ws-client.test.js`
- Create: `tests/responses-ws-passthrough.test.js`

- [ ] Add failing tests for `?ws=true` URL preservation, direct `/responses` URL handling, mode normalization, payload preservation, and passthrough frame relay.
- [ ] Run targeted tests and confirm failures are caused by missing behavior.

### Task 2: Shared Helpers

**Files:**
- Create: `src/services/shared/responses-ws-mode.js`
- Modify: `src/services/shared/responses-ws-client.js`
- Create: `src/services/shared/responses-ws-passthrough.js`

- [ ] Implement mode normalization and passthrough detection.
- [ ] Preserve valid Responses fields in WS payloads while removing only `stream` and `background`.
- [ ] Implement bidirectional passthrough relay with JSON frame validation, close propagation, and upstream headers.

### Task 3: Relay Wiring

**Files:**
- Modify: `src/services/relay/api.js`
- Modify: `src/routes/relay.js`

- [ ] Fix `buildResponsesWebSocketUrl()` to parse URLs and preserve queries.
- [ ] Add optional mode metadata to Relay WS handling.
- [ ] Use passthrough only for `/relay/v1/responses` WS ingress with an active `responses_ws` upstream and explicit mode.

### Task 4: Verification

**Files:**
- Test command: `npm test`

- [ ] Run targeted WS tests.
- [ ] Run full `npm test`.
- [ ] Review `git diff` for unrelated edits before reporting.
