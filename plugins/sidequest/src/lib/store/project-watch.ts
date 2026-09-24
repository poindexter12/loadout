'use strict';

const { createGhPrPort } = require('../ports/github-pr');

function prWatchMarker(status: any, observedAt = new Date().toISOString()) {
  return `[sidequest:pr-watch] ${JSON.stringify({
    number: status.number,
    state: status.state,
    checks: status.checks,
    failingChecks: Array.isArray(status.failingChecks) ? status.failingChecks : [],
    observedAt,
  })}`;
}

function prWatchTerminalState(status: any) {
  if (status?.state === 'MERGED') return 'MERGED';
  if (status?.state === 'CLOSED') return 'CLOSED';
  if (status?.checks === 'failure') return 'failure';
  return null;
}

function readPrWatchState(ticket: any, number: number, status?: any) {
  const comments = Array.isArray(ticket?.comments) ? ticket.comments : [];
  for (const comment of comments.slice().reverse()) {
    const body = String(comment?.body || '');
    if (!body.startsWith('[sidequest:pr-watch] ')) continue;
    try {
      const recorded = JSON.parse(body.slice('[sidequest:pr-watch] '.length));
      if (recorded?.number !== number || !recorded?.state || !recorded?.checks || !recorded?.observedAt) continue;
      if (!status || (recorded.state === status.state
        && recorded.checks === status.checks
        && JSON.stringify(recorded.failingChecks || []) === JSON.stringify(status.failingChecks || []))) return recorded;
    } catch (_error: unknown) {
      // Ignore malformed historical watch markers.
    }
  }
  return null;
}

function createProjectBoardWatch(project: any, environment = process.env, dependencies?: any) {
  const pulse = require('./pulse');
  const {
    store = require('../store'),
    createBoardWatch = pulse.createBoardWatch,
    createGitHubCiRunsProvider = pulse.createGitHubCiRunsProvider,
    createGitHubPrPort = createGhPrPort,
    includeAllTickets = false,
  } = dependencies || {};
  const watchingSession = environment.CLAUDE_CODE_SESSION_ID || environment.CLAUDE_SESSION_ID || '';
  const watchingActor = environment.SIDEQUEST_AGENT || watchingSession;
  const projectPath = project.meta?.path;
  const prPort = createGitHubPrPort();
  const recordedState = (ref: string, status: any) => {
    const ticket = store.getTicket?.(project.slug, ref);
    return readPrWatchState(ticket, status.number, status);
  };
  const recordedTerminalState = (ref: string, status: any) => {
    const ticket = store.getTicket?.(project.slug, ref);
    const recorded = readPrWatchState(ticket, status.number);
    return prWatchTerminalState(recorded) === prWatchTerminalState(status) && prWatchTerminalState(status) !== null;
  };
  return createBoardWatch({
    board: project.slug,
    changesPayload: (board: string, since: string) => {
      if (board !== project.slug) throw new Error('watch attempted to read a board other than its registered identity.');
      return { project: project.slug, ...store.changesPayload(project.slug, since, { includeDispatchOwner: true }) };
    },
    ciRunsProvider: createGitHubCiRunsProvider(projectPath),
    awaitingMergeWavesProvider: async () => {
      const waves = store.findAwaitingMergeWaves?.(project.slug) || [];
      try {
        return {
          waves: await Promise.all(waves.map(async (wave: any) => {
            const pr = store.readWavePr?.(project.slug, wave.waveId) || wave.pr;
            const status = await prPort.viewPr({ cwd: projectPath, number: pr.number });
            return {
              ...wave, pr, status,
              recorded: Boolean(recordedState(wave.participants[0], status)),
              terminalRecorded: recordedTerminalState(wave.participants[0], status),
            };
          })),
          recordState: (wave: any, status: any) => {
            if (recordedState(wave.participants[0], status)) return;
            store.addComment(project.slug, wave.participants[0], {
              by: watchingActor || 'sidequest-watch', body: prWatchMarker(status), kind: 'comment', source: 'watch',
              sourceSession: watchingSession, actor: watchingActor, operation: 'pr-watch',
            });
          },
        };
      } catch (error: unknown) {
        return { waves: [], degraded: error instanceof Error ? error.message : String(error) };
      }
    },
    includeAllTickets,
    watchingAuthor: watchingActor,
    watchingSession,
    watchingOrigin: { sessionId: watchingSession, actor: watchingActor, operation: 'comment' },
  });
}

module.exports = { createProjectBoardWatch, prWatchMarker, readPrWatchState };
