# Yasmin — AI Ordering Agent for WhatsApp

> Case study / portfolio writeup. This repo documents the architecture and the real engineering
> problems solved while building and hardening a production AI agent that takes food orders over
> WhatsApp. Client name, phone numbers, and credentials have been removed or genericized — the
> architecture, bugs, and fixes described here are real and unmodified.

## What it does

A customer messages a restaurant's WhatsApp number. An AI agent ("Yasmin") reads the menu,
answers questions, builds an order (including combos, add-ons, delivery address, and payment),
and creates the order in the restaurant's order-management system — with no human in the loop for
the common case. It also handles delivery-status push notifications and a post-order feedback
flow.

This is not a chatbot demo. It moves real money and real food orders for real customers, which
changes what "good enough" means: a hallucinated product ID or an unconfirmed choice isn't a
cosmetic bug, it's a wrong order.

## Architecture

```mermaid
flowchart LR
  WA[Customer on WhatsApp] <--> ZAPI[WhatsApp Business API]
  ZAPI <--> N8N[n8n orchestration]
  N8N --> BUF[Message buffer\n(handles fragmented messages)]
  BUF --> AGENT[AI Agent\nOpenAI, tool-calling]
  AGENT --> MEM[(Redis\nshort-term memory)]
  AGENT -->|tools| MENU[Get menu]
  AGENT -->|tools| ORDER[Create order]
  AGENT -->|tools| STATUS[Check order status]
  ORDER --> GUARD{Deterministic\nvalidation guards}
  GUARD -->|valid| API[Order-management REST API]
  GUARD -->|invalid| AGENT
  API -->|status webhook| N8N
  N8N --> FEEDBACK[Post-order feedback poll]
```

- **n8n** orchestrates everything: webhook intake, message buffering/fragmentation handling,
  routing, and the tool-calling layer for the AI agent.
- **AI Agent** (OpenAI, function-calling) owns the conversation — it decides when to look up the
  menu, when to ask a clarifying question, and when it has enough information to place an order.
- **Redis** holds short-term conversation memory (migrated from PostgreSQL — see below) and a
  handful of structural state flags described further down.
- **Deterministic guards**, not the model, are the last line of defense before anything is sent
  to the real order-management API. This is the part of the project I'm most proud of, and it's
  the subject of most of this writeup.

## The interesting part: keeping an LLM honest in production

Prompt engineering gets an agent to work in the demo. It does not reliably get an agent to work
when real customers type real, messy, fragmented, ambiguous things at 11pm on a Friday. Below are
three real bugs, in the order I actually found and fixed them, with the reasoning behind each fix.

### 1. The model invented product IDs — and the reason was hiding in an undocumented field

Order creation started intermittently failing with a generic `500` from the order-management API.
The AI agent was sometimes sending a numeric product ID for a combo that simply didn't exist
anywhere in the real menu.

The lazy fix is "tell the model harder, in the prompt, to only use real IDs." I'd already tried
that — twice — with no improvement, which is a strong signal the cause isn't in the prompt at all.

Root cause, found by diffing the raw menu API response against what the AI actually saw: the
vendor's menu endpoint returns, for every "add-on group," an internal `product_id` field used for
their own POS integration. That field is stripped out before the AI ever sees it — but its numeric
*format* (7 digits, a specific prefix) is identical to the format of real, orderable product IDs.
The model was generalizing the wrong numeric pattern and occasionally landing on one of these
internal IDs, which happen to exist in the vendor's system (for something completely unrelated),
so the API's own validation didn't reject them the way it rejects a made-up number.

**Fix:** not a longer prompt. A deterministic guard in the order-creation workflow that re-fetches
the live menu and checks every product/combo ID against it *before* the order is submitted. If an
ID doesn't check out, the request is rejected with a clean, structured error instead of reaching
the vendor API — which lets the agent retry with a fresh, correct lookup instead of the customer
seeing a broken order or a raw technical error.

```js
// simplified from the real guard — fetches the live menu and validates every item
// before the order is ever sent to the vendor API
const freshMenu = await this.helpers.httpRequest({ method: 'GET', url: menuEndpoint, headers, json: true });
const validGeneralIds = new Set(freshMenu.general.flatMap(cat => cat.products.map(p => Number(p.id))));
const validComboIds = new Set(freshMenu.combos.map(c => Number(c.id)));

const invalidItem = orderItems.find(item => {
  const id = Number(item.id);
  return item.type === 'combo' ? !validComboIds.has(id) : !validGeneralIds.has(id);
});

if (invalidItem) {
  return [{ json: { error: 'order_creation_failed', detail: `invalid id ${invalidItem.id}` } }];
}
```

### 2. A years-old silent failure, found by auditing, not by guessing

