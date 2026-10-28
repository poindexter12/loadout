'use strict';
// SQ-137: one topic shard of the former mcp.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_mcp-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  os,
  path,
  fs,
  mcp,
  store,
  worktrees,
  DISPATCH_DESCRIPTION,
  committedRepo,
  callTool,
  callToolRaw,
  callHandler,
  gitAt,
  runCli,
  createGitWorktree,
  prepareIsolatedWorktreeDispatch,
  submitIsolatedDeliveryCandidate,
  removeTestWorktree,
} from './_mcp-fixture.js';

test('integrate compacts successful verification output', async () => {
  const repo = committedRepo('sq-mcp-integrate-verify-success-');
  gitAt(repo, ['config', 'user.name', 'Sidequest Test']);
  gitAt(repo, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'verify-summary.cjs'), "console.log('ok 1 - verification'); console.log('1..1'); console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0'); console.log('# skipped 0'); console.log('# duration_ms 12.5');\n");
  gitAt(repo, ['add', 'verify-summary.cjs']);
  gitAt(repo, ['commit', '-m', 'verification fixture']);
  const project = store.ensureProject(repo).slug;
  const base = gitAt(repo, ['rev-parse', 'HEAD']);
  const ticket = store.createTicket(project, {
    title: 'compact successful integration output',
    category: 'codebase-exploration',
    description: 'Verify that successful integration output stays small.',
    files: ['feature.txt'],
  });
  gitAt(repo, ['checkout', '-b', 'submission']);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'submitted\n');
  gitAt(repo, ['add', 'feature.txt']);
  gitAt(repo, ['commit', '-m', 'submission fixture']);
  const commit = gitAt(repo, ['rev-parse', 'HEAD']);
  const gitRef = `refs/sidequest/${ticket.ref}`;
  gitAt(repo, ['update-ref', gitRef, commit]);
  gitAt(repo, ['checkout', 'main']);
  const verify = `"${process.execPath}" verify-summary.cjs`;
  assert.equal(store.claimTicket(project, ticket.ref, 'fixture-worker', { direct: true, reason: 'The integration fixture requires a local direct claim.' }).ok, true);
  const submitted = store.submitTicket(project, ticket.ref, 'fixture-worker', {
    commit,
    gitRef,
    range: {
      base,
      upstream: 'main',
      upstreamCommit: base,
      commits: [commit],
      changedPaths: ['feature.txt'],
      integrationMode: 'local',
      integrationBranch: 'main',
    },
    worktree: repo,
    verify,
  });
  assert.equal(submitted.ok, true);

  const result = await callHandler('integrate', { project, ref: ticket.ref, by: 'payload-tester' });
  const payload = JSON.stringify(result);
  assert.equal(result.ok, true);
  assert.equal(result.verify.status, 'passed');
  assert.match(fs.readFileSync(result.verify.logPath, 'utf8'), /^# tests 1$/m);
  assert.ok(result.verify.logPath);
  assert.equal(result.verify.outputTail, undefined);
  assert.equal(result.delivery.verify, undefined);
  assert.equal((payload.match(/"verify"\s*:/g) || []).length, 1);
  assert.equal(payload.includes('ok 1 - verification'), false);
});

test('verify commands reject direct multi-plugin directory chaining', () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-multi-plugin-verify-')).slug;
  assert.throws(() => store.createTicket(project, {
    title: 'unsafe multi-plugin verify',
    executorVerify: 'cd plugins/sidequest && npm test; cd plugins/observability && npm test',
  }), /Verify cannot use `;` command chaining/);
  assert.doesNotThrow(() => store.createTicket(project, {
    title: 'safe multi-plugin verify',
    executorVerify: '(cd plugins/sidequest && npm test) && (cd plugins/observability && npm test)',
  }));
});

