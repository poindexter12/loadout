import test from 'node:test';
import assert from 'node:assert/strict';

const { planGithub, applyGithub } = require('../src/lib/audit/github');

type Call = { program: string; arguments_: string[] };
function fakeGh(responses: Record<string, unknown>, calls: Call[] = []) {
  return (program: string, arguments_: string[]) => {
    calls.push({ program, arguments_ });
    const key = arguments_.join(' ');
    const response = responses[key];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected gh ${key}`);
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
}

const linked = [{ ticketId: 'tk_one', ref: 'SQ-84', provider: 'github', repo: 'owner/repo', number: 12 }];
const done = [{ id: 'tk_one', ref: 'SQ-84', status: 'done' }];
const list = 'issue list --repo owner/repo --state all --limit 1000 --json number,state,labels,title';
const comments = 'api repos/owner/repo/issues/12/comments --paginate';

test('plans only linked issue drift and reports untracked open issues', () => {
  const plan = planGithub({
    links: linked,
    tickets: done,
    released: { tk_one: null },
    gh: fakeGh({ [list]: [
      { number: 12, state: 'OPEN', labels: [{ name: 'bug' }, { name: 'status:in-progress' }], title: 'linked' },
      { number: 13, state: 'OPEN', labels: [], title: 'untracked' },
    ] }),
  });
  assert.equal(plan.linkedDrift.length, 1);
  assert.deepEqual(plan.linkedDrift[0].actions, [
    { type: 'addLabel', label: 'status:in-testing' },
    { type: 'removeLabel', label: 'status:in-progress' },
  ]);
  assert.deepEqual(plan.untrackedIssues.map((issue: any) => issue.number), [13]);
});

test('many-to-many closes only after all tickets release and names every ref', () => {
  const links = [...linked, { ticketId: 'tk_two', ref: 'SQ-85', provider: 'github', repo: 'owner/repo', number: 12 }];
  const tickets = [...done, { id: 'tk_two', ref: 'SQ-85', status: 'doing' }];
  const issues = [{ number: 12, state: 'OPEN', labels: [{ name: 'status:in-progress' }] }];
  const unreleased = planGithub({ links, tickets, released: { tk_one: { version: 'v3.546.0' }, tk_two: null }, gh: fakeGh({ [list]: issues }) });
  assert.deepEqual(unreleased.linkedDrift, []);
  const released = planGithub({ links, tickets, released: { tk_one: { version: 'v3.546.0' }, tk_two: { version: 'v3.547.0' } }, gh: fakeGh({ [list]: issues }) });
  const comment = released.linkedDrift[0].actions.find((action: any) => action.type === 'comment') as any;
  assert.match(comment.body, /Fixed in v3\.547\.0 \(SQ-84, SQ-85\)/);
  assert.match(comment.marker, /ticket=tk_one,tk_two/);
  assert.deepEqual(released.linkedDrift[0].actions.map((action: any) => action.type), ['removeLabel', 'comment', 'close']);
});

test('plans a missing release marker on an already closed issue without closing it again', () => {
  const plan = planGithub({
    links: linked,
    tickets: done,
    released: { tk_one: { version: 'v3.546.0' } },
    gh: fakeGh({ [list]: [{ number: 12, state: 'CLOSED', labels: [] }], [comments]: [] }),
  });
  assert.deepEqual(plan.linkedDrift[0].actions.map((action: any) => action.type), ['comment']);
});

test('treats a closed issue with its release marker as converged', () => {
  const marker = '<!-- sidequest:released ticket=tk_one version=v3.546.0 -->';
  const plan = planGithub({
    links: linked,
    tickets: done,
    released: { tk_one: { version: 'v3.546.0' } },
    gh: fakeGh({ [list]: [{ number: 12, state: 'CLOSED', labels: [] }], [comments]: [{ body: marker }] }),
  });
  assert.deepEqual(plan.linkedDrift, []);
});

test('finds a release marker on a later paginated comments response', () => {
  const marker = '<!-- sidequest:released ticket=tk_one version=v3.546.0 -->';
  const calls: Call[] = [];
  const plan = planGithub({
    links: linked,
    tickets: done,
    released: { tk_one: { version: 'v3.546.0' } },
    gh: fakeGh({ [list]: [{ number: 12, state: 'CLOSED', labels: [] }], [comments]: `[{"body":"earlier"}]\n[{"body":"${marker}"}]` }, calls),
  });
  assert.deepEqual(plan.linkedDrift, []);
  assert.equal(calls.some((call) => call.arguments_.join(' ') === comments), true);
});

test('apply creates labels, comments once, closes after comment, and leaves a second plan empty', () => {
  const initial = [{ number: 12, state: 'OPEN', labels: [] }];
  const plan = planGithub({ links: linked, tickets: done, released: { tk_one: { version: 'v3.546.0' } }, gh: fakeGh({ [list]: initial }) });
  const calls: Call[] = [];
  const gh = fakeGh({
    'label list --repo owner/repo --limit 1000 --json name': [],
    'issue edit 12 --repo owner/repo --remove-label status:in-progress': '',
    [comments]: [],
    [`issue comment 12 --repo owner/repo --body ${(plan.linkedDrift[0].actions.find((action: any) => action.type === 'comment') as any).body}`]: '',
    'issue close 12 --repo owner/repo': '',
  }, calls);
  const results = applyGithub(plan, gh);
  assert.ok(results.some((result: any) => result.action === 'comment' && result.ok));
  assert.ok(results.some((result: any) => result.action === 'close' && result.ok));
  assert.equal(calls.some((call) => call.arguments_.join(' ').startsWith('issue edit 13 ')), false);
  const second = planGithub({
    links: linked,
    tickets: done,
    released: { tk_one: { version: 'v3.546.0' } },
    gh: fakeGh({
      [list]: [{ number: 12, state: 'CLOSED', labels: [] }],
      [comments]: [{ body: '<!-- sidequest:released ticket=tk_one version=v3.546.0 -->' }],
    }),
  });
  assert.deepEqual(applyGithub(second, gh), []);
});

test('does not close when comment lookup or posting fails', () => {
  const plan = planGithub({ links: linked, tickets: done, released: { tk_one: { version: 'v3.546.0' } }, gh: fakeGh({ [list]: [{ number: 12, state: 'OPEN', labels: [] }] }) });
  const comment = plan.linkedDrift[0].actions.find((action: any) => action.type === 'comment') as any;
  const calls: Call[] = [];
  const results = applyGithub(plan, fakeGh({
    'label list --repo owner/repo --limit 1000 --json name': [],
    [comments]: [],
    [`issue comment 12 --repo owner/repo --body ${comment.body}`]: new Error('offline'),
  }, calls));
  assert.ok(results.some((result: any) => result.action === 'close' && result.skipped));
  assert.equal(calls.some((call) => call.arguments_.join(' ').startsWith('issue close')), false);
});

test('creates missing status labels and reopens an incorrectly closed linked issue', () => {
  const inProgress = planGithub({ links: linked, tickets: [{ id: 'tk_one', ref: 'SQ-84', status: 'doing' }], released: {}, gh: fakeGh({ [list]: [{ number: 12, state: 'CLOSED', labels: [] }] }) });
  assert.deepEqual(inProgress.linkedDrift[0].actions, [
    { type: 'addLabel', label: 'status:in-progress' },
    { type: 'reopen' },
  ]);
  const calls: Call[] = [];
  applyGithub(inProgress, fakeGh({
    'label list --repo owner/repo --limit 1000 --json name': [],
    'label create status:in-progress --repo owner/repo --color 0E8A16': '',
    'issue edit 12 --repo owner/repo --add-label status:in-progress': '',
    'issue reopen 12 --repo owner/repo': '',
  }, calls));
  assert.equal(calls.some((call) => call.arguments_.join(' ') === 'label create status:in-progress --repo owner/repo --color 0E8A16'), true);
  assert.equal(calls.some((call) => call.arguments_.join(' ') === 'issue reopen 12 --repo owner/repo'), true);
});

test('offline planning and applying are warning/no-op and never throw', () => {
  const plan = planGithub({ links: linked, tickets: done, released: {}, gh: fakeGh({ [list]: new Error('not authenticated') }) });
  assert.deepEqual(plan.linkedDrift, []);
  assert.deepEqual(plan.untrackedIssues, []);
  assert.match(plan.warnings[0], /GitHub sections skipped/);
  assert.deepEqual(applyGithub(plan, fakeGh({})), []);
});

// --- Issue mirror (SQ-98) ---------------------------------------------------

const {
  MIRRORED_FIELDS, REDACTION_CLASSES, applyIssueMirror, defaultIssueMirror,
  mirrorMatches, planIssueMirror, redactionClassesFor, renderMirrorIssue, sanitizeText,
} = require('../src/lib/audit/mirror');

const mirrorContext = { hostname: 'joes-laptop.local', foreignProjects: ['jacaranda-foundation', 'another-board'] };
const mirrorOn = { enabled: true, labels: ['bug', 'feature'], categories: [], stories: [], labelMap: { bug: 'bug', feature: 'enhancement' } };

function mirrorTicket(overrides: Record<string, unknown> = {}) {
  return { id: 'tk_m1', ref: 'SQ-900', title: 'Dashboard totals drift after a refresh', description: 'The totals row disagrees with the rows below it after a refresh. Expected: both agree. See https://example.com/spec for the contract.', status: 'todo', labels: ['bug'], category: 'coding.normal', storyId: null, ...overrides };
}

// One case per deny class the grooming pass named. A class that is in the list
// but never fires is a deny-list that exists and is not called.
const denyCases: ReadonlyArray<readonly [string, string]> = [
  ['home-path', 'the log is at ~/.claude/sidequest/audit.log today'],
  ['absolute-path', 'the log is at /Users/someone/Code/loadout/proxy.log today'],
  ['session-id', 'session 107afcfd-f8bd-4140-8c0c-f71a02574e5b stalled'],
  ['dispatch-token', 'pass token: aa19d404-e50b-44a2 to the launcher'],
  ['opaque-identifier', 'digest 9f3c1a7edeadbeefcafef00dbaadf00d0123 was wrong'],
  ['cost', 'the run cost $12.40 before it failed'],
  ['hostname', 'reproduced on build-box.local overnight'],
  ['claim-owner', 'claimed by sq-98-exec-9f3c1a7e and never released'],
  ['board-slug', 'board loadout-4d277aeb holds the record'],
  ['board-ref', 'this duplicates SQ-364 exactly'],
  ['machine-hostname', 'only joes-laptop.local reproduces it'],
  ['foreign-project', 'the same bug exists in jacaranda-foundation'],
];

for (const [className, text] of denyCases) {
  test(`issue mirror deny class ${className} is detected and redacted`, () => {
    assert.equal(REDACTION_CLASSES.includes(className), true, `${className} must be a published deny class`);
    assert.equal(redactionClassesFor(text, mirrorContext).includes(className), true, `${className} must fire on: ${text}`);
    const sanitized = sanitizeText(text, mirrorContext);
    assert.match(sanitized, /\[redacted\]/);
    assert.deepEqual(redactionClassesFor(sanitized.replace(/\[redacted\]/g, ''), mirrorContext), []);
  });
}

test('issue mirror deny classes are reachable from the mirror path, not just the sanitizer', () => {
  // Reachability: every class above is exercised through planIssueMirror, the
  // only entry point that can ever reach GitHub.
  for (const [className, text] of denyCases) {
    const plan = planIssueMirror({
      tickets: [mirrorTicket({ id: `tk_${className}`, ref: 'SQ-901', description: `A real problem statement. ${text}` })],
      links: [], config: mirrorOn, repo: 'owner/repo', context: mirrorContext,
    });
    assert.equal(plan.creations.length, 1, `${className} ticket should still plan`);
    assert.equal(plan.creations[0].body.includes('[redacted]'), true, `${className} must be redacted in the planned body`);
    assert.deepEqual(redactionClassesFor(plan.creations[0].body.replace(/\[redacted\]/g, ''), mirrorContext), [], `${className} leaked into the planned body`);
  }
});

test('issue mirror publishes an allow-list of fields and nothing a later field could add', () => {
  assert.deepEqual([...MIRRORED_FIELDS], ['title', 'description']);
  const rendered = renderMirrorIssue(mirrorTicket({ worktreePath: '/Users/someone/wt', claim: { by: 'sq-98-exec-9f3c1a7e' }, comments: [{ body: '/Users/someone/secret' }] } as any), mirrorOn, mirrorContext);
  assert.equal('reason' in rendered, false);
  const body = (rendered as { body: string }).body;
  assert.equal(body.includes('/Users/someone'), false);
  assert.equal(body.includes('sq-98-exec'), false);
  assert.match(body, /totals row disagrees/);
  assert.match(body, /https:\/\/example\.com\/spec/); // public links survive
});

test('issue mirror refuses to publish a rendering it cannot clean', () => {
  const plan = planIssueMirror({
    tickets: [mirrorTicket({ title: '/Users/someone/Code/loadout is broken' })],
    links: [], config: mirrorOn, repo: 'owner/repo', context: mirrorContext,
  });
  assert.deepEqual(plan.creations, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.warnings[0], /issue mirror skipped/);
});

test('issue mirror is off by default and matches only the configured filter', () => {
  const off = defaultIssueMirror();
  assert.equal(off.enabled, false);
  assert.equal(mirrorMatches(mirrorTicket(), off), false);
  assert.deepEqual(planIssueMirror({ tickets: [mirrorTicket()], links: [], config: off, repo: 'owner/repo' }).creations, []);
  assert.equal(mirrorMatches(mirrorTicket(), mirrorOn), true);
  assert.equal(mirrorMatches(mirrorTicket({ labels: ['chore'] }), mirrorOn), false);
  assert.equal(mirrorMatches(mirrorTicket({ archived: true }), mirrorOn), false);
  // Review/research categories need naming outright; a bug label never buys them in.
  assert.equal(mirrorMatches(mirrorTicket({ category: 'review-audit' }), mirrorOn), false);
  assert.equal(mirrorMatches(mirrorTicket({ category: 'evidence-research' }), mirrorOn), false);
  assert.equal(mirrorMatches(mirrorTicket({ category: 'review-audit' }), { ...mirrorOn, categories: ['review-audit'] }), true);
  assert.equal(mirrorMatches(mirrorTicket({ labels: [], storyId: 'st_1' }), { ...mirrorOn, stories: ['st_1'] }), true);
});

test('issue mirror maps ticket labels to GitHub labels and leaves hand-linked tickets alone', () => {
  const plan = planIssueMirror({
    tickets: [mirrorTicket(), mirrorTicket({ id: 'tk_m2', ref: 'SQ-902', labels: ['feature'] }), mirrorTicket({ id: 'tk_m3', ref: 'SQ-903' })],
    links: [{ ticketId: 'tk_m3', provider: 'github' }], config: mirrorOn, repo: 'owner/repo', context: mirrorContext,
  });
  assert.deepEqual(plan.creations.map((creation: any) => creation.ticketId), ['tk_m1', 'tk_m2']);
  assert.deepEqual(plan.creations[0].labels, ['bug']);
  assert.deepEqual(plan.creations[1].labels, ['enhancement']);
});

test('applying the issue mirror creates one issue, records the link, and never repeats itself', () => {
  const calls: Call[] = [];
  const recorded: any[] = [];
  const labelList = 'label list --repo owner/repo --limit 1000 --json name';
  const gh = fakeGh({ [labelList]: [{ name: 'bug' }], 'ISSUE_CREATE': '' }, calls) as any;
  const creating = (program: string, arguments_: string[]) => {
    if (arguments_[0] === 'issue' && arguments_[1] === 'create') {
      calls.push({ program, arguments_ });
      return 'https://github.com/owner/repo/issues/77\n';
    }
    return gh(program, arguments_);
  };
  const first = planIssueMirror({ tickets: [mirrorTicket()], links: [], config: mirrorOn, repo: 'owner/repo', context: mirrorContext });
  const results = applyIssueMirror(first, creating as any, (ticketId: string, record: any) => recorded.push({ ticketId, ...record }));
  assert.deepEqual(results.map((result: any) => [result.action, result.ok, result.number]), [['createIssue', true, 77]]);
  assert.deepEqual(recorded, [{ ticketId: 'tk_m1', provider: 'github', repo: 'owner/repo', number: 77, url: 'https://github.com/owner/repo/issues/77' }]);
  const created = calls.find((call) => call.arguments_[1] === 'create')!.arguments_;
  assert.equal(created.includes('--label'), true);
  assert.equal(created[created.indexOf('--label') + 1], 'bug');
  assert.equal(created.join(' ').includes('SQ-900'), false);
  // Idempotent: the stored link is the key, so the second plan is empty.
  const second = planIssueMirror({ tickets: [mirrorTicket()], links: [{ ticketId: 'tk_m1', provider: 'github' }], config: mirrorOn, repo: 'owner/repo', context: mirrorContext });
  assert.deepEqual(second.creations, []);
  assert.deepEqual(applyIssueMirror(second, creating as any, () => undefined), []);
});

test('issue mirror reports instead of throwing when the repo is unknown or gh fails', () => {
  const noRepo = planIssueMirror({ tickets: [mirrorTicket()], links: [], config: mirrorOn, repo: null, context: mirrorContext });
  assert.deepEqual(noRepo.creations, []);
  assert.match(noRepo.warnings[0], /no GitHub origin repo/);
  const plan = planIssueMirror({ tickets: [mirrorTicket()], links: [], config: mirrorOn, repo: 'owner/repo', context: mirrorContext });
  const failing = (() => { throw new Error('gh: not authenticated'); }) as any;
  const results = applyIssueMirror(plan, failing, () => undefined);
  assert.deepEqual(results.map((result: any) => [result.action, result.ok]), [['createIssue', false]]);
  assert.match(results[0].error, /not authenticated/);
});
