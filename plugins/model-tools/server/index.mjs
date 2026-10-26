#!/usr/bin/env node
// model-tools MCP server: classification (/v1/decisions) and images (/v1/images/*) through the
// OpenAI-compatible API configured for Claude Code. Zero dependencies; stdio JSON-RPC, one message per line.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '0.1.0';
const MAX_CONTENT_CHARS = 20000;
const CLASSIFY_CONCURRENCY = 4;
const DECISIONS_TIMEOUT_MS = 60_000;
const IMAGES_TIMEOUT_MS = 300_000;
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// A plugin userConfig field that was never set can arrive as an empty string or an unexpanded
// `${user_config.x}` placeholder; both mean "not configured".
const configured = (v) => (v && !v.startsWith('${') ? v.trim() : '');

export function resolveAuth(env = process.env) {
  const pluginKey = configured(env.MODEL_TOOLS_API_KEY);
  const pluginBase = configured(env.MODEL_TOOLS_BASE_URL);
  const settingsBase = configured(env.ANTHROPIC_BASE_URL);
  // Claude Code's own key is borrowed only when Claude Code itself talks to a custom API host:
  // a key for api.anthropic.com must never be sent anywhere else, and that host has no such API.
  const customHost = settingsBase && !/^https?:\/\/api\.anthropic\.com/i.test(settingsBase);
  const settingsKey = customHost ? [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].map(configured).find(Boolean) : '';
  const key = pluginKey || settingsKey || '';
  const source = pluginKey ? 'plugin' : settingsKey ? 'settings.json' : 'none';
  let base = pluginBase || (customHost ? settingsBase : '');
  base = base.replace(/\/+$/, '');
  if (base && !base.endsWith('/v1')) base += '/v1';
  return { key, source, base };
}

const dataDir = () => configured(process.env.CLAUDE_PLUGIN_DATA) || join(process.env.HOME || '.', '.model-tools');
const configPath = () => join(dataDir(), 'config.json');

async function loadConfig() {
  try { return JSON.parse(await readFile(configPath(), 'utf8')); } catch { return {}; }
}

class ToolError extends Error {}

async function call(method, path, body, timeoutMs) {
  const { key, base } = resolveAuth();
  if (!key) throw new ToolError('No API key: set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in ~/.claude/settings.json, or the plugin api_key and base_url options, then run /model-tools:setup.');
  if (!base) throw new ToolError('No API URL: set ANTHROPIC_BASE_URL in ~/.claude/settings.json or the plugin base_url option.');
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

const errorText = (r) => `HTTP ${r.status}: ${r.json?.error?.message || JSON.stringify(r.json).slice(0, 300)}`;

async function listIds(type) {
  const r = await call('GET', `/models?model_type=${type}`, null, DECISIONS_TIMEOUT_MS);
  if (r.status !== 200) throw new ToolError(errorText(r));
  return (r.json.data || []).map((m) => ({ id: m.id, ...(m.image_parameters ? { image_parameters: m.image_parameters } : {}), ...(m.pricing ? { pricing: m.pricing } : {}) }));
}

// The API checks the key's permission before the body (403 before 400), so an empty body tells
// "allowed" from "not allowed" without spending anything.
async function permitted(path) {
  const r = await call('POST', path, {}, DECISIONS_TIMEOUT_MS);
  return r.status === 403 ? false : r.status === 400 ? true : null;
}

async function listModels() {
  const { source, base } = resolveAuth();
  const [classifiers, imageModels, canDecide, canDraw, config] = await Promise.all([
    listIds('decisions'), listIds('image'), permitted('/decisions'), permitted('/images/generations'), loadConfig(),
  ]);
  return {
    api_url: base, key_source: source,
    permissions: { decisions: canDecide, images: canDraw },
    defaults: { classifier: config.classifier || null, image_model: config.image_model || null },
    classifiers, image_models: imageModels,
  };
}

async function configure({ classifier, image_model }) {
  const config = await loadConfig();
  if (classifier) {
    const ids = (await listIds('decisions')).map((m) => m.id);
    if (!ids.includes(classifier)) throw new ToolError(`Unknown classifier ${classifier}; available: ${ids.join(', ')}`);
    config.classifier = classifier;
  }
  if (image_model) {
    const ids = (await listIds('image')).map((m) => m.id);
    if (!ids.includes(image_model)) throw new ToolError(`Unknown image model ${image_model}; available: ${ids.join(', ')}`);
    config.image_model = image_model;
  }
  await mkdir(dataDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2));
  return { saved: configPath(), ...config };
}

const projectDir = () => configured(process.env.CLAUDE_PROJECT_DIR) || process.cwd();
const absolute = (p) => (isAbsolute(p) ? p : resolve(projectDir(), p));

async function readItem(item) {
  if (item.text !== undefined) return { name: item.name || 'text', content: String(item.text) };
  const path = absolute(item.path);
  const buf = await readFile(path);
  if (buf.subarray(0, 8000).includes(0)) throw new ToolError(`${item.path} is binary; describe it in text and pass it as {text}`);
  const text = buf.toString('utf8');
  return { name: item.path, content: text.length > MAX_CONTENT_CHARS ? text.slice(0, MAX_CONTENT_CHARS) + '\n…[truncated]' : text };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function classify({ items, questions, context, model }) {
  if (!Array.isArray(items) || items.length === 0) throw new ToolError('items must be a non-empty array of {path} or {text}');
  if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) throw new ToolError('questions must be a non-empty object');
  const chosen = model || (await loadConfig()).classifier;
  if (!chosen) throw new ToolError('No classifier chosen: pass model, or run /model-tools:setup to pick a default.');
  const results = await mapLimit(items, CLASSIFY_CONCURRENCY, async (item) => {
    try {
      const { name, content } = await readItem(item);
      const r = await call('POST', '/decisions', { model: chosen, state: { item: name, content, ...(context ? { context } : {}) }, questions }, DECISIONS_TIMEOUT_MS);
      return r.status === 200 ? { item: name, answers: r.json.answers } : { item: name, error: errorText(r) };
    } catch (e) {
      return { item: item.path || item.name || 'text', error: e.message };
    }
  });
  return { model: chosen, results };
}

