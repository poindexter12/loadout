'use strict';
/**
 * SQ-278 regression: release fragments are opt-in per repository.
 *
 * nexia-claude-marketplace ships plugins from a `.claude-plugin/marketplace.json` but releases
 * through Release Please with conventional commits. It has no `.release/` directory, and its
 * tickets said "No release fragment". Submit still refused every shipped-plugin change with
 * missing_release_fragment, demanding `.release/unreleased/<ref>.md`, a file the repo would never
 * read, so SQ-41 and SQ-42 were handed back.
 *
 * The marker of the fragment convention is a `.release/` directory at the repository root. A repo
 * without one never faces the requirement, at submit or at delivery close. A repo with one keeps it.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-278-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-278-fixtures-'));
process.env.CLAUDE_PROJECT_DIR = path.join(FIXTURE_ROOT, 'board');
fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: process.env.CLAUDE_PROJECT_DIR, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: process.env.CLAUDE_PROJECT_DIR, windowsHide: true });
process.env.CLAUDE_CODE_SESSION_ID = `sq-278-session-${process.pid}`;
process.env.SIDEQUEST_AGENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-278-agents-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-278-nocatalog-'));

const mcp = require('../lib/mcp.js');
const store = require('../lib/store.js');

let idc = 0;
async function callTool(name: string, args: any) {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  assert.ok(resp && resp.result, `tool ${name} returned a result`);
  assert.ok(!resp.result.isError, `tool ${name} errored: ${resp.result.content?.[0]?.text}`);
  return JSON.parse(resp.result.content[0].text);
}

function gitAt(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function createMarketplaceWorktree(options: { fragmentConvention: boolean }) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-278-worktree-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-278-remote-'));
  gitAt(worktree, ['init', '-b', 'main']);
  gitAt(worktree, ['config', 'user.name', 'Sidequest Test']);
  gitAt(worktree, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'base\n');
  fs.mkdirSync(path.join(worktree, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    plugins: [{ name: 'fixture-plugin', source: './plugins/fixture-plugin' }],
  }));
  const tracked = ['README.md', '.claude-plugin/marketplace.json'];
  if (options.fragmentConvention) {
    fs.mkdirSync(path.join(worktree, '.release'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.release', 'README.md'), 'Release fragments live in unreleased/.\n');
    tracked.push('.release/README.md');
  }
  gitAt(worktree, ['add', ...tracked]);
  gitAt(worktree, ['commit', '-m', 'base']);
  execFileSync('git', ['init', '-b', 'main', '--bare', remote], { encoding: 'utf8', windowsHide: true });
  gitAt(worktree, ['remote', 'add', 'origin', remote]);
  gitAt(worktree, ['push', '-u', 'origin', 'main']);
  return worktree;
}

async function submitPluginChange(worktree: string, by: string) {
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: `plugin change (${by})`, files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm the release fragment gate follows the repository convention',
  });
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The SQ-278 fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(worktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  gitAt(worktree, ['add', 'plugins/fixture-plugin/index.js']);
  gitAt(worktree, ['commit', '-m', 'plugin change without fragment']);
  const commit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, commit]);
  const result = await callTool('submit', {
    project, ref: ticket.ref, by, commit, worktree, body: 'SQ-278 fixture evidence',
  });
  return { project, ticket, result };
}

test('SQ-278: submit does not demand a release fragment from a repo without a .release/ directory', async () => {
  const worktree = createMarketplaceWorktree({ fragmentConvention: false });
  const { result } = await submitPluginChange(worktree, 'sq-278-no-convention-worker');
  assert.notEqual(result.reason, 'missing_release_fragment', `submit demanded a fragment the repo never uses: ${result.message}`);
  assert.equal(result.ok, true, result.message || result.reason);
});

test('SQ-278: submit still demands the release fragment from a repo that keeps .release/', async () => {
  const worktree = createMarketplaceWorktree({ fragmentConvention: true });
  const { project, ticket, result } = await submitPluginChange(worktree, 'sq-278-convention-worker');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_release_fragment');
  assert.match(result.message, new RegExp(`\\.release/unreleased/${ticket.ref}\\.md`));
  assert.ok(store.getTicket(project, ticket.ref).claim, 'fragment refusal keeps the claim');
});

test('SQ-278: the delivery-close fragment check follows the same repository convention', () => {
  const changed = ['plugins/fixture-plugin/index.js'];
  const without = createMarketplaceWorktree({ fragmentConvention: false });
  assert.equal(store.missingReleaseFragment(without, 'SQ-1', changed), null, 'submit check: no .release/ means no requirement');
  assert.equal(store.missingDeliveredReleaseFragment(without, 'SQ-1', changed), null, 'delivery check: no .release/ means no requirement');

  const withConvention = createMarketplaceWorktree({ fragmentConvention: true });
  assert.equal(store.missingReleaseFragment(withConvention, 'SQ-1', changed)?.fragmentPath, '.release/unreleased/SQ-1.md');
  assert.equal(store.missingDeliveredReleaseFragment(withConvention, 'SQ-1', changed)?.fragmentPath, '.release/unreleased/SQ-1.md');
});
