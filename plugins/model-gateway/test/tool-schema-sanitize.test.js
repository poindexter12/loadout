'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess } = require('./support.js');
const { sanitizeCodexToolSchemas } = require('../lib/request-worker.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

// The exact pattern Claude Code's Artifact tool carries on its `field`
// parameter, which OpenAI's function-schema validator rejects with
// "is not a 'regex'" and which 400s the whole request.
const ARTIFACT_FIELD_PATTERN = '^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}"\\\\./[\\]]{1,200}$';
const SUPPORTED_PATTERN = '^wf_[a-z0-9-]{6,}$';
const LOOKBEHIND_PATTERN = '(?<=x)y';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: body == null ? 'GET' : 'POST',
      path: pathname,
      headers: body == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForHealthz(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/healthz');
      if (response.status === 200) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('shim did not become healthy');
}

const artifactTool = () => ({
  name: 'Artifact',
  description: 'Artifact fixture',
  input_schema: {
    type: 'object',
    properties: {
      field: { type: 'string', pattern: ARTIFACT_FIELD_PATTERN },
      resumeFromRunId: { type: 'string', pattern: SUPPORTED_PATTERN },
      nested: {
        type: 'object',
        // A property genuinely named "pattern" holds a schema object, not a
        // regex string, and must survive untouched.
        properties: { pattern: { type: 'string' } },
      },
      writes: {
        type: 'array',
        items: { type: 'object', properties: { doc_id: { type: 'string', pattern: LOOKBEHIND_PATTERN } } },
      },
    },
    propertyNames: { pattern: ARTIFACT_FIELD_PATTERN },
  },
});

test('sanitizeCodexToolSchemas strips only patterns the backend cannot parse', () => {
  const [tool] = sanitizeCodexToolSchemas([artifactTool()]);
  const { properties, propertyNames } = tool.input_schema;

  assert.equal('pattern' in properties.field, false, 'unicode property escape must be stripped');
  assert.equal('pattern' in properties.writes.items.properties.doc_id, false, 'lookbehind must be stripped');
  assert.equal('pattern' in propertyNames, false, 'propertyNames pattern must be stripped');

  assert.equal(properties.resumeFromRunId.pattern, SUPPORTED_PATTERN, 'supported pattern must survive');
  assert.deepEqual(properties.nested.properties.pattern, { type: 'string' }, 'a property named "pattern" is not a regex');
  assert.equal(properties.field.type, 'string', 'sibling keys are preserved');
});

test('sanitizeCodexToolSchemas leaves clean tool lists by reference', () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object', properties: { cmd: { type: 'string', pattern: SUPPORTED_PATTERN } } } }];
  assert.equal(sanitizeCodexToolSchemas(tools), tools);
  assert.equal(sanitizeCodexToolSchemas(undefined), undefined);
});

test('Codex requests forward sanitized schemas while Anthropic passthrough stays byte-identical', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const forwardedToCodex = [];
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedToCodex.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-sol', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  let forwardedToAnthropic;
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedToAnthropic = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'claude-opus-5[1m]', content: [] }));
    });
  });
  const anthropicPort = await new Promise((resolve) => {
    anthropic.listen(0, '127.0.0.1', () => resolve(anthropic.address().port));
  });
  t.after(() => anthropic.close());

  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const body = {
    model: 'claude-gpt-5.6-sol',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'publish something' }],
    tools: [artifactTool()],
  };
  assert.equal((await request(shimPort, '/v1/messages', JSON.stringify(body))).status, 200);

  const forwarded = forwardedToCodex[0].tools[0].input_schema;
  assert.equal('pattern' in forwarded.properties.field, false);
  assert.equal('pattern' in forwarded.propertyNames, false);
  assert.equal(forwarded.properties.resumeFromRunId.pattern, SUPPORTED_PATTERN);
  assert.equal(JSON.stringify(forwardedToCodex[0]).includes('\\p{'), false);

  // Claude models keep their own byte-identical forwarding: the sanitizer is a
  // Codex-backend workaround and must never touch an Anthropic-bound request.
  const anthropicRaw = JSON.stringify({ ...body, model: 'claude-opus-5[1m]' }, null, 2);
  assert.equal((await request(shimPort, '/v1/messages', anthropicRaw)).status, 200);
  assert.equal(forwardedToAnthropic, anthropicRaw);
  assert.equal(forwardedToCodex.length, 1);
});
