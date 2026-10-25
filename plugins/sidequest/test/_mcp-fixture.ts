import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
'use strict';
/**
 * Tests for the MCP tool layer (SQ-152): the JSON-RPC handler in lib/mcp.js and
 * the stdio server in bin/sidequest-mcp.js.
 *
 * Two levels:
 *   - handleRequest() unit tests (fast, in-process) for the protocol handshake
 *     and the tool round-trips over the same store the CLI uses.
 *   - one child_process integration test that drives the real stdio server with
 *     newline-delimited JSON-RPC, to prove the transport frames correctly.
 *
 * Run: node --test plugins/sidequest/test/mcp.test.js
 */
export const test = require('node:test');
export const assert = require('node:assert');
export const os = require('os');
export const path = require('path');
export const fs = require('fs');
export const { spawnSync, execFileSync } = require('child_process');

export const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
// Agent definitions are written to the directory Claude Code's loader reads, which
// resolves to the developer's real `<CLAUDE_CONFIG_DIR>/agents` unless pinned (SQ-316).
// Several dispatch tests below route to a Codex model and so register a pin; without
// this they would deposit generated executors in the real tree.
process.env.SIDEQUEST_AGENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-agents-'));
// Per-process fixture root. A fixed path under the OS temp directory is shared
// with every other suite run on this machine and with the real `sidequest temp
// cleanup` sweep, either of which deletes this repo mid-run and takes the two
// dispatch tests that need a live work tree with it (SQ-867).
export const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-fixtures-'));
export const PROJ = path.join(FIXTURE_ROOT, 'board');
fs.mkdirSync(PROJ, { recursive: true });
execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: PROJ, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: PROJ, windowsHide: true });
process.env.CLAUDE_PROJECT_DIR = PROJ;
export const MCP_SESSION_ID = `mcp-test-session-${process.pid}`;
process.env.CLAUDE_CODE_SESSION_ID = MCP_SESSION_ID;
// Start with no discovery root at all — a real machine (e.g. this one, with
// model-gateway installed) can have a genuine ~/.claude/model-gateway/catalog.json,
// which would otherwise leak real discovered slugs into these tests. The
// SQ-162 tests below point SIDEQUEST_DISCOVERY_DIRS at their own fake catalog.
export const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-nocatalog-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

export const mcp = require('../lib/mcp.js');
export const contextPacket = require('../lib/context-packet.js');
export const agentsync = require('../lib/agentsync.js');
export const store = require('../lib/store.js');
export const db = require('../lib/db.js');
export const sourceRevisionCapability = require('../lib/source-revision-capability.js');
export const { runCapturedVerification } = require('../lib/verify-capture.js');
export const worktrees = require('../lib/worktrees.js');
export const { createCheckoutInstanceMarker } = require('../lib/kernel/worktree.js');
// SQ-364: a compact dispatch payload embeds temp-directory paths several times over
// (the project path, the planned token file under SIDEQUEST_HOME, the worktree root), so
// a raw `Buffer.byteLength` of that payload measures THIS MACHINE'S temp path, not the
// payload's own content. The spread is not small: macOS `os.tmpdir()` resolves to
// `/private/var/folders/<2>/<30>/T` (~31 characters longer than Linux `/tmp`), and
// `scripts/test-full.mjs` nests another 28 characters under TMPDIR for the suite
// sandbox. Measured on this base, each added path character costs 3 payload bytes, which
// is how the v4.14.0 cut saw 1266 bytes against a 1220 cap while Linux CI passed the very
// same commit and `npm run test:files` passed it locally. Normalize every temp root to
// the Linux `/tmp` shape before measuring so these caps bound payload CONTENT — a new
// field, a longer prose string — which is the only thing they can usefully police.
export const PAYLOAD_TEMP_ROOT_STANDIN = '/tmp';
export function payloadTempRoots(): string[] {
  const roots = new Set<string>();
  for (const candidate of [os.tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP]) {
    if (!candidate) continue;
    const trimmed = candidate.replace(/[\\/]+$/, '');
    if (!trimmed) continue;
    roots.add(trimmed);
    try { roots.add(fs.realpathSync(trimmed)); } catch { /* an unresolvable root cannot appear in a payload */ }
  }
  // Longest first: `/private/var/folders/...` CONTAINS the unresolved `/var/folders/...`,
  // so replacing the short form first would leave `/private/tmp` and reintroduce drift.
  return [...roots].sort((left, right) => right.length - left.length);
}
export function payloadBytes(text: string): number {
  let normalized = text;
  for (const root of payloadTempRoots()) normalized = normalized.split(root).join(PAYLOAD_TEMP_ROOT_STANDIN);
  for (const root of payloadTempRoots()) {
    assert.ok(!normalized.includes(root), `payload byte budget still depends on the temp path ${root}`);
  }
  return Buffer.byteLength(normalized, 'utf8');
}
export const DISPATCH_DESCRIPTION = 'Where: the routed test fixture. Contract: prepare a stable executor without changing the ticket title. Verify: inspect the dispatch result.';
export const NO_SCOPE_WARNING = 'Planning-depth warning: no file scope declared for a write-scope ticket, and this board has no autoApproveScope policy that can grant the first request. Dispatch will refuse unless you declare files or explicitly allow an unscoped run.';