test('dispatch records a heal-capable loaded-version skew and returns its warning', async () => {
  const projectPath = committedRepo('sq-mcp-dispatch-freshness-');
  const project = store.ensureProject(projectPath).slug;
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-dispatch-freshness-home-'));
  const installPath = path.join(claudeHome, 'sidequest-install');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const originalClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const loadedPluginRoot = path.join(__dirname, '..');
  try {
    fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(path.join(installPath, '.mcp.json'), JSON.stringify({ mcpServers: { board: {} } }));
    fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
    fs.writeFileSync(registryPath, JSON.stringify({ plugins: {
      'sidequest@loadout': [{ scope: 'project', projectPath, installPath, version: '99.99.99' }],
    } }));
    process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_PLUGIN_ROOT = loadedPluginRoot;

    const ticket = await callTool('add', {
      project,
      title: 'dispatch freshness warning',
      description: DISPATCH_DESCRIPTION,
      category: 'general',
      files: ['src'],
    });
    const dispatched = await callTool('dispatch', { allowUnscoped: true, project, ref: ticket.ref, full: true });
    assert.match(dispatched.warnings.join('\n'), /Sidequest dispatch skew: loaded \d+\.\d+\.\d+, installed 99\.99\.99/);
    const prepared = store.getTicket(project, ticket.ref);
    assert.deepEqual(prepared.dispatch?.dispatchSkew, {
      loadedVersion: JSON.parse(fs.readFileSync(path.join(loadedPluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version,
      installedVersion: '99.99.99',
      schemaVersion: 1,
    });
  } finally {
    if (originalClaudeHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = originalClaudeHome;
    if (originalPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
  }
});

test('dispatch keeps freshness silent with an isolated matching install', async () => {
  const projectPath = committedRepo('sq-mcp-dispatch-freshness-current-');
  const project = store.ensureProject(projectPath).slug;
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-dispatch-freshness-current-home-'));
  const installPath = path.join(claudeHome, 'sidequest-install');
  const stalePluginRoot = path.join(claudeHome, 'stale-plugin-root');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const originalClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const loadedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  try {
    fs.mkdirSync(path.join(stalePluginRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(path.join(stalePluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(installPath, '.mcp.json'), JSON.stringify({ mcpServers: { board: {} } }));
    fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }));
    fs.writeFileSync(registryPath, JSON.stringify({ plugins: {
      'sidequest@loadout': [{ scope: 'project', projectPath, installPath, version: loadedVersion }],
    } }));
    process.env.SIDEQUEST_CLAUDE_HOME = claudeHome;
    process.env.CLAUDE_PLUGIN_ROOT = stalePluginRoot;

    const ticket = await callTool('add', {
      project,
      title: 'dispatch freshness stays silent',
      description: DISPATCH_DESCRIPTION,
      category: 'general',
      files: ['src'],
    });
    const dispatched = await callTool('dispatch', { allowUnscoped: true, project, ref: ticket.ref, full: true });
    assert.deepEqual(dispatched.warnings, []);
  } finally {
    if (originalClaudeHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = originalClaudeHome;
    if (originalPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
  }
});

test('read-only external output is accepted while repository-category output is refused', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-dispatch-external-')).slug;
  const scope = path.join(os.tmpdir(), `sq-mcp-dispatch-audition-${process.pid}.html`).replace(/\\/g, '/');
  const allowed = await callTool('add', {
    project,
    title: 'external dispatch output',
    description: DISPATCH_DESCRIPTION,
    category: 'codebase-exploration',
    files: [scope],
  });
  const prepared = store.prepareDispatch(project, allowed.ref, { sharedTree: false });
  assert.equal(prepared.ticket.dispatch.nonRepoOutput, true);

  const refused = await callToolRaw('add', {
    project,
    title: 'repository external dispatch output',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: [scope],
  });

  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /paths outside the repo worktree/);
  assert.match(refused.content[0].text, /classify as non-repo\/artifact work/);
});

test('dispatch warns about declared scopes held by in-flight tickets', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-dispatch-overlap-')).slug;
  const inFlight = await callTool('add', {
    project,
    title: 'in-flight scope',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['src'],
  });
  const prepared = store.prepareDispatch(project, inFlight.ref, { allowUnscoped: true });
  assert.equal(store.claimTicket(project, inFlight.ref, 'overlap-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const target = await callTool('add', {
    project,
    title: 'overlapping scope',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['src/lib.rs'],
  });

  const dispatched = await callTool('dispatch', { allowUnscoped: true, project, ref: target.ref, full: true });
  assert.deepEqual(dispatched.warnings, [
    `Dispatch warning: ${target.ref} overlaps in-flight ${inFlight.ref} at src/lib.rs — parallel is fine in isolated worktrees unless the same symbols/regions change; assess.`,
  ]);
});

test('dispatch identifies lockfile-only scope overlaps', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-lockfile-overlap-')).slug;
  const inFlight = await callTool('add', {
    project,
    title: 'in-flight lockfile',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['Cargo.lock'],
  });
  store.prepareDispatch(project, inFlight.ref, { allowUnscoped: true });
  const target = await callTool('add', {
    project,
    title: 'overlapping lockfile',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['Cargo.lock'],
  });

  const dispatched = await callTool('dispatch', { allowUnscoped: true, project, ref: target.ref, full: true });
  assert.deepEqual(dispatched.warnings, [
    `Dispatch warning: ${target.ref} overlaps in-flight ${inFlight.ref} at Cargo.lock — parallel is fine in isolated worktrees unless the same symbols/regions change; assess. Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration.`,
  ]);
});

test('compact pulse bounds latest comment bodies and list rows omit ticket bodies', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-compact-pulse-body-')).slug;
  const body = `latest comment body: ${'x'.repeat(6000)}`;
  const ticket = store.createTicket(project, {
    title: 'compact pulse body',
    description: `ticket description: ${'y'.repeat(6000)}`,
  });
  assert.equal(store.addComment(project, ticket.ref, { body, by: 'payload-tester', kind: 'comment', source: 'mcp' }).ok, true);

  const originalPulsePayload = store.pulsePayload;
  store.pulsePayload = (slug: any, ref: any) => {
    const payload = originalPulsePayload(slug, ref);
    return Object.assign({}, payload, {
      lastComment: Object.assign({}, payload.lastComment, { body }),
    });
  };
  try {
    const raw = await callToolRaw('pulse', { project, ref: ticket.ref });
    const compact = JSON.parse(raw.content[0].text);
    assert.ok(Buffer.byteLength(raw.content[0].text) < 1000, `compact pulse is ${Buffer.byteLength(raw.content[0].text)} bytes`);
    assert.ok(compact.lastComment.body.length <= 280);
    assert.match(compact.lastComment.body, /use full:true/);

    const full = await callTool('pulse', { project, ref: ticket.ref, full: true });
    assert.equal(full.lastComment.body, body);
  } finally {
    store.pulsePayload = originalPulsePayload;
  }

  const list = await callToolRaw('list', { project });
  const row = JSON.parse(list.content[0].text).tickets.find((candidate: any) => candidate.ref === ticket.ref);
  assert.equal(row.description, undefined);
  assert.equal(row.lastComment, undefined);
  assert.equal(row.comments, 1);
  assert.ok(!list.content[0].text.includes('ticket description:'), 'compact list rows omit ticket descriptions');
  assert.ok(!list.content[0].text.includes('latest comment body:'), 'compact list rows omit comment bodies');
});

test('compact category pages stay bounded and recover complete taxonomy rows', async (t: any) => {
  const root = path.join(os.tmpdir(), 'sq-mcp-category-pages');
  const project = store.ensureProject(root, 'SQ category pages').slug;
  const expectedDescriptions = new Map();
  for (let index = 0; index < 21; index += 1) {
    const id = `bounded-${String(index).padStart(2, '0')}`;
    const prefix = `Classification contract ${index}: `;
    const description = prefix + String(index % 10).repeat(16000 - prefix.length);
    expectedDescriptions.set(id, description);
    store.setProjectCategory(project, id, 'ADD', {
      id,
      name: `Bounded category ${String(index).padStart(2, '0')}`,
      description,
      contract: `Executor contract ${index}`,
      route: { model: 'sonnet', effort: 'low' },
      fallback: null,
      enabled: true,
    });
  }

  const compactIds: string[] = [];
  const pageBytes: number[] = [];
  let cursor: string | undefined;
  let compactPages = 0;
  do {
    const raw = await callToolRaw('category_list', { project, ...(cursor ? { cursor } : {}) });
    const bytes = Buffer.byteLength(raw.content[0].text);
    pageBytes.push(bytes);
    assert.ok(bytes <= 70 * 1024, `compact category page is ${bytes} bytes`);
    const page = JSON.parse(raw.content[0].text);
    assert.equal(page.returned, page.categories.length);
    for (const category of page.categories) {
      compactIds.push(category.id);
      if (expectedDescriptions.has(category.id)) {
        assert.equal(category.descriptionLength, 16000);
        assert.equal(category.descriptionTruncated, true);
        assert.match(category.description, /use full:true/);
      }
    }
    cursor = page.nextCursor || undefined;
    compactPages += 1;
  } while (cursor);
  assert.equal(compactPages, 1);
  assert.equal(new Set(compactIds).size, compactIds.length);
  assert.deepEqual([...expectedDescriptions.keys()].filter((id) => !compactIds.includes(id)), []);
  t.diagnostic(`category_list: ${compactIds.length} rows across ${compactPages} pages, max ${Math.max(...pageBytes)} bytes`);

  const recovered = new Map();
  cursor = undefined;
  do {
    const page = await callTool('category_list', { project, full: true, limit: 1, ...(cursor ? { cursor } : {}) });
    for (const category of page.categories) {
      if (!expectedDescriptions.has(category.id)) continue;
      let body = category.descriptionRetrieval ? '' : category.description;
      let bodyCursor = category.descriptionRetrieval?.arguments.cursor || null;
      while (bodyCursor !== null) {
        const bodyPage = await callTool('context_page', { ...category.descriptionRetrieval.arguments, cursor: bodyCursor, limit: 12 * 1024 });
        body += bodyPage.body;
        bodyCursor = bodyPage.nextCursor;
      }
      recovered.set(category.id, body);
    }
    cursor = page.nextCursor || undefined;
  } while (cursor);
  assert.deepEqual(recovered, expectedDescriptions);

  const legacyFull = await callTool('category_list', { project, full: true });
  assert.equal(legacyFull.retrieval.tool, 'context_page');
  const cliCategories = runCli(['category', 'list', '--project', project, '--json']);
  assert.deepEqual(Object.keys(cliCategories).sort(), ['categories', 'localRowCount', 'profile', 'project', 'projectName', 'warnings']);
  assert.equal(cliCategories.categories.find((category: any) => category.id === 'bounded-00').description, expectedDescriptions.get('bounded-00'));

  for (const args of [{ cursor: 'bad' }, { cursor: '-1' }, { limit: 0 }, { limit: 101 }]) {
    const invalid = await callToolRaw('category_list', { project, ...args });
    assert.equal(invalid.isError, true);
  }
  const pastEnd = await callToolRaw('category_list', { project, cursor: '9999' });
  assert.equal(pastEnd.isError, true);
});

test('comment reads stay chronological through the ten-comment threshold', async (t: any) => {
  const root = path.join(os.tmpdir(), 'sq-mcp-comment-pages');
  const project = store.ensureProject(root, 'SQ comment pages').slug;
  const ticket = store.createTicket(project, {
    title: 'bounded comments',
    description: DISPATCH_DESCRIPTION,
    complexity: 2,
    complexityWhy: 'exercise bounded comment reads and complete executor briefing recovery',
  });

  const empty = await callTool('comments', { project, ref: ticket.ref });
  assert.deepEqual(empty.comments, []);
  assert.deepEqual({ total: empty.total, returned: empty.returned, nextCursor: empty.nextCursor }, { total: 0, returned: 0, nextCursor: null });

  const bodies: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const prefix = `comment-${index}:`;
    const body = prefix + String(index).repeat(16000 - prefix.length);
    bodies.push(body);
    assert.equal(store.addComment(project, ticket.ref, { body, by: `worker-${index}`, kind: 'comment', source: 'mcp' }).ok, true);
  }

  const defaultRaw = await callToolRaw('comments', { project, ref: ticket.ref });
  const defaultBytes = Buffer.byteLength(defaultRaw.content[0].text);
  const defaultRead = JSON.parse(defaultRaw.content[0].text);
  assert.equal(defaultRead.total, 8);
  assert.equal(defaultRead.returned, 8);
  assert.equal(defaultRead.order, 'chronological');
  assert.equal(defaultRead.comments[0].bodyLength, 16000);
  assert.equal(defaultRead.comments[0].bodyTruncated, true);
  assert.match(defaultRead.comments[0].body, /^comment-0:/);
  assert.equal(defaultRead.comments[0].source, undefined);
  assert.equal(Object.hasOwn(defaultRead, 'notice'), false);
  t.diagnostic(`comments: ${defaultRead.returned}/${defaultRead.total} exact rows in ${defaultBytes} bytes`);

  const recoverBody = async (retrieval: any) => {
    let body = '';
    let bodyCursor = retrieval.arguments.cursor;
    while (bodyCursor !== null) {
      const page = await callTool('context_page', { ...retrieval.arguments, cursor: bodyCursor, limit: 4096 });
      body += page.body;
      bodyCursor = page.nextCursor;
    }
    return body;
  };
  const recoverPageBodies = async (read: any) => {
    const comments = [...read.comments];
    let rowCursor = read.commentsRetrieval?.arguments.cursor || null;
    while (rowCursor !== null) {
      const page = await callTool('context_page', { ...read.commentsRetrieval.arguments, cursor: rowCursor, limit: 12 * 1024 });
      comments.push(...page.rows);
      rowCursor = page.nextCursor;
    }
    return Promise.all(comments.map((comment: any) => comment.bodyRetrieval ? recoverBody(comment.bodyRetrieval) : comment.body));
  };

  const pagedFull = await callTool('comments', { project, ref: ticket.ref, full: true, limit: 2 });
  assert.deepEqual(await recoverPageBodies(pagedFull), bodies.slice(0, 2));

  const legacyFull = await callTool('comments', { project, ref: ticket.ref, full: true });
  assert.equal(legacyFull.commentsRetrieval, undefined);
  assert.deepEqual(await recoverPageBodies(legacyFull), bodies);
  assert.equal(legacyFull.comments[0].source, 'mcp');
  const cliComments = runCli(['comments', ticket.ref, '--project', project, '--json']);
  assert.deepEqual(Object.keys(cliComments).sort(), ['comments', 'project', 'ticket']);
  assert.deepEqual(cliComments.comments.map((comment: any) => comment.body), bodies);

  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId: 'complete-comment-briefing' });
  const briefingOutput = runCli(['briefing', ticket.ref, '--token-file', prepared.ticket.dispatch.tokenFile, '--project', project]);
  const briefingPath = /Before acting, Read "([^"]+)" in full/.exec(briefingOutput)?.[1];
  assert.ok(briefingPath, briefingOutput);
  const briefing = fs.readFileSync(briefingPath, 'utf8');
  assert.match(briefing, /## Executor briefing/);
  // SQ-387: eight 16000-byte bodies pass SQ-350's 16 KiB briefing comment budget. The newest
  // stays inline; the seven older ones are deferred, each to a context_page call printed in
  // place under its own numbered header. Recovering every handle, in briefing order, still
  // yields every body: complete, and chronological once the newest-first order is reversed.
  assert.ok(briefing.includes(bodies[7]), 'the newest comment body is inlined verbatim');
  for (const body of bodies.slice(0, 7)) assert.ok(!briefing.includes(body), 'older bodies are deferred by the budget');
  assert.match(briefing, /7 older comment bodies are deferred to keep this section within 16384 bytes/);
  const commentSection = briefing.slice(briefing.indexOf('## Newest ticket evidence and comments (newest first)'));
  const headers = [...commentSection.matchAll(/^### Comment (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(headers, [8, 7, 6, 5, 4, 3, 2, 1], 'comments are numbered newest first');
  const deferredCalls = [...commentSection.matchAll(/\(Body deferred by the 16384-byte briefing comment budget: 16000 bytes\. Fetch it with context_page\((\{.*?\})\)\.\)/g)]
    .map((match) => JSON.parse(match[1] ?? '{}'));
  assert.equal(deferredCalls.length, 7, 'every deferred body prints its own retrieval call');
  const recoveredOlder = await Promise.all(deferredCalls.map((retrieval: any) => recoverBody({ arguments: retrieval })));
  assert.deepEqual([...recoveredOlder].reverse(), bodies.slice(0, 7), 'deferred handles recover the older bodies in chronological order');

  for (const args of [{ cursor: 'bad' }, { cursor: '-1' }, { limit: 0 }, { limit: 101 }]) {
    const invalid = await callToolRaw('comments', { project, ref: ticket.ref, ...args });
    assert.equal(invalid.isError, true);
  }
  const pastEnd = await callToolRaw('comments', { project, ref: ticket.ref, cursor: '9' });
  assert.equal(pastEnd.isError, true);
});

test('comment reads elide only oldest bodies past ten and full bypasses elision', async () => {
  const root = path.join(os.tmpdir(), 'sq-mcp-comment-elision');
  const project = store.ensureProject(root, 'SQ comment elision').slug;
  const ticket = store.createTicket(project, { title: 'comment body elision' });
  const bodies = Array.from({ length: 12 }, (_, index) => `body-${index}`);
  for (let index = 0; index < bodies.length; index += 1) {
    assert.equal(store.addComment(project, ticket.ref, {
      body: bodies[index],
      by: `worker-${index}`,
      kind: index === 0 ? 'risk' : 'comment',
      source: 'mcp',
    }).ok, true);
  }

  const defaultRead = await callTool('comments', { project, ref: ticket.ref });
  assert.equal(defaultRead.order, 'chronological');
  assert.equal(defaultRead.total, 12);
  assert.equal(defaultRead.returned, 12);
  assert.equal(defaultRead.omittedBodies, 2);
  assert.equal(defaultRead.notice, '2 earlier comment bodies omitted — pass --full to see them.');
  assert.deepEqual(
    defaultRead.comments.slice(0, 2).map((comment: any) => ({ by: comment.by, kind: comment.kind, bodyOmitted: comment.bodyOmitted, hasBody: Object.hasOwn(comment, 'body') })),
    [
      { by: 'worker-0', kind: 'comment', bodyOmitted: true, hasBody: false },
      { by: 'worker-1', kind: 'comment', bodyOmitted: true, hasBody: false },
    ],
  );
  assert.ok(defaultRead.comments[0].at);
  assert.deepEqual(defaultRead.comments.slice(2).map((comment: any) => comment.body), bodies.slice(2));

  const fullRead = await callTool('comments', { project, ref: ticket.ref, full: true });
  assert.deepEqual(fullRead.comments.map((comment: any) => comment.body), bodies);
  assert.equal(Object.hasOwn(fullRead, 'notice'), false);

  const cliDefault = runCli(['comments', ticket.ref, '--project', project, '--json']);
  assert.equal(cliDefault.notice, '2 earlier comment bodies omitted — pass --full to see them.');
  assert.deepEqual(cliDefault.comments.slice(2).map((comment: any) => comment.body), bodies.slice(2));
  const cliText = runCli(['comments', ticket.ref, '--project', project]);
  assert.match(cliText, /2 earlier comment bodies omitted — pass --full to see them\./);
  assert.match(cliText, /worker-0 \(comment\): \[body omitted\]/);
  const cliFull = runCli(['comments', ticket.ref, '--project', project, '--json', '--full']);
  assert.deepEqual(Object.keys(cliFull).sort(), ['comments', 'project', 'ticket']);
  assert.deepEqual(cliFull.comments.map((comment: any) => comment.body), bodies);
});

test('MCP comment reads do not track per-session polling state and changes includes bounded excerpts', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-polling-diet-')).slug;
  const ticket = store.createTicket(project, { title: 'polling diet fixture' });
  const body = `latest progress: ${'x'.repeat(500)}`;
  const since = new Date(Date.now() - 1000).toISOString();
  assert.equal(store.addComment(project, ticket.ref, { body, by: 'polling-worker', kind: 'comment', source: 'mcp' }).ok, true);

  const first = await callTool('comments', { project, ref: ticket.ref });
  const second = await callTool('comments', { project, ref: ticket.ref });
  assert.deepEqual(second, first);
  assert.equal(second.hint, undefined);

  const changes = await callTool('changes', { project, since });
  const changed = changes.tickets.find((entry: any) => entry.ref === ticket.ref);
  assert.deepEqual(changed.lastComment, {
    id: changed.lastComment.id,
    by: 'polling-worker',
    kind: 'comment',
    body: changed.lastComment.body,
    bodyLength: body.length,
    bodyTruncated: true,
  });
  assert.ok(changed.lastComment.body.length <= 200);
  assert.match(changed.lastComment.body, /use full:true/);
});

