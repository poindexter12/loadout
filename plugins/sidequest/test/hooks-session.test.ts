'use strict';
// SQ-137: one topic shard of the former hooks.test.ts, split so the runner can spread its tests
// across workers. Shared setup and helpers live in ./_hooks-fixture.ts; the tests are moved unchanged.
import {
  test,
  assert,
  os,
  fs,
  path,
  crypto,
  execFileSync,
  spawn,
  SIDEQUEST_HOME,
  store,
  worktrees,
  db,
  agentsync,
  BOARD_PATH,
  slug,
  database,
  HOOKS,
  SESSION,
  SESSION_END,
  BOARD_RECONCILIATION_REMINDER,
  BUDGET,
  RETIRED_SCOUT,
  runHookOutput,
  runHookProcessForBudget,
  waitForPath,
  runHook,
  runSessionWithHome,
  runHookOutputForBudget,
  runHookForBudget,
  writeCategory,
  withSidequestHome,
  registerProject,
  writeOversizedRoutingProfile,
  assertNoRetiredDoctrine,
  gitFixture,
  sweepReportFile,
  addTicket,
  claimStopTicket,
  recordTerminalAgentFailure,
  fixtureState,
} from './_hooks-fixture.js';

test('stop reminder: reviewed submissions stay held until integration', () => {
  const sessionId = `reconcile-reviewed-${++fixtureState.sqSeq}`;
  const submitted = addTicket('reviewed pending submission');
  claimStopTicket(submitted, sessionId, 'reconcile-reviewed');
  assert.equal(store.submitTicket(slug, submitted.ref, 'reconcile-reviewed', {
    commit: 'abc9876',
    sessionId,
  }).ok, true);
  const review = store.createTicket(slug, { title: 'Review pending submission', category: 'review-audit', status: 'done' });
  assert.equal(store.linkTickets(slug, review.ref, 'related', submitted.ref).ok, true);

  const input = { session_id: sessionId, cwd: BOARD_PATH };
  const output = runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, input);
  assert.match(output.hookSpecificOutput.additionalContext, /1 submission pending integration/);
  assert.equal(runHookOutputForBudget(BOARD_RECONCILIATION_REMINDER, input), null);
});

test('stop reminder: holds a submitted integration while a linked repair verifies', () => {
  const sessionId = `reconcile-held-repair-${++fixtureState.sqSeq}`;
  const by = 'reconcile-held-repair-worker';
  const submitted = addTicket('audited submission awaiting repair');
  claimStopTicket(submitted, sessionId, by);
  assert.equal(store.submitTicket(slug, submitted.ref, by, {
    commit: 'abc9876',
    sessionId,
  }).ok, true);
  assert.equal(store.addComment(slug, submitted.ref, {
    by: 'orchestrator',
    kind: 'comment',
    body: 'Hold integration: the audit failed and the linked repair is active.',
    source: 'mcp',
  }).ok, true);

  const audit = store.createTicket(slug, { title: 'Audit held submission', category: 'review-audit', status: 'done' });
  assert.equal(store.addComment(slug, audit.ref, {
    by: 'auditor',
    kind: 'comment',
    body: 'Audit failed: repair before integration.',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.linkTickets(slug, audit.ref, 'related', submitted.ref).ok, true);

  const repair = addTicket('repair audited submission');
  assert.equal(store.linkTickets(slug, repair.ref, 'related', submitted.ref).ok, true);
  claimStopTicket(repair, sessionId, 'reconcile-linked-repair');
  assert.equal(store.addComment(slug, repair.ref, {
    by: 'reconcile-linked-repair',
    kind: 'comment',
    body: '[sidequest:verify-start] node --test plugins/sidequest/test/hooks.test.ts',
    source: 'mcp',
  }).ok, true);

  const input = { session_id: sessionId, cwd: BOARD_PATH, stop_hook_active: false };
  const first = runHookOutput(BOARD_RECONCILIATION_REMINDER, input);
  assert.match(first.hookSpecificOutput.additionalContext, /1 submission pending integration/);
  assert.match(first.hookSpecificOutput.additionalContext, /1 live claim in progress/);
  assert.match(first.hookSpecificOutput.additionalContext, /Hold integration until 1 live claim becomes terminal\./);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /checkpoint and hold/);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, new RegExp(repair.ref));

  const checkpoint = store.checkpointTicket(slug, submitted.ref, by, {
    commit: 'abc9876',
    verify: 'focused tests passed before the audit hold',
  });
  assert.equal(checkpoint.ok, false);
  assert.equal(checkpoint.reason, 'submitted');
  for (let stop = 0; stop < 3; stop += 1) {
    assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null);
  }
});