// Write a fake model-gateway catalog (mirrors test/discovery.test.js) so a
// discovered+enabled custom slug can be exercised over the MCP surface.
export function writeCatalogRaw(dir?: any, body?: any) {
  fs.mkdirSync(path.join(dir, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'model-gateway', 'catalog.json'), body);
}
export function seedCatalog(models?: any, codexReadiness: any = {
  ready: true,
  state: 'ready',
  message: 'Codex readiness confirms local binary, /v1/models, authentication, shim, and serving-version checks.',
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schemaVersion: 3, source: 'model-gateway', updatedAt: new Date().toISOString(), codexReadiness, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}
export function seedCatalogV4(models?: any, providers?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schemaVersion: 4, source: 'model-gateway', updatedAt: new Date().toISOString(), providers, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}
export function clearCatalog() {
  process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;
}
seedCatalog([
  { id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' },
  { id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' },
]);
export function committedRepo(prefix?: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Pin the branch: integrationTarget resolves "main", and release suites run with
  // GIT_CONFIG_NOSYSTEM=1, so the ambient init.defaultBranch is not there to supply it.
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: root, windowsHide: true });
  return root;
}

// Call a tool through the JSON-RPC surface and return the parsed result object
// (the text content decoded back to JSON), asserting it wasn't an error.
export const fixtureState: { idc: number; mcpDispatchCwd: string | null } = { idc: 0, mcpDispatchCwd: null };
// SQ-309: a real board MCP server runs with cwd = the session's project root, and shared-tree dispatch
// refuses a runtime rooted in another repository. These tests drive the in-process server against
// temporary boards, so a dispatch (or native_agent) call runs from that board's checkout, as a session rooted there would.
// `fixtureState.mcpDispatchCwd` overrides it for a test that simulates a session rooted elsewhere.
export async function inDispatchRuntime(name?: any, args?: any, run?: any) {
  if (name !== 'dispatch' && name !== 'native_agent') return run();
  let target = fixtureState.mcpDispatchCwd;
  if (!target) {
    try { target = require('../lib/mcp-shared.js').resolveProject(args && args.project).meta.path; } catch (_: any) { target = null; }
  }
  if (!target || !fs.existsSync(target)) return run();
  const previous = process.cwd();
  process.chdir(target);
  try { return await run(); } finally { process.chdir(previous); }
}

export async function callTool(name?: any, args?: any) {
  const resp = await inDispatchRuntime(name, args, () => mcp.handleRequest({ jsonrpc: '2.0', id: ++fixtureState.idc, method: 'tools/call', params: { name, arguments: args || {} } }));
  assert.ok(resp && resp.result, `tool ${name} returned a result`);
  assert.ok(!resp.result.isError, `tool ${name} errored: ${resp.result.content && resp.result.content[0] && resp.result.content[0].text}`);
  return JSON.parse(resp.result.content[0].text);
}
export async function callToolRaw(name?: any, args?: any) {
  const resp = await inDispatchRuntime(name, args, () => mcp.handleRequest({ jsonrpc: '2.0', id: ++fixtureState.idc, method: 'tools/call', params: { name, arguments: args || {} } }));
  return resp.result;
}
export async function callToolAsSession(sessionId: string, name?: any, args?: any) {
  const previousSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = sessionId;
  try {
    return await callTool(name, args);
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = previousSessionId;
  }
}
export async function callToolRawAsSession(sessionId: string, name?: any, args?: any) {
  const previousSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = sessionId;
  try {
    return await callToolRaw(name, args);
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = previousSessionId;
  }
}
export async function callToolOn(server?: any, name?: any, args?: any) {
  const resp = await server.handleRequest({ jsonrpc: '2.0', id: ++fixtureState.idc, method: 'tools/call', params: { name, arguments: args || {} } });
  assert.ok(resp && resp.result, `tool ${name} returned a result`);
  assert.ok(!resp.result.isError, `tool ${name} errored: ${resp.result.content && resp.result.content[0] && resp.result.content[0].text}`);
  return JSON.parse(resp.result.content[0].text);
}
export function freshMcpServer() {
  const modulePath = require.resolve('../lib/mcp.js');
  delete require.cache[modulePath];
  return require(modulePath);
}
// Legacy native-agent helpers remain CLI-only, but their handlers still have
// direct coverage for the backward-compatible fallback path.
export async function callHandler(name?: any, args?: any) {
  const tool = mcp.TOOLS.find((t: any) => t.name === name);
  assert.ok(tool, `tool ${name} exists in the registry`);
  return inDispatchRuntime(name, args, () => tool.handler(args || {}));
}

export function gitAt(cwd?: any, args?: any) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

export function persistTicket(project: string, ticket: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim?.by || null,
    data: ticket,
  });
}

