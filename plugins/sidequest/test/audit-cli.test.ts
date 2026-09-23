import test from 'node:test';
import assert from 'node:assert/strict';

const { auditReport, formatAudit, ghExecutor, gitExecutor } = require('../src/lib/audit/report');

const ticket = { id: 'tk_one', ref: 'SQ-72', title: 'Audit command reports board drift', status: 'todo', createdAt: '2020-01-01T00:00:00.000Z' };
const linkedTicket = { id: 'tk_two', ref: 'SQ-73', title: 'Active linked change', status: 'doing', createdAt: '2020-01-01T00:00:00.000Z' };
const links = [{ ticketId: 'tk_two', ref: 'SQ-73', provider: 'github', repo: 'owner/repo', number: 3 }];

function git(args: string[]) {
  const command = args.join(' ');
  if (command === 'rev-parse --verify origin/main') return 'main';
  if (command.startsWith('log origin/main ')) return 'abcdef123456\x1f2025-01-01T00:00:00.000Z\x1fFix audit SQ-72\x1fFix audit SQ-72\x1e';
  if (command === 'ls-tree -r --name-only origin/main -- .release/unreleased') return '.release/unreleased/SQ-72.md\n';
  if (command === 'show origin/main:CHANGELOG.md') return '# Changelog\n';
  if (command === 'tag --list v* --sort=creatordate') return 'v3.600.0\n';
  if (command === 'merge-base --is-ancestor delivery v3.600.0') return '';
  if (command === 'remote get-url origin') return 'git@github.com:owner/repo.git';
  throw new Error(`unexpected git ${command}`);
}

function gh(responses: Record<string, unknown>, calls: string[] = []) {
  return (_program: string, args: string[]) => {
    const command = args.join(' ');
    calls.push(command);
    const response = responses[command];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected gh ${command}`);
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
}

const list = 'issue list --repo owner/repo --state all --limit 1000 --json number,state,labels,title';

test('audit report renders every section from injected board, git, and GitHub evidence', () => {
  const report = auditReport({
    tickets: [ticket, linkedTicket], links, git,
    gh: gh({ [list]: [
      { number: 3, state: 'OPEN', labels: [], title: 'linked drift' },
      { number: 4, state: 'OPEN', labels: [], title: 'untracked issue' },
    ] }), repo: 'owner/repo',
  });
  assert.equal(report.staleBoardTickets.length, 1);
  assert.equal(report.untrackedIssues.length, 1);
  assert.equal(report.linkedDrift.length, 1);
  const output = formatAudit(report);
  assert.match(output, /STALE BOARD TICKETS \(1\)/);
  assert.match(output, /UNTRACKED ISSUES \(1\)/);
  assert.match(output, /LINKED DRIFT \(1\)/);
  assert.match(output, /WARNINGS \(0\)/);
});

test('audit apply calls GitHub actions only for linked drift', () => {
  const calls: string[] = [];
  const report = auditReport({
    tickets: [ticket, linkedTicket], links, git,
    gh: gh({
      [list]: [{ number: 3, state: 'OPEN', labels: [], title: 'linked drift' }, { number: 4, state: 'OPEN', labels: [], title: 'untracked' }],
      'label list --repo owner/repo --limit 1000 --json name': [{ name: 'status:in-progress' }, { name: 'status:in-testing' }],
      'issue edit 3 --repo owner/repo --add-label status:in-progress': '',
    }, calls), repo: 'owner/repo',
  }, true);
  assert.equal(report.applied.length, 1);
  assert.ok(calls.some((command) => command.startsWith('issue edit 3 ')));
  assert.equal(calls.some((command) => command.startsWith('issue edit 4 ')), false);
});

test('audit turns offline GitHub access into a warning without throwing', () => {
  const report = auditReport({ tickets: [ticket], links: [], git, gh: gh({ [list]: new Error('offline') }), repo: 'owner/repo' });
  assert.equal(report.untrackedIssues.length, 0);
  assert.match(report.warnings.join('\n'), /GitHub sections skipped/);
});

test('audit turns a timed-out GitHub executor into a warning without throwing', () => {
  const calls: Record<string, unknown>[] = [];
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const timedGh = ghExecutor(((program: string, args: string[], options: Record<string, unknown>) => {
    calls.push(options);
    throw timeout;
  }) as any);
  const report = auditReport({ tickets: [ticket], links: [], git, gh: timedGh, repo: 'owner/repo' });
  assert.equal(report.untrackedIssues.length, 0);
  assert.match(formatAudit(report), /WARNINGS \(2\).*gh unavailable for owner\/repo; GitHub sections skipped\./s);
  assert.deepEqual(calls[0], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000, killSignal: 'SIGKILL' });
});

test('audit Git executor bounds timed-out commands and returns null', () => {
  const calls: Record<string, unknown>[] = [];
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const timedGit = gitExecutor('/repo', ((program: string, args: string[], options: Record<string, unknown>) => {
    calls.push(options);
    throw timeout;
  }) as any);
  assert.equal(timedGit(['remote', 'get-url', 'origin']), null);
  assert.deepEqual(calls[0], { cwd: '/repo', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000, killSignal: 'SIGKILL' });
});
