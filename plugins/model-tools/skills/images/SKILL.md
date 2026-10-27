---
name: images
description: Generate or edit raster images — when the user asks for a picture, and on your own when a task needs one: README or landing hero, banner, app icon or avatar, placeholder product photo, illustration for docs or slides, texture, sprite, a variant or fix of an existing image. Not for diagrams (SVG, Mermaid) or UI (HTML/CSS).
---

# Images

1. Write a concrete prompt: subject, setting, style, lighting, composition, and any exact text that
   must appear on the image (in quotes). One image per call.
2. Call `generate_image` (`prompt`, optional `aspect_ratio` such as `16:9`, `1:1`, `9:16`;
   `resolution` `1K`/`2K`/`4K` for Nano Banana; `out_dir`, `filename`). To change or combine
   existing pictures, call `edit_image` with `images: ["path/a.png", …]` and a prompt that says
   what to keep and what to change.
3. The tool saves the file (default `generated-images/` in the project) and returns its path.
   Read that file to check the result before you report it; if it misses the brief, refine the
   prompt and generate again — say so rather than presenting a weak image as done.
4. Which options each model accepts, and the price per image, are in `list_models`
   (`image_parameters`). Pass only options the user needs; unset options keep the model's own
   defaults.

Without a default the tool uses the first image model the key can use and says so in `note`;
mention once that `/model-tools:setup` picks a different default. A 403 means the key is not
allowed to generate images — ask whoever issued the key to allow it.
