---
name: classify
description: Classify, label, triage, score or check files, texts and images with a fast decision model (Jev and others) through the model-tools `classify` tool, instead of judging each item yourself. Use when the user asks to sort, tag, categorize, triage, rate or filter files, logs, tickets or messages, to ask whether a picture shows something and how likely it is, or where an object is in a picture, and whenever a repeated yes/no, pick-one or score judgement over many items is needed.
---

# Classify with a decision model

A decision model answers fixed questions about one item at a time, with calibrated
probabilities. It is fast (about 2 s) and cheap, so prefer it over reading dozens of files yourself
when the judgement is repetitive, and use it whenever the user asks for a probability.

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
Treat a confidence below about 0.6 as "unsure" and look at that item yourself. An item that failed
carries `error` and the rest still succeed.

Without a default the tool uses the newest Jev the key can use and says so in `note`; mention
once that `/model-tools:setup` picks a different default.
