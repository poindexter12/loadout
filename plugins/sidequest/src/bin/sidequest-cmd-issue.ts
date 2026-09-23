'use strict';

const store = require('../lib/store');
const { fail, resolveProject } = require('./sidequest-cmd-shared');

async function cmdIssue(opts: any, positional: string[]) {
  const [action, ref, issueInput] = positional;
  if (!['link', 'unlink', 'list'].includes(String(action || ''))) fail('issue: expected `sidequest issue link|unlink|list <REF> <url|#N>`');
  const project = await resolveProject(opts);
  if (action === 'list') {
    const links = store.listExternalLinks(project.slug, ref ? { ticketId: ref } : {});
    if (opts.json) console.log(JSON.stringify({ links }, null, 2));
    else for (const link of links) console.log(`${link.ref} ${link.url}`);
    return links;
  }
  if (!ref || !issueInput) fail(`issue ${action}: expected a ticket ref and GitHub issue URL or #N.`);
  const issue = store.parseGitHubIssue(project.slug, issueInput);
  const result = action === 'link'
    ? store.addExternalLink(project.slug, ref, issue)
    : store.removeExternalLink(project.slug, ref, issue);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(action === 'link' ? `${result.ref} linked ${result.url}` : `${ref} unlinked ${issue.url}`);
  return result;
}

module.exports = { cmdIssue };
