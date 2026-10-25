'use strict';
// SQ-137: one topic shard of the former submission.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_submission-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  path,
  fs,
  store,
  PROJECT_DIR,
  REMOTE_DIR,
  git,
  cleanBranch,
  pin,
  slug,
  addTicket,
  callMcp,
  fixtureState,
} from './_submission-fixture.js';

test('SQ-277: a shared-tree submit excludes foreign dirt from the dirty-scope gate and starts after a sibling sanctioned commit', async (t?: any) => {
  if (git(['remote']).split(/\r?\n/).includes('origin')) {
    git(['remote', 'set-url', 'origin', REMOTE_DIR]);
  } else {
    git(['remote', 'add', 'origin', REMOTE_DIR]);
  }
  git(['fetch', 'origin']);
  cleanBranch();
  const dispatchBase = git(['rev-parse', 'origin/main']);
  const priorBoardConfig = store.boardConfig(slug);
  assert.strictEqual(store.setBoardConfig(slug, { integrationMode: 'remote', integrationBranch: 'main' }).ok, true);
  t.after(() => {
    store.setBoardConfig(slug, {
      integrationMode: priorBoardConfig.integrationMode,
      integrationBranch: priorBoardConfig.integrationBranch,
    });
    git(['checkout', '-f', '-B', `submission-${++fixtureState.branchSeq}`, dispatchBase]);
    git(['clean', '-fd']);
    git(['branch', '-f', 'main', dispatchBase]);
    git(['push', '--force', 'origin', 'main']);
    git(['fetch', 'origin']);
  });

  function dispatch(title: string, files: string[], worker: string, sessionId: string, sharedTree: boolean) {
    const ticket = addTicket(title, { files, category: 'submission.fixture' });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree });
    assert.strictEqual(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      sessionId,
    }).ok, true);
    return ticket;
  }

  async function submit(ticket: any, worker: string, commit: string) {
    pin(ticket, commit);
    return callMcp('submit', {
      project: PROJECT_DIR,
      ref: ticket.ref,
      by: worker,
      commit,
      worktree: PROJECT_DIR,
      body: 'SQ-277 shared-tree attribution fixture.',
    });
  }

  function write(file: string, body: string) {
    const target = path.join(PROJECT_DIR, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }

  function commitPaths(message: string, paths: string[]) {
    git(['add', ...paths]);
    git(['commit', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  }

  // Case 1: the board widened this ticket's scope to a directory, and a live sibling's
  // uncommitted file sits inside it. The commit tool refuses to sweep that file into this
  // ticket's commit, so demanding it be committed here left the executor no legal move.
  const widenedSibling = dispatch('widened sibling owns its own file', ['lib/widened/sibling.js'], 'widened-sibling-worker', 'sq277-widened-sibling', true);
  const widenedCandidate = dispatch('widened candidate owns the directory', ['lib/widened'], 'widened-candidate-worker', 'sq277-widened-candidate', true);
  write('lib/widened/candidate.js', 'candidate\n');
  const widenedCommit = commitPaths('widened candidate work', ['lib/widened/candidate.js']);
  write('lib/widened/sibling.js', 'sibling work in progress\n');
  const widenedSubmission = await submit(widenedCandidate, 'widened-candidate-worker', widenedCommit);
  assert.strictEqual(widenedSubmission.ok, true, widenedSubmission.message);
  assert.match(
    widenedSubmission.advisory,
    new RegExp(`lib/widened/sibling\\.js \\(${widenedSibling.ref}\\)`),
    'the sibling keeps its file and is named as its owner rather than being counted against this ticket',
  );
  assert.deepStrictEqual(
    store.getTicket(slug, widenedCandidate.ref).submission.excludedScopePaths,
    [{ path: 'lib/widened/sibling.js', owners: [widenedSibling.ref] }],
  );
  assert.strictEqual(store.getTicket(slug, widenedSibling.ref).claim?.by, 'widened-sibling-worker', 'the sibling claim is untouched');

  // Case 2: dirt that was already in the shared tree when this dispatch launched, inside
  // the declared scope. The dirty baseline attributes it to the tree, not to this ticket.
  cleanBranch();
  write('lib/inherited/user-draft.js', 'user draft present before dispatch\n');
  const inheritedCandidate = dispatch('inherited dirt candidate', ['lib/inherited'], 'inherited-candidate-worker', 'sq277-inherited', true);
  write('lib/inherited/work.js', 'work\n');
  const inheritedCommit = commitPaths('inherited dirt candidate work', ['lib/inherited/work.js']);
  const inheritedSubmission = await submit(inheritedCandidate, 'inherited-candidate-worker', inheritedCommit);
  assert.strictEqual(inheritedSubmission.ok, true, inheritedSubmission.message);
  assert.match(inheritedSubmission.advisory, /lib\/inherited\/user-draft\.js \(pre-existing since dispatch base\)/);
  assert.deepStrictEqual(
    store.getTicket(slug, inheritedCandidate.ref).submission.excludedScopePaths,
    [{ path: 'lib/inherited/user-draft.js', owners: ['pre-existing since dispatch base'] }],
  );

  // Case 3 (regression guard): an isolated worktree belongs to one executor, so nothing
  // uncommitted inside its scope is foreign and the gate stays exactly as it was.
  cleanBranch();
  const isolatedCandidate = dispatch('isolated candidate keeps the dirty gate', ['lib/isolated'], 'isolated-candidate-worker', 'sq277-isolated', false);
  write('lib/isolated/work.js', 'work\n');
  const isolatedCommit = commitPaths('isolated candidate work', ['lib/isolated/work.js']);
  write('lib/isolated/uncommitted.js', 'left behind\n');
  const isolatedSubmission = await submit(isolatedCandidate, 'isolated-candidate-worker', isolatedCommit);
  assert.strictEqual(isolatedSubmission.ok, false);
  assert.strictEqual(isolatedSubmission.reason, 'dirty_scope');
  assert.match(isolatedSubmission.message, /lib\/isolated\/uncommitted\.js/);

  // Case 4 (regression guard): the shared-tree executor's own uncommitted work inside its
  // own scope is nobody else's, so it is still refused.
  cleanBranch();
  const ownDirtCandidate = dispatch('shared-tree candidate owns its own dirt', ['lib/own-dirt'], 'own-dirt-worker', 'sq277-own-dirt', true);
  write('lib/own-dirt/work.js', 'work\n');
  const ownDirtCommit = commitPaths('own dirt candidate work', ['lib/own-dirt/work.js']);
  write('lib/own-dirt/forgotten.js', 'forgotten\n');
  const ownDirtSubmission = await submit(ownDirtCandidate, 'own-dirt-worker', ownDirtCommit);
  assert.strictEqual(ownDirtSubmission.ok, false);
  assert.strictEqual(ownDirtSubmission.reason, 'dirty_scope');
  assert.match(ownDirtSubmission.message, /lib\/own-dirt\/forgotten\.js/);

  // Case 5: a sibling that committed through the board but has not submitted yet. Its
  // sanctioned commit is an approved boundary, so this candidate's range starts after it
  // instead of swallowing it and being refused for paths it never touched.
  cleanBranch();
  const sanctionedSibling = dispatch('sanctioned sibling commits first', ['lib/sanctioned-sibling.js'], 'sanctioned-sibling-worker', 'sq277-sanctioned-sibling', true);
  const sanctionedCandidate = dispatch('sanctioned candidate commits second', ['lib/sanctioned-candidate.js'], 'sanctioned-candidate-worker', 'sq277-sanctioned-candidate', true);
  write('lib/sanctioned-sibling.js', 'sibling\n');
  const siblingCommit = commitPaths('sanctioned sibling work', ['lib/sanctioned-sibling.js']);
  assert.strictEqual(store.recordSanctionedCommit(slug, sanctionedSibling.ref, { by: 'sanctioned-sibling-worker', commit: siblingCommit }).ok, true);
  write('lib/sanctioned-candidate.js', 'candidate\n');
  const sanctionedCommit = commitPaths('sanctioned candidate work', ['lib/sanctioned-candidate.js']);
  const sanctionedSubmission = await submit(sanctionedCandidate, 'sanctioned-candidate-worker', sanctionedCommit);
  assert.strictEqual(sanctionedSubmission.ok, true, sanctionedSubmission.message);
  const storedSanctioned = store.getTicket(slug, sanctionedCandidate.ref).submission;
  assert.strictEqual(storedSanctioned.base, siblingCommit, 'the sibling sanctioned commit is the selected boundary');
  assert.deepStrictEqual(storedSanctioned.commits, [sanctionedCommit]);
  assert.deepStrictEqual(storedSanctioned.changedPaths, ['lib/sanctioned-candidate.js']);
  assert.strictEqual(store.getTicket(slug, sanctionedSibling.ref).submission, undefined, 'the sibling still has not submitted');

  // A released sibling keeps its boundary: the commit is still in this tree's history, and
  // an executor that died after committing must not deadlock whoever committed behind it.
  cleanBranch();
  const releasedSibling = dispatch('released sibling commits then dies', ['lib/released-sibling.js'], 'released-sibling-worker', 'sq277-released-sibling', true);
  const releasedCandidate = dispatch('candidate behind a released sibling', ['lib/released-candidate.js'], 'released-candidate-worker', 'sq277-released-candidate', true);
  write('lib/released-sibling.js', 'sibling\n');
  const releasedSiblingCommit = commitPaths('released sibling work', ['lib/released-sibling.js']);
  assert.strictEqual(store.recordSanctionedCommit(slug, releasedSibling.ref, { by: 'released-sibling-worker', commit: releasedSiblingCommit }).ok, true);
  assert.strictEqual(store.releaseTicket(slug, releasedSibling.ref, 'released-sibling-worker', { status: 'todo', reason: 'executor died after committing' }).ok, true);
  write('lib/released-candidate.js', 'candidate\n');
  const releasedCandidateCommit = commitPaths('candidate behind released sibling', ['lib/released-candidate.js']);
  const releasedSubmission = await submit(releasedCandidate, 'released-candidate-worker', releasedCandidateCommit);
  assert.strictEqual(releasedSubmission.ok, true, releasedSubmission.message);
  assert.strictEqual(store.getTicket(slug, releasedCandidate.ref).submission.base, releasedSiblingCommit);
  assert.deepStrictEqual(store.getTicket(slug, releasedCandidate.ref).submission.changedPaths, ['lib/released-candidate.js']);
});

export {};
