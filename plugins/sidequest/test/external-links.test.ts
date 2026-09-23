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
execFileSync('git', ['init'], { cwd: PROJECT });
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
