# model-tools — a Claude Code plugin

Gives Claude Code two abilities through the API your Claude Code is already configured for:

- **classify** — sort, tag, triage or score files and texts with a fast decision model
  (`POST /v1/decisions`);
- **images** — generate and edit images (`POST /v1/images/generations`, `/v1/images/edits`).

## Install

```
claude plugin marketplace add explyt/model-tools
claude plugin install model-tools@model-tools
```

Then run `/model-tools:setup` in Claude Code: it shows which key the plugin uses and what that key
may do, and lets you pick the default classifier and image generator from the models the API lists
for your key (`GET /v1/models?model_type=decisions` and `?model_type=image`).

## Key and URL

By default the plugin borrows Claude Code's own settings from `~/.claude/settings.json`:
`ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`). It does so only when
`ANTHROPIC_BASE_URL` points to a custom API host; a key for `api.anthropic.com` is never sent
anywhere. To use a different key or URL, open `/plugin`, pick `model-tools` and set `api_key`
(kept in the system credential store) and `base_url`.

Usage is billed to the key like any other request.

## Development

```
node --test plugins/model-tools/server/index.test.mjs
claude plugin validate ./
```