test('stop reminder: completion clears the transition boundary', () => {
  const sessionId = `reconcile-complete-${++fixtureState.sqSeq}`;
  const by = 'reconcile-complete-worker';
  const ticket = addTicket('responsibility returns after completion');
  store.updateTicket(slug, ticket.ref, { labels: ['direct-ok'] });
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    direct: true,
    reason: 'Completion boundary fixture.',
    sessionId,
  }).ok, true);
  const input = { session_id: sessionId, cwd: BOARD_PATH };
  assert.ok(runHookOutput(BOARD_RECONCILIATION_REMINDER, input));

  assert.equal(store.releaseTicket(slug, ticket.ref, by, { status: 'todo', source: 'test' }).ok, true);
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null);
  store.updateTicket(slug, ticket.ref, { labels: ['direct-ok'] });
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    direct: true,
    reason: 'Reappearing responsibility fixture.',
    sessionId,
  }).ok, true);
  assert.ok(runHookOutput(BOARD_RECONCILIATION_REMINDER, input));
});

test('stop reminder: an immediate release and reclaim starts a new responsibility', () => {
  const sessionId = `reconcile-immediate-reclaim-${++fixtureState.sqSeq}`;
  const by = 'reconcile-immediate-reclaim-worker';
  const ticket = addTicket('immediately reclaimed responsibility');
  store.updateTicket(slug, ticket.ref, { labels: ['direct-ok'] });
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    direct: true,
    reason: 'Immediate reclaim responsibility fixture.',
    sessionId,
  }).ok, true);
  const input = { session_id: sessionId, cwd: BOARD_PATH };
  const firstGeneration = store.getTicket(slug, ticket.ref).claim.generation;
  assert.ok(firstGeneration);
  assert.ok(runHookOutput(BOARD_RECONCILIATION_REMINDER, input));

  assert.equal(store.releaseTicket(slug, ticket.ref, by, { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    direct: true,
    reason: 'Immediate reclaim responsibility fixture.',
    sessionId,
  }).ok, true);
  assert.notEqual(store.getTicket(slug, ticket.ref).claim.generation, firstGeneration);
  assert.ok(runHookOutput(BOARD_RECONCILIATION_REMINDER, input));
});

test('stop reminder: ignores re-entry and unchanged responsibility', () => {
  const sessionId = `reconcile-bound-${++fixtureState.sqSeq}`;
  const ticket = addTicket('bounded reconciliation reminder');
  const stop = claimStopTicket(ticket, sessionId, 'reconcile-bound');
  assert.equal(recordTerminalAgentFailure(ticket, stop).ok, true);
  const input = { session_id: sessionId, cwd: BOARD_PATH };

  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, {
    ...input,
    stop_hook_active: true,
  }), null, 're-entered Stop hooks must never emit another continuation');
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null);
  assert.equal(runHookOutput(BOARD_RECONCILIATION_REMINDER, input), null);
});

test('session-start excludes the retired generic-agent bypass', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  const pluginRoot = path.join(__dirname, '..');
  const forceBypass = fs.readFileSync(path.join(HOOKS, 'force-exec-bypass.js'), 'utf8');
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
  for (const surface of [forceBypass, skill, ctx]) {
    assert.doesNotMatch(surface, new RegExp(RETIRED_SCOUT), 'published guidance must not carry the retired bypass');
  }
});

test('session-start force-loads the Sidequest skill only for orchestrator mid-wave recovery', () => {
  const midWaveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-mid-wave-skill-'));
  const midWaveProject = path.join(midWaveHome, 'project');
  const category = 'session-start-mid-wave-skill';
  registerProject(midWaveHome, midWaveProject);
  writeCategory(midWaveHome, {
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'high' },
    fallback: null,
    enabled: true,
  });
  withSidequestHome(midWaveHome, () => {
    const projectSlug = store.ensureProject(midWaveProject).slug;
    const ticket = store.createTicket(projectSlug, { title: 'pending mid-wave submission', category, source: 'test' });
    assert.equal(store.claimTicket(projectSlug, ticket.ref, 'mid-wave-skill-worker', {
      direct: true,
      reason: 'Fixture creates a pending submission for SessionStart recovery.',
    }).ok, true);
    assert.equal(store.submitTicket(projectSlug, ticket.ref, 'mid-wave-skill-worker', { commit: '1234567' }).ok, true);
  });

  const midWaveStartup = runHookOutput(SESSION, {
    session_id: 'mid-wave-skill-startup',
    source: 'startup',
    cwd: midWaveProject,
  }, { SIDEQUEST_HOME: midWaveHome, CLAUDE_PROJECT_DIR: midWaveProject });
  assert.equal(midWaveStartup.hookSpecificOutput.initialUserMessage, '/sidequest:sidequest');

  const midWaveExecutor = runHookOutput(SESSION, {
    session_id: 'mid-wave-skill-executor',
    source: 'startup',
    cwd: midWaveProject,
  }, { SIDEQUEST_HOME: midWaveHome, CLAUDE_PROJECT_DIR: midWaveProject, SIDEQUEST_AGENT: 'fixture-executor' });
  assert.equal(midWaveExecutor.hookSpecificOutput.initialUserMessage, undefined);

  const midWaveCompact = runHookOutput(SESSION, {
    session_id: 'mid-wave-skill-compact',
    source: 'compact',
    cwd: midWaveProject,
  }, { SIDEQUEST_HOME: midWaveHome, CLAUDE_PROJECT_DIR: midWaveProject });
  assert.equal(midWaveCompact.hookSpecificOutput.initialUserMessage, undefined);

  const quietHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-quiet-skill-'));
  const quietProject = path.join(quietHome, 'project');
  registerProject(quietHome, quietProject);
  const quietStartup = runHookOutput(SESSION, {
    session_id: 'quiet-skill-startup',
    source: 'startup',
    cwd: quietProject,
  }, { SIDEQUEST_HOME: quietHome, CLAUDE_PROJECT_DIR: quietProject });
  assert.equal(quietStartup.hookSpecificOutput.initialUserMessage, undefined);
});

