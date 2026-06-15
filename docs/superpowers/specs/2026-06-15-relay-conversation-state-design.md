# Relay Conversation State Design

## Goal

Make all 16 Relay protocol combinations usable when a request passes through
OpenAI Chat Completions, OpenAI Responses HTTP, Responses WebSocket, and
Anthropic Messages. The fix must use the same code path for local and cloud
deployments. A Relay instance should not know whether it is the local hop or
the upstream hop; it should decide behavior only from the incoming protocol,
the active upstream protocol, and the available conversation state.

## Problem

Chat Completions and Anthropic Messages usually carry a full transcript in each
request. Responses and Responses WebSocket may carry only incremental input plus
`previous_response_id`, relying on upstream state to recover prior context.

The current Relay converters can translate the visible Responses input, but they
cannot reconstruct omitted history. This works when the active upstream is also
Responses or Responses WebSocket, because that upstream can resolve
`previous_response_id`. It fails when the active upstream is Chat Completions or
Anthropic, because those protocols require full messages.

## Design

Add a shared `RelayConversationStore` used by every Relay instance. The store is
a short-lived, tenant-scoped state cache keyed by `tenantId + conversationKey`.
It also indexes `response_id -> conversationKey` so a later Responses request
can hydrate history from `previous_response_id`.

The first implementation can be in memory because expected usage is small
(around 10 users). The store interface should hide the storage backend so Redis
or database-backed storage can replace it later without changing protocol
conversion logic.

Relay should keep a canonical transcript instead of treating Chat or Responses
as the only internal representation. The canonical state includes:

- model and request options that affect generation
- system or instructions content
- ordered messages with role, content parts, reasoning, tool calls, tool output,
  and assistant output
- tool definitions, tool choice, and parallel tool call settings
- known Responses ids and their completed output snapshots
- timestamps and size counters for TTL and pruning

## Data Flow

For Chat Completions ingress, Relay converts the full `messages` payload into a
canonical transcript and stores it before calling the active upstream.

For Anthropic ingress, Relay converts `system`, `messages`, tools, tool choice,
thinking, and tool blocks into the same canonical transcript and stores it
before calling the active upstream.

For Responses HTTP and Responses WebSocket ingress, Relay first checks whether
the request references `previous_response_id`. If state exists, Relay hydrates
the prior canonical transcript and appends the new Responses input. If no state
exists, Relay keeps only the visible input until upstream formatting decides
whether that is sufficient. Responses-capable upstreams can still receive the
incremental request, while Chat and Anthropic upstreams must fail with
`state_missing`.

After every successful upstream response, Relay records the assistant output in
the canonical transcript. If the upstream response contains a Responses id, Relay
maps that id back to the conversation state. If the upstream is Chat or
Anthropic, Relay generates equivalent assistant transcript entries from the
converted response.

## Upstream Formatting

When the active upstream is Responses HTTP or Responses WebSocket, Relay may
preserve incremental Responses behavior. It can send `previous_response_id`
where appropriate and continue using the existing WebSocket context pool.

When the active upstream is Chat Completions or Anthropic, Relay must format from
the hydrated canonical transcript. It must not convert only the current
Responses input item. If the request depends on `previous_response_id` and the
store cannot hydrate it, Relay returns a clear `state_missing` protocol error
instead of sending a lossy request upstream.

This rule applies identically in local and cloud deployments. The behavior is
triggered by the target upstream protocol, not by deployment role.

## Error Handling

If state is missing and the active upstream is Responses or Responses WebSocket,
Relay may pass the request through because a downstream Responses-capable hop may
have the needed state.

If state is missing and the active upstream is Chat or Anthropic, Relay should
fail before the upstream call with an explicit error:

- OpenAI-shaped routes return an OpenAI error body with code `state_missing`.
- Anthropic-shaped routes return an Anthropic error body with code
  `state_missing`.
- Responses WebSocket routes send a WS error event with code `state_missing`.

State entries expire by TTL and by maximum transcript size. Expiration is normal
and should be logged at info/debug level, not as an upstream failure.

## Testing

Add tests for state hydration before implementation changes:

- Responses HTTP to Chat with `previous_response_id` uses stored history.
- Responses HTTP to Anthropic with `previous_response_id` uses stored history.
- Responses WebSocket to Chat with `previous_response_id` uses stored history.
- Responses WebSocket to Anthropic with `previous_response_id` uses stored
  history.
- Missing state fails for Chat and Anthropic upstreams.
- Missing state can pass through to Responses and Responses WebSocket upstreams.
- Chat and Anthropic ingress update the same store used by Responses ingress.
- Response ids from completed Responses events are mapped back to the canonical
  conversation.

Run the targeted relay and Responses WebSocket tests first, then the full
`npm test` suite.