export function runCli(args?: any, cwd?: any) {
  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const output = execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  const trimmed = output.trim();
  return trimmed && trimmed.startsWith('{') ? JSON.parse(trimmed) : trimmed;
}

export function runForceBypass(payload?: any) {
  const hook = path.join(__dirname, '..', 'hooks', 'force-exec-bypass.js');
  const output = execFileSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') },
  });
  return output.trim() ? JSON.parse(output) : null;
}

export function createGitWorktree() {
  // The space is the point: every commit/submit path below runs against a
  // worktree whose absolute path contains one. Keep the sq- prefix too, it is
  // what the temp tracker and `temp cleanup` key on.
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp worktree-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-remote-'));
  gitAt(worktree, ['init', '-b', 'main']);
  gitAt(worktree, ['config', 'user.name', 'Sidequest Test']);
  gitAt(worktree, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'base\n');
  gitAt(worktree, ['add', 'README.md']);
  gitAt(worktree, ['commit', '-m', 'base']);
  gitAt(worktree, ['branch', '-M', 'main']);
  execFileSync('git', ['init', '-b', 'main', '--bare', remote], { encoding: 'utf8', windowsHide: true });
  gitAt(worktree, ['remote', 'add', 'origin', remote]);
  gitAt(worktree, ['push', '-u', 'origin', 'main']);
  return worktree;
}

export function addMarketplaceFixture(worktree: string) {
  const marketplacePath = path.join(worktree, '.claude-plugin');
  fs.mkdirSync(marketplacePath, { recursive: true });
  fs.writeFileSync(path.join(marketplacePath, 'marketplace.json'), JSON.stringify({
    plugins: [{ name: 'fixture-plugin', source: './plugins/fixture-plugin' }],
  }));
  // SQ-278: the release fragment gate is opt-in per repo, marked by a .release/ directory.
  fs.mkdirSync(path.join(worktree, '.release'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.release', 'README.md'), 'Release fragments live in unreleased/.\n');
  gitAt(worktree, ['add', '.claude-plugin/marketplace.json', '.release/README.md']);
  gitAt(worktree, ['commit', '-m', 'fixture marketplace']);
  gitAt(worktree, ['push']);
}

export function windowsShortPath(pathname: string) {
  if (process.platform !== 'win32') return pathname;
  return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${pathname}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true, shell: true,
  }).trim();
}

export function createLinkedWorktree(primary?: any) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-linked-worktree-'));
  const linked = path.join(parent, 'linked');
  gitAt(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
  return linked;
}

