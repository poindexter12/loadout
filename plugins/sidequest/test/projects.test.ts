import './_temp-cleanup.js';
'use strict';
/**
 * mergeProject ref preservation (SQ-32).
 *
 * Folding one board into another used to re-mint every source ref, which renamed tickets that
 * had no conflict at all: every comment, commit message, branch name and handoff naming the old
 * ref went stale for nothing. A merge now keeps a ref the destination does not already hold and
 * re-mints only a genuine collision.
 *
 * The companion cases in repo-anchor-and-merge.test.ts cover the mixed collide-and-keep merge
 * end to end (links, stories, assets); these cover the preservation rules themselves.
 *
 * Run: cd plugins/sidequest && npm run test:files -- test/projects.test.ts
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-projects-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

let boardSeq = 0;
// Two sibling boards under one throwaway parent, named apart per test so the slugs never clash.
function boards() {
  const root = path.join(os.tmpdir(), `sq-merge-fx-${process.pid}-${(boardSeq += 1)}`);
  return {
    dest: store.ensureProject(path.join(root, 'parent'), `parent-${boardSeq}`),
    src: store.ensureProject(path.join(root, 'parent', 'child'), `child-${boardSeq}`),
  };
}

function refsIn(slug?: any) {
  return store.listTickets(slug).map((ticket?: any) => ticket.ref).sort();
}

test('a merge into a destination with no conflicts renames nothing', () => {
  const { dest, src } = boards();
  const a = store.createTicket(src.slug, { title: 'src A', complexity: 1 });
  const b = store.createTicket(src.slug, { title: 'src B', complexity: 1 });
  assert.deepStrictEqual([a.ref, b.ref], ['SQ-1', 'SQ-2']);

  const res = store.mergeProject(src.slug, dest.slug);
  assert.strictEqual(res.tickets, 2);

  // The whole point: an empty destination holds no ref, so every ref survives the move.
  assert.deepStrictEqual(refsIn(dest.slug), ['SQ-1', 'SQ-2']);
  assert.deepStrictEqual(
    res.mapping.map((entry?: any) => [entry.from, entry.to]),
    [['SQ-1', 'SQ-1'], ['SQ-2', 'SQ-2']],
    'the reported mapping says so too',
  );

  // The counter has to cover the refs that were carried in, or the next ordinary mint reissues
  // one of them.
  assert.strictEqual(store.createTicket(dest.slug, { title: 'after', complexity: 1 }).ref, 'SQ-3');
});

test('an archived destination ticket still occupies its ref', () => {
  const { dest, src } = boards();
  const destTicket = store.createTicket(dest.slug, { title: 'dest A', complexity: 1 });
  assert.strictEqual(store.archiveTicket(dest.slug, destTicket.ref).ok, true);

  const moved = store.createTicket(src.slug, { title: 'src A', complexity: 1 });
  assert.strictEqual(moved.ref, 'SQ-1');
  store.mergeProject(src.slug, dest.slug);

  // Archiving hides a ticket, it does not release its ref: keeping SQ-1 here would surface two
  // tickets under one ref the moment the archived one came back.
  const movedNow = store.listTickets(dest.slug).find((ticket?: any) => ticket.id === moved.id);
  assert.strictEqual(movedNow.ref, 'SQ-2');
  assert.deepStrictEqual(refsIn(dest.slug), ['SQ-1', 'SQ-2']);
});

test('a re-minted ref never lands on a ref one of its siblings is keeping', () => {
  const { dest, src } = boards();
  // Dest owns SQ-1 only. The source wants SQ-1 (collides) and SQ-2, SQ-3 (both free).
  store.createTicket(dest.slug, { title: 'dest A', complexity: 1 });
  const a = store.createTicket(src.slug, { title: 'src A', complexity: 1 });
  const b = store.createTicket(src.slug, { title: 'src B', complexity: 1 });
  const c = store.createTicket(src.slug, { title: 'src C', complexity: 1 });
  assert.deepStrictEqual([a.ref, b.ref, c.ref], ['SQ-1', 'SQ-2', 'SQ-3']);

  store.mergeProject(src.slug, dest.slug);

  const byId = (id?: any) => store.listTickets(dest.slug).find((ticket?: any) => ticket.id === id).ref;
  assert.strictEqual(byId(b.id), 'SQ-2', 'free refs are kept');
  assert.strictEqual(byId(c.id), 'SQ-3');
  // Minting naively here would hand A the SQ-2 that B is keeping, so the counter is lifted past
  // every kept number before any re-mint happens.
  assert.strictEqual(byId(a.id), 'SQ-4');
  assert.deepStrictEqual(refsIn(dest.slug), ['SQ-1', 'SQ-2', 'SQ-3', 'SQ-4']);
});

test('links follow the refs that moved and keep the refs that did not', () => {
  const { dest, src } = boards();
  store.createTicket(dest.slug, { title: 'dest A', complexity: 1 });
  const a = store.createTicket(src.slug, { title: 'src A', complexity: 1 }); // SQ-1, collides
  const b = store.createTicket(src.slug, { title: 'src B', complexity: 1 }); // SQ-2, kept
  store.linkTickets(src.slug, a.ref, 'blocks', b.ref);

  store.mergeProject(src.slug, dest.slug);
  const destTickets = store.listTickets(dest.slug);
  const movedA = destTickets.find((ticket?: any) => ticket.id === a.id);
  const movedB = destTickets.find((ticket?: any) => ticket.id === b.id);

  assert.strictEqual(movedA.ref, 'SQ-3');
  assert.strictEqual(movedB.ref, 'SQ-2');

  // One side of the link was re-minted and the other was not, so a remap that rewrote both or
  // neither would break it.
  const forward = movedA.links.find((link?: any) => link.type === 'blocks');
  assert.strictEqual(forward.ref, 'SQ-2', 'B kept its ref, so the link still names SQ-2');
  const inverse = movedB.links.find((link?: any) => link.ref === movedA.ref);
  assert.ok(inverse, `the inverse link should name A's new ref SQ-3, got ${JSON.stringify(movedB.links)}`);
});

test('a dry run reports which refs would be kept without touching disk', () => {
  const { dest, src } = boards();
  store.createTicket(dest.slug, { title: 'dest A', complexity: 1 });
  store.createTicket(src.slug, { title: 'src A', complexity: 1 }); // SQ-1, would collide
  store.createTicket(src.slug, { title: 'src B', complexity: 1 }); // SQ-2, would be kept

  const res = store.mergeProject(src.slug, dest.slug, { dryRun: true });
  const mapping = new Map(res.mapping.map((entry?: any) => [entry.from, entry.to]));

  // A kept ref is known up front, so the preview names it rather than hiding it behind the
  // placeholder the re-minted ones have to use.
  assert.strictEqual(mapping.get('SQ-2'), 'SQ-2');
  assert.strictEqual(mapping.get('SQ-1'), 'SQ-?', 'a colliding ref gets its number at merge time');

  assert.strictEqual(store.listTickets(src.slug).length, 2, 'dry run must not move anything');
  assert.strictEqual(store.listTickets(dest.slug).length, 1);
  // Nor may the preview bump the destination counter.
  assert.strictEqual(store.createTicket(dest.slug, { title: 'after', complexity: 1 }).ref, 'SQ-2');
});