test('session-start: tells orchestrators when to fan out independent work', () => {
  const pluginRoot = path.join(__dirname, '..');
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
  const orchestration = fs.readFileSync(path.join(pluginRoot, 'skills', 'sidequest', 'references', 'orchestration.md'), 'utf8');
  const userStory = fs.readFileSync(path.join(pluginRoot, 'skills', 'user-story', 'SKILL.md'), 'utf8');
  assert.match(skill, /independent audits, migrations, and reviews/i);
  assert.match(skill, /Dispatch concurrently despite isolated-worktree overlap/i);
  assert.match(skill, /sequential\/shared-design work together/i);
  assert.match(skill, /size shards by items and verify cost/i);

  for (const surface of [skill, orchestration, userStory]) {
    assert.match(surface, /one\s+investigation\s+ticket\s+per\s+independent\s+item/i);
  }
  for (const surface of [skill, orchestration]) {
    assert.match(surface, /SOLO-FIT picks\s+one-executor vs wave; it NEVER means you implement\s+inline/);
  }
  assert.match(userStory, /This never means the orchestrator implements it/);

  for (const source of ['', 'compact', 'resume']) {
    const context = runHookForBudget(SESSION, { session_id: `fanout-${source || 'startup'}`, source });
    assert.match(context, /shard implementation and read-only investigation tickets, then dispatch each wave concurrently/i);
    assert.match(context, /isolated-worktree overlap is an integration concern/i);
    assert.match(context, /sequential dependencies or a shared design decision stay together/i);
    const budget = source ? BUDGET.compact : BUDGET.session;
    assert.ok(
      Buffer.byteLength(context, 'utf8') <= budget,
      `fanout briefing is ${Buffer.byteLength(context, 'utf8')} bytes — budget is ${budget}`,
    );
  }
});

test('session-start: tells orchestrators to arm the board watch when Monitor exists', () => {
  for (const source of ['', 'compact', 'resume']) {
    const context = runHookForBudget(SESSION, { session_id: `watch-${source || 'startup'}`, source });
    assert.match(context, /Arm a persistent Monitor running node "?.+[/\\]bin[/\\]sidequest\.js"? watch --project <path>/);
    assert.match(context, /ticket alerts default to dispatches prepared by this session plus unowned and terminal tickets/i);
    assert.match(context, /failed GitHub CI runs stay project-wide/i);
    assert.match(context, /Use --all for project-wide ticket alerts/i);
    assert.match(context, /Skip it if Monitor is unavailable/);
  }
});

test('session-start: states usable-route admission while preserving the specific-edit boundary', () => {
  for (const source of ['', 'compact', 'resume']) {
    const context = runHookForBudget(SESSION, { session_id: `authorization-${source || 'startup'}`, source });
    assert.match(context, /no usable project route here, so substantive work may stay inline/i);
    assert.match(context, /the first Board MCP call auto-registers this project/i);
    assert.match(context, /use board_config to enable a category with an available executor before asking for board dispatch/i);
    assert.match(context, /one-file or one-prompt asks stay inline unless dependency or risk warrants dispatch/i);
    assert.match(context, /ask before work beyond the approved scope unless explicit standing permission covers it/i);
  }
});

test('session-start: keeps specific edits inline and proactive changes user-approved', () => {
  for (const source of ['', 'compact', 'resume']) {
    const context = runHookForBudget(SESSION, { session_id: `inline-boundary-${source || 'startup'}`, source });
    assert.match(context, /one-file or one-prompt asks stay inline unless dependency or risk warrants dispatch/i);
    assert.match(context, /ask before work beyond the approved scope unless explicit standing permission covers it/i);
  }
});