export function claimDispatchedTicket(project?: any, ticket?: any, by?: any, sharedTree?: any) {
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sharedTree, sessionId: MCP_SESSION_ID });
  assert.equal(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: MCP_SESSION_ID,
  }).ok, true);
}

export function prepareIsolatedWorktreeDispatch(project: string, primary: string, ticket: any, by: string) {
  const sessionId = `mcp-delivery-${ticket.id}`;
  const prepared = store.prepareDispatch(project, ticket.ref, {
    allowUnscoped: true,
    sharedTree: false,
    sessionId,
  });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
  }).ok, true);
  const worktree = worktrees.agentWorktreePath(primary, `delivery-${ticket.id}`);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, worktree).ok, true);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  gitAt(primary, ['worktree', 'add', '-b', `worktree-agent-delivery-${ticket.id}`, worktree, 'HEAD']);
  const gitDirectoryValue = gitAt(worktree, ['rev-parse', '--git-dir']);
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  createCheckoutInstanceMarker(gitDirectory);
  assert.equal(store.completeDispatchWorktreeCreation(project, sessionId, worktree).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
  }).ok, true);
  return worktree;
}

export async function submitIsolatedDeliveryCandidate(project: string, ticket: any, by: string, worktree: string) {
  fs.writeFileSync(path.join(worktree, 'feature.js'), `${ticket.ref}\n`);
  const committed = await callTool('commit', {
    project,
    ref: ticket.ref,
    by,
    message: `delivery candidate ${ticket.ref}`,
    worktree,
  });
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);
  const submitted = await callTool('submit', {
    project,
    ref: ticket.ref,
    by,
    commit: committed.commit,
    worktree,
    verify: 'manual: the delivery cleanup fixture was checked',
    body: `Delivery cleanup fixture for ${ticket.ref}.`,
  });
  assert.equal(submitted.ok, true, submitted.message || submitted.reason);
}

export function removeTestWorktree(primary: string, worktree: string) {
  if (fs.existsSync(worktree)) {
    try { gitAt(primary, ['worktree', 'unlock', worktree]); } catch {}
    try { gitAt(primary, ['worktree', 'remove', '--force', worktree]); } catch {}
  }
  fs.rmSync(primary, { recursive: true, force: true });
}

export function stageLongOutOfScopeChangeSet(worktree?: any) {
  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'allowed.js'), 'allowed\n');
  const paths = Array.from({ length: 180 }, (_, index) => `foreign/${String(index).padStart(3, '0')}-${'x'.repeat(110)}.js`);
  for (const file of paths) {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(worktree, file), 'foreign\n');
  }
  gitAt(worktree, ['add', '.']);
  return paths;
}

export function repoWithDirectories(prefix: string, directories: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const directory of directories) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return root;
}

/* ------------------------------------------------------------------ *
 *  SQ-228: the default MCP `list` is PAGED so a large board cannot
 *  overflow the tool-result token cap. SQ-220 made each ROW compact but
 *  not the row COUNT, so a few-hundred-ticket column still overflowed
 *  (98k chars observed live). Now each call returns a bounded page +
 *  total + returned + nextCursor; following nextCursor walks the whole
 *  board one safe page at a time. all:true / limit:N are the escapes.
 * ------------------------------------------------------------------ */

// The pretty serialization the RPC layer emits for a tool result — the exact
// string that hits the tool-result cap, so it's what a page is proven against.
export async function resultChars(name?: any, args?: any) {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: ++fixtureState.idc, method: 'tools/call', params: { name, arguments: args || {} } });
  return resp.result.content[0].text.length;
}

