import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-external-links-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-external-links-project-'));
process.env.SIDEQUEST_HOME = HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT;
execFileSync('git', ['init', '-b', 'main'], { cwd: PROJECT });
execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Owner/Repo.git'], { cwd: PROJECT });
const store = require('../lib/store.js');
const meta = store.ensureProject(PROJECT);
const first = store.createTicket(meta.slug, { title: 'first', category: 'coding.normal', files: ['a.ts'] });
const second = store.createTicket(meta.slug, { title: 'second', category: 'coding.normal', files: ['b.ts'] });

test('external links are idempotent and many-to-many', () => {
  const issue = store.parseGitHubIssue(meta.slug, '#42');
  const once = store.addExternalLink(meta.slug, first.ref, issue);
  const twice = store.addExternalLink(meta.slug, first.ref, issue);
  store.addExternalLink(meta.slug, second.ref, issue);
  store.addExternalLink(meta.slug, first.ref, store.parseGitHubIssue(meta.slug, 'owner/repo#43'));
  assert.equal(once.ticketId, first.id);
  assert.equal(twice.ticketId, first.id);
  assert.equal(store.listExternalLinks(meta.slug, { ticketId: first.ref }).length, 2);
  assert.equal(store.listExternalLinks(meta.slug, {}).length, 3);
  store.removeExternalLink(meta.slug, first.ref, issue);
  store.removeExternalLink(meta.slug, first.ref, issue);
  assert.equal(store.listExternalLinks(meta.slug, { ticketId: first.ref }).length, 1);
});

test('issue parsing rejects malformed inputs clearly', () => {
  assert.throws(() => store.parseGitHubIssue(meta.slug, 'not-an-issue'), /expected a GitHub issue/);
});

// SQ-438: gh is injected, never run; each stub records its calls so a refusal that should stop
// before the fetch can prove it did.
function ghStub(issues: Record<number, unknown>, calls: string[][] = []) {
  return (_program: string, args: string[]) => {
    calls.push(args);
    const number = Number(args[2]);
    const issue = issues[number];
    if (issue instanceof Error) throw issue;
    if (issue === undefined) throw Object.assign(new Error('gh failed'), { stderr: `GraphQL: Could not resolve to an issue with the number of ${number}.` });
    return JSON.stringify(issue);
  };
}

function ticketCount() {
  return store.listTickets(meta.slug).length;
}

test('add from an issue defaults title and description from it and records the link', () => {
  const link = store.parseGitHubIssue(meta.slug, '#100');
  const calls: string[][] = [];
  const gh = ghStub({ 100: { number: 100, state: 'OPEN', title: 'Imported issue title', body: 'Steps to reproduce.', url: link.url } }, calls);
  const { ticket, link: recorded } = store.createTicketFromIssue(meta.slug, { category: 'coding.normal', files: ['c.ts'] }, '#100', undefined, { gh });
  assert.deepEqual(calls[0], ['issue', 'view', '100', '--repo', link.repo, '--json', 'number,state,title,body,url']);
  const saved = store.getTicket(meta.slug, ticket.ref);
  assert.equal(saved.title, 'Imported issue title');
  assert.match(saved.description, new RegExp(`^GitHub issue: ${link.url.replace(/[.]/g, '\\.')}\\n\\nSteps to reproduce\\.$`));
  assert.equal(recorded.ticketId, ticket.id);
  const links = store.listExternalLinks(meta.slug, { ticketId: ticket.ref });
  assert.equal(links.length, 1);
  assert.equal(links[0].number, 100);
  assert.equal(links[0].repo, link.repo);
});

test('add from an issue keeps an explicit title and description and still carries the issue URL', () => {
  const link = store.parseGitHubIssue(meta.slug, '#101');
  const gh = ghStub({ 101: { number: 101, state: 'OPEN', title: 'Issue title loses', body: 'issue body', url: link.url } });
  const { ticket } = store.createTicketFromIssue(meta.slug, { title: 'Explicit title wins', description: 'Where: x.ts', category: 'coding.normal', files: ['d.ts'] }, link.url, undefined, { gh });
  const saved = store.getTicket(meta.slug, ticket.ref);
  assert.equal(saved.title, 'Explicit title wins');
  assert.equal(saved.description, `Where: x.ts\n\nGitHub issue: ${link.url}`);
  assert.equal(store.listExternalLinks(meta.slug, { ticketId: ticket.ref }).length, 1);
});

test('add from an issue already linked on this board refuses, names the ticket, and never fetches', () => {
  const owner = store.createTicket(meta.slug, { title: 'owner', category: 'coding.normal', files: ['e.ts'] });
  store.addExternalLink(meta.slug, owner.ref, store.parseGitHubIssue(meta.slug, '#102'));
  const before = ticketCount();
  const calls: string[][] = [];
  assert.throws(
    () => store.createTicketFromIssue(meta.slug, { category: 'coding.normal' }, '#102', undefined, { gh: ghStub({}, calls) }),
    (error: any) => error.reason === 'issue_already_linked' && error.message.includes(owner.ref) && /issue_link/.test(error.guidance),
  );
  assert.equal(calls.length, 0);
  assert.equal(ticketCount(), before);
});

test('add from an issue gh cannot read refuses with guidance and creates no ticket', () => {
  const before = ticketCount();
  assert.throws(
    () => store.createTicketFromIssue(meta.slug, { category: 'coding.normal' }, '#103', undefined, { gh: ghStub({ 103: new Error('spawn gh ENOENT') }) }),
    (error: any) => error.reason === 'issue_fetch_failed' && /ENOENT/.test(error.message) && /gh auth status/.test(error.guidance),
  );
  assert.equal(ticketCount(), before);
  assert.equal(store.listExternalLinks(meta.slug, {}).filter((row: any) => row.number === 103).length, 0);
});

test('add from a closed issue refuses with guidance and creates no ticket', () => {
  const link = store.parseGitHubIssue(meta.slug, '#104');
  const before = ticketCount();
  assert.throws(
    () => store.createTicketFromIssue(meta.slug, { category: 'coding.normal' }, '#104', undefined, { gh: ghStub({ 104: { number: 104, state: 'CLOSED', title: 'done already', body: '', url: link.url } }) }),
    (error: any) => error.reason === 'issue_closed' && /not work to import/.test(error.message) && /Reopen/.test(error.guidance),
  );
  assert.equal(ticketCount(), before);
});

test('sidequest add --issue imports through the CLI with gh on PATH', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-external-links-gh-'));
  const link = store.parseGitHubIssue(meta.slug, '#105');
  const payload = JSON.stringify({ number: 105, state: 'OPEN', title: 'CLI imported title', body: 'cli body', url: link.url });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s' '${payload}'\n`, { mode: 0o755 });
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), 'add', '--issue', '#105', '--category', 'coding.normal', '--file', 'f.ts', '--json'], {
    cwd: PROJECT, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.ticket.title, 'CLI imported title');
  assert.equal(result.issueLink.number, 105);
  assert.equal(store.listExternalLinks(meta.slug, { ticketId: result.ticket.ref }).length, 1);
});
