# Usine Hermes bridge

This app is a process-local bridge for one Hermes agent and one existing Usine server. It reads the
public loopback HTTP resources and SSE observations, exposes bounded Streamable HTTP MCP tools on a
loopback listener, and sends best-effort signed Hermes generic V2 webhook attention hints.

The webhook is an attention hint, not a task command. Hermes must pull the current Task resource and
history through MCP before deciding what to do. Only a current retryable `waiting` Task or a current
`blocked`, `reviewed_pr`, or `merged` Task wakes Hermes. Intermediate observations are invalidation
hints and are never wakes by themselves.

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
tools listed by the bridge. The bridge rejects non-loopback MCP binding.

Every webhook body includes the configured opaque source ID. Task attention includes the latest Task
revision and, for event-triggered wakes, the triggering event sequence. The current Task list is a
bounded, unpaginated window. It is not exhaustive historical discovery.
On process startup, current retryable waiting Tasks may wake and existing terminal Tasks are treated
as baseline. After an observed outage, the bridge sends one unavailable signal, reconciles current
state only after Usine responds, and then sends one reconnected signal. Terminal transitions that
happen while the bridge is offline can be missed because the bridge has no durable ledger or replay
cursor.

Run the bundled executable with Node 24 and the configured environment:

```text
<NODE_24> <BRIDGE_EXECUTABLE>
```
