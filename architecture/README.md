# Topology of the production n8n project

[`n8n-topology.json`](n8n-topology.json) is the real structure of the project, generated from a
full export of the production n8n instance (October 2026): 16 workflows and about 300 nodes.

It contains **structure only**:

- each workflow and its nodes (name, type, and whether the node is disabled);
- every connection, with its kind (`main`, `ai_tool`, `ai_languageModel`, `ai_memory`) and, for
  `main`, the output index, so the true and false branches of an `IF` can be told apart;
- which sub-workflow each tool or execute node calls;
- the model name on the language-model nodes.

**Removed:** every node parameter (prompts, code, expressions, HTTP URLs, headers, queries),
credentials, webhook paths, workflow and node IDs, and positions. The order-management vendor and
the WhatsApp gateway are genericized ("Vendor", "WA Gateway"). Node names are the production names,
in Portuguese.

Later releases changed the code inside nodes, the prompts and some tool parameters. The wiring
shown here is the October export.

## How to read it

| workflow | role |
|---|---|
| `Agente Atendimento - Master` | Orchestrator: inbound webhook, message buffer and per-customer lock, order-state builder, deterministic routing gates and LLM classifier fallback, false-confirmation interceptor, validator/humanizer agent, outbound messages |
| `Especialista - Pedidos` | Ordering specialist agent and its tools (menu search, create order, combo drinks, escalation) |
| `Especialista - Atendimento` | Support specialist agent (questions, menu photos, escalation) |
| `Especialista - Pós-venda` | Post-sale specialist agent (order status, complaints, changes to a placed order) |
| `Sub - Criar Pedido Vendor` | Order creation: parse and repair, payment lock, guards, confirmation gate, vendor API, closing message |
| `Sub - API Vendor` | Menu, store status and order lookups against the vendor, with token caching |
| `Webhook - Status Pedido Vendor` | Vendor status webhooks: delivery notifications, order-state cleanup, feedback poll |
| `Schedule - ...`, other `Sub - ...` | Reminders, wait-time updates, feedback, human escalation, menu photos |

Some useful patterns to look for in the JSON:

- The routing in the Master is a chain of `IF` nodes on Redis flags (in an order, active order,
  waiting for a complaint report, recent order) before the `Classificador` LLM chain is reached.
- About a third of the nodes are Redis reads and writes: the system's state lives there, keyed per
  customer, with a TTL on every write.
- The specialists reach the order system only through `toolWorkflow` nodes. No agent calls the
  vendor API directly.