async function dataUrl(path) {
  const ext = extname(path).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new ToolError(`${path}: not a png/jpeg/webp/gif image`);
  const buf = await readFile(absolute(path));
  if (buf.length > MAX_REFERENCE_BYTES) throw new ToolError(`${path}: larger than ${MAX_REFERENCE_BYTES / 1024 / 1024} MB`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function sniffExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return 'bin';
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
const IMAGE_OPTIONS = ['size', 'aspect_ratio', 'resolution', 'quality', 'output_format', 'background', 'output_compression'];

async function draw(route, args, extra) {
  if (!args.prompt) throw new ToolError('prompt is required');
  const model = args.model || (await loadConfig()).image_model;
  if (!model) throw new ToolError('No image model chosen: pass model, or run /model-tools:setup to pick a default.');
  const body = { model, prompt: args.prompt, ...extra };
  for (const k of IMAGE_OPTIONS) if (args[k] !== undefined) body[k] = args[k];
  const r = await call('POST', route, body, IMAGES_TIMEOUT_MS);
  if (r.status !== 200) throw new ToolError(errorText(r));
  const outDir = absolute(args.out_dir || 'generated-images');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const saved = [];
  for (const [i, item] of (r.json.data || []).entries()) {
    if (!item.b64_json) continue;
    const buf = Buffer.from(item.b64_json, 'base64');
    let name = `${args.filename ? slug(args.filename) : slug(args.prompt)}-${stamp}${i ? `-${i}` : ''}.${sniffExt(buf)}`;
    if (existsSync(join(outDir, name))) name = `${i}-${name}`;
    await writeFile(join(outDir, name), buf);
    saved.push({ path: join(outDir, name), bytes: buf.length, ...(item.revised_prompt ? { revised_prompt: item.revised_prompt } : {}) });
  }
  if (saved.length === 0) throw new ToolError('the API returned no image');
  return { model, images: saved, ...(r.json.usage ? { usage: r.json.usage } : {}) };
}

const generateImage = (args) => draw('/images/generations', args, {});
async function editImage(args) {
  if (!Array.isArray(args.images) || args.images.length === 0) throw new ToolError('images must be a non-empty list of local image paths');
  const images = await Promise.all(args.images.map(async (p) => ({ image_url: await dataUrl(p) })));
  return draw('/images/edits', args, { images });
}

const imageOptionProps = {
  model: { type: 'string', description: 'Image model id; defaults to the one picked in /model-tools:setup.' },
  size: { type: 'string', description: 'WxH, e.g. 1024x1024, or auto.' },
  aspect_ratio: { type: 'string', description: 'e.g. 16:9, 1:1, 9:16 (see image_parameters of the model).' },
  resolution: { type: 'string', description: 'Nano Banana: 512, 1K, 2K or 4K.' },
  quality: { type: 'string', description: 'GPT Image: low, medium, high or auto.' },
  output_format: { type: 'string', description: 'png, jpeg or webp, where the model supports it.' },
  background: { type: 'string', description: 'transparent, opaque or auto, where supported.' },
  out_dir: { type: 'string', description: 'Directory to save into, relative to the project; default generated-images.' },
  filename: { type: 'string', description: 'Base file name (without extension).' },
};

export const TOOLS = [
  {
    name: 'list_models',
    description: 'Classifiers (decision models) and image models this API key can use, with image parameters and prices, the key source and permissions, and the current defaults.',
    inputSchema: { type: 'object', properties: {} },
    run: listModels,
  },
  {
    name: 'configure',
    description: 'Save the default classifier and/or image model (ids from list_models).',
    inputSchema: { type: 'object', properties: { classifier: { type: 'string' }, image_model: { type: 'string' } } },
    run: configure,
  },
  {
    name: 'classify',
    description: 'Classify or score files or texts with a decision model (e.g. Jev). One call per item. `questions` maps a name to {type:"choice", instructions, criteria:{label: description}} or {type:"score", instructions, criteria:["0: …","1: …",…]}. Text files only; describe images in text first.',
    inputSchema: {
      type: 'object',
      required: ['items', 'questions'],
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' }, name: { type: 'string' } } } },
        questions: { type: 'object' },
        context: { type: 'string', description: 'Shared background for every item, e.g. what the project is.' },
        model: { type: 'string', description: 'Classifier id; defaults to the one picked in /model-tools:setup.' },
      },
    },
    run: classify,
  },
  {
    name: 'generate_image',
    description: 'Generate an image from a prompt and save it into the project. Returns the saved path; read it to look at the result.',
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, ...imageOptionProps } },
    run: generateImage,
  },
  {
    name: 'edit_image',
    description: 'Edit or combine existing local images by a prompt (reference images). Returns the saved path.',
    inputSchema: {
      type: 'object', required: ['prompt', 'images'],
      properties: { prompt: { type: 'string' }, images: { type: 'array', items: { type: 'string' }, description: 'Local image paths.' }, ...imageOptionProps },
    },
    run: editImage,
  },
];

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'model-tools', version: VERSION } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
      try {
        return reply({ content: [{ type: 'text', text: JSON.stringify(await tool.run(params.arguments || {}), null, 2) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : `${e.name}: ${e.message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'index.mjs') {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