test('session-start: loads user-story for routed work beyond small tasks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-routed-work-shape-'));
  const project = path.join(home, 'project');
  registerProject(home, project);
  for (const source of ['', 'compact', 'resume']) {
    const context = runHookForBudget(SESSION, { session_id: `routed-work-shape-${source || 'startup'}`, source }, {
      SIDEQUEST_HOME: home,
      CLAUDE_PROJECT_DIR: project,
    });
    const inlineCarveOut = 'Quick edits at a named or known location, one-line fixes, operational requests, and direct questions stay inline and do not load user-story';
    const userStoryDefault = 'For work beyond a small task, load the user-story skill before ticketing or dispatching';
    const dispatchDefault = 'A usable Sidequest project route authorizes the ROUTE, not the MANDATE';
    assert.match(context, new RegExp(inlineCarveOut, 'i'));
    assert.match(context, new RegExp(userStoryDefault, 'i'));
    assert.match(context, new RegExp(dispatchDefault, 'i'));
    assert.match(context, /name who asked and what breaks if nobody does it/i);
    assert.match(context, /if you only noticed it, report it and file nothing/i);
    assert.ok(context.indexOf(inlineCarveOut) < context.indexOf(userStoryDefault));
    assert.ok(context.indexOf(userStoryDefault) < context.indexOf(dispatchDefault));
    assert.doesNotMatch(context, /can ask to use it/i);
  }
});

test('session-start adds model-specific checkpoint guidance only for eligible models', () => {
  const defaultContext = runHook(SESSION, { session_id: 'checkpoint-none' });
  const sonnet = runHook(SESSION, { session_id: 'checkpoint-sonnet', model: 'claude-sonnet-5' });
  assert.notEqual(sonnet, defaultContext);
  assert.equal((sonnet.match(/CHECKPOINT MODE/g) || []).length, 1, 'checkpoint-mode startup guidance must appear once');
  const compactDefault = runHook(SESSION, { session_id: 'checkpoint-compact-none', source: 'compact' });
  const compact = runHook(SESSION, { session_id: 'checkpoint-compact', source: 'compact', model: 'claude-haiku-4-5' });
  assert.notEqual(compact, compactDefault);

  for (const payload of [
    { session_id: 'checkpoint-none' },
    { session_id: 'checkpoint-opus', model: 'claude-opus-5' },
  ]) {
    assert.doesNotMatch(runHook(SESSION, payload), /CHECKPOINT MODE/, 'an absent or higher-tier model must not silently enable checkpoint mode');
  }
});

test('session-start: suppresses workforce for an unregistered project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-unregistered-workforce-'));
  const context = runHookForBudget(SESSION, { session_id: 'unregistered-workforce', cwd: path.join(home, 'project') }, {
    SIDEQUEST_HOME: home,
  });
  assert.doesNotMatch(context, /YOUR EXECUTORS — delegate work AND investigation to them:/);
});

test('session-start: shows the live investigation workforce within its cap', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-workforce-'));
  const project = path.join(home, 'project');
  registerProject(home, project);
  for (const source of ['', 'compact', 'resume']) {
    const ctx = runHookForBudget(SESSION, { session_id: `workforce-${source || 'startup'}`, source }, {
      SIDEQUEST_HOME: home,
      CLAUDE_PROJECT_DIR: project,
    });
    const start = ctx.indexOf('YOUR EXECUTORS — delegate work AND investigation to them:');
    assert.ok(start >= 0, `${source || 'startup'} includes the workforce`);
    const workforce = ctx.slice(start);
    assert.ok(Buffer.byteLength(workforce) <= BUDGET.workforce, `${source || 'startup'} workforce is ${Buffer.byteLength(workforce)} bytes`);
    for (const id of ['codebase-exploration', 'debugging', 'spike-investigation', 'source-lookup', 'evidence-research']) {
      assert.match(workforce, new RegExp(`${id} — .+ \\(.+·.+\\)`), id);
    }
    assert.match(workforce, /visual-evaluation — (?:.+ )?\(.+·.+\)/, 'visual-evaluation');
  }
});

test('session-start: bounds oversized workforces and preserves each briefing tail', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-workforce-cap-'));
  const project = path.join(home, 'project');
  writeOversizedRoutingProfile(home);
  registerProject(home, project);
  for (const source of ['', 'compact', 'resume']) {
    const output = runHookOutputForBudget(SESSION, { session_id: `oversized-workforce-${source || 'startup'}`, source }, {
      SIDEQUEST_HOME: home,
      CLAUDE_PROJECT_DIR: project,
    });
    const context = output.hookSpecificOutput.additionalContext;
    const workforce = context.slice(context.indexOf('YOUR EXECUTORS — delegate work AND investigation to them:'));
    assert.ok(Buffer.byteLength(workforce) <= BUDGET.workforce, `oversized workforce is ${Buffer.byteLength(workforce)} bytes`);
    assert.match(workforce, /… \d+ more enabled categories\./);
    assert.match(
      context,
      source
        ? /Board MCP is the lifecycle authority; no Sidequest CLI or raw Agent fallback\./
        : /Workers own claimed work and report conflicts, verification, and cleanup\./,
    );
  }
});

