'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
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

function post(port, pathname, bodyObject) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(bodyObject));
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

test('SQ-22: codex 429 body names the backend, disclaims Anthropic, and warns off sibling gpt-* models', () => {
  const upstreamBody = Buffer.from(JSON.stringify({ error: { message: 'rate limited' } }));
  const message = codexRateLimitMessage(upstreamBody, { 'retry-after': '5' });
  assert.match(message, /codex backend is rate limiting/);
  assert.match(message, /not an Anthropic usage limit/);
  assert.match(message, /Claude subscription is unaffected/);
  assert.match(message, /All 20 gpt-\* picker models share/);
  assert.match(message, /will NOT help/);
  assert.match(message, /claude-\*.*Anthropic.*grok-4\.5.*Grok|grok-4\.5.*claude-\*/);
  assert.match(message, /Retry-After: 5s/);
  assert.match(message, /Upstream said: "rate limited"/);
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
  assert.match(parsed.error.message, /All 20 gpt-\* picker models share/);
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
