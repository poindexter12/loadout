'use strict';

const { createGhPrPort } = require('../ports/github-pr');

function prWatchMarker(number: number, state: string) {
  return `[sidequest:pr-watch] pr=${number} state=${state}`;
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
  const recordedState = (ref: string, number: number, state: string) => {
    const ticket = store.getTicket?.(project.slug, ref);
    return Array.isArray(ticket?.comments) && ticket.comments.some((comment: any) => String(comment?.body || '') === prWatchMarker(number, state));
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
            return { ...wave, pr, status, recorded: recordedState(wave.participants[0], pr.number, status.state) };
          })),
          recordState: (wave: any, state: string) => {
            if (recordedState(wave.participants[0], wave.pr.number, state)) return;
            store.addComment(project.slug, wave.participants[0], {
              by: watchingActor || 'sidequest-watch', body: prWatchMarker(wave.pr.number, state), kind: 'comment', source: 'watch',
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

module.exports = { createProjectBoardWatch, prWatchMarker };
