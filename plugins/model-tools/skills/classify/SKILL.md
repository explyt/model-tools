---
name: classify
description: Probabilities from a fast decision model (Jev) — use instead of judging by eye for any yes/no, pick-one or rubric call, above all one repeated over many items. E.g. triage logs, tickets, reviews or PRs by topic and urgency; rank which files or search hits matter for a task; check a diff against CLAUDE.md rules or for breaking changes; flag spam, duplicates, flaky tests; is X in this screenshot or photo, and where. Not for counting or math.
---

# Classify with a decision model

A decision model answers fixed questions about one item at a time, with calibrated
probabilities. It is fast (about 2 s) and cheap, so prefer it over reading dozens of files yourself
when the judgement is repetitive, and use it whenever the user asks for a probability.

## Where it fits

Good: routing and triage (team, topic, urgency), moderation and policy checks, relevance and
reranking (which files, docs or search hits matter), verification (is the answer grounded in the
source, does the diff follow a rule, is it a breaking change), scoring against a rubric, gates
before a risky step (continue / retry / ask the user), spotting a stuck or looping run.

Poor: counting, arithmetic and date math, multi-step reasoning, anything that needs generated
text or an explanation — do those yourself. For a high-stakes single decision, read the item too.

Thresholds: below about 0.6 confidence treat the answer as "unsure"; ask for 0.85+ before acting
on something risky.

## Calling `classify`

- `items`: `[{ "path": "src/a.py" }, { "path": "photos/cup.jpg" }, { "text": "…", "name": "ticket 42" }]`
  — paths relative to the project. A PNG or JPEG path is sent as the image itself (Jev reads
  images; a picture larger than 1568 px per side is scaled down first). Text past 20 000
  characters is truncated. Other binary files are refused.
- `questions`: one or more named questions, all answered per item:
  ```json
  {
    "kind":    { "type": "choice", "instructions": "What kind of file is this?",
                 "criteria": { "code": "source code", "docs": "documentation", "config": "configuration" } },
    "quality": { "type": "score", "instructions": "How complete is the documentation?",
                 "criteria": ["0: nothing", "1: a title only", "2: short but usable", "3: thorough"] }
  }
  ```
  Question types:
  - `noul` — the probability that a statement is true: `{ "type": "noul", "instructions": "The picture shows a mug." }`
    → `answers.<name>.noul` (0…1). Use it for "is there X / how likely".
  - `choice` — one label; criteria are an object label → what qualifies.
  - `score` — a level on a scale; criteria are a list of levels.
  - `box` (Jev 1.14+, images only) — where the object named in `instructions` is; it always returns
    a box, so ask a `noul` about the same object in the same call to know whether it is there.
  Write criteria as observable facts, not vague words: "mentions a refund or a chargeback" beats
  "about money".
- `context` (optional): one line of shared background, e.g. what the project is.
- `model` (optional): overrides the default classifier chosen in `/model-tools:setup`.

Each result carries `answers.<question>` with `noul`, `choice` or `score` (plus `probabilities`
and `confidence` where the type has them).
An unsure item is one to look at yourself. An item that failed carries `error` and the rest still
succeed.

Without a default the tool uses the newest Jev the key can use and says so in `note`; mention
once that `/model-tools:setup` picks a different default.
