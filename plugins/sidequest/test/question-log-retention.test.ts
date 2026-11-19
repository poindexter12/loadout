import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORKER = process.env.QUESTION_RETENTION_WORKER || path.join(ROOT, 'hooks', 'sweep-worktrees.js');

// Retention belongs to the detached SessionStart worker: the foreground hook only starts this
// process and never waits for question-log I/O.
test('detached SessionStart worker prunes expired question-log files but retains live questions and bodies', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-question-retention-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-question-retention-repo-'));
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
    const ql = require(${JSON.stringify(path.join(ROOT, 'lib', 'store', 'question-log.js'))});
    const project = store.ensureProject(${JSON.stringify(repo)});
    const dir = ql.questionLogDir(project.slug);
    const day = 24 * 60 * 60 * 1000;
    const old = Date.parse('2026-01-01T00:00:00.000Z');
    const stale = ql.askQuestion(dir, { ref: 'SQ-1', text: 'expired answer' }, { now: new Date(old) });
    const staleAnswer = ql.answerQuestion(dir, { ref: 'SQ-1', question: stale.qid, text: 's'.repeat(3000) }, { now: new Date(old + 1) });
    const open = ql.askQuestion(dir, { ref: 'SQ-2', text: 'must remain open' }, { now: new Date(old + 2) });
    ql.askQuestion(dir, { ref: 'SQ-3', text: 'rotate old segment' }, { now: new Date(old + 31 * day) });
    const live = ql.askQuestion(dir, { ref: 'SQ-4', text: 'active answer' }, { now: new Date() });
    const liveAnswer = ql.answerQuestion(dir, { ref: 'SQ-4', question: live.qid, text: 'l'.repeat(3000) }, { now: new Date() });
    fs.writeFileSync(path.join(${JSON.stringify(home)}, 'fixture.json'), JSON.stringify({ dir, open: open.qid, stale: staleAnswer.aid, live: liveAnswer.aid }));
  `;
  execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: ROOT },
  });

  execFileSync(process.execPath, [WORKER, '--cwd', repo, '--session', 'retention'], {
    env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: ROOT },
  });

  const ql = require(path.join(ROOT, 'lib', 'store', 'question-log.js'));
  const fixture = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
  const fold = ql.readQuestionLog(fixture.dir);
  assert.ok(fold.open[fixture.open], 'the worker must never remove an open question');
  assert.ok(fs.existsSync(path.join(fixture.dir, 'bodies', `${fixture.live}.txt`)), 'the worker must retain an active body file');
  assert.ok(!fs.existsSync(path.join(fixture.dir, 'bodies', `${fixture.stale}.txt`)), 'the worker removes bodies no retained line references');
  assert.deepStrictEqual(ql.listArchivedSegments(fixture.dir), [], 'the worker removes expired archived segments');
});