test('MCP comments returns only entries appended after a prior comment id', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-comment-since-')).slug;
  const ticket = store.createTicket(project, { title: 'comment since fixture' });
  assert.equal(store.addComment(project, ticket.ref, { body: 'first handoff', by: 'first-worker', kind: 'comment', source: 'mcp' }).ok, true);

  const firstRead = await callTool('comments', { project, ref: ticket.ref });
  const firstComment = firstRead.comments.at(-1);
  assert.ok(firstComment?.id);
  assert.equal(store.addComment(project, ticket.ref, { body: 'second handoff', by: 'second-worker', kind: 'comment', source: 'mcp' }).ok, true);

  const incremental = await callTool('comments', { project, ref: ticket.ref, since: firstComment.id });
  assert.deepEqual(incremental.comments.map((comment: any) => comment.body), ['second handoff']);
  assert.deepEqual(
    { total: incremental.total, returned: incremental.returned, nextCursor: incremental.nextCursor, order: incremental.order },
    { total: 2, returned: 1, nextCursor: null, order: 'chronological' },
  );

  const quiet = await callTool('comments', { project, ref: ticket.ref, since: incremental.comments[0].id });
  assert.deepEqual(quiet.comments, []);
  assert.deepEqual(
    { total: quiet.total, returned: quiet.returned, nextCursor: quiet.nextCursor, order: quiet.order },
    { total: 2, returned: 0, nextCursor: null, order: 'chronological' },
  );

  const timestamp = new Date(Date.parse(firstComment.at) - 1).toISOString();
  const timestampRead = await callTool('comments', { project, ref: ticket.ref, since: timestamp });
  assert.deepEqual(timestampRead.comments.map((comment: any) => comment.body), ['first handoff', 'second handoff']);
});