`check order status` had apparently never worked for a normal, non-canceled order — for as long
as anyone could remember. It had been chalked up to "the vendor API is occasionally
unreliable" and worked around with retries and human escalation.

Root cause: an `IF` node inside the status-check sub-workflow had two branches — "canceled/
scheduled" and "everything else." Only the first branch was wired to anything. The second
branch, the one that fires for the overwhelming majority of real orders, connected to nothing at
all. The sub-workflow would just... stop, silently, for any order that wasn't canceled.

This wasn't found by trial and error. It was found by systematically re-reading every node's
connections in the sub-workflow against what the tool was supposed to return, because every other
explanation had already been ruled out with evidence. The fix was a single missing connection —
the investigation, not the fix, was the actual work.

### 3. A confirmed choice that was never actually confirmed

Combo orders include a drink, chosen by the customer tapping a button in a WhatsApp poll. Testing
turned up a case where the agent closed an order with a specific drink flavor recorded — despite
never having sent the poll at all in that conversation. The model had gotten busy handling two
other pending decisions in the same exchange, silently dropped the drink question, and filled in
a plausible-sounding default when it was time to close the order.

Nothing here is a "hallucination" in the exotic sense — it's a well-known LLM failure mode
(the model does not track state as reliably as it appears to), applied to a place where it has a
real, invisible-until-tested consequence: the customer would receive a drink they never chose.

**Fix:** the poll response handler now writes the *actual* confirmed choice to Redis, with a
short TTL, only when a real button tap is processed. The order-creation guard cross-checks any
"drink: X" note against that record before accepting the order — if there's no match, the order
is rejected with a clean error, and the agent is told (via the error detail, not another prompt
rewrite) to send the poll for real and wait for an answer.

```js
// simplified: reject a combo's drink choice unless it matches a real, recorded poll response
const confirmedDrink = String(redisGet(`drink_confirmed:${customerPhone}`) || '').trim();
const fabricated = orderItems.find(item => {
  const note = /drink:\s*(.+)/i.exec(item.notes || '');
  if (!note) return false;
  return !confirmedDrink || note[1].trim().toLowerCase() !== confirmedDrink.toLowerCase();
});
if (fabricated) {
  return [{ json: { error: 'order_creation_failed', detail: 'drink choice not confirmed by a real poll tap' } }];
}
```

Both directions were tested against the real vendor API before shipping: a real poll tap →
order succeeds with the correct drink; a fabricated drink note with no recorded tap → order is
rejected, nothing bad reaches the vendor.

## Testing failure modes without touching production

Two tools in the agent depend on external APIs (an order-vendor login endpoint and the WhatsApp
send API). I needed to know what happens when those calls genuinely fail — invalid credentials,
network unreachable — not just what *should* happen in theory.

Corrupting the real production credential to test this was rejected on purpose: that credential
is shared across the entire restaurant, so breaking it, even briefly, would degrade the
experience for every real customer messaging in at that moment, not just a test conversation.

Instead: a full, identical clone of the production workflow, published under a different, private
webhook path, with the credential (or the target host) swapped for something guaranteed to fail.
Same agent, same prompt, same tool-calling logic, zero shared blast radius with real traffic.

- Invalid credential → real `401`-style rejection from the real login endpoint, caught cleanly,
  customer gets a normal, graceful response, no stack trace, no silent hang.
- Unreachable host (real TCP failure, not a mocked one) → same result, different exact error
  message, same graceful handling.

Both were confirmed with real network calls against real infrastructure, and neither test could
affect a real customer.

## A structural n8n quirk, found by isolation, not by luck

Applying a large update to the always-on production workflow started failing with a generic
`500` and an empty response body — no useful error message anywhere.

Instead of guessing (size? one specific node? something un-fixable?), I isolated variables one at
a time: pushed an identical clone of the *entire* workflow, unmodified, as a brand-new inactive
workflow — it saved instantly, no error. That ruled out payload size and node complexity in one
shot. The only remaining difference was that the real target workflow was *active* (its webhook
live) at the moment of the write. Deactivating before the write and reactivating after fixed it
completely, and now this is a hard rule for any future change to this specific workflow — not
something documented anywhere publicly for this platform, found and verified with a controlled
experiment instead of trial and error.

## Stack

n8n (orchestration) · OpenAI (function-calling agent) · Redis (short-term memory, structural
state guards) · PostgreSQL (was the memory store; migrated to Redis for native TTL expiry once it
became clear the data was ephemeral by design) · REST APIs · WhatsApp Business API webhooks

## Status

In production, handling real customer orders end-to-end: menu browsing, combo + add-on selection,
delivery and pickup, payment (including cash-with-change), delivery-status push notifications, and
post-order feedback collection.