// SQ-923. Whether a run writes anything is an OUTCOME, so no dispatch-time flag
// predicts it: a read-only contract routed through a write-capable category
// records readonly:false correctly and then has nothing to hand in. 27 tickets
// in three days died on that (the:SQ-48/49/54/178, bmr:SQ-95, eige:SQ-820),
// each burning a release plus a re-dispatch. done now goes and looks.
export function isolatedDispatch(prefix: string, agentId: string, files: string[], verifyCommand?: string, options: any = {}) {
  const repo = fs.realpathSync(committedRepo(prefix));
  const project = store.ensureProject(repo, `SQ-923 ${agentId}`).slug;
  const ticket = store.createTicket(project, {
    title: `read-only outcome ${agentId}`,
    description: 'A write-routed dispatch whose contract forbids repository edits, exactly like the audited bounces.',
    category: 'debugging',
    files,
    ...(options.executorVerifyKind ? {
      executorVerifyKind: options.executorVerifyKind,
      executorVerify: options.executorVerify === undefined ? (verifyCommand || '') : options.executorVerify,
      executorAttestationArtifact: options.executorAttestationArtifact,
    } : (verifyCommand ? { executorVerifyKind: 'command', executorVerify: verifyCommand } : {})),
    ...(options.externalDeliverable === true ? { externalDeliverable: true } : {}),
    ...(options.readonly === true ? { readonly: true } : {}),
  });
  const sessionId = options.preparingSessionId || `sq923-session-${agentId}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId, source: options.preparingSource || 'store' });
  assert.equal(prepared.ticket.dispatch.sharedTree, false, 'the fixture dispatch is isolated');
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  const worktree = `${repo}-agent-${agentId}`;
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, worktree).ok, true);
  gitAt(repo, ['worktree', 'add', '-q', '-b', `agent-${agentId}`, worktree, 'HEAD']);
  createCheckoutInstanceMarker(gitAt(worktree, ['rev-parse', '--git-dir']));
  const worktreeCompletion = store.completeDispatchWorktreeCreation(project, sessionId, worktree);
  assert.equal(worktreeCompletion.ok, true, JSON.stringify(worktreeCompletion));
  assert.equal(
    store.bindDispatchAgent(
      sessionId,
      prepared.ticket.dispatchExecutor,
      agentId,
      agentId,
      worktree
    ).ok,
    true
  );
  assert.equal(store.claimTicket(project, ticket.ref, `by-${agentId}`, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const boundWorktree = store.getTicket(project, ticket.ref).dispatch.worktree;
  return { repo, project, ref: ticket.ref, by: `by-${agentId}`, worktree: boundWorktree, verifyCommand, preparingSessionId: sessionId };
}

export function recordNoOpVerification(fixture: any) {
  assert.equal(store.addComment(fixture.project, fixture.ref, {
    by: fixture.by,
    source: 'mcp',
    body: '[sidequest:verify-start] npm run test:full',
  }).ok, true);
  assert.equal(store.addComment(fixture.project, fixture.ref, {
    by: fixture.by,
    source: 'mcp',
    body: '[sidequest:verify-complete] no-op: focused regression passed 1/1, 0 failed, 0 skipped.',
  }).ok, true);
}

export async function recordExternalDeliverableCapture(fixture: any) {
  assert.ok(fixture.verifyCommand);
  const { capture, recorded } = await runCapturedVerification(fixture.verifyCommand, { project: fixture.repo, ticket: fixture.ref }, fixture.worktree);
  try {
    assert.equal(capture.status, 'passed', capture.evidence);
    assert.equal(recorded?.ok, true);
    return recorded.capture;
  } finally {
    fs.rmSync(capture.logPath, { force: true });
  }
}

export function redispatchExternalDeliverableFixture(fixture: any, agentId: string) {
  assert.equal(store.releaseTicket(fixture.project, fixture.ref, fixture.by, { status: 'todo', source: 'test' }).ok, true);
  const sessionId = 'sq2391-session-' + agentId;
  const prepared = store.prepareDispatch(fixture.project, fixture.ref, { allowUnscoped: true, sessionId });
  assert.notEqual(prepared.ticket.dispatchNonce, fixture.dispatchNonce, 'each dispatch receives a new attempt identity');
  assert.equal(store.recordDispatchLaunch(fixture.project, fixture.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.claimTicket(fixture.project, fixture.ref, 'by-' + agentId, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return {
    ...fixture,
    by: 'by-' + agentId,
    dispatchNonce: prepared.ticket.dispatchNonce,
    worktree: store.getTicket(fixture.project, fixture.ref).dispatch.worktree,
  };
}

// SQ-137: the topic shards of the former mcp.test.ts share this setup. Each shard runs in its
// own process, so each gets its own copy of every temp directory and env var made above.
