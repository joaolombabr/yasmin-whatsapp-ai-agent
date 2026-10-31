# The guards

The main [case study](../README.md) describes what these guards do and why each one exists.
This directory is the code.

| file | what it is |
|---|---|
| [`order-validation.js`](order-validation.js) | The validation node that runs between the ordering specialist and the vendor's order API, in production. Nothing the agent produces reaches the vendor without passing through it. Snapshot from September 2026, the first guard layer. |
| [`false-confirmation-interceptor.js`](false-confirmation-interceptor.js) | The last check before a message reaches the customer. It replaces any reply that announces an order when no order exists, keeps code-built summaries and closing messages away from the humanizer, and restores parts of the closing message that the model dropped. Current version, October 2026. |

The second guard layer (the order-state builder, the confirmation gate and the payment lock) is
described in the main README. Its code is not published: it is built around the client's menu and
product names, and redacting it would leave little that reads as code.

## What has been redacted

The vendor's name, the client's menu item names, the real product IDs and internal order numbers
are removed or genericized. Credentials were never in the source: the bearer token and base URL
arrive as runtime values, which is why the files have nothing to strip. The control flow, the
checks and the rejection messages are unmodified. Comments, and in the interceptor also node
names, field names and customer-facing strings, are translated from the Portuguese originals.

One later finding applies to this snapshot. The credit/debit guard (in the order parser, not in
this file) derived the right value but wrote it to `cardMethod`, a key the vendor accepts and
ignores. The vendor reads `cardPaymentMethod`. The main README tells that story.

## Guard → incident

| Guard | Blocks | Incident |
|---|---|---|
| 1 — Delivery type has no default | Empty or invalid value | An order silently became counter-pickup |
| 2 — Proof the question was asked | Ordering without having asked delivery vs. pickup | Order created from a conversation where it was never asked |
| 3 — Item payload shape | Empty or malformed JSON | Broken payload reached the API as a generic 400 |
| 4 — Invalid item id | ID outside the live menu | The undocumented-field story — the ID *looks* real |
| 5 — id/type vs. notes | Combo swapped for standalone during assembly | Wrong product on a real order |
| 6 — Add-on group mismatch | Add-on ID from another product's group | `400 Extra does not belong to combo` |
| 7 — Drink must match one available can | Ambiguous or unavailable drink | A combo shipped with a drink nobody chose |
| 8 — Combo with no drink note | Silent omission | Incomplete order |
| 9 — Item already charged | Duplicate charge in one conversation | Double-charged customer |
| 10 — Fee resolved from the address | A delivery fee the model guessed | Wrong fee, absorbed by the restaurant |

## The two ideas worth stealing

**Reject with an instruction, not an error code.** Every rejection hands the agent a next
action — *"ask, wait, then call again"* — instead of a status code it will paraphrase badly to
the customer. This is the difference between a guard that recovers and a guard that dead-ends.

**When a rule is an LLM decision, move the proof outside the model.** Guard 2 exists because
five rounds of prompt reinforcement could not stop the agent from inventing a valid-looking
answer. The fix was not a better prompt. It was a Redis key written only when the outgoing
message provably contained the question — external state the model cannot assert its way past.