test('session-start: names the upstream-defect filing destination for the local registry', () => {
  const maintainerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-loadout-maintainer-'));
  const loadoutRepo = path.join(maintainerHome, 'loadout');
  fs.mkdirSync(path.join(loadoutRepo, 'plugins', 'sidequest', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(loadoutRepo, 'plugins', 'sidequest', '.claude-plugin', 'plugin.json'), '{}');
  registerProject(maintainerHome, loadoutRepo);
  const commonClause = /never encode a workaround into project rules, hooks, or memory/i;
  const maintainerContext = runHookForBudget(SESSION, { session_id: 'upstream-defect-maintainer', cwd: loadoutRepo }, {
    SIDEQUEST_HOME: maintainerHome,
    SIDEQUEST_SWEEP_DEADLINE_MS: '60000',
    CLAUDE_PROJECT_DIR: loadoutRepo,
  });
  assert.match(maintainerContext, /Offer to file it as a ticket on the loadout board on this machine \(the Loadout working copy\), not via the Anthropic feedback tool\./);
  assert.doesNotMatch(maintainerContext, /Offer to file it as a GitHub issue on poindexter12\/loadout/);
  assert.match(maintainerContext, commonClause);

  const nonMaintainerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-loadout-non-maintainer-'));
  const nonMaintainerContext = runHookForBudget(SESSION, { session_id: 'upstream-defect-non-maintainer' }, {
    SIDEQUEST_HOME: nonMaintainerHome,
    SIDEQUEST_SWEEP_DEADLINE_MS: '60000',
  });
  assert.match(nonMaintainerContext, /Offer to file it as a GitHub issue on poindexter12\/loadout, not via the Anthropic feedback tool\./);
  assert.match(nonMaintainerContext, /Any GitHub body, comment, reply, or closure note you author must stand alone/);
  assert.match(nonMaintainerContext, /omit local SQ-\/US- IDs, board slugs, local-only paths, and board-only references/);
  assert.match(nonMaintainerContext, /Preserve reporter text unless authorized to edit it/);
  assert.match(nonMaintainerContext, /do not strip diagnostic error text or hand-edit historical changelogs or generated release history/);
  assert.match(nonMaintainerContext, commonClause);
});

test('session-start: stays inside its byte budget and off the retired doctrine', () => {
  const ctx = runHookForBudget(SESSION, { session_id: 'test' });
  assert.ok(
    ctx.length <= BUDGET.session,
    `session block is ${ctx.length} chars — budget is ${BUDGET.session}; trim it, don't raise the budget`
  );
  assertNoRetiredDoctrine(ctx, 'session-start');
  assert.match(ctx, /board path refuses verified work, deliver it yourself through groomClose with deliveryCommit/i);
});

// The bundled ladder ships in the plugin package and must never wait for
// SessionStart. SQ-300 adds the ONE deliberate exception: a codex route's
// per-(model, effort) pin names a model discovered at runtime, so it cannot be
// bundled at build time and is written user-scoped. The invariant that survives
// is that nothing bundled is ever user-written.
test('session-start writes only runtime codex pins into the user scope, never a bundled executor', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-agents-'));
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  const first = JSON.parse(runSessionWithHome(home));
  const firstContext = first.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(firstContext, /Executor definitions were just \(re\)provisioned/);
  const agentsDir = path.join(home, 'agents');
  const written = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).sort() : [];
  for (const file of written) {
    assert.match(
      file,
      /^sidequest-exec-codex-(?:readonly-)?[a-z0-9-]+-(?:low|medium|high|xhigh|max)\.md$/,
      `SessionStart may only write runtime codex pins into the user scope, not ${file}`
    );
  }
  for (const bundled of ['sidequest-exec-dispatch.md', 'sidequest-exec-dispatch-readonly.md', 'sidequest-exec-high.md', 'sidequest-exec-readonly-high.md']) {
    assert.ok(!written.includes(bundled), `${bundled} ships in the plugin package and must not be user-written`);
  }

  const second = JSON.parse(runSessionWithHome(home));
  const secondContext = second.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(secondContext, /Executor definitions were just \(re\)provisioned/);
  // Content-compared, so a second start neither rewrites nor re-announces.
  assert.deepStrictEqual(fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).sort() : [], written);
});
// SQ-300 revives the retired per-combo name (`sidequest-exec-codex-<model>-<effort>`)
// for the published-id pins, so a stale file at that path is no longer pruned on
// sight: it is content-compared and REWRITTEN when its route is still configured,
// SessionStart provisions a pin for every configured codex route and prunes
// every other generated file in the directory, so the retired per-combo scheme
// is cleaned up rather than mistaken for a live pin.
test('session-start writes pins for configured routes and prunes retired per-combo definitions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-codex-'));
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  const agents = path.join(home, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const staleBody = '<!-- generated-by: sidequest-agentsync -->\nold';
  // The retired per-combo scheme tokenised the board SLUG, so it dropped the
  // context window: `gpt-5-6-terra`. A pin tokenises the PUBLISHED id and keeps
  // it: `gpt-5-6-terra-1m`. So none of these legacy names is a live pin, and all
  // three must be pruned rather than adopted.
  const legacyFiles = [
    'sidequest-exec-codex-gpt-5-6-terra-high.md',
    'sidequest-exec-codex-gpt-5-6-terra-low.md',
    'sidequest-exec-codex-gpt-9-9-nova-max.md',
  ].map((name) => path.join(agents, name));
  for (const file of legacyFiles) fs.writeFileSync(file, staleBody);
  // The configured route terra/high, under the pin naming.
  const liveFile = path.join(agents, 'sidequest-exec-codex-gpt-5-6-terra-1m-high.md');
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, updatedAt: new Date().toISOString(), source: 'model-gateway', codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' }, models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' }] }));
  runSessionWithHome(home, { SIDEQUEST_AGENTS_DIR: agents, SIDEQUEST_DISCOVERY_DIRS: catalog });

  assert.ok(fs.existsSync(liveFile), 'the configured route must get its pin at SessionStart');
  const written = fs.readFileSync(liveFile, 'utf8');
  assert.match(written, /^model: claude-gpt-5\.6-terra\[1m\]$/m, 'the pin names the published id');
  assert.match(written, /^effort: high$/m, 'the pin carries the route effort in frontmatter');
  // The body must carry no actual marker DIRECTIVE. It does name the marker, in
  // the prohibition against writing one, so the check is for `model=` rather than
  // for the bare token.
  assert.doesNotMatch(written, /\[sidequest-route model=/, 'the pin must carry no marker directive');
  assert.match(written, /there is NO `\[sidequest-route \.\.\.\]` marker on this path/, 'the pin must forbid writing one');

  for (const file of legacyFiles) {
    assert.ok(!fs.existsSync(file), `a retired per-combo definition must be pruned: ${path.basename(file)}`);
  }
  assert.ok(!fs.existsSync(path.join(agents, 'sidequest-exec-dispatch.md')), 'the plugin package provides the shared dispatch executor before SessionStart');
});

