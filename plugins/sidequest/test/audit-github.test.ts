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
