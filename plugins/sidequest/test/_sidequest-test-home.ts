import { spawn } from 'node:child_process';
import fs from 'node:fs';

const { tmpFixture } = require('../../test-support/tmp-fixture.js') as { tmpFixture(prefix: string): string };
const sidequestTestHome = tmpFixture('sq-test-home-');
Object.assign(process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
});
process.env.SIDEQUEST_HOME = sidequestTestHome;

// Agent definitions (the Codex dispatch pins and temporary native executors) are
// written to the directory Claude Code's agent loader reads, which resolves to the
// developer's real `<CLAUDE_CONFIG_DIR>/agents` when nothing pins it (SQ-316). Any
// suite that dispatches a Codex-routed ticket registers a pin, so without this every
// such run would deposit generated executors in the real tree. Before SQ-316 the
// target followed SIDEQUEST_HOME and was disposable by construction; now it has to be
// pinned explicitly. Keep this ahead of any suite-local override.
const sidequestTestAgentsHome = tmpFixture('sq-test-agents-');
process.env.SIDEQUEST_AGENTS_DIR = sidequestTestAgentsHome;

// Discovery reads GET /v1/models off the effective ANTHROPIC_BASE_URL (SQ-298).
// A developer or CI box with a live gateway wired into its shell would otherwise
// inject that machine's real external models into every discovery expectation,
// so no suite inherits it. A test that wants the endpoint source sets this to
// its own local fixture server.
delete process.env.ANTHROPIC_BASE_URL;

// Claim backstops and pulse liveness discount host sleep (SQ-164) by reading the real
// `pmset -g log` on darwin. A developer laptop's own sleep history must never shift
// fixture timing, so suites run with detection off; host-sleep.test.ts injects events.
process.env.SIDEQUEST_HOST_SLEEP_DETECTION = '0';

process.once('exit', () => {
  try {
    for (const dir of [sidequestTestHome, sidequestTestAgentsHome]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  } catch {
    const cleanup = spawn(process.execPath, ['-e', `for (const dir of ${JSON.stringify([sidequestTestHome, sidequestTestAgentsHome])}) require('node:fs').rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    cleanup.unref();
  }
});
