import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuth } from './index.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function stubApi() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/v1/models?model_type=decisions') return send(200, { data: [{ id: 'Typesafe/jev-1.14' }] });
      if (req.url === '/v1/models?model_type=image') return send(200, { data: [{ id: 'gemini-3.1-flash-image', image_parameters: { sizes: ['1024x1024'] } }] });
      if (req.url === '/v1/decisions' && !json.model) return send(400, { error: { message: 'model is required' } });
      if (req.url === '/v1/images/generations' && !json.prompt) return send(403, { error: { message: 'images not enabled for this key' } });
      if (req.url === '/v1/decisions') return send(200, { answers: { kind: { choice: json.state.content.includes('def ') ? 'code' : 'docs' } } });
      if (req.url.startsWith('/v1/images/')) return send(200, { created: 1, data: [{ b64_json: PNG.toString('base64') }] });
      send(404, {});
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, seen, port: server.address().port })));
}

function mcp(env) {
  const child = spawn(process.execPath, [new URL('./index.mjs', import.meta.url).pathname], { env: { ...env, PATH: process.env.PATH } });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((ok) => { const n = ++id; waiting.set(n, ok); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { rpc, tool, close: () => child.kill() };
}

test('the settings.json key is borrowed only for a custom API host', () => {
  assert.deepEqual(resolveAuth({ ANTHROPIC_API_KEY: 'k1', ANTHROPIC_BASE_URL: 'https://llm.example.com' }),
    { key: 'k1', source: 'settings.json', base: 'https://llm.example.com/v1' });
  assert.deepEqual(resolveAuth({ ANTHROPIC_API_KEY: 'sk-ant-real', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
    { key: '', source: 'none', base: '' });
  assert.deepEqual(resolveAuth({ ANTHROPIC_API_KEY: 'sk-ant-real' }), { key: '', source: 'none', base: '' });
  assert.equal(resolveAuth({ MODEL_TOOLS_API_KEY: '${user_config.api_key}', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://x' }).source, 'settings.json');
  assert.deepEqual(resolveAuth({ MODEL_TOOLS_API_KEY: 'p', MODEL_TOOLS_BASE_URL: 'https://g/v1/', ANTHROPIC_API_KEY: 'sk-ant-real' }),
    { key: 'p', source: 'plugin', base: 'https://g/v1' });
});

test('setup, classify and draw end to end against a stub API', async () => {
  const { server, seen, port } = await stubApi();
  const project = await mkdtemp(join(tmpdir(), 'mt-proj-'));
  const data = await mkdtemp(join(tmpdir(), 'mt-data-'));
  const c = mcp({ ANTHROPIC_API_KEY: 'key-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project, MODEL_TOOLS_API_KEY: '' });
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'model-tools');
    assert.deepEqual((await c.rpc('tools/list')).result.tools.map((t) => t.name), ['list_models', 'configure', 'classify', 'generate_image', 'edit_image']);

    // No default yet: the tool says to run setup instead of guessing a model.
    assert.match((await c.tool('classify', { items: [{ text: 'x' }], questions: { q: {} } })).text, /model-tools:setup/);

    const models = (await c.tool('list_models', {})).json;
    assert.deepEqual(models.permissions, { decisions: true, images: false });
    assert.equal(models.key_source, 'settings.json');
    assert.deepEqual(models.classifiers.map((m) => m.id), ['Typesafe/jev-1.14']);

    assert.ok((await c.tool('configure', { classifier: 'nope' })).isError);
    await c.tool('configure', { classifier: 'Typesafe/jev-1.14', image_model: 'gemini-3.1-flash-image' });
    assert.deepEqual(JSON.parse(await readFile(join(data, 'config.json'), 'utf8')), { classifier: 'Typesafe/jev-1.14', image_model: 'gemini-3.1-flash-image' });

    await writeFile(join(project, 'a.py'), 'def f():\n  pass\n');
    await writeFile(join(project, 'b.bin'), Buffer.from([1, 0, 2]));
    const q = { kind: { type: 'choice', instructions: 'kind?', criteria: { code: 'code', docs: 'docs' } } };
    const cls = (await c.tool('classify', { items: [{ path: 'a.py' }, { text: '# readme', name: 'R' }, { path: 'b.bin' }], questions: q })).json;
    assert.equal(cls.model, 'Typesafe/jev-1.14');
    assert.equal(cls.results[0].answers.kind.choice, 'code');
    assert.equal(cls.results[1].answers.kind.choice, 'docs');
    assert.match(cls.results[2].error, /binary/);
    const sent = seen.filter((s) => s.url === '/v1/decisions' && s.body.model);
    assert.equal(sent.length, 2, 'a binary file is never sent');
    assert.deepEqual(Object.keys(sent[0].body).sort(), ['model', 'questions', 'state']);
    assert.ok(seen.every((s) => s.auth === 'Bearer key-test'));

    const img = (await c.tool('generate_image', { prompt: 'A red apple', aspect_ratio: '16:9' })).json;
    const gen = seen.find((s) => s.url === '/v1/images/generations' && s.body.prompt);
    assert.deepEqual(gen.body, { model: 'gemini-3.1-flash-image', prompt: 'A red apple', aspect_ratio: '16:9' }, 'unset options are not sent');
    assert.match(img.images[0].path, /generated-images\/a-red-apple-.*\.png$/);
    assert.deepEqual(await readFile(img.images[0].path), PNG);

    await writeFile(join(project, 'ref.png'), PNG);
    await c.tool('edit_image', { prompt: 'make it green', images: ['ref.png'] });
    const edit = seen.find((s) => s.url === '/v1/images/edits');
    assert.equal(edit.body.images[0].image_url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal((await readdir(join(project, 'generated-images'))).length, 2);
  } finally {
    c.close();
    server.close();
  }
});