test('MCP commit and submit finish an isolated worktree without a PATH command', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP terminal lifecycle', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'],
    complexityWhy: 'exercise the MCP commit and submit terminal worktree lifecycle',
  });
  const by = 'mcp-worktree-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The MCP worktree fixture requires a local direct claim.' })).ok, true);

  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'allowed.js'), 'allowed\n');
  fs.writeFileSync(path.join(worktree, 'foreign.js'), 'foreign\n');
  gitAt(worktree, ['add', '.']);
  const explicitPath = process.platform === 'win32' ? worktree.replace(/\//g, '\\') : worktree;
  const committed = await callTool('commit', {
    project, ref: ticket.ref, by, message: 'MCP scoped commit', worktree: explicitPath,
  });
  assert.ok(committed.commit, 'commit returns the local hash');
  assert.equal(committed.paths, undefined, 'commit acknowledgement omits echoed paths');
  assert.equal(gitAt(worktree, ['diff', '--cached', '--name-only']), 'foreign.js', 'foreign staging remains intact');
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);

  const missingReport = await callToolRaw('submit', {
    project, ref: ticket.ref, by, commit: committed.commit, worktree: explicitPath,
  });
  assert.ok(missingReport.isError, 'submit refuses a missing final report');
  assert.match(missingReport.content[0].text, /"body" is required.*final report/i);
  assert.ok(store.getTicket(project, ticket.ref).claim, 'a missing report keeps the claim');
  gitAt(worktree, ['reset', '--', 'foreign.js']);
  fs.unlinkSync(path.join(worktree, 'foreign.js'));

  const requested = await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['foreign/denied.js'] });
  assert.equal(requested.state, 'refused');
  assert.deepEqual(requested.refused, ['foreign/denied.js']);

  const finalReport = `MCP terminal evidence ${'x'.repeat(1600)}`;
  const submitted = await callTool('submit', {
    project, ref: ticket.ref, by, commit: committed.commit,
    worktree: explicitPath, verify: 'node --test plugins/sidequest/test/mcp.test.js',
    body: finalReport,
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.submission, undefined, 'submit acknowledgement omits stored submission details');
  assert.equal(store.getTicket(project, ticket.ref).submission.commit, committed.commit);
  const after = store.getTicket(project, ticket.ref);
  assert.equal(after.claim, null, 'submit releases the claim');
  const reportComment = after.comments.find((comment: any) => comment.body === finalReport);
  assert.equal(after.submission.commentId, reportComment.id);
  const comments = await callTool('comments', { project, ref: ticket.ref });
  const reportRead = comments.comments.find((comment: any) => comment.id === reportComment.id);
  assert.equal(reportRead.body, finalReport, 'the newest executor final report remains verbatim');
  assert.equal(reportRead.bodyTruncated, false);

  const malformed = store.createTicket(project, {
    title: 'MCP malformed submission', files: ['lib/other.js'], complexity: 3,
    labels: ['direct-ok'],
    complexityWhy: 'confirm malformed MCP submission input preserves the ticket claim',
  });
  assert.equal((await callTool('claim', { project, ref: malformed.ref, by: 'mcp-bad-worker', direct: true, reason: 'The malformed submission fixture requires a direct claim.' })).ok, true);
  const bad = await callToolRaw('submit', { project, ref: malformed.ref, by: 'mcp-bad-worker', commit: 'not-a-hash', worktree, body: 'Malformed submission evidence' });
  assert.ok(bad.isError, 'malformed hashes fail before a board write');
  assert.ok(store.getTicket(project, malformed.ref).claim, 'malformed submission keeps the claim');
});

test('MCP delivery reclaims a terminal isolated worktree immediately', async (context: any) => {
  const primary = createGitWorktree();
  const project = store.ensureProject(primary).slug;
  store.setBoardConfig(project, { integrationMode: 'local', integrationBranch: 'main', worktreeBase: 'local-main' });
  const ticket = store.createTicket(project, {
    title: 'reclaim delivered worktree', files: ['feature.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'exercise delivery-time cleanup through the public integration tool',
  });
  const by = 'delivery-cleanup-worker';
  const worktree = prepareIsolatedWorktreeDispatch(project, primary, ticket, by);
  context.after(() => removeTestWorktree(primary, worktree));
  await submitIsolatedDeliveryCandidate(project, ticket, by, worktree);

  const integrated = await callTool('integrate', { project, ref: ticket.ref, by: 'delivery-cleanup-integrator' });
  assert.equal(integrated.ok, true, integrated.message || integrated.reason);
  assert.equal(store.getTicket(project, ticket.ref).status, 'done');
  assert.equal(fs.existsSync(worktree), false);
});

export {};
