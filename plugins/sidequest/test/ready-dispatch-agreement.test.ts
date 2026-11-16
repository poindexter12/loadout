import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
'use strict';

// SQ-394: `ready` and `dispatch` must agree on what is workable. A ticket dispatch refuses from its
// own stored state is not listed as ready (it rides `notDispatchable` with the refusal and the next
// step instead), and is never named by the higherPriorityReady notice on another ticket's dispatch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ready-dispatch-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ready-dispatch-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ready-dispatch-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  updatedAt: new Date().toISOString(),
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' }],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
process.env.CLAUDE_PROJECT_DIR = PROJECT;

function git(args: string[]) {
  return execFileSync('git', args, { cwd: PROJECT, encoding: 'utf8', windowsHide: true }).trim();
}
git(['init', '--quiet', '-b', 'main']);
git(['config', 'user.email', 'test@example.invalid']);
git(['config', 'user.name', 'Ready Dispatch Agreement Test']);
fs.writeFileSync(path.join(PROJECT, 'tracked.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(PROJECT, 'candidate.txt'), 'candidate\n');
git(['add', 'tracked.js', 'candidate.txt']);
git(['commit', '--quiet', '-m', 'seed fixture']);
const CANDIDATE = git(['rev-parse', 'HEAD']);

const store = require('../lib/store.js');
const db = require('../lib/db.js');
const mcp = require('../lib/mcp.js');
const slug = store.ensureProject(PROJECT).slug;

store.setCategory({ id: 'agreement.write', name: 'Agreement write', route: { model: 'sonnet', effort: 'high' }, fallback: null, enabled: true });
store.setCategory({ id: 'review-audit', name: 'review-audit', route: { model: 'sonnet', effort: 'high' }, fallback: null, readonly: true, enabled: true });

function persist(ticket: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}

function writeTicket(title: string, priority: string, files: string[] = ['tracked.js']) {
  return store.createTicket(slug, { title, priority, category: 'agreement.write', files, source: 'test' });
}

function dispatchRefusal(ref: string) {
  try {
    store.prepareDispatch(slug, ref);
  } catch (error: any) {
    return String(error?.message || error);
  }
  assert.fail(`dispatch ${ref} was expected to refuse`);
}

function readyRefs() {
  return store.readyTickets(slug).map((t: any) => t.ref);
}

function waveRefs() {
  return store.readyPayload(slug).waves.flat().map((t: any) => t.ref || t);
}

// A claim-free terminal submission whose bound review an oracle permanently rejected: the state
// SQ-254 was in when `ready` listed it in Wave 1 and dispatch refused it (2026-11-08).
function rejectedReview(priority: string) {
  const source = store.createTicket(slug, { title: 'rejected source', files: ['candidate.txt'], source: 'test' });
  const terminalAt = new Date().toISOString();
  source.status = 'doing';
  source.claim = null;
  source.dispatch = {
    terminalAt,
    outcome: 'submitted',
    agentId: 'source-agent',
    attempts: [{ outcome: 'submitted', commit: CANDIDATE, agentId: 'source-agent', terminalAt }],
  };
  source.submission = {
    by: 'implementer', at: terminalAt, commit: CANDIDATE, verify: 'manual: fixture', changedPaths: ['candidate.txt'], integratedAt: null,
  };
  persist(source);
  const review = store.createTicket(slug, {
    title: 'review of the rejected candidate', priority, category: 'review-audit', files: ['candidate.txt'], source: 'test',
  }, { ref: source.ref, commit: CANDIDATE });
  const storedSource = store.getTicket(slug, source.ref);
  storedSource.submission.review.outcome = 'rejected';
  persist(storedSource);
  const storedReview = store.getTicket(slug, review.ref);
  storedReview.reviewTarget.outcome = 'rejected';
  persist(storedReview);
  return { source: storedSource, review: storedReview };
}

function archive(...tickets: any[]) {
  for (const ticket of tickets) store.archiveTicket(slug, ticket.ref, { source: 'test' });
}

test('a write ticket with no declared file scope is not ready, and ready names the dispatch refusal (reproduction 2)', () => {
  const unscoped = writeTicket('unscoped write work', 'high', []);
  const target = writeTicket('scoped normal work', 'normal');
  try {
    const refusal = dispatchRefusal(unscoped.ref);
    assert.match(refusal, /has no declared file scope for write work/);

    assert.ok(!readyRefs().includes(unscoped.ref), 'ready does not list a ticket dispatch refuses');
    assert.ok(readyRefs().includes(target.ref));
    assert.ok(!waveRefs().includes(unscoped.ref), 'no wave carries it');

    const [row] = store.readyNotDispatchable(slug).filter((r: any) => r.ref === unscoped.ref);
    assert.equal(row.code, 'no_declared_scope');
    assert.equal(row.reason, refusal, 'the ready row carries the exact refusal dispatch raises');
    assert.equal(row.override, 'allowUnscoped');
    assert.match(row.next, /Declare the files/);
    assert.deepEqual(store.readyPayload(slug).notDispatchable.map((r: any) => r.ref), [unscoped.ref]);

    // The priority notice uses the same definition: the unscoped high does not hold up the normal.
    const prepared = store.prepareDispatch(slug, target.ref);
    assert.deepEqual(store.dispatchHigherPriorityReady(prepared.ticket, slug), []);
    assert.doesNotMatch(store.dispatchWarnings(prepared.ticket, slug).join('\n'), new RegExp(`${unscoped.ref}\\b`));
    assert.equal(store.releaseTicket(slug, target.ref, 'agreement-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);

    // Declaring scope makes it ready again, and dispatchable.
    assert.ok(store.updateTicket(slug, unscoped.ref, { files: ['tracked.js'] }));
    assert.ok(readyRefs().includes(unscoped.ref));
    assert.deepEqual(store.readyNotDispatchable(slug), []);
  } finally {
    archive(unscoped, target);
  }
});

test('a review whose candidate was permanently rejected is not ready, and dispatch and ready agree (reproduction 1)', async () => {
  const { source, review } = rejectedReview('high');
  const target = writeTicket('normal work after the rejected review', 'normal');
  try {
    const refusal = dispatchRefusal(review.ref);
    assert.match(refusal, /candidate was permanently rejected; repair needs fresh ticket, attempt, candidate, and review identities/);

    assert.ok(!readyRefs().includes(review.ref), 'ready does not list the rejected review');
    assert.ok(!readyRefs().includes(source.ref), 'the parked source stays out as before');
    assert.ok(!waveRefs().includes(review.ref));

    const [row] = store.readyNotDispatchable(slug).filter((r: any) => r.ref === review.ref);
    assert.equal(row.code, 'candidate_rejected');
    assert.equal(row.reason, refusal);
    assert.equal(row.override, undefined, 'no dispatch flag rescues a rejected candidate');
    assert.match(row.next, /File a fresh repair ticket/);

    const ready = await mcp.TOOLS.find((t: any) => t.name === 'ready').handler({ project: PROJECT });
    const payload = typeof ready === 'string' ? JSON.parse(ready) : ready;
    const text = JSON.stringify(payload);
    assert.match(text, new RegExp(`"notDispatchable".*"${review.ref}".*candidate_rejected`));

    // SQ-113's warning named SQ-254 as unblocked ready work waiting undispatched. It no longer does.
    const prepared = store.prepareDispatch(slug, target.ref);
    assert.deepEqual(store.dispatchHigherPriorityReady(prepared.ticket, slug), []);
    assert.doesNotMatch(store.dispatchWarnings(prepared.ticket, slug).join('\n'), new RegExp(`${review.ref}\\b`));
    assert.equal(store.releaseTicket(slug, target.ref, 'agreement-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  } finally {
    archive(review, target);
  }
});

// claimNext was checked for the same disagreement and deliberately left alone: on a routed board a
// non-direct claim refuses dispatch_required, so `next` hands out only direct inline claims, which
// never pass through dispatch and so are not subject to its stored-state refusals.
test('claimNext is the direct inline path, so dispatch-only refusals do not hold it back', () => {
  const unscoped = writeTicket('unscoped urgent', 'urgent', []);
  const target = writeTicket('claimable low', 'low');
  try {
    assert.ok(!readyRefs().includes(unscoped.ref), 'ready holds the unscoped ticket back from dispatch');
    const claimed = store.claimNext(slug, 'agreement-claimer', { direct: true, reason: 'test fixture claims inline' });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.ticket.ref, unscoped.ref, 'a direct inline claim still takes the top-priority ticket');
    assert.equal(store.releaseTicket(slug, unscoped.ref, 'agreement-claimer', { status: 'todo', source: 'test', force: true }).ok, true);
  } finally {
    archive(unscoped, target);
  }
});