test('session-start leaves user agent directories untouched when retired prefs data is unreadable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-unreadable-'));
  const agents = path.join(home, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const codexFile = path.join(agents, 'sidequest-exec-dispatch.md');
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  db.openDb(home).prepare("INSERT INTO globals (key, data) VALUES ('model-prefs', '{')").run();
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
  fs.mkdirSync(path.join(catalog, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'model-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, updatedAt: new Date().toISOString(), source: 'model-gateway', codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' }, models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]' }] }));
  runSessionWithHome(home, { SIDEQUEST_AGENTS_DIR: agents, SIDEQUEST_DISCOVERY_DIRS: catalog });
  assert.ok(!fs.existsSync(codexFile), 'a packaged executor requires no user-agent write even when retired preferences are unreadable');
});
test('session-start preserves the live linked worktree that started the sweep', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-live-worktree-'));
  const worktrees = path.join(repo, '.claude', 'worktrees');
  const live = path.join(worktrees, 'agent-session-live');
  const sessionId = `session-live-${crypto.randomUUID()}`;
  try {
    gitFixture(['init', '-b', 'main'], repo);
    gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
    gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
    gitFixture(['add', 'README.md'], repo);
    gitFixture(['commit', '-m', 'base'], repo);
    gitFixture(['branch', '-M', 'main'], repo);
    fs.mkdirSync(worktrees, { recursive: true });
    gitFixture(['worktree', 'add', '-b', 'worktree-agent-session-live', live, 'main'], repo);
    fs.writeFileSync(path.join(live, 'live.txt'), 'integrated\n');
    gitFixture(['add', 'live.txt'], live);
    gitFixture(['commit', '-m', 'live fixture'], live);
    const commit = gitFixture(['rev-parse', 'HEAD'], live);
    gitFixture(['cherry-pick', commit], repo);
    const aged = new Date(Date.now() - 4 * 60 * 60 * 1000);
    fs.utimesSync(live, aged, aged);
    store.ensureProject(repo);

    runHook(SESSION, { session_id: sessionId, source: 'startup', cwd: live }, { CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') });

    assert.ok(fs.existsSync(live), 'the SessionStart sweep must preserve the linked worktree that owns it');
  } finally {
    runHook(SESSION_END, { session_id: sessionId, cwd: repo }, { CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') });
    if (fs.existsSync(live)) gitFixture(['worktree', 'remove', '--force', live], repo);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('session-start reclaims a clean old worktree without lease identity', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-sweep-'));
  const worktrees = path.join(repo, '.claude', 'worktrees');
  const old = path.join(worktrees, 'agent-session-sweep');
  try {
    gitFixture(['init', '-b', 'main'], repo);
    gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
    gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
    gitFixture(['add', 'README.md'], repo);
    gitFixture(['commit', '-m', 'base'], repo);
    gitFixture(['branch', '-M', 'main'], repo);
    fs.mkdirSync(worktrees, { recursive: true });
    gitFixture(['worktree', 'add', '-b', 'worktree-agent-session-sweep', old, 'main'], repo);
    fs.writeFileSync(path.join(old, 'sweep.txt'), 'integrated\n');
    gitFixture(['add', 'sweep.txt'], old);
    gitFixture(['commit', '-m', 'integrated fixture'], old);
    const commit = gitFixture(['rev-parse', 'HEAD'], old);
    gitFixture(['cherry-pick', commit], repo);
    const aged = new Date(Date.now() - 4 * 60 * 60 * 1000);
    fs.utimesSync(old, aged, aged);
    store.ensureProject(repo);
    const report = sweepReportFile(SIDEQUEST_HOME, repo);
    fs.rmSync(report, { force: true });

    runHook(SESSION, { session_id: 'session-sweep', source: 'startup', cwd: repo }, {
      SIDEQUEST_HOME,
      SIDEQUEST_SWEEP_DEADLINE_MS: '0',
      CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..'),
    });
    await waitForPath(report);
    assert.equal(fs.existsSync(old), false, 'SessionStart must reclaim a clean old worktree without lease identity');
  } finally {
    if (fs.existsSync(old)) gitFixture(['worktree', 'remove', '--force', old], repo);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('session-start: a sweep past its deadline still injects the full block and says so', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-deadline-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-deadline-cwd-'));
  registerProject(home, cwd);
  const context = runHook(
    SESSION,
    { session_id: 'sweep-deadline', source: 'startup', cwd },
    { SIDEQUEST_HOME: home, SIDEQUEST_SWEEP_DEADLINE_MS: '0', CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') }
  );
  assert.match(context, /worktree sweep exceeded its SessionStart budget/);
  assert.match(context, /Progress at the \d+ms budget, not a final result: assessed 0 of 0 candidate worktrees, planned 0, removed 0, skipped 0 \(none\)/);
  assert.match(context, /worktrees sweep --yes --project/);
  assert.ok(context.includes('=== sidequest (active) ==='), 'a deferred sweep must not cost the session its orchestrator block');
  assert.ok(context.includes('YOUR EXECUTORS'), 'a deferred sweep must not cost the session its workforce');
});

test('session-start emits its briefing before slow claim maintenance finishes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-slow-claim-sweep-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-slow-claim-sweep-cwd-'));
  const preload = path.join(home, 'slow-claim-sweep.cjs');
  const blockMs = 200;
  registerProject(home, cwd);
  fs.writeFileSync(preload, `
const Module = require('node:module');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  const loaded = load.call(this, request, parent, isMain);
  if ((request.endsWith('/lib/store.js') || request.endsWith('\\\\lib\\\\store.js')) && !loaded.__slowClaimSweep) {
    Object.defineProperty(loaded, '__slowClaimSweep', { value: true });
    const sweep = loaded.sweepStaleClaims;
    loaded.sweepStaleClaims = function(...args) {
      const until = Date.now() + ${blockMs};
      while (Date.now() < until) {}
      return sweep.apply(this, args);
    };
  }
  return loaded;
};
`);

  const result = await runHookProcessForBudget(
    SESSION,
    { session_id: 'slow-claim-sweep', source: 'startup', cwd },
    {
      SIDEQUEST_HOME: home,
      SIDEQUEST_SWEEP_DEADLINE_MS: '25',
      CLAUDE_PROJECT_DIR: cwd,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${preload.replaceAll(path.sep, '/')}"`.trim(),
    },
  );
  const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  const context = output?.hookSpecificOutput?.additionalContext || '';

  assert.equal(result.status, 0, result.stderr);
  assert.match(context, /=== sidequest \(active\) ===/);
  assert.match(context, /ROLE: ORCHESTRATOR/);
  assert.match(context, /YOUR EXECUTORS — delegate work AND investigation to them:/);
  assert.match(context, /worktree sweep exceeded its SessionStart budget/);
});

test('session-start carries released-claim notices from background maintenance', async () => {
  const stale = addTicket('background claim release');
  store.updateTicket(slug, stale.ref, { labels: ['direct-ok'] });
  assert.equal(store.claimTicket(slug, stale.ref, 'background-stale-session', {
    direct: true,
    reason: 'The background-maintenance fixture needs a direct claim.',
  }).ok, true);
  const staleTicket = store.getTicket(slug, stale.ref);
  staleTicket.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
  db.putRow(database, 'tickets', {
    id: staleTicket.id, project: slug, ref: staleTicket.ref, status: staleTicket.status,
    archived: staleTicket.archived ? 1 : 0, ord: staleTicket.order, claim_by: staleTicket.claim.by, data: staleTicket,
  });
  const report = sweepReportFile(SIDEQUEST_HOME, BOARD_PATH);
  fs.rmSync(report, { force: true });

  runHook(SESSION, { session_id: 'background-claim-release', cwd: BOARD_PATH }, {
    SIDEQUEST_SWEEP_DEADLINE_MS: '0',
    CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..'),
  });
  await waitForPath(report);

  const context = runHook(SESSION, { session_id: 'background-claim-release-next', cwd: BOARD_PATH }, {
    SIDEQUEST_SWEEP_DEADLINE_MS: '0',
    CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..'),
  });
  assert.equal(store.getTicket(slug, stale.ref).claim, null);
  assert.match(context, new RegExp(`released .+ claim ${stale.ref}`));
});

test('session-start: a deferred sweep report is drained into the next session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-drain-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-drain-cwd-'));
  const report = sweepReportFile(home, cwd);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify({ notices: ['sidequest: carried sweep notice from last session'] }));

  const context = runHook(
    SESSION,
    { session_id: 'sweep-drain', source: 'startup', cwd },
    { SIDEQUEST_HOME: home, SIDEQUEST_SWEEP_DEADLINE_MS: '0', CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') }
  );
  assert.match(context, /carried sweep notice from last session/);
  const remainingReport = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
  assert.ok(!remainingReport.includes('carried sweep notice from last session'), 'a drained report must be cleared so it is not replayed forever');
});

test('sweep worker: records its notices for the next session instead of dropping them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-worker-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-worker-'));
  gitFixture(['init', '-b', 'main'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  gitFixture(['add', 'README.md'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  gitFixture(['branch', '-M', 'main'], repo);
  const boardHome = db.openDb(home);
  assert.ok(boardHome, 'fixture home must open');
  execFileSync(process.execPath, [path.join(HOOKS, 'sweep-worktrees.js'), '--cwd', repo, '--session', 'worker'], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') },
  });
  const report = sweepReportFile(home, repo);
  assert.ok(fs.existsSync(report), 'the worker must always leave a report, so a crashed sweep is distinguishable from a quiet one');
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(report, 'utf8')).notices));
});

