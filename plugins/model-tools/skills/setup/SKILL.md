---
name: setup
description: Set up the model-tools plugin — check which key it uses, which classifiers and image generators that key can use, and pick the defaults. Use on first use of the model-tools tools, when a tool says "run /model-tools:setup", or when the user wants to change the default classifier or image model.
---

# Set up model-tools

1. Call the `list_models` tool of the `model-tools` MCP server.
2. Tell the user, in one short block:
   - which key is in use: `key_source` is `settings.json` (Claude Code's own `ANTHROPIC_API_KEY`,
     borrowed because `ANTHROPIC_BASE_URL` points to a custom API host), `plugin` (the plugin's own
     `api_key` option) or `none`;
   - the API URL (`api_url`);
   - `permissions`: `true` = allowed, `false` = this key is not allowed (ask whoever issued the key to
     allow decisions / images for it), `null` = could not tell (the API may not offer that endpoint).
3. Ask the user to confirm the key with AskUserQuestion: keep the key from settings.json
   (recommended when `key_source` is `settings.json`), or use another key. For another key: they
   open `/plugin`, pick `model-tools`, and set `api_key` (stored in the secure credential store, not
   in settings.json); then run `/model-tools:setup` again. Never ask the user to paste a key into the
   chat.
4. Ask with AskUserQuestion which classifier to use by default — the options are exactly the
   `classifiers` ids from step 1 (put the newest `jev` first and mark it recommended) — and which
   image model — exactly the `image_models` ids (put `gemini-3.1-flash-image`, Nano Banana, first
   and mark it recommended). Skip a question whose permission is `false`. If a list has more than
   four ids, offer the four most relevant and say the rest can be typed in.
5. Call `configure` with the chosen ids and tell the user where the defaults were saved.
