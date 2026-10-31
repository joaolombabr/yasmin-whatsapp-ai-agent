# Evaluating the agent: the regression bench

The main [case study](../README.md) explains why the system is built as an LLM inside a cage of
deterministic code. This page explains how that cage is tested. The bench itself is not published:
it is built on the client's real menu, prices and conversation fragments. The design, the numbers
and the lessons are below.

## What is being evaluated

The thing that matters is not whether the agent's reply sounds right. It is **which order reaches
the vendor, and whether it charges the right amount.** So the unit of evaluation is:

```
customer messages in a conversation  ->  the order the system would create (items, add-ons, total)
```

Ground truth comes from the menu. Every expected total is computed from the vendor's own prices,
the same way the vendor computes it.

## How it runs

- **The code under test is the production code.** The Code nodes on the order path live as `.js`
  files. Each one is the same file that gets pasted into n8n, not a copy that can drift. The bench loads it, wraps it
  in an async function, and supplies a fake `$()` that returns what the upstream nodes would have
  produced.
- **Nodes run chained, like the real sub-workflow.** The chain is the order-state builder, then the
  parser and repair pass, the payment lock, the confirmation gate, and the closing-message builder.
  A test exercises the whole path, not one function.
- **The vendor API is simulated from a real menu snapshot.** It is the raw response of the vendor's
  menu endpoint, captured from production, so IDs, add-on groups, availability and prices are the
  real ones.
- **Any node file can be swapped for another version** through an environment variable, so the same
  suite runs against the current code and against the previous release.

## Two-sided test cases

Most cases come in pairs, because there are two different ways to fail:

| side | input | must happen |
|---|---|---|
| **RIGHT** | the order the customer actually asked for | the order **is created**, with the exact total |
| **WRONG** | a mistake the model could make, such as a combo the customer never asked for, an add-on on the wrong burger, a dropped item, or an invented payment method | the order is **never created wrong**: it is either rejected with an instruction the agent can act on, or corrected by code to the right order |

The WRONG side is modeled on errors the model has actually made in production or in live tests. It
is a catalogue of the model's observed failure modes, turned into regression cases.

A guard that rejects too much is also a bug. The RIGHT side catches over-blocking, which a suite of
only "bad" inputs never would.

## Numbers (last full run: October 2026)

| | |
|---|---|
| Suites run directly against the current code | **22** |
| Cases in those suites | **1,492, all passing** |
| Largest suite: the whole menu, each item ordered several ways | **894 cases** |
| Legacy suites run against both the previous and the current version | **9**; every difference must be on an allowlist of intended behaviour changes, otherwise it is reported as a regression |

The full-menu suite was written after **one** real order came out wrong: two burgers, one of them
with two add-ons, were created as a combo carrying only one of the add-ons, and the code accepted it. Run against the
production code of that day, the new suite scored **691 / 894**. The fix shipped at **894 / 894**,
with every other suite unchanged. One incident exposed about two hundred failing cases.

## The release loop

```
real failure (a live test, or a production order)
  -> reproduce it on the bench: it must FAIL there first
  -> fix the node code
  -> the new case passes, and every other suite still passes (or differs only on the allowlist)
  -> apply in n8n
  -> ONE live WhatsApp test at a time, from a clean state
     (cancel the previous order, clear the test keys, clear the chat history)
  -> check the result against the vendor's panel, not against what the agent said
```

From 6 to 15 October, 28 releases went through this loop. "One live test at a time" is deliberate:
running several scripted conversations back to back made one failure hide another (one test once
failed because of state left over from the test before it).

## Lesson: the bench has to see what production sees

One release added a lock: on cash delivery, the order cannot be created until the customer has
answered the change question. The bench passed. In production, the customer said "no" four times,
and the lock kept refusing. **The conversation looped.**

Cause: in production, the customer's message reaches that node with a line of code-built context
prepended (`[CUSTOMER ALREADY SAID: ...]`, the order state injected for the agent). The bench sent
only the customer's words. The node's anchored match for "não" ("no") could never fire on the real input.

The fix had two parts. The node now strips the context line before reading the answer. More
important, **the bench now builds its inputs in the exact production shape**, with the context
line included, in every suite that exercises that path. A test harness that is cleaner than
production gives a false pass.

## What the bench does not cover

- **The model itself.** The bench proves that the deterministic layer catches the model's
  mistakes. It does not measure how often the model makes them. That is checked with scripted
  live conversations, a numbered list per release, and by reading production conversations against
  the vendor panel.
- **Tone and wording.** One known gap is open: after adding items, the agent's acknowledgment
  sometimes names only part of them, while the order it creates is complete and correct. The
  system of record is right and the sentence is not. That gap is tracked, not hidden.
- **CI.** The suites run locally (`node`, no dependencies) before every release. They do not run
  on a server.
- **Tracing.** LLM tracing (Langfuse) is planned. The plan is one trace per customer message,
  tagged with the specialist, gate rejections, and the total the agent said next to the total
  actually created. It is not live yet.
