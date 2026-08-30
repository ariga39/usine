# Usine Hermes bridge

This app is a separate, process-local observer/supervisor bridge for one Hermes agent and one existing
Usine server. It is not part of the Usine server or Task Authority. It reads existing generic loopback
HTTP resources and process-local `subscribe` invalidations, exposes one bounded, replaceable
Streamable HTTP MCP session on a loopback listener, and sends best-effort signed Hermes generic V2
webhook attention hints.

The webhook is an attention hint, not a task command. Hermes must pull the current Task resource and
history through MCP before deciding what to do. Only a current retryable `waiting` Task or a current
`blocked`, `reviewed_pr`, or `merged` Task wakes Hermes. Intermediate observations are invalidation
hints and are never wakes by themselves. Webhook, MCP, and process state do not prove Task completion;
the durable Task resource and history remain authoritative.

## Operator configuration

Provide the values through the process environment or an equivalent secret/configuration manager.
Use placeholders in deployment material and keep real values outside the repository:

```text
USINE_SERVER_URL=<LOOPBACK_USINE_SERVER_URL>
USINE_SOURCE_ID=<OPAQUE_LOGICAL_USINE_SOURCE_ID>
HERMES_WEBHOOK_URL=<HERMES_GENERIC_V2_WEBHOOK_URL>
HERMES_WEBHOOK_SECRET=<HERMES_WEBHOOK_SECRET>
HERMES_BRIDGE_HOST=<LOOPBACK_MCP_HOST>
HERMES_BRIDGE_PORT=<MCP_PORT>
```

Configure a normal Hermes webhook route that starts a fresh agent run. Do not use direct-delivery
mode. Configure Hermes' MCP client with the bridge's `/mcp` URL and allow only the six `usine_*`
tools listed by the bridge. The bridge rejects non-loopback MCP binding. The bridge owns best-effort
wake delivery, agent-product configuration/lifecycle, coalescing, retry, and cancellation. The current
implementation uses an Effect-owned process lifecycle and queue for those concerns; this is bridge-local
state, not a second scheduler or durable agent-session store.

Every webhook body includes the configured opaque source ID. Task attention includes the latest Task
revision and, for event-triggered wakes, the triggering event sequence. The current Task list is a
bounded, unpaginated window. It is not exhaustive historical discovery. Process-local Task IDs,
Repository IDs, and classifications have a fixed 200-observation bound with recency eviction; a
full current list response is still processed even when it exceeds that retained bound. Eviction is
observation-only: there is no replay guarantee after disconnect or restart.
On process startup, current retryable waiting Tasks may wake and existing terminal Tasks are treated
as baseline. After an observed outage, the bridge sends one unavailable signal, reconciles current
state only after Usine responds, and then sends one reconnected signal. Terminal transitions that
happen while the bridge is offline can be missed because the bridge has no durable cursor, ledger,
replay, or acknowledgement protocol. Disconnect or restart starts fresh. The bridge adds no
Hermes-specific Usine API, fact, event, or persistence; it uses the existing generic resources and
mutations and rereads current Task state/history when correctness matters.

Run the bundled executable with Node 24 and the configured environment:

```text
<NODE_24> <BRIDGE_EXECUTABLE>
```
