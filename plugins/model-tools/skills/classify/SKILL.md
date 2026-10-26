---
name: classify
description: Classify, label, triage or score many files or texts with a fast decision model (Jev and others) through the model-tools `classify` tool, instead of reading each item yourself. Use when the user asks to sort, tag, categorize, triage, rate or filter files, logs, tickets, messages, or images (described in text), and when a repeated yes/no or pick-one judgement over many items is needed.
---

# Classify with a decision model

A decision model answers fixed questions about one item at a time: pick one label (`choice`) or
place it on a scale (`score`), with probabilities and a confidence. It is fast (about 2 s) and
cheap, so prefer it over reading dozens of files yourself when the judgement is repetitive.

## Calling `classify`

- `items`: `[{ "path": "src/a.py" }, { "text": "…", "name": "ticket 42" }]` — paths relative to
  the project. Text files only; content past 20 000 characters is truncated. For an image, look at
  it yourself first and pass a short text description as `{text}`.
- `questions`: one or more named questions, all answered per item:
  ```json
  {
    "kind":    { "type": "choice", "instructions": "What kind of file is this?",
                 "criteria": { "code": "source code", "docs": "documentation", "config": "configuration" } },
    "quality": { "type": "score", "instructions": "How complete is the documentation?",
                 "criteria": ["0: nothing", "1: a title only", "2: short but usable", "3: thorough"] }
  }
  ```
  `choice` criteria are an object label → what qualifies; `score` criteria are a list of levels.
  Write criteria as observable facts, not vague words: "mentions a refund or a chargeback" beats
  "about money".
- `context` (optional): one line of shared background, e.g. what the project is.
- `model` (optional): overrides the default classifier chosen in `/model-tools:setup`.

Each result carries `answers.<question>.choice` or `.score`, `probabilities` and `confidence`.
Treat a confidence below about 0.6 as "unsure" and look at that item yourself. An item that failed
carries `error` and the rest still succeed.

If the tool says no classifier is chosen, run `/model-tools:setup`.