test('session-start skips an unavailable integration target without failing the sweep', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-sweep-target-'));
  gitFixture(['init', '-b', 'main'], repo);
  gitFixture(['config', 'user.name', 'Sidequest Test'], repo);
  gitFixture(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  gitFixture(['add', 'README.md'], repo);
  gitFixture(['commit', '-m', 'base'], repo);
  gitFixture(['branch', '-M', 'main'], repo);
  const board = store.ensureProject(repo);
  store.setBoardConfig(board.slug, { integrationBranch: 'missing-target' });

  // A slow CI runner can push the sweep child past the default 2500ms budget,
  // turning the expected skip notice into a deferral notice; pin the deadline
  // so the sweep always finishes inside this test.
  const context = runHook(SESSION, { session_id: 'session-target', source: 'startup', cwd: repo }, { SIDEQUEST_SWEEP_DEADLINE_MS: '60000', CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') });
  assert.match(context, /skipped worktree sweep/);
  assert.match(context, /configured integration branch is unavailable locally/);
  assert.doesNotMatch(context, /worktree sweep failed/);
});

test('negative control: session-start recovery rejects the retired CLI fallback for resume and compact', () => {
  for (const source of ['compact', 'resume']) {
    const ctx = runHookForBudget(SESSION, { session_id: 't', source });
    assert.match(ctx, /never\s+TaskOutput/i, `${source} must ban native Agent TaskOutput polling`);
    assert.match(ctx, /Reconnect Board MCP, re-dispatch, and spawn the exact returned executor/i, `${source} must reconnect before lifecycle recovery`);
    assert.match(ctx, /Board MCP is the lifecycle authority; no Sidequest CLI or raw Agent fallback/i, `${source} must reject lifecycle fallbacks`);
    assert.doesNotMatch(ctx, /list --status(?: |=)doing.*MCP is absent/i, `${source} must reject the retired SessionStart fallback`);
    assert.ok(!ctx.includes('external tracker'), `${source} must not inject the full block`);
    assert.match(ctx, /board path refuses verified work, deliver it yourself through groomClose with deliveryCommit/i);
    assert.ok(Buffer.byteLength(ctx) <= BUDGET.compact, `${source} block is ${Buffer.byteLength(ctx)} bytes — budget is ${BUDGET.compact}`);
  }
});

test('session-start source excludes the retired lifecycle CLI fallback', () => {
  const source = fs.readFileSync(SESSION, 'utf8');
  assert.doesNotMatch(source, /list --status=doing only if MCP is absent/);
  assert.match(source, /Reconnect Board MCP, re-dispatch, and spawn the exact returned executor/);
});

export {};
