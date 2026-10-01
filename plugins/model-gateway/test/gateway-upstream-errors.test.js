'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { startGateway } = require('./support.js');
const {
  codexRateLimitBody, codexRateLimitMessage, upstreamConnectErrorMessage,
} = require('../lib/request-worker.js');

// SQ-21 + SQ-22: closest analogs are gateway-drain.test.js (spawns a real
// `serve-shim` worker against a fake proxy on CODEX_GATEWAY_PROXY_PORT) and
// gateway-process-isolation.test.js. Both new error-classification helpers
// are exercised at the unit level (fast, precise about wording) and end to
// end through a real worker process (proves the wiring actually reaches
// the client response).

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function postRaw(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: pathname,
      headers: { 'content-type': 'application/json', 'content-length': encoded.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

function post(port, pathname, bodyObject) {
  return postRaw(port, pathname, JSON.stringify(bodyObject));
}

// --- SQ-21: unit coverage for the connect-error classifier ---

test('SQ-21: ECONNREFUSED to the local shim gets transient wording, not a raw passthrough', () => {
  const url = new URL('http://127.0.0.1:18765');
  const message = upstreamConnectErrorMessage(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18765'), { code: 'ECONNREFUSED' }), url);
  assert.match(message, /local gateway proxy/);
  assert.match(message, /temporarily unreachable \(ECONNREFUSED\)/);
  assert.match(message, /recovery is automatic/i);
  assert.doesNotMatch(message, /connect ECONNREFUSED 127\.0\.0\.1:18765/, 'must not leak the raw Node error string verbatim');
});

test('SQ-21: ECONNRESET and EPIPE are also classified transient', () => {
  const url = new URL('http://127.0.0.1:18765');
  for (const code of ['ECONNRESET', 'EPIPE']) {
    const message = upstreamConnectErrorMessage(Object.assign(new Error(code), { code }), url);
    assert.match(message, new RegExp(`temporarily unreachable \\(${code}\\)`));
    assert.match(message, /model-gateway status.*model-gateway doctor|doctor/);
  }
});

test('SQ-21: an unrecognized error code gets fatal wording with a concrete next step', () => {
  const url = new URL('http://127.0.0.1:18765');
  const message = upstreamConnectErrorMessage(Object.assign(new Error('boom'), { code: 'EACCES' }), url);
  assert.match(message, /local gateway proxy/);
  assert.doesNotMatch(message, /recovery is automatic/i, 'fatal wording must not claim automatic recovery');
  assert.match(message, /model-gateway status/);
  assert.match(message, /model-gateway doctor/);
});

test('SQ-21: an external upstream failure is not misnamed as the local gateway proxy', () => {
  const url = new URL('https://api.anthropic.com');
  const message = upstreamConnectErrorMessage(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }), url);
  assert.doesNotMatch(message, /local gateway proxy/);
  assert.match(message, /https:\/\/api\.anthropic\.com/);
});

// --- SQ-22: unit coverage for the 429 rewrite ---

test('SQ-22: codex 429 body names the backend, disclaims Anthropic, and offers both remedies', () => {
  const upstreamBody = Buffer.from(JSON.stringify({ error: { message: 'rate limited' } }));
  const message = codexRateLimitMessage(upstreamBody, { 'retry-after': '5' });
  assert.match(message, /codex backend is rate limiting/);
  assert.match(message, /not an Anthropic usage limit/);
  assert.match(message, /Claude subscription is unaffected/);
  assert.match(message, /All 20 gpt-\* picker models route to this same codex backend/);
  assert.match(message, /sibling gpt-\* model is worth trying/);
  assert.match(message, /claude-\*.*Anthropic.*grok-4\.5.*Grok|grok-4\.5.*claude-\*/);
  assert.match(message, /Retry-After: 5s/);
  assert.match(message, /Upstream said: "rate limited"/);
});

// Guards the correction itself: an earlier revision asserted a shared account
// rate pool and told the reader a sibling gpt-* "will NOT help". Measured data
// contradicted that (gpt-5.6-luna: 140 requests, 0 429s, same backend, same day
// gpt-6-astra took 420). Never reintroduce the claim without pool-level evidence.
test('SQ-22: codex 429 body does not claim a shared rate pool or rule out sibling gpt-* models', () => {
  const message = codexRateLimitMessage(Buffer.from('{}'), {});
  assert.doesNotMatch(message, /rate pool/i);
  assert.doesNotMatch(message, /will NOT help/);
});

test('SQ-22: codex 429 message still names the backend with no retry-after header or JSON body', () => {
  const message = codexRateLimitMessage(Buffer.from('not json'), {});
  assert.match(message, /codex backend is rate limiting/);
  assert.match(message, /no Retry-After hint/);
});

test('SQ-22: the rewritten body is well-formed JSON carrying a rate_limit_error type', () => {
  const body = JSON.parse(codexRateLimitBody(Buffer.from('{}'), {}).toString());
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error');
  assert.match(body.error.message, /codex backend is rate limiting/);
});

// --- SQ-22: end-to-end through a real worker process ---

test('SQ-22 e2e: a 429 from the codex proxy is rewritten before it reaches the client', async (t) => {
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const { gatewayTestEnvironment } = require('./support.js');
  const environment = gatewayTestEnvironment(t);
  const { port: shimPort } = await startGateway(t, 'serve-shim', environment, {
    isolatedOverrides: {
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
  });

  const response = await post(shimPort, '/v1/messages', {
    model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1,
  });

  assert.equal(response.status, 429);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.type, 'rate_limit_error');
  assert.match(parsed.error.message, /codex backend is rate limiting/);
  assert.match(parsed.error.message, /not an Anthropic usage limit/);
  assert.match(parsed.error.message, /All 20 gpt-\* picker models route to this same codex backend/);
  assert.doesNotMatch(parsed.error.message, /^Rate limited$/, 'must not be the raw opaque upstream body');
});

test('SQ-21 e2e: an unreachable local proxy produces the named-component 502', async (t) => {
  const { gatewayTestEnvironment } = require('./support.js');
  const environment = gatewayTestEnvironment(t);
  // Reserve a port and immediately release it so nothing is listening there.
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const { port: shimPort } = await startGateway(t, 'serve-shim', environment, {
    isolatedOverrides: {
      CODEX_GATEWAY_PROXY_PORT: String(deadPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
  });

  const response = await post(shimPort, '/v1/messages', {
    model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1,
  });

  assert.equal(response.status, 502);
  const parsed = JSON.parse(response.body);
  assert.match(parsed.error.message, /local gateway proxy/);
  assert.match(parsed.error.message, /temporarily unreachable \(ECONNREFUSED\)/);
  assert.match(parsed.error.message, /recovery is automatic/i);
});

test('SQ-29 e2e: aborting a streaming client destroys the upstream socket promptly', async (t) => {
  let signalUpstreamReady;
  const upstreamReady = new Promise((resolve) => { signalUpstreamReady = resolve; });
  let signalUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { signalUpstreamClosed = resolve; });
  const proxy = http.createServer((req, res) => {
    req.socket.once('close', () => {
      res.end();
      signalUpstreamClosed({
        requestDestroyed: req.destroyed,
        socketDestroyed: req.socket.destroyed,
      });
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    signalUpstreamReady();
  });
  const proxyPort = await listen(proxy);
  t.after(() => {
    proxy.closeAllConnections?.();
    proxy.close();
  });

  const { gatewayTestEnvironment } = require('./support.js');
  const environment = gatewayTestEnvironment(t);
  const { port: shimPort } = await startGateway(t, 'serve-shim', environment, {
    isolatedOverrides: {
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
  });

  const body = Buffer.from(JSON.stringify({
    model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1,
  }));
  let signalClientAborted;
  const clientAborted = new Promise((resolve) => { signalClientAborted = resolve; });
  const client = http.request({
    host: '127.0.0.1', port: shimPort, method: 'POST', path: '/v1/messages', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': body.length },
  });
  client.once('response', () => {
    client.socket.destroy();
    signalClientAborted();
  });
  client.once('error', () => {});
  client.end(body);
  await upstreamReady;
  await clientAborted;

  const closed = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('upstream socket remained open after the client aborted')), 1000);
    upstreamClosed.then((result) => { clearTimeout(timeout); resolve(result); }, reject);
  });
  assert.equal(closed.socketDestroyed, true, 'client abort must destroy the upstream socket');
});

test('SQ-30 e2e: the parsed routing table preserves each route and only malformed JSON passes through', async (t) => {
  const received = { codex: [], grok: [], antigravity: [], anthropic: [] };
  const upstream = (provider, response) => http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received[provider].push(Buffer.concat(chunks).toString());
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
  });
  const codex = upstream('codex', { type: 'message', model: 'gpt-5.6-terra', content: [] });
  const grok = upstream('grok', { id: 'resp_test', model: 'grok-4.5', output: [], usage: {} });
  const antigravity = upstream('antigravity', { type: 'message', model: 'gemini-2.5-pro', content: [] });
  const anthropic = upstream('anthropic', { type: 'message', model: 'claude-sonnet-4-5', content: [] });
  const [codexPort, grokPort, antigravityPort, anthropicPort] = await Promise.all([
    listen(codex), listen(grok), listen(antigravity), listen(anthropic),
  ]);
  t.after(() => [codex, grok, antigravity, anthropic].forEach((server) => server.close()));

  const { gatewayTestEnvironment } = require('./support.js');
  const environment = gatewayTestEnvironment(t);
  fs.mkdirSync(environment.CODEX_GATEWAY_GROK_HOME, { recursive: true });
  fs.writeFileSync(path.join(environment.CODEX_GATEWAY_GROK_HOME, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::openid': { key: 'test-grok-key', expires_at: Date.now() + 3600000 },
  }));
  const { port: shimPort } = await startGateway(t, 'serve-shim', environment, {
    isolatedOverrides: {
      CODEX_GATEWAY_PROXY_PORT: String(codexPort),
      CODEX_GATEWAY_GROK_ENDPOINT: `http://127.0.0.1:${grokPort}/v1/responses`,
      CODEX_GATEWAY_ANTIGRAVITY_ENDPOINT: `http://127.0.0.1:${antigravityPort}`,
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
  });

  const routes = [
    { name: 'codex', body: { model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1 } },
    { name: 'grok', body: { model: 'claude-grok-4.5', messages: [], max_tokens: 1 } },
    { name: 'antigravity', body: { model: 'claude-gemini-2.5-pro', messages: [], max_tokens: 1 } },
    { name: 'anthropic', body: { model: 'claude-sonnet-4-5', messages: [], max_tokens: 1 } },
    { name: 'unparseable body', body: '{not valid JSON' },
  ];
  for (const route of routes) {
    const response = typeof route.body === 'string'
      ? await postRaw(shimPort, '/v1/messages', route.body)
      : await post(shimPort, '/v1/messages', route.body);
    assert.equal(response.status, 200, `${route.name} must reach its selected upstream`);
  }

  assert.equal(received.codex.filter((body) => body.includes('gpt-5.6-terra')).length, 1);
  assert.equal(received.grok.length, 1);
  assert.equal(received.antigravity.filter((body) => body.includes('"model":"gemini-2.5-pro"')).length, 1);
  assert.equal(received.anthropic.length, 2, 'native Anthropic and malformed bodies are the only Anthropic requests');
  assert.equal(received.anthropic[1], '{not valid JSON', 'unparseable bodies stay byte-identical');
});

test('SQ-30 e2e: a post-parse routing exception returns 500 and does not fall through to Anthropic', async (t) => {
  let anthropicRequests = 0;
  const anthropic = http.createServer((req, res) => {
    anthropicRequests += 1;
    res.end(JSON.stringify({ type: 'message', content: [] }));
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());

  const { gatewayTestEnvironment } = require('./support.js');
  const environment = gatewayTestEnvironment(t);
  const { port: shimPort } = await startGateway(t, 'serve-shim', environment, {
    isolatedOverrides: {
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_SENTRY: '0',
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
  });
  // sanitizeToolSchemas recurses after JSON.parse. This deliberately deep JSON
  // schema reliably overflows that post-parse walk without making JSON.parse fail.
  const nestedSchema = '{"node":'.repeat(12000) + 'null' + '}'.repeat(12000);
  const body = `{"model":"claude-gpt-5.6-terra","messages":[],"tools":[{"input_schema":${nestedSchema}}]}`;
  const response = await postRaw(shimPort, '/v1/messages', body);

  assert.equal(response.status, 500);
  assert.match(JSON.parse(response.body).error.message, /no Anthropic fallback was used/);
  assert.equal(anthropicRequests, 0, 'post-parse failures must not leak to the Anthropic upstream');
});
